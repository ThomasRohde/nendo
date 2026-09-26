using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>A package the open file carries, with the origin its views run at on this device.</summary>
/// <param name="ContentDigest">
/// Sixteen hex characters that change whenever any file's content, path or the entry point does,
/// so a view restarts when accepted code changes, even by an edit of the same size.
/// </param>
internal sealed record DesktopExtensionPackageView(
    string PackageId,
    string Title,
    string? Version,
    string EntryPoint,
    string? Description,
    string Origin,
    int FileCount,
    long TotalBytes,
    string ContentDigest)
{
    /// <summary>
    /// The name of the folder this device runs the package from while it is developed
    /// (ADR-0013 Phase 4), or null. The name only: the Workbench is never handed a path.
    /// </summary>
    public string? DevelopmentFolder { get; init; }
}

/// <summary>
/// Whether the open file's views may run here, and why not when they may not. The Workbench
/// draws no frame while <see cref="Run"/> is false, and the host refuses every view origin as
/// well, so either one alone keeps views off.
/// </summary>
/// <param name="OffReason"><c>recovery</c>, <c>device</c>, <c>file</c> or <c>health</c>; null while views run.</param>
internal sealed record DesktopExtensionRuntimeView(
    bool Run,
    string? OffReason,
    bool DeviceEnabled,
    bool FileEnabled,
    IReadOnlyList<DesktopExtensionPackageView> Packages)
{
    public string? Notice { get; init; }
}

/// <summary>One answer of the view origin server: a status, and content when there is some.</summary>
internal sealed record DesktopExtensionAsset(int Status, string? MediaType, byte[] Content)
{
    internal static DesktopExtensionAsset Forbidden { get; } = new(403, "text/plain", "Custom views are off."u8.ToArray());
    internal static DesktopExtensionAsset NotFound { get; } = new(404, "text/plain", "Not in this package."u8.ToArray());
    internal static DesktopExtensionAsset Unavailable { get; } = new(503, "text/plain", "The file is not readable right now."u8.ToArray());
}

internal sealed partial class DesktopSessionController
{
    private DesktopExtensionSettingsStore? _extensionSettings;
    private volatile bool _extensionsSuspended;
    private volatile ExtensionServing _extensionServing = ExtensionServing.None;
    private readonly ExtensionContentCache _extensionContent = new();

    private DesktopExtensionSettingsStore ExtensionSettings => _extensionSettings ??= new(_deviceStateRoot);

