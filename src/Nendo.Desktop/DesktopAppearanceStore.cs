using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopAppearanceView(string Preference, string Effective, bool Persisted, string? Notice);

// Device preference only, never application data. An unavailable preference file
// must not prevent Studio/recovery startup. Last explicitly saved choice wins
// across processes; this is not a live cross-window settings synchronizer.
internal sealed class DesktopAppearanceStore
{
    private const int MaximumBytes = 4096;
    private readonly string _root;
    private string StatePath => Path.Combine(_root, "appearance.json");
    internal string Preference { get; private set; } = "system";
    internal bool Persisted { get; private set; } = true;
    internal string? Notice { get; private set; }

    internal static string DefaultRoot
    {
        get
        {
            if (DesktopRuntimeConfiguration.DeviceStateRoot is { } root) return root;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nendo");
        }
    }

    internal DesktopAppearanceStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("Appearance document exceeds its limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredAppearance>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1 || !IsPreference(document.Preference)) throw new JsonException("Unsupported appearance document.");
            Preference = document.Preference;
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Persisted = false;
            Notice = "The saved appearance could not be read. Using the Windows theme; file recovery remains available.";
        }
    }

    internal void Save(string preference)
    {
        if (!IsPreference(preference)) throw new NendoValidationException("Choose System, Light or Dark appearance.");
        Preference = preference;
        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(_root);
            var stage = Path.Combine(_root, $"appearance-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                JsonSerializer.Serialize(stream, new StoredAppearance(1, preference));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Persisted = false;
            Notice = "Appearance changed for this window, but could not be saved for the next launch.";
        }
        finally
        {
            if (ownedStage is not null)
            {
                try { File.Delete(ownedStage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private static bool IsPreference(string? value) => value is "system" or "light" or "dark";
    private sealed record StoredAppearance(int Version, string Preference);
}
