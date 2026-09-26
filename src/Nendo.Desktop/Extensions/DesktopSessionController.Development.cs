using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// Developing a view from a folder (ADR-0013 Phase 4): while this device links a package of the
/// open file to a folder, the package's origin answers from the folder, a save there becomes one
/// event that reloads its views, and Save to file proposes the folder the way Import would.
/// Nothing here reaches the file; the link is this device's.
/// </summary>
internal sealed partial class DesktopSessionController
{
    /// <summary>How long after the last change in a folder its views are reloaded, so a save of many files is one reload.</summary>
    internal static readonly TimeSpan DevelopmentSettle = TimeSpan.FromMilliseconds(250);

    private readonly object _developmentLock = new();
    private Dictionary<string, DevelopmentServing> _development = new(StringComparer.Ordinal);

    /// <summary>A linked package's folder changed and its views should load it again. Carries the package ID.</summary>
    internal event Action<string>? ExtensionDevelopmentChanged;

    /// <summary>The folder a package of the open file is linked to on this device, by its name only, or null.</summary>
    private string? DevelopmentFolderName(string packageId)
    {
        lock (_developmentLock)
            return _development.TryGetValue(packageId, out var serving) ? Path.GetFileName(serving.Folder.TrimEnd(Path.DirectorySeparatorChar)) : null;
    }

    /// <summary>
    /// Brings the servings in line with this device's links for the open file: one for each linked
    /// package the file carries, none for anything else. Called from every view read, so it costs a
    /// dictionary comparison when nothing changed.
    /// </summary>
    private void ReconcileDevelopment(string? applicationId, IReadOnlyCollection<string> carried)
    {
        var wanted = applicationId is null ? [] : ExtensionSettings.LinksFor(applicationId)
            .Where(link => carried.Contains(link.PackageId))
            .ToDictionary(link => link.PackageId, link => link.Folder, StringComparer.Ordinal);
        List<DevelopmentServing> stale = [];
        lock (_developmentLock)
        {
            if (wanted.Count == _development.Count && wanted.All(pair => _development.TryGetValue(pair.Key, out var had) && had.Folder == pair.Value))
                return;
            var next = new Dictionary<string, DevelopmentServing>(StringComparer.Ordinal);
            foreach (var (packageId, folder) in wanted)
            {
                if (_development.TryGetValue(packageId, out var had) && had.Folder == folder) next[packageId] = had;
                else next[packageId] = new DevelopmentServing(packageId, folder, changed => ExtensionDevelopmentChanged?.Invoke(changed));
            }
            stale.AddRange(_development.Where(pair => !next.TryGetValue(pair.Key, out var kept) || !ReferenceEquals(kept, pair.Value)).Select(pair => pair.Value));
            _development = next;
        }
        foreach (var serving in stale) serving.Dispose();
    }

    private void StopDevelopment() => ReconcileDevelopment(null, []);

    /// <summary>A linked package's file from its folder, or null when the package is not linked.</summary>
    private DesktopExtensionAsset? ReadDevelopmentAsset(string packageId, string path)
    {
        DevelopmentServing? serving;
        lock (_developmentLock) _development.TryGetValue(packageId, out serving);
        return serving?.Read(path);
    }

