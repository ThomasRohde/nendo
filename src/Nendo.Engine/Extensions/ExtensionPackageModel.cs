using System.Security.Cryptography;

namespace Nendo.Engine;

/// <summary>
/// A package carried in the file (ADR-0013): its metadata and the files it holds, without
/// their contents. What a client lists; the bytes are read one file at a time.
/// </summary>
/// <param name="EntryPoint">The file a view's frame loads first; null for a skill package, which has none (ADR-0024).</param>
public sealed record NendoExtensionPackageSnapshot(
    string PackageId,
    string Title,
    string? Version,
    string? EntryPoint,
    string? Description,
    IReadOnlyList<NendoExtensionFileSnapshot> Files)
{
    /// <summary><see cref="NendoExtensionPackageKind.View"/> or <see cref="NendoExtensionPackageKind.Skill"/>.</summary>
    public string Kind { get; init; } = NendoExtensionPackageKind.View;

    /// <summary>A skill package: text an agent reads, never code a view runs.</summary>
    public bool IsSkill => Kind == NendoExtensionPackageKind.Skill;

    /// <summary>The bytes the package's current files hold together.</summary>
    public long TotalBytes => Files.Sum(file => file.ByteLength);
}

/// <summary>
/// What a package is (ADR-0024). A view package holds code a custom view runs from its entry
/// point; a skill package holds a <c>SKILL.md</c> and its supporting files for an agent to
/// read, has no entry point, and is never run.
/// </summary>
public static class NendoExtensionPackageKind
{
    public const string View = "view";
    public const string Skill = "skill";

    public static bool IsKnown(string? kind) => kind is View or Skill;
}

/// <summary>The frontmatter a skill package's <c>SKILL.md</c> opens with: what skills/list reports.</summary>
public sealed record NendoSkillFrontmatter(string Name, string Description);

/// <summary>
/// The rules a skill package's <c>SKILL.md</c> follows (ADR-0024, the Agent Skills format):
/// it sits at the package's root and opens with frontmatter naming the skill and saying what
/// it is for. The name is the package ID's last segment, so a client that keys skills by
/// name and URI finds the same one by both.
/// </summary>
public static class NendoAgentSkill
{
    public const string FileName = "SKILL.md";

    /// <summary>The longest skill name the Agent Skills format allows.</summary>
    public const int NameCharacters = 64;

    /// <summary>The longest description the Agent Skills format allows.</summary>
    public const int DescriptionCharacters = 1024;

    private static readonly System.Text.UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>The name a skill package's skill carries: the last segment of its package ID.</summary>
    public static string NameFor(string packageId) => packageId[(packageId.LastIndexOf('.') + 1)..];

