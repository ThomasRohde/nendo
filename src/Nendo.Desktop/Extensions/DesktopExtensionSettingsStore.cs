using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// This device's switches for custom views: whether any run at all, and which files' views are
/// off. Device preference, never application data, so a file cannot turn its own views back on
/// and a received file cannot turn off anyone else's. Both default to on: a view that is shown runs.
/// </summary>
internal sealed class DesktopExtensionSettingsStore
{
    private const int MaximumBytes = 256 * 1024;
    private const int MaximumFiles = 4096;

    private readonly string _root;
    private readonly HashSet<string> _disabledFiles = new(StringComparer.Ordinal);
    private string StatePath => Path.Combine(_root, "extension-settings.json");

    internal bool Run { get; private set; } = true;
    internal string? Notice { get; private set; }

    internal DesktopExtensionSettingsStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("Custom view settings exceed their limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredExtensionSettings>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1 || document.DisabledFiles is not { Count: <= MaximumFiles } files)
                throw new JsonException("Unsupported custom view settings.");
            Run = document.Run;
            foreach (var file in files.Where(file => file is { Length: > 0 and <= 200 })) _disabledFiles.Add(file);
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Notice = "The saved custom view settings could not be read. Views run with the defaults for this session.";
        }
    }

    internal bool FileEnabled(string applicationId) => !_disabledFiles.Contains(applicationId);

    internal void SetRun(bool run)
    {
        Run = run;
        Save();
    }

    internal void SetFileEnabled(string applicationId, bool enabled)
    {
        if (enabled) _disabledFiles.Remove(applicationId);
        else if (_disabledFiles.Count >= MaximumFiles)
            throw new NendoValidationException($"Custom views are off for {MaximumFiles} files on this device already. Turn some back on first.");
        else _disabledFiles.Add(applicationId);
        Save();
    }

    private void Save()
    {
        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(_root);
            var stage = Path.Combine(_root, $"extension-settings-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                JsonSerializer.Serialize(stream, new StoredExtensionSettings(1, Run, _disabledFiles.Order(StringComparer.Ordinal).ToArray()));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Notice = "The custom view setting applies for this session, but could not be saved for the next launch.";
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

    private sealed record StoredExtensionSettings(int Version, bool Run, IReadOnlyList<string> DisabledFiles);
}