    /// <summary>
    /// Links a package the open file carries to a folder on this device. The folder must read as a
    /// package, by Import's rules, and name the same package: developing one package from another's
    /// folder would run code nobody meant for it.
    /// </summary>
    internal async Task<DesktopSessionView> LinkExtensionFolderAsync(string packageId, string folder, CancellationToken cancellationToken = default)
    {
        var archive = await Task.Run(() => NendoExtensionArchives.ReadFolder(folder), cancellationToken);
        if (archive.PackageId != packageId)
            throw new NendoPreconditionException("extension-link-mismatch",
                $"That folder's {NendoExtensionArchives.ManifestName} names {archive.PackageId}, not {packageId}. Choose the folder of {packageId}.");
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var applicationId = _extensionServing.ApplicationId ?? throw new NendoPreconditionException(
                "no-file-open", "Open a file before developing one of its custom views.");
            var carried = await CarriedPackagesAsync(cancellationToken);
            if (!carried.Contains(packageId))
                throw new NendoPreconditionException("extension-package-not-found",
                    $"The file carries no package {packageId}. Import it once, then develop it from its folder.");
            ExtensionSettings.SetLink(applicationId, packageId, folder);
            var view = await ReadViewAsync(cancellationToken);
            ExtensionDevelopmentChanged?.Invoke(packageId);
            return view;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Ends a link: the package's views run the file's reviewed code again.</summary>
    internal async Task<DesktopSessionView> UnlinkExtensionFolderAsync(string packageId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var applicationId = _extensionServing.ApplicationId ?? throw new NendoPreconditionException(
                "no-file-open", "Open a file before changing how its custom views run.");
            ExtensionSettings.RemoveLink(applicationId, packageId);
            var view = await ReadViewAsync(cancellationToken);
            ExtensionDevelopmentChanged?.Invoke(packageId);
            return view;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Save to file: the proposal Import would prepare from the linked folder, for the ordinary review.</summary>
    internal async Task<NendoProposalPreview> PrepareDevelopmentSaveAsync(string packageId, CancellationToken cancellationToken = default)
    {
        var applicationId = _extensionServing.ApplicationId ?? throw new NendoPreconditionException(
            "no-file-open", "Open a file before saving a view into it.");
        var link = ExtensionSettings.LinksFor(applicationId).FirstOrDefault(candidate => candidate.PackageId == packageId)
            ?? throw new NendoPreconditionException("extension-not-linked", $"{packageId} is not being developed from a folder on this device.");
        var archive = await Task.Run(() => NendoExtensionArchives.ReadFolder(link.Folder), cancellationToken);
        if (archive.PackageId != packageId)
            throw new NendoPreconditionException("extension-link-mismatch",
                $"The folder's {NendoExtensionArchives.ManifestName} now names {archive.PackageId}, not {packageId}.");
        return await PrepareExtensionImportAsync(archive, cancellationToken);
    }

    /// <summary>The packages the open file carries. The caller holds the request gate.</summary>
    private async Task<HashSet<string>> CarriedPackagesAsync(CancellationToken cancellationToken) =>
        (await RequireService().GetDefinitionSnapshotAsync(cancellationToken)).ExtensionPackages
            .Select(package => package.PackageId).ToHashSet(StringComparer.Ordinal);

    /// <summary>
    /// One linked package: its folder, read on demand and again after any change, and a watcher
    /// that turns a burst of changes into one notice. The folder is read by Import's own rules, so
    /// what runs is exactly what Save would propose.
    /// </summary>
    private sealed class DevelopmentServing : IDisposable
    {
        private readonly string _packageId;
        private readonly Action<string> _changed;
        private readonly FileSystemWatcher? _watcher;
        private readonly Timer _settle;
        private readonly object _lock = new();
        private NendoExtensionArchive? _archive;
        private string? _failure;
        private bool _disposed;

        internal string Folder { get; }

        internal DevelopmentServing(string packageId, string folder, Action<string> changed)
        {
            _packageId = packageId;
            _changed = changed;
            Folder = folder;
            _settle = new Timer(_ => { if (!_disposed) _changed(_packageId); });
            try
            {
                _watcher = new FileSystemWatcher(folder)
                {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size,
                    InternalBufferSize = 64 * 1024,
                };
                _watcher.Changed += (_, _) => Invalidate();
                _watcher.Created += (_, _) => Invalidate();
                _watcher.Deleted += (_, _) => Invalidate();
                _watcher.Renamed += (_, _) => Invalidate();
                _watcher.Error += (_, _) => Invalidate();
                _watcher.EnableRaisingEvents = true;
            }
            catch (Exception exception) when (exception is ArgumentException or IOException or UnauthorizedAccessException)
            {
                // A folder that has gone is served as a failure the view shows; there is nothing to watch.
                _watcher?.Dispose();
                _watcher = null;
            }
        }

        private void Invalidate()
        {
            lock (_lock) { _archive = null; _failure = null; }
            if (!_disposed) _settle.Change(DevelopmentSettle, Timeout.InfiniteTimeSpan);
        }

        internal DesktopExtensionAsset Read(string path)
        {
            NendoExtensionArchive archive;
            lock (_lock)
            {
                if (_archive is null && _failure is null)
                {
                    try
                    {
                        var read = NendoExtensionArchives.ReadFolder(Folder);
                        if (read.PackageId != _packageId) _failure = $"The folder's {NendoExtensionArchives.ManifestName} names {read.PackageId}, not {_packageId}.";
                        else _archive = read;
                    }
                    catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException)
                    {
                        _failure = exception.Message;
                    }
                }
                if (_archive is null)
                    return new(503, "text/plain", System.Text.Encoding.UTF8.GetBytes("The development folder could not be read: " + _failure));
                archive = _archive;
            }
            if (path.Length == 0) path = archive.EntryPoint;
            else if (path.EndsWith('/')) path += "index.html";
            var file = archive.Files.FirstOrDefault(candidate => candidate.Path == path);
            return file is null ? DesktopExtensionAsset.NotFound : new(200, NendoExtensionContent.MediaTypeFor(path), file.Content);
        }

        public void Dispose()
        {
            _disposed = true;
            _watcher?.Dispose();
            _settle.Dispose();
        }
    }
}