    /// <summary>Lowercase letters and digits in hyphen-separated runs, at most 64 characters.</summary>
    public static bool ValidName(string? name) =>
        name is { Length: >= 1 and <= NameCharacters } &&
        System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9]+(-[a-z0-9]+)*\\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// Reads the frontmatter of a skill package's <c>SKILL.md</c>, or says in one sentence that
    /// names the file what is wrong with it. <paramref name="content"/> is null when the
    /// package holds no <c>SKILL.md</c>.
    /// </summary>
    public static bool TryRead(string packageId, byte[]? content, out NendoSkillFrontmatter? frontmatter, out string? problem)
    {
        frontmatter = null;
        var file = $"{packageId}/{FileName}";
        var expected = NameFor(packageId);
        if (content is null)
        {
            problem = $"The skill package {packageId} has no {FileName} at its root. Put one there: it is what an agent reads first.";
            return false;
        }
        string text;
        try { text = StrictUtf8.GetString(content); }
        catch (System.Text.DecoderFallbackException)
        {
            problem = $"{file} is not UTF-8 text.";
            return false;
        }
        text = text.TrimStart('﻿').Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = text.Split('\n');
        var close = Array.FindIndex(lines, 1, line => line.TrimEnd() == "---");
        if (lines.Length == 0 || lines[0].TrimEnd() != "---" || close < 0)
        {
            problem = $"{file} does not open with frontmatter: a line ---, then name: {expected} and description: on lines of their own, then a closing ---.";
            return false;
        }
        var values = Frontmatter(lines[1..close]);
        if (!values.TryGetValue("name", out var name) || name.Length == 0)
        {
            problem = $"{file} has no name in its frontmatter. Add name: {expected}.";
            return false;
        }
        if (name != expected)
        {
            problem = $"{file} names the skill '{name}', and a file's skill is named for the last segment of its package ID: name: {expected}.";
            return false;
        }
        if (!ValidName(name))
        {
            problem = $"{file} names the skill '{name}', which is not a skill name: lowercase letters and digits in hyphen-separated runs, at most {NameCharacters} characters. Choose a package ID whose last segment is one.";
            return false;
        }
        if (!values.TryGetValue("description", out var description) || description.Length == 0)
        {
            problem = $"{file} has no description in its frontmatter. Add description: and say in a sentence what the skill is for and when to use it.";
            return false;
        }
        if (description.Length > DescriptionCharacters)
        {
            problem = $"{file} has a description of {description.Length} characters, and a skill's description is at most {DescriptionCharacters}.";
            return false;
        }
        frontmatter = new(name, description);
        problem = null;
        return true;
    }

    /// <summary>
    /// The top-level scalar keys of a frontmatter block: a <c>key: value</c> line, quoted or
    /// not, or a folded or literal block (<c>&gt;</c>, <c>|</c>) of the indented lines after
    /// it. A nested map, such as <c>metadata:</c>, is skipped; only name and description are read.
    /// </summary>
    private static Dictionary<string, string> Frontmatter(string[] lines)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index];
            if (line.Length == 0 || line[0] is ' ' or '\t' or '#') continue;
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            if (value.Length > 0 && value[0] is '|' or '>')
            {
                var block = new List<string>();
                while (index + 1 < lines.Length && (lines[index + 1].Length == 0 || lines[index + 1][0] is ' ' or '\t'))
                    block.Add(lines[++index].Trim());
                value = string.Join(value[0] == '|' ? "\n" : " ", block).Trim();
            }
            else if (value.Length >= 2 && (value[0] == '"' && value[^1] == '"' || value[0] == '\'' && value[^1] == '\''))
            {
                value = value[0] == '"'
                    ? value[1..^1].Replace("\\\"", "\"", StringComparison.Ordinal).Replace("\\\\", "\\", StringComparison.Ordinal)
                    : value[1..^1].Replace("''", "'", StringComparison.Ordinal);
            }
            values.TryAdd(key, value);
        }
        return values;
    }
}

/// <summary>One file of a package as the file holds it now: where it is, what it is and which bytes.</summary>
public sealed record NendoExtensionFileSnapshot(
    string Path,
    string MediaType,
    string Sha256,
    long ByteLength);

/// <summary>One file of a package with its bytes.</summary>
public sealed record NendoExtensionFileContent(
    string PackageId,
    string Path,
    string MediaType,
    string Sha256,
    byte[] Content);

/// <summary>
/// How one package file differs between the active file and the file a proposal would leave,
/// so a person reviewing code reads the change rather than a sentence about it.
/// </summary>
/// <param name="Change"><c>added</c>, <c>replaced</c> or <c>removed</c>.</param>
/// <param name="Hunks">
/// The changed lines with three lines of context, for a text file of at most
/// <see cref="NendoExtensionLimits.DiffedFileBytes"/> on both sides. Empty for a binary file,
/// whose change is said by its sizes alone.
/// </param>
/// <param name="Truncated">True when the lines shown stop before the change does.</param>
public sealed record NendoExtensionFileChange(
    string PackageId,
    string Path,
    string Change,
    string? MediaTypeBefore,
    string? MediaTypeAfter,
    long? BytesBefore,
    long? BytesAfter,
    bool Textual,
    IReadOnlyList<NendoExtensionDiffHunk> Hunks,
    bool Truncated);

/// <summary>
/// A window of one package file exactly as a proposal would leave it, read from the proposal's
/// own validated copy, so a review whose diff stops early can still be read to its last byte
/// (review R-017). <paramref name="Sha256"/> and <paramref name="TotalBytes"/> are the whole
/// file's, so a reader that assembles every window can check what it has.
/// </summary>
public sealed record NendoProposalFileWindow(
    string ProposalId,
    string ReviewedDigest,
    string PackageId,
    string Path,
    string MediaType,
    string Sha256,
    long TotalBytes,
    long Offset,
    byte[] Content);

