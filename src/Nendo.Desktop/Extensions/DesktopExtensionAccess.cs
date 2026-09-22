using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopExtensionDisclosure(string NodeType, string NodeLabel, string EdgeType,
    string SourceField, string TargetField, string? StatusField);
internal sealed record DesktopExtensionViewStatus(NendoExtensionViewDefinition Definition,
    DesktopExtensionDisclosure Disclosure, string PackageState, bool IsApproved, string? Notice);
internal sealed record DesktopExtensionConsentReview(string ReviewId, DesktopExtensionViewStatus View);

internal sealed partial class DesktopSessionController
{
    private DesktopExtensionPackageStore? _extensionPackages;
    private DesktopExtensionGrantStore? _extensionGrants;
    private readonly Dictionary<string, ExtensionConsentContext> _extensionReviews = new(StringComparer.Ordinal);
    internal DesktopExtensionPackageStore ExtensionPackages => _extensionPackages ??= new(_deviceStateRoot);
    private DesktopExtensionGrantStore ExtensionGrants => _extensionGrants ??= new(_deviceStateRoot);

    internal async Task<DesktopExtensionViewStatus> ReadExtensionStatusAsync(string viewId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var view = await RequireService().ReadExtensionViewAsync(viewId, cancellationToken);
            return await DescribeExtensionCoreAsync(view, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    /// <summary>A native consent dialog reviews this token; no package or MCP path can approve it.</summary>
    internal async Task<DesktopExtensionConsentReview> PrepareExtensionConsentAsync(string viewId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var view = await RequireService().ReadExtensionViewAsync(viewId, cancellationToken);
            var description = await DescribeExtensionCoreAsync(view, cancellationToken);
            if (description.PackageState != "available")
                throw new NendoPreconditionException("extension-package-unavailable", "Install this exact custom-view package before approving it.");
            if (_extensionReviews.Count >= 16) _extensionReviews.Clear();
            var id = "extension-review-" + Guid.NewGuid().ToString("N");
            _extensionReviews.Add(id, new(_fileSessionId, RequireExtensionFileKey(), GrantFor(view)));
            return new(id, description);
        }
        finally { _gate.Release(); }
    }

    internal async Task<DesktopExtensionViewStatus> ApproveExtensionAsync(string reviewId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_extensionReviews.Remove(reviewId, out var reviewed) || reviewed.FileSessionId != _fileSessionId ||
                reviewed.PhysicalFileKey != RequireExtensionFileKey())
                throw new NendoPreconditionException("extension-review-stale", "Review this custom view again before approving it.");
            var view = await RequireService().ReadExtensionViewAsync(reviewed.Grant.ViewId, cancellationToken);
            if (GrantFor(view) != reviewed.Grant)
                throw new NendoPreconditionException("extension-review-stale", "The package or disclosed fields changed. Review the custom view again.");
            using var package = ExtensionPackages.Acquire(view.Definition.PackageDigest, view.Definition.PackageId, view.Definition.PackageVersion);
            ExtensionGrants.Approve(reviewed.PhysicalFileKey, reviewed.Grant);
            return await DescribeExtensionCoreAsync(view, cancellationToken);
        }
        finally { _gate.Release(); }
    }

    internal async Task DisableExtensionAsync(string viewId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            // A broken or removed definition must still be revocable.
            var manifest = (await RequireService().GetDefinitionSnapshotAsync(cancellationToken)).Manifest;
            ExtensionGrants.Revoke(RequireExtensionFileKey(), manifest.ApplicationId, manifest.InstanceId, viewId);
            foreach (var key in _extensionReviews.Where(p => p.Value.Grant.ViewId == viewId).Select(p => p.Key).ToArray())
                _extensionReviews.Remove(key);
        }
        finally { _gate.Release(); }
    }

    private async Task<DesktopExtensionViewStatus> DescribeExtensionCoreAsync(NendoExtensionViewSnapshot view, CancellationToken cancellationToken)
    {
        var schema = await RequireService().GetDefinitionSnapshotAsync(cancellationToken);
        if (schema.Manifest.ChangeSequence != view.Projection.SourceChangeSequence)
            throw new NendoPreconditionException("extension-view-changed", "The file changed while preparing this view. Refresh to continue.");
        var binding = view.Definition.Binding;
        var nodes = schema.Entities.Single(e => e.EntityId == binding.NodeEntityId);
        var edges = schema.Entities.Single(e => e.EntityId == binding.EdgeEntityId);
        string Label(NendoEntitySnapshot entity, string id) => entity.Fields.Single(f => f.FieldId == id).DisplayName;
        var disclosure = new DesktopExtensionDisclosure(nodes.DisplayName, Label(nodes, binding.LabelFieldId), edges.DisplayName,
            Label(edges, binding.SourceFieldId), Label(edges, binding.TargetFieldId), binding.StatusFieldId is { } status ? Label(nodes, status) : null);
        var packageState = "available";
        try { using var package = ExtensionPackages.Acquire(view.Definition.PackageDigest, view.Definition.PackageId, view.Definition.PackageVersion); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { packageState = "missing"; }
        catch (InvalidDataException) { packageState = "corrupt"; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { packageState = "unavailable"; }
        var approved = ExtensionGrants.ForFile(RequireExtensionFileKey()).IsGranted(GrantFor(view));
        return new(view.Definition, disclosure, packageState, approved, ExtensionGrants.Notice);
    }

    private string RequireExtensionFileKey() => _currentObservation?.PhysicalFileKey
        ?? throw new NendoPreconditionException("extension-file-identity-unavailable", "This file's physical identity is unavailable. Use Studio instead.");
    private static NendoExtensionGrant GrantFor(NendoExtensionViewSnapshot view) => new(view.ApplicationId, view.InstanceId,
        view.Definition.ViewId, view.Definition.PackageDigest, view.Definition.ComputeBindingDigest(), view.Definition.ProtocolVersion);
    private sealed record ExtensionConsentContext(string FileSessionId, string PhysicalFileKey, NendoExtensionGrant Grant);
}