    /// <summary>
    /// What the origin server may answer, swapped whole whenever the view is read. It is read
    /// from the browser's request handler without the request gate, so it is immutable.
    /// </summary>
    private sealed record ExtensionServing(
        string? ApplicationId,
        bool Run,
        IReadOnlyDictionary<string, NendoExtensionPackageSnapshot> Hosts)
    {
        internal static ExtensionServing None { get; } = new(null, false,
            new Dictionary<string, NendoExtensionPackageSnapshot>(StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The recovery view's "Restart without custom views": nothing runs until the person turns
    /// views on again or starts Nendo again. Not saved, so a restart never leaves views off.
    /// </summary>
    internal void SuspendExtensions()
    {
        _extensionsSuspended = true;
        _extensionServing = _extensionServing with { Run = false };
    }

    private void StopExtensionsForFile()
    {
        lock (_viewProposals) _viewProposals.Clear();
        _extensionServing = ExtensionServing.None;
        StopDevelopment();
    }

    /// <summary>
    /// Admits a write made by a custom view of <paramref name="packageId"/> (ADR-0013 Phase 3):
    /// only while views may run, and only for a package the open file carries. Every kill
    /// switch that stops a view's frame therefore also stops its writes, even one already on
    /// its way.
    /// </summary>
    internal void RequireExtensionWriter(string packageId)
    {
        var serving = _extensionServing;
        if (!serving.Run)
            throw new NendoPreconditionException("views-off", "Custom views are off, so a view cannot change this file.");
        if (!serving.Hosts.Values.Any(package => string.Equals(package.PackageId, packageId, StringComparison.Ordinal)))
            throw new NendoPreconditionException("actor-not-allowed", $"This file carries no package {packageId}, so nothing may write in its name.");
    }

    /// <summary>
    /// A proposal a custom view prepares (ADR-0013 Phase 3). One per package waits at a time:
    /// each proposal validates against a copy of the file, so a view asking in a loop would
    /// fill the disk, and the person is never asked twice at once by one view.
    /// </summary>
    internal Task<NendoProposalPreview> PrepareExtensionProposalAsync(
        NendoCanonicalProposalRequest request,
        CancellationToken cancellationToken = default) =>
        QueryAsync(async service =>
        {
            var waiting = (await service.ListProposalsAsync(cancellationToken))
                .FirstOrDefault(proposal => proposal.Origin == request.Origin && proposal.State == NendoProposalState.Previewable);
            if (waiting is not null)
                throw new NendoPreconditionException("proposal-waiting",
                    $"This view's proposal \"{waiting.Title}\" ({waiting.ProposalId}) is still waiting for a person. It can prepare another once that one is accepted or rejected.");
            var preview = await service.PrepareProposalAsync(request, cancellationToken);
            lock (_viewProposals)
            {
                if (_viewProposals.Count >= MaximumViewProposals) _viewProposals.Remove(_viewProposals.Keys.First());
                _viewProposals[preview.ProposalId] = new(request.Origin, preview.Title);
            }
            return preview;
        }, cancellationToken);

    /// <summary>A view's kept values (ADR-0013 Phase 3): one key's, or every key with its version.</summary>
    internal Task<IReadOnlyList<NendoExtensionStateEntry>> ReadExtensionStateAsync(
        string packageId, string viewId, string? key, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.ReadExtensionStateAsync(packageId, viewId, key, cancellationToken), cancellationToken);

    /// <summary>Keeps, replaces or removes one value of a view, as one Data revision under the view's package.</summary>
    internal Task<DesktopMutationView> SetExtensionStateAsync(
        string packageId, string viewId, string key, string? valueJson, long? expectedVersion, string description,
        string idempotencyKey, string origin, CancellationToken cancellationToken = default) =>
        MutateAsync(service => service.SetExtensionStateAsync(packageId, viewId, key, valueJson, expectedVersion, description,
            new NendoRequestContext("desktop.p2.5", idempotencyKey, origin), cancellationToken), cancellationToken);

    /// <summary>The proposals views prepared in this file session, so a view can follow one after it is decided.</summary>
    private readonly Dictionary<string, (string Origin, string Title)> _viewProposals = new(StringComparer.Ordinal);
    private const int MaximumViewProposals = 256;

    /// <summary>
    /// A proposal a view's package prepared, for that view. The Engine lets a decided proposal
    /// go, so one that is gone answers from the file: committed means accepted (its receipt is
    /// in the file), anything else was rejected. Another origin's proposal is not found.
    /// </summary>
    internal Task<object> GetExtensionProposalAsync(string proposalId, string origin, CancellationToken cancellationToken = default)
    {
        (string Origin, string Title) known;
        lock (_viewProposals)
        {
            if (!_viewProposals.TryGetValue(proposalId, out known) || known.Origin != origin)
                throw new NendoPreconditionException("proposal-not-found", "The proposal is not available in this session.");
        }
        return QueryAsync<object>(async service =>
        {
            try
            {
                return await service.GetProposalAsync(proposalId, cancellationToken);
            }
            catch (NendoPreconditionException exception) when (exception.Code == "proposal-not-found")
            {
                var receipt = await service.GetProposalReceiptAsync(proposalId, cancellationToken);
                return new DesktopDecidedProposalView(proposalId, known.Title,
                    receipt is null ? NendoProposalState.Rejected : NendoProposalState.Active, [], origin);
            }
        }, cancellationToken);
    }

    /// <summary>The file session a view's frames belong to, so a late failure from a closed file is ignored.</summary>
    internal string CurrentFileSessionId => _fileSessionId;

    /// <summary>403 while views are off, 404 for an origin the open file does not have, otherwise 200.</summary>
    internal int ExtensionOriginStatus(string host)
    {
        var serving = _extensionServing;
        return !serving.Run ? 403 : serving.Hosts.ContainsKey(host) ? 200 : 404;
    }

    private DesktopExtensionRuntimeView DescribeExtensions(NendoSessionSnapshot snapshot, string health)
    {
        var settings = ExtensionSettings;
        var applicationId = snapshot.Manifest.ApplicationId;
        var fileEnabled = settings.FileEnabled(applicationId);
        var offReason = _extensionsSuspended ? "recovery"
            : !settings.Run ? "device"
            : !fileEnabled ? "file"
            : health != "normal" ? "health"
            : null;
        ReconcileDevelopment(applicationId, snapshot.ExtensionPackages.Select(package => package.PackageId).ToHashSet(StringComparer.Ordinal));
        var hosts = new Dictionary<string, NendoExtensionPackageSnapshot>(StringComparer.OrdinalIgnoreCase);
        var packages = new List<DesktopExtensionPackageView>(snapshot.ExtensionPackages.Count);
        foreach (var package in snapshot.ExtensionPackages)
        {
            var host = ExtensionOrigins.Host(applicationId, package.PackageId);
            hosts[host] = package;
            packages.Add(new(package.PackageId, package.Title, package.Version, package.EntryPoint, package.Description,
                "https://" + host, package.Files.Count, package.TotalBytes, ContentDigest(package))
            { DevelopmentFolder = DevelopmentFolderName(package.PackageId) });
        }
        _extensionServing = new(applicationId, offReason is null, hosts);
        return new(offReason is null, offReason, settings.Run, fileEnabled, packages) { Notice = settings.Notice };
    }

    private static string ContentDigest(NendoExtensionPackageSnapshot package)
    {
        var text = new System.Text.StringBuilder(package.EntryPoint).Append('\n');
        foreach (var file in package.Files.OrderBy(file => file.Path, StringComparer.Ordinal))
            text.Append(file.Path).Append('\t').Append(file.Sha256).Append('\n');
        return NendoExtensionContent.Sha256(System.Text.Encoding.UTF8.GetBytes(text.ToString()))[..16];
    }

    internal async Task<DesktopSessionView> SetExtensionSettingAsync(string scope, bool enabled, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            switch (scope)
            {
                case "device":
                    ExtensionSettings.SetRun(enabled);
                    // Turning views on is also how a person ends a restart without them.
                    if (enabled) _extensionsSuspended = false;
                    break;
                case "file":
                    var applicationId = _extensionServing.ApplicationId ?? throw new NendoPreconditionException(
                        "no-file-open", "Open a file before changing whether its custom views run.");
                    ExtensionSettings.SetFileEnabled(applicationId, enabled);
                    break;
                default:
                    throw new NendoValidationException("Custom views are switched for this device or for this file.");
            }
            return await ReadViewAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// One file of a view, for the browser. Answers from what the last view read saw, so a
    /// request never waits behind the Workbench's own queue; the bytes come from a content cache
    /// or the Engine. A package or path the file does not carry is a 404, and every view origin
    /// is a 403 while views are off.
    /// </summary>
    internal async Task<DesktopExtensionAsset> ReadExtensionAssetAsync(string host, string path, CancellationToken cancellationToken = default)
    {
        var serving = _extensionServing;
        if (!serving.Run) return DesktopExtensionAsset.Forbidden;
        if (!serving.Hosts.TryGetValue(host, out var package)) return DesktopExtensionAsset.NotFound;
        // The serving order's development step: a package this device develops answers from its folder.
        if (ReadDevelopmentAsset(package.PackageId, path) is { } developed) return developed;
        if (path.Length == 0) path = package.EntryPoint;
        else if (path.EndsWith('/')) path += "index.html";
        var file = package.Files.FirstOrDefault(candidate => candidate.Path == path);
        if (file is null) return DesktopExtensionAsset.NotFound;
        if (_extensionContent.TryGet(file.Sha256) is { } cached) return new(200, file.MediaType, cached);
        var service = _service;
        if (service is null) return DesktopExtensionAsset.NotFound;
        try
        {
            var content = await service.ReadExtensionFileAsync(package.PackageId, path, cancellationToken);
            if (content is null) return DesktopExtensionAsset.NotFound;
            _extensionContent.Add(content.Sha256, content.Content);
            return new(200, content.MediaType, content.Content);
        }
        catch (Exception exception) when (exception is ObjectDisposedException or NendoException or OperationCanceledException or IOException)
        {
            return DesktopExtensionAsset.Unavailable;
        }
    }

    /// <summary>
    /// A proposal that puts a package into the file, or brings the one it carries up to date.
    /// Prepared, never applied: the person reads the code in the proposal review and accepts it.
    /// </summary>
    internal Task<NendoProposalPreview> PrepareExtensionImportAsync(NendoExtensionArchive archive, CancellationToken cancellationToken = default) =>
        QueryAsync(async service =>
        {
            var snapshot = await service.GetDefinitionSnapshotAsync(cancellationToken);
            var current = snapshot.ExtensionPackages.FirstOrDefault(package => package.PackageId == archive.PackageId);
            return await service.PrepareProposalAsync(
                new NendoProposalRequest(
                    $"proposal-{Guid.NewGuid():N}",
                    $"{(current is null ? "Add" : "Update")} the custom view package {archive.Title}",
                    "workbench",
                    NendoExtensionArchives.ChangeSet(archive, current)),
                cancellationToken);
        }, cancellationToken);

    /// <summary>A proposal that takes a package and every file it holds out of the file.</summary>
    internal Task<NendoProposalPreview> PrepareExtensionRemovalAsync(string packageId, CancellationToken cancellationToken = default) =>
        QueryAsync(async service =>
        {
            var snapshot = await service.GetDefinitionSnapshotAsync(cancellationToken);
            var package = snapshot.ExtensionPackages.FirstOrDefault(candidate => candidate.PackageId == packageId)
                ?? throw new NendoPreconditionException("extension-package-not-found", $"The file carries no package {packageId}.");
            var stem = "remove-" + Guid.NewGuid().ToString("N");
            var operations = package.Files
                .Select((file, index) => (NendoOperation)new RemoveExtensionFileOperation($"{stem}-file-{index + 1}", packageId, file.Path, file.Sha256))
                .Append(new RemoveExtensionPackageOperation(stem + "-package", packageId))
                .ToArray();
            var changeSet = new NendoChangeSet(
            [
                new NendoMutation("desktop.extension", stem, "workbench",
                    $"Remove the custom view package {package.Title} ({packageId})", operations),
            ]);
            return await service.PrepareProposalAsync(
                new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", $"Remove the custom view package {package.Title}", "workbench", changeSet),
                cancellationToken);
        }, cancellationToken);

    /// <summary>A package with every file's bytes, for export.</summary>
    internal Task<(NendoExtensionPackageSnapshot Package, IReadOnlyList<NendoExtensionFileContent> Files)> ReadExtensionPackageAsync(
        string packageId, CancellationToken cancellationToken = default) =>
        QueryAsync(async service =>
        {
            var snapshot = await service.GetDefinitionSnapshotAsync(cancellationToken);
            var package = snapshot.ExtensionPackages.FirstOrDefault(candidate => candidate.PackageId == packageId)
                ?? throw new NendoPreconditionException("extension-package-not-found", $"The file carries no package {packageId}.");
            var files = new List<NendoExtensionFileContent>(package.Files.Count);
            foreach (var file in package.Files)
            {
                files.Add(await service.ReadExtensionFileAsync(packageId, file.Path, cancellationToken)
                    ?? throw new NendoPreconditionException("extension-file-missing", $"{file.Path} went missing while it was being read. Try again."));
            }
            return (package, (IReadOnlyList<NendoExtensionFileContent>)files);
        }, cancellationToken);

    /// <summary>
    /// View content by its hash, so a reload does not wait on the Engine and an edit that changes
    /// one file leaves the others cached. Bounded; the oldest content goes first.
    /// </summary>
    private sealed class ExtensionContentCache
    {
        private const long BudgetBytes = 64L * 1024 * 1024;
        private readonly Lock _lock = new();
        private readonly LinkedList<(string Sha256, byte[] Content)> _order = new();
        private readonly Dictionary<string, LinkedListNode<(string Sha256, byte[] Content)>> _entries = new(StringComparer.Ordinal);
        private long _bytes;

        internal byte[]? TryGet(string sha256)
        {
            lock (_lock)
            {
                if (!_entries.TryGetValue(sha256, out var node)) return null;
                _order.Remove(node);
                _order.AddFirst(node);
                return node.Value.Content;
            }
        }

        internal void Add(string sha256, byte[] content)
        {
            if (content.Length > BudgetBytes / 4) return;
            lock (_lock)
            {
                if (_entries.ContainsKey(sha256)) return;
                _entries[sha256] = _order.AddFirst((sha256, content));
                _bytes += content.Length;
                while (_bytes > BudgetBytes && _order.Last is { } oldest)
                {
                    _order.RemoveLast();
                    _entries.Remove(oldest.Value.Sha256);
                    _bytes -= oldest.Value.Content.Length;
                }
            }
        }
    }
}

/// <summary>A proposal a view prepared that has since been accepted or rejected, as the view reads it.</summary>
internal sealed record DesktopDecidedProposalView(
    string ProposalId,
    string Title,
    NendoProposalState State,
    IReadOnlyList<NendoCompilerDiagnostic> Diagnostics,
    string Origin);