/// <summary>A run of changed lines and its context, numbered from one on each side.</summary>
public sealed record NendoExtensionDiffHunk(
    int OldStart,
    int OldLines,
    int NewStart,
    int NewLines,
    IReadOnlyList<NendoExtensionDiffLine> Lines);

/// <summary>One line of a hunk: <c>context</c>, <c>removed</c> or <c>added</c>.</summary>
public sealed record NendoExtensionDiffLine(string Kind, string Text);

/// <summary>
/// The bounds a package in the file keeps (ADR-0013). Bounded product choices rather than
/// measured optima: large enough for a view with a bundled library and its assets, small
/// enough that code cannot crowd the records out of a file Nendo opens up to 256 MiB.
/// Declared once here, published through <see cref="NendoAuthoringLimits"/>, and refused
/// above rather than truncated.
/// </summary>
public static class NendoExtensionLimits
{
    /// <summary>The largest single file.</summary>
    public const int FileBytes = 4 * 1024 * 1024;

    /// <summary>The most files one package holds.</summary>
    public const int PackageFiles = 512;

    /// <summary>The most bytes one package's current files hold together.</summary>
    public const long PackageBytes = 16L * 1024 * 1024;

    /// <summary>The most packages one file carries.</summary>
    public const int Packages = 64;

    /// <summary>The largest value a view keeps with <c>nendo.state</c>, as JSON.</summary>
    public const int StateValueBytes = 64 * 1024;

    /// <summary>The longest state key.</summary>
    public const int StateKeyCharacters = 128;

    /// <summary>The longest view ID a state row names.</summary>
    public const int StateViewIdCharacters = 200;

    /// <summary>The most keys one view, or a package's shared state, holds.</summary>
    public const int StateKeysPerView = 256;

    /// <summary>The most bytes of state one package holds across its views.</summary>
    public const long StatePackageBytes = 1024 * 1024;

    /// <summary>The most bytes every package's current files hold together.</summary>
    public const long TotalBytes = 64L * 1024 * 1024;

    /// <summary>
    /// The most new file content one change set may carry. It bounds the largest commit, which
    /// is what the write reserve below the open bound has to cover.
    /// </summary>
    public const int ContentBytesPerChangeSet = 4 * 1024 * 1024;

    /// <summary>The most bytes one read of a proposed package file returns.</summary>
    public const int ProposalFileWindowBytes = 256 * 1024;

    /// <summary>The largest text file the review diffs line by line; a larger one is said by its sizes.</summary>
    public const int DiffedFileBytes = 1024 * 1024;

    /// <summary>The most changed lines the review shows for one file.</summary>
    public const int DiffLinesPerFile = 400;

    /// <summary>The most changed lines the review shows for one proposal.</summary>
    public const int DiffLinesPerProposal = 2000;

    /// <summary>The longest path within a package.</summary>
    public const int PathCharacters = 240;

    /// <summary>The longest package ID. Short enough that <c>extension:</c> plus it fits an origin of 100.</summary>
    public const int PackageIdCharacters = 80;
}

/// <summary>
/// The rules a package's IDs, paths and media types follow, in one place, so the Engine that
/// stores a file, the host that serves it and the adapters that author it agree on them.
/// </summary>
public static class NendoExtensionContent
{
    public static string Sha256(ReadOnlySpan<byte> content) =>
        Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();

