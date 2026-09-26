using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// A package of one file that this device runs from a folder while somebody develops it
/// (ADR-0013 Phase 4). Device preference like the switches: never in the file, so a copy of
/// the file, or the file on another device, runs the reviewed package it carries.
/// </summary>
internal sealed record DesktopDevelopmentLink(string ApplicationId, string PackageId, string Folder);

/// <summary>
/// This device's switches for custom views: whether any run at all, and which files' views are
/// off. Device preference, never application data, so a file cannot turn its own views back on
/// and a received file cannot turn off anyone else's. Both default to on: a view that is shown runs.
/// It also holds the development links (ADR-0013 Phase 4), for the same reason.
/// </summary>
internal sealed class DesktopExtensionSettingsStore
{
    private const int MaximumBytes = 256 * 1024;
    private const int MaximumFiles = 4096;
    private const int MaximumLinks = 64;

    private readonly string _root;
    private readonly HashSet<string> _disabledFiles = new(StringComparer.Ordinal);
    private readonly List<DesktopDevelopmentLink> _links = [];
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
            // A link that does not read as one is dropped rather than trusted: the folder must be an
            // absolute path, and the IDs the lengths the file would allow.
            foreach (var link in (document.DevelopmentLinks ?? []).Take(MaximumLinks))
            {
                if (link is { ApplicationId.Length: > 0 and <= 200, PackageId.Length: > 0 and <= 80, Folder.Length: > 0 and <= 1024 } &&
                    Path.IsPathFullyQualified(link.Folder))
                    _links.Add(new(link.ApplicationId, link.PackageId, link.Folder));
            }
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Notice = "The saved custom view settings could not be read. Views run with the defaults for this session.";
        }
    }

    internal bool FileEnabled(string applicationId) => !_disabledFiles.Contains(applicationId);

    /// <summary>The links for one file's packages, on this device.</summary>
    internal IReadOnlyList<DesktopDevelopmentLink> LinksFor(string applicationId) =>
        _links.Where(link => link.ApplicationId == applicationId).ToArray();

    internal void SetLink(string applicationId, string packageId, string folder)
    {
        _links.RemoveAll(link => link.ApplicationId == applicationId && link.PackageId == packageId);
        if (_links.Count >= MaximumLinks)
            throw new NendoValidationException($"This device develops {MaximumLinks} packages from folders already. Stop developing one first.");
        _links.Add(new(applicationId, packageId, Path.GetFullPath(folder)));
        Save();
    }

    internal void RemoveLink(string applicationId, string packageId)
    {
        if (_links.RemoveAll(link => link.ApplicationId == applicationId && link.PackageId == packageId) != 0) Save();
    }

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
                JsonSerializer.Serialize(stream, new StoredExtensionSettings(1, Run, _disabledFiles.Order(StringComparer.Ordinal).ToArray(),
                    _links.Select(link => new StoredDevelopmentLink(link.ApplicationId, link.PackageId, link.Folder)).ToArray()));
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

    private sealed record StoredExtensionSettings(int Version, bool Run, IReadOnlyList<string> DisabledFiles,
        IReadOnlyList<StoredDevelopmentLink>? DevelopmentLinks = null);

    private sealed record StoredDevelopmentLink(string ApplicationId, string PackageId, string Folder);
}
