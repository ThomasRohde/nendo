using System.Text;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

/// <summary>
/// What a proposal does to each package file, as lines a person can read before accepting
/// code into the file (ADR-0013). Compared between the active file and the validated clone,
/// so the review shows what acceptance commits rather than what an author said it would.
/// </summary>
internal static class ExtensionPackageDiff
{
    private const int ContextLines = 3;

    /// <summary>The most edits the line comparison searches before it says the change by its sizes.</summary>
    private const int MaximumEdits = 2000;

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static async Task<IReadOnlyList<NendoExtensionFileChange>> ComputeAsync(
        SqliteNendoStore active, SqliteNendoStore clone, NendoChangeSet changeSet, CancellationToken ct)
    {
        var touched = changeSet.Mutations.SelectMany(mutation => mutation.Operations)
            .Select(operation => operation switch
            {
                PutExtensionFileOperation put => (put.PackageId, put.Path),
                RemoveExtensionFileOperation remove => (remove.PackageId, remove.Path),
                _ => ((string, string)?)null,
            })
            .OfType<(string PackageId, string Path)>()
            .Distinct()
            .ToArray();
        var changes = new List<NendoExtensionFileChange>();
        var budget = NendoExtensionLimits.DiffLinesPerProposal;
        foreach (var (packageId, path) in touched)
        {
            var before = await active.ReadExtensionFileAsync(packageId, path, null, ct);
            var after = await clone.ReadExtensionFileAsync(packageId, path, null, ct);
            if (before is null && after is null || before?.Sha256 == after?.Sha256) continue;
            var change = before is null ? "added" : after is null ? "removed" : "replaced";
            string[] oldLines = [];
            string[] newLines = [];
            var textual = NendoExtensionContent.IsTextual(after?.MediaType ?? before!.MediaType) &&
                (before?.Content.Length ?? 0) <= NendoExtensionLimits.DiffedFileBytes &&
                (after?.Content.Length ?? 0) <= NendoExtensionLimits.DiffedFileBytes &&
                TryLines(before?.Content, out oldLines) && TryLines(after?.Content, out newLines);
            IReadOnlyList<NendoExtensionDiffHunk> hunks = [];
            var truncated = false;
            if (textual)
            {
                var allowance = Math.Min(budget, NendoExtensionLimits.DiffLinesPerFile);
                (hunks, var shown, truncated) = Hunks(oldLines, newLines, allowance);
                budget -= shown;
            }
            changes.Add(new(packageId, path, change, before?.MediaType, after?.MediaType,
                before?.Content.LongLength, after?.Content.LongLength, textual, hunks, truncated));
        }
        return changes;
    }