    public static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    /// <summary>
    /// A package ID names an origin and an attribution, so it is lowercase and dotted: at least
    /// two segments, each starting with a letter, of letters, digits and hyphens.
    /// </summary>
    public static bool ValidPackageId(string? value) =>
        value is { Length: >= 3 and <= NendoExtensionLimits.PackageIdCharacters } && value.Split('.').Length >= 2 &&
        value.Split('.').All(segment => segment.Length > 0 && segment[0] is >= 'a' and <= 'z' &&
            segment.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'));

    /// <summary>An exact semantic version such as 1.0.0 or 2.1.0-beta.1, without leading zeros in numeric parts.</summary>
    public static bool ValidVersion(string value)
    {
        if (value.Length > 64 || !System.Text.RegularExpressions.Regex.IsMatch(value,
                @"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant)) return false;
        var release = value.Split('+')[0];
        var dash = release.IndexOf('-');
        return dash < 0 || release[(dash + 1)..].Split('.').All(part => part.Length == 1 || part[0] != '0' || !part.All(char.IsAsciiDigit));
    }

    /// <summary>
    /// A relative path of letters, digits, <c>_ - . ~</c> and <c>/</c> between segments. No
    /// empty, <c>.</c> or <c>..</c> segment, none ending in a dot, no Windows device name, and
    /// nothing under <c>_nendo/</c>, which every view origin reserves for the host.
    /// </summary>
    public static bool ValidPath(string? path)
    {
        if (path is null || path.Length is 0 or > NendoExtensionLimits.PathCharacters) return false;
        if (path.Any(character => character is not (>= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '-' or '.' or '~' or '/')))
            return false;
        var segments = path.Split('/');
        if (string.Equals(segments[0], "_nendo", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (var segment in segments)
        {
            if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith('.')) return false;
            var name = segment.Split('.')[0].ToUpperInvariant();
            if (name is "CON" or "PRN" or "AUX" or "NUL" ||
                name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) && name[3] is >= '0' and <= '9')
                return false;
        }
        return true;
    }

    /// <summary>A bare <c>type/subtype</c>, lowercase, without parameters; the host adds a charset when it serves text.</summary>
    public static bool ValidMediaType(string? value)
    {
        if (value is null || value.Length is < 3 or > 100) return false;
        var slash = value.IndexOf('/');
        if (slash <= 0 || slash != value.LastIndexOf('/') || slash == value.Length - 1) return false;
        return value.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '/' or '!' or '#' or '$' or '&' or '^' or '_' or '.' or '+' or '-');
    }

    private static readonly IReadOnlyDictionary<string, string> MediaTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html", [".htm"] = "text/html", [".js"] = "text/javascript", [".mjs"] = "text/javascript",
        [".cjs"] = "text/javascript", [".css"] = "text/css", [".json"] = "application/json", [".map"] = "application/json",
        [".txt"] = "text/plain", [".md"] = "text/markdown", [".csv"] = "text/csv", [".xml"] = "application/xml",
        [".svg"] = "image/svg+xml", [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif", [".webp"] = "image/webp", [".avif"] = "image/avif", [".ico"] = "image/x-icon",
        [".bmp"] = "image/bmp", [".wasm"] = "application/wasm", [".woff"] = "font/woff", [".woff2"] = "font/woff2",
        [".ttf"] = "font/ttf", [".otf"] = "font/otf", [".mp3"] = "audio/mpeg", [".wav"] = "audio/wav", [".ogg"] = "audio/ogg",
        [".mp4"] = "video/mp4", [".webm"] = "video/webm", [".pdf"] = "application/pdf", [".geojson"] = "application/geo+json",
        [".topojson"] = "application/json", [".glb"] = "model/gltf-binary", [".gltf"] = "model/gltf+json",
        [".ts"] = "text/plain", [".tsx"] = "text/plain", [".vue"] = "text/plain", [".yaml"] = "text/yaml", [".yml"] = "text/yaml",
    };

    /// <summary>The media type a path's extension names, or <c>application/octet-stream</c> when it names none.</summary>
    public static string MediaTypeFor(string path) =>
        MediaTypes.TryGetValue(System.IO.Path.GetExtension(path), out var type) ? type : "application/octet-stream";

    /// <summary>Whether a media type is text a review can show line by line and a server should label UTF-8.</summary>
    public static bool IsTextual(string mediaType) =>
        mediaType.StartsWith("text/", StringComparison.Ordinal) ||
        mediaType is "application/json" or "application/xml" or "image/svg+xml" or "application/geo+json" or "model/gltf+json" ||
        mediaType.EndsWith("+json", StringComparison.Ordinal) || mediaType.EndsWith("+xml", StringComparison.Ordinal);
}
