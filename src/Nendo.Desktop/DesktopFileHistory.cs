using System.Diagnostics;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopRecentFile(string Id, string FileName, string State, DateTimeOffset LastOpened);

/// <summary>
/// A recent file with its path, for the Windows shell alone.
/// <para>
/// Separate from <see cref="DesktopRecentFile"/> because that one crosses the
/// Workbench bridge and deliberately carries no path. A Jump List entry is a shortcut
/// and cannot be built without one, so the path is exposed here, to a caller inside
/// the host — and nowhere else.
/// </para>
/// </summary>
internal sealed record DesktopShellRecentFile(string Path, string FileName, DateTimeOffset LastOpened);
internal sealed record DesktopRecentFiles(IReadOnlyList<DesktopRecentFile> Files, string? Notice);
internal sealed record DesktopFileConflict(string RecentId, string FileName);
internal sealed record DesktopFileAdmission(DesktopFileConflict? Conflict, string? Notice);

/// <summary>
/// Bounded advisory device state. Paths never enter Workbench/MCP payloads.
/// Every entry is revalidated against its actual file before use; this store
/// cannot grant coordinator authority or silently assign new application IDs.
/// </summary>
internal sealed class DesktopFileHistory(string root)
{
    private const int MaximumEntries = 32;
    private const long MaximumBytes = 64 * 1024;
    private const string Unavailable = "Recent-file history is unavailable. Recovery remains available; detection of older local copies may be incomplete.";
    private readonly string _root = Path.GetFullPath(root);
    private string StatePath => Path.Combine(_root, "recent-files.json");

    internal static string DefaultRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nendo", "FileHistory");

    internal async Task<DesktopFileAdmission> CheckAsync(NendoFileObservation candidate, CancellationToken cancellationToken)
    {
        var loaded = await LoadAsync(cancellationToken);
        if (candidate.Inspection.Manifest is not { } manifest) return new(null, loaded.Notice);
        foreach (var entry in loaded.Document.Entries.Where(entry => entry.WasWritable && entry.InstanceId == manifest.InstanceId))
        {
            // The supplied observation already identifies this physical file.
            // Reopening that same file cannot be a second physical original.
            // The coordinator still pins and revalidates it before admission.
            if (Matches(entry, candidate)) continue;
            var observed = await NendoWriteCoordinator.ObserveAsync(entry.Path, cancellationToken);
            if (!Matches(entry, observed)) continue;
            if (candidate.PhysicalFileKey is null || observed.PhysicalFileKey != candidate.PhysicalFileKey)
                return new(new(entry.Id, Path.GetFileName(entry.Path)), loaded.Notice);
        }
        return new(null, loaded.Notice);
    }

    internal async Task<DesktopRecentFiles> ListAsync(CancellationToken cancellationToken)
    {
        var loaded = await LoadAsync(cancellationToken);
        var result = new List<DesktopRecentFile>();
        foreach (var entry in loaded.Document.Entries)
        {
            var observed = await NendoWriteCoordinator.ObserveAsync(entry.Path, cancellationToken);
            var state = Matches(entry, observed) ? "available" : observed.Inspection.Findings.Any(finding => finding.Code == "file-missing")
                ? "missing" : observed.Inspection.Manifest is not null ? "changed" : "unavailable";
            result.Add(new(entry.Id, Path.GetFileName(entry.Path), state, entry.LastOpened));
        }
        return new(result.AsReadOnly(), loaded.Notice);
    }

    /// <summary>
    /// The files the taskbar menu may offer: the ones still on disk, still the same
    /// file, newest first. An entry whose file has moved or changed identity is left
    /// out rather than listed as unavailable — a Jump List has nowhere to say that,
    /// and an entry that cannot open is worse than a shorter list.
    /// <para>
    /// Stops at <paramref name="wanted"/> confirmed files rather than checking all of
    /// them. Each check opens the file, this runs inside the session's request gate,
    /// and nothing behind the gate moves while it does — so a remembered file on a
    /// disconnected share is a stall every other request waits out. The menu has room
    /// for ten; checking the twenty-two nobody will see buys nothing.
    /// </para>
    /// </summary>
    internal async Task<IReadOnlyList<DesktopShellRecentFile>> ListForShellAsync(int wanted, CancellationToken cancellationToken)
    {
        var loaded = await LoadAsync(cancellationToken);
        var result = new List<DesktopShellRecentFile>();
        foreach (var entry in loaded.Document.Entries.OrderByDescending(entry => entry.LastOpened))
        {
            if (result.Count >= wanted) break;
            var observed = await NendoWriteCoordinator.ObserveAsync(entry.Path, cancellationToken);
            if (!Matches(entry, observed)) continue;
            result.Add(new(entry.Path, Path.GetFileName(entry.Path), entry.LastOpened));
        }
        return result.AsReadOnly();
    }

    internal async Task<(string Path, NendoFileObservation Observation)> ResolveAsync(string id, CancellationToken cancellationToken)
    {
        var loaded = await LoadAsync(cancellationToken);
        var entry = loaded.Document.Entries.SingleOrDefault(entry => entry.Id == id)
            ?? throw new NendoPreconditionException("recent-file-unavailable", "This recent file is no longer available. Use Open file to choose it again.");
        var observed = await NendoWriteCoordinator.ObserveAsync(entry.Path, cancellationToken);
        if (!Matches(entry, observed))
            throw new NendoPreconditionException("recent-file-changed", "This recent entry no longer identifies the same file. Use Open file to inspect the selected file again.");
        return (entry.Path, observed);
    }