    private static bool TryLines(byte[]? content, out string[] lines)
    {
        lines = [];
        if (content is null) return true;
        try
        {
            var text = StrictUtf8.GetString(content);
            lines = text.Split('\n');
            if (lines.Length > 0 && lines[^1].Length == 0) lines = lines[..^1];
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    /// <summary>
    /// The changed lines grouped into hunks with three lines of context, at most
    /// <paramref name="allowance"/> changed lines in all. Returns how many changed lines it
    /// showed and whether it stopped before the change did.
    /// </summary>
    internal static (IReadOnlyList<NendoExtensionDiffHunk> Hunks, int Shown, bool Truncated) Hunks(
        string[] oldLines, string[] newLines, int allowance)
    {
        var script = Script(oldLines, newLines);
        var changes = Enumerable.Range(0, script.Count).Where(index => script[index].Kind != '=').ToArray();
        var hunks = new List<NendoExtensionDiffHunk>();
        var shown = 0;
        var truncated = false;
        var next = 0;
        while (next < changes.Length && !truncated)
        {
            // Changes whose context would touch share one hunk.
            var first = changes[next];
            var last = first;
            while (next + 1 < changes.Length && changes[next + 1] - last - 1 <= ContextLines * 2) last = changes[++next];
            next++;
            var start = Math.Max(0, first - ContextLines);
            var end = Math.Min(script.Count - 1, last + ContextLines);
            var lines = new List<NendoExtensionDiffLine>();
            for (var index = start; index <= end; index++)
            {
                if (script[index].Kind != '=')
                {
                    if (shown >= allowance) { truncated = true; break; }
                    shown++;
                }
                lines.Add(Line(script[index], oldLines, newLines));
            }
            hunks.Add(new(script[start].Old + 1, lines.Count(line => line.Kind != "added"),
                script[start].New + 1, lines.Count(line => line.Kind != "removed"), lines));
        }
        return (hunks, shown, truncated);
    }

    private static NendoExtensionDiffLine Line((char Kind, int Old, int New) step, string[] oldLines, string[] newLines) => step.Kind switch
    {
        '=' => new("context", Display(oldLines[step.Old])),
        '-' => new("removed", Display(oldLines[step.Old])),
        _ => new("added", Display(newLines[step.New])),
    };

    // A carriage return is compared, so a change of line endings is a change, but not shown.
    private static string Display(string line) => line.EndsWith('\r') ? line[..^1] : line;

    /// <summary>
    /// The edit script from the old lines to the new: <c>=</c> kept, <c>-</c> removed, <c>+</c>
    /// added, each with its line index on the side it belongs to. Myers' greedy algorithm over
    /// what is left once the common first and last lines are set aside; a change larger than
    /// <see cref="MaximumEdits"/> is said as everything between them replaced.
    /// </summary>
    internal static IReadOnlyList<(char Kind, int Old, int New)> Script(string[] a, string[] b)
    {
        var prefix = 0;
        while (prefix < a.Length && prefix < b.Length && a[prefix] == b[prefix]) prefix++;
        var suffix = 0;
        while (suffix < a.Length - prefix && suffix < b.Length - prefix && a[^(suffix + 1)] == b[^(suffix + 1)]) suffix++;
        var script = new List<(char, int, int)>();
        for (var index = 0; index < prefix; index++) script.Add(('=', index, index));
        var n = a.Length - prefix - suffix;
        var m = b.Length - prefix - suffix;
        var middle = Myers(a.AsSpan(prefix, n).ToArray(), b.AsSpan(prefix, m).ToArray());
        if (middle is null)
        {
            for (var index = 0; index < n; index++) script.Add(('-', prefix + index, prefix));
            for (var index = 0; index < m; index++) script.Add(('+', prefix + n, prefix + index));
        }
        else
        {
            foreach (var (kind, oldIndex, newIndex) in middle) script.Add((kind, prefix + oldIndex, prefix + newIndex));
        }
        for (var index = 0; index < suffix; index++) script.Add(('=', a.Length - suffix + index, b.Length - suffix + index));
        return script;
    }

    private static List<(char, int, int)>? Myers(string[] a, string[] b)
    {
        var n = a.Length;
        var m = b.Length;
        if (n == 0 && m == 0) return [];
        var max = Math.Min(n + m, MaximumEdits);
        var offset = max + 1;
        var v = new int[2 * max + 3];
        var trace = new List<int[]>();
        for (var d = 0; d <= max; d++)
        {
            trace.Add((int[])v.Clone());
            for (var k = -d; k <= d; k += 2)
            {
                var x = k == -d || k != d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
                var y = x - k;
                while (x < n && y < m && a[x] == b[y]) { x++; y++; }
                v[offset + k] = x;
                if (x >= n && y >= m) return Backtrack(trace, a.Length, b.Length, offset);
            }
        }
        return null;
    }

    private static List<(char, int, int)> Backtrack(List<int[]> trace, int n, int m, int offset)
    {
        var steps = new List<(char, int, int)>();
        var x = n;
        var y = m;
        for (var d = trace.Count - 1; d >= 0; d--)
        {
            var v = trace[d];
            var k = x - y;
            var previousK = k == -d || k != d && v[offset + k - 1] < v[offset + k + 1] ? k + 1 : k - 1;
            var previousX = v[offset + previousK];
            var previousY = previousX - previousK;
            while (x > previousX && y > previousY)
            {
                steps.Add(('=', x - 1, y - 1));
                x--;
                y--;
            }
            if (d > 0)
            {
                steps.Add(x == previousX ? ('+', previousX, previousY) : ('-', previousX, previousY));
            }
            x = previousX;
            y = previousY;
        }
        steps.Reverse();
        return steps;
    }
}
