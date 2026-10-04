using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Desktop;

internal sealed record DesktopWindowState(int X, int Y, int Width, int Height, bool Maximized);

// Device state only. Failure to read or save geometry must never block recovery.
internal sealed class DesktopWindowStore(string root)
{
    /// <summary>How many files keep a place of their own before the least recently saved is forgotten.</summary>
    internal const int MaximumFiles = 64;

    private const int MaximumFileBytes = 64 * 1024;

    private string StatePath => Path.Combine(root, "window.json");

    private string FilesPath => Path.Combine(root, "window-files.json");

    /// <summary>
    /// Where a window should open: where this file's window last was, or, for a file that has
    /// never had one (or no file at all), where the last window of any file was.
    /// <para>
    /// There was only the second answer, so every Nendo window opened on the same rectangle
    /// and a second file landed exactly on top of the first. Keyed by where the file is,
    /// because that is what is known when the window is built: the file's own identity is
    /// read only once it is open, and a window that moved then would move under the pointer.
    /// </para>
    /// </summary>
    internal DesktopWindowState? Load(string? filePath = null) =>
        (filePath is null ? null : LoadForFile(filePath)) ?? LoadDevice();

    /// <summary>
    /// Keeps this window's place as the device default and, when a file is open, as that
    /// file's own. True only when everything asked for was kept.
    /// </summary>
    internal bool Save(DesktopWindowState state, string? filePath = null)
    {
        if (state.Width <= 0 || state.Height <= 0) return false;
        var saved = SaveDevice(state);
        if (filePath is not null) saved &= SaveForFile(filePath, state);
        return saved;
    }

    private DesktopWindowState? LoadDevice()
    {
        try
        {
            var saved = DesktopStateFile.Read<StoredWindow>(StatePath, 4096, maximumDepth: 4);
            return saved is { Version: 1, State: { Width: > 0, Height: > 0 } } ? saved.State : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private DesktopWindowState? LoadForFile(string filePath) =>
        ReadFiles() is { } files && files.TryGetValue(KeyFor(filePath), out var entry) && entry.State is { Width: > 0, Height: > 0 }
            ? entry.State
            : null;

    private bool SaveDevice(DesktopWindowState state) =>
        DesktopStateFile.TryReplace(root, StatePath, "window", stream => JsonSerializer.Serialize(stream, new StoredWindow(1, state)));

    private bool SaveForFile(string filePath, DesktopWindowState state)
    {
        // Two windows closing together would otherwise each read the list, add themselves and
        // write it back, and the second write would forget the first window's place.
        using var guard = DesktopDeviceStateLock.Enter("window-files");
        var files = ReadFiles() ?? new Dictionary<string, StoredFileWindow>(StringComparer.Ordinal);
        files[KeyFor(filePath)] = new StoredFileWindow(state, DateTimeOffset.UtcNow);
        var kept = files
            .OrderByDescending(pair => pair.Value.SavedAt)
            .Take(MaximumFiles)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        return DesktopStateFile.TryReplace(root, FilesPath, "window-files", stream =>
            JsonSerializer.Serialize(stream, new StoredFileWindows(1, kept)));
    }

    private Dictionary<string, StoredFileWindow>? ReadFiles()
    {
        try
        {
            var saved = DesktopStateFile.Read<StoredFileWindows>(FilesPath, MaximumFileBytes, maximumDepth: 6);
            return saved is { Version: 1, Files: { } files }
                ? new Dictionary<string, StoredFileWindow>(files, StringComparer.Ordinal)
                : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// A digest of where the file is, not the path itself: the place is all this list needs to
    /// answer, and a list of every file somebody opened is not worth keeping in the clear.
    /// </summary>
    internal static string KeyFor(string filePath) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(filePath).ToUpperInvariant())))[..32];

    private sealed record StoredWindow(int Version, DesktopWindowState State);

    private sealed record StoredFileWindow(DesktopWindowState State, DateTimeOffset SavedAt);

    private sealed record StoredFileWindows(int Version, Dictionary<string, StoredFileWindow> Files);
}