    internal async Task<bool> RememberAsync(string path, NendoFileObservation observed, bool writable, CancellationToken cancellationToken)
        => await RememberCoreAsync(path, observed, writable, null, cancellationToken);

    // Only a completed, verified host replacement can transfer a known local
    // observation from the displaced physical file to the activated one. Other
    // physical originals with the same instance remain collision candidates.
    internal Task<bool> RememberReplacementAsync(string path, NendoFileObservation previous,
        NendoFileObservation replacement, CancellationToken cancellationToken)
    {
        if (previous.PhysicalFileKey is null || previous.Inspection.Manifest is not { } before ||
            replacement.Inspection.Manifest is not { } after || before.ApplicationId != after.ApplicationId || before.InstanceId != after.InstanceId)
            throw new NendoPreconditionException("replacement-history-mismatch", "The completed replacement does not match the previous file identity.");
        return RememberCoreAsync(path, replacement, false, previous, cancellationToken);
    }

    private async Task<bool> RememberCoreAsync(string path, NendoFileObservation observed, bool writable,
        NendoFileObservation? previous, CancellationToken cancellationToken)
    {
        if (observed.Inspection.Manifest is not { } manifest || observed.PhysicalFileKey is null) return false;
        string? stage = null;
        try
        {
            Directory.CreateDirectory(_root);
            await using var access = await AcquireAccessAsync(cancellationToken);
            var loaded = await LoadAsync(cancellationToken);
            // Preserve corrupt/newer device state for diagnosis. Do not turn a
            // fallback empty list into permission to overwrite that file.
            if (!loaded.CanPersist) return false;
            var fullPath = Path.GetFullPath(path);
            var sameFile = loaded.Document.Entries.FirstOrDefault(entry => Matches(entry, observed)) ??
                (previous is null ? null : loaded.Document.Entries.FirstOrDefault(entry => Matches(entry, previous)));
            var replacement = new StoredFile(sameFile?.Id ?? $"recent-{Guid.NewGuid():N}", fullPath,
                manifest.ApplicationId, manifest.InstanceId, observed.PhysicalFileKey,
                writable || sameFile?.WasWritable is true, DateTimeOffset.UtcNow);
            var entries = new[] { replacement }.Concat(loaded.Document.Entries.Where(entry =>
                    entry.Id != replacement.Id && !string.Equals(entry.Path, fullPath, StringComparison.OrdinalIgnoreCase)))
                .Take(MaximumEntries).ToArray();
            stage = Path.Combine(_root, $".recent-{Guid.NewGuid():N}.tmp");
            await using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, new HistoryDocument(1, entries), cancellationToken: cancellationToken);
                if (stream.Length > MaximumBytes) return false;
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(stage, StatePath, overwrite: true);
            stage = null;
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            if (stage is not null)
            {
                try { File.Delete(stage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private async Task<LoadedHistory> LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (!File.Exists(StatePath)) return new(new(1, []), true, null);
            await using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length > MaximumBytes) return new(new(1, []), false, Unavailable);
            var document = await JsonSerializer.DeserializeAsync<HistoryDocument>(stream, cancellationToken: cancellationToken);
            if (document is null || document.Version != 1 || document.Entries is null || document.Entries.Count > MaximumEntries ||
                document.Entries.Any(entry => entry is null || !IsValid(entry)) ||
                document.Entries.Select(entry => entry.Id).Distinct(StringComparer.Ordinal).Count() != document.Entries.Count)
                return new(new(1, []), false, Unavailable);
            return new(document, true, null);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return new(new(1, []), false, Unavailable);
        }
    }

    private async Task<FileStream> AcquireAccessAsync(CancellationToken cancellationToken)
    {
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { return new FileStream(Path.Combine(_root, ".recent-access"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose); }
            catch (IOException) when (elapsed.Elapsed < TimeSpan.FromSeconds(2)) { await Task.Delay(25, cancellationToken); }
        }
    }

    private static bool Matches(StoredFile entry, NendoFileObservation observed) =>
        observed.PhysicalFileKey == entry.PhysicalFileKey && observed.Inspection.Manifest is { } manifest &&
        manifest.ApplicationId == entry.ApplicationId && manifest.InstanceId == entry.InstanceId;

    private static bool IsValid(StoredFile entry)
    {
        try
        {
            return !string.IsNullOrWhiteSpace(entry.Id) && entry.Id.Length <= 100 &&
                !string.IsNullOrWhiteSpace(entry.Path) && entry.Path.Length <= 4096 && Path.IsPathFullyQualified(entry.Path) &&
                string.Equals(Path.GetFullPath(entry.Path), entry.Path, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(Path.GetExtension(entry.Path), NendoFormat.FileExtension, StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(entry.ApplicationId) && entry.ApplicationId.Length <= 200 &&
                !string.IsNullOrWhiteSpace(entry.InstanceId) && entry.InstanceId.Length <= 200 &&
                !string.IsNullOrWhiteSpace(entry.PhysicalFileKey) && entry.PhysicalFileKey.Length <= 100;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or IOException) { return false; }
    }

    private sealed record StoredFile(string Id, string Path, string ApplicationId, string InstanceId, string PhysicalFileKey, bool WasWritable, DateTimeOffset LastOpened);
    private sealed record HistoryDocument(int Version, IReadOnlyList<StoredFile> Entries);
    private sealed record LoadedHistory(HistoryDocument Document, bool CanPersist, string? Notice);
}
