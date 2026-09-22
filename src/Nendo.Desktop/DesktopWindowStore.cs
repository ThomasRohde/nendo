using System.Text.Json;

namespace Nendo.Desktop;

internal sealed record DesktopWindowState(int X, int Y, int Width, int Height, bool Maximized);

// Device state only. Failure to read or save geometry must never block recovery.
internal sealed class DesktopWindowStore(string root)
{
    private string StatePath => Path.Combine(root, "window.json");

    internal DesktopWindowState? Load()
    {
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > 4096) return null;
            var saved = JsonSerializer.Deserialize<StoredWindow>(stream, new JsonSerializerOptions { MaxDepth = 4 });
            return saved is { Version: 1, State: { Width: > 0, Height: > 0 } } ? saved.State : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    internal bool Save(DesktopWindowState state)
    {
        if (state.Width <= 0 || state.Height <= 0) return false;
        string? stage = null;
        try
        {
            Directory.CreateDirectory(root);
            stage = Path.Combine(root, $"window-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, new StoredWindow(1, state));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
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

    private sealed record StoredWindow(int Version, DesktopWindowState State);
}
