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

    private const int MaximumBytes = 64 * 1024;

    private readonly string _folder = DesktopDeviceStateLayout.Window(root);

    private string StatePath => Path.Combine(_folder, "places.json");

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
    internal DesktopWindowState? Load(string? filePath = null)
    {
        var places = Read();
        if (places is null) return null;
        if (filePath is not null && places.Files.TryGetValue(KeyFor(filePath), out var entry) && Usable(entry.State)) return entry.State;
        return Usable(places.Last) ? places.Last : null;
    }

    /// <summary>
    /// Keeps this window's place as the device default and, when a file is open, as that
    /// file's own, in one write. True when it was kept.
    /// </summary>
    internal bool Save(DesktopWindowState state, string? filePath = null)
    {
        if (state.Width <= 0 || state.Height <= 0) return false;
        // Two windows closing together would otherwise each read the places, add themselves and
        // write them back, and the second write would forget the first window's place.
        using var guard = DesktopDeviceStateLock.Enter("window.places");
        var files = Read()?.Files ?? new Dictionary<string, StoredFileWindow>(StringComparer.Ordinal);
        if (filePath is not null) files[KeyFor(filePath)] = new StoredFileWindow(state, DateTimeOffset.UtcNow);
        var kept = files
            .OrderByDescending(pair => pair.Value.SavedAt)
            .Take(MaximumFiles)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        return DesktopStateFile.TryReplace(_folder, StatePath, "places", stream =>
            JsonSerializer.Serialize(stream, new StoredPlaces(1, state, kept)));
    }

    private static bool Usable(DesktopWindowState? state) => state is { Width: > 0, Height: > 0 };

    private StoredPlaces? Read()
    {
        try
        {
            var saved = DesktopStateFile.Read<StoredPlaces>(StatePath, MaximumBytes, maximumDepth: 6);
            if (saved is not { Version: 1 }) return null;
            // An entry or a list that is not there reads as no place for that file, not as no places.
            var files = (saved.Files ?? [])
                .Where(pair => pair.Value is not null)
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            return saved with { Files = files };
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

    private sealed record StoredFileWindow(DesktopWindowState State, DateTimeOffset SavedAt);

    private sealed record StoredPlaces(int Version, DesktopWindowState? Last, Dictionary<string, StoredFileWindow> Files);
}
