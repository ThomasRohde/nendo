using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// What the review names. Protocol 2 adds the disclosed fields of each record type and
/// the fields the view is narrowed by, each by its display name.
/// </summary>
internal sealed record DesktopExtensionDisclosure(string NodeType, string NodeLabel, string? EdgeType,
    string? SourceField, string? TargetField, string? StatusField)
{
    internal IReadOnlyList<string> NodeFields { get; init; } = [];
    internal IReadOnlyList<string> EdgeFields { get; init; } = [];
    internal IReadOnlyList<string> FilterFields { get; init; } = [];

    /// <summary>Two reviews say the same thing when they name the same fields in the same order.</summary>
    public bool Equals(DesktopExtensionDisclosure? other) => other is not null &&
        (NodeType, NodeLabel, EdgeType, SourceField, TargetField, StatusField) ==
        (other.NodeType, other.NodeLabel, other.EdgeType, other.SourceField, other.TargetField, other.StatusField) &&
        NodeFields.SequenceEqual(other.NodeFields) && EdgeFields.SequenceEqual(other.EdgeFields) && FilterFields.SequenceEqual(other.FilterFields);
    public override int GetHashCode() => HashCode.Combine(NodeType, NodeLabel, EdgeType, SourceField, TargetField, StatusField);

    /// <summary>Printed in full, so a failing comparison says which field list differed.</summary>
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append($"NodeType = {NodeType}, NodeLabel = {NodeLabel}, EdgeType = {EdgeType}, SourceField = {SourceField}, ");
        builder.Append($"TargetField = {TargetField}, StatusField = {StatusField}, NodeFields = [{string.Join(", ", NodeFields)}], ");
        builder.Append($"EdgeFields = [{string.Join(", ", EdgeFields)}], FilterFields = [{string.Join(", ", FilterFields)}]");
        return true;
    }
}
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
            using var package = ExtensionPackages.Acquire(view.Definition.PackageDigest, view.Definition.PackageId, view.Definition.PackageVersion, view.Definition.ProtocolVersion);
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
        // A record set has no edge type, and its review names none.
        var edges = binding.EdgeEntityId is null ? null : schema.Entities.Single(e => e.EntityId == binding.EdgeEntityId);
        string Label(NendoEntitySnapshot entity, string id) => entity.Fields.Single(f => f.FieldId == id).DisplayName;
        // A disclosed reference reaches the page as the label of the record it points at,
        // so the review says whose label that is.
        string Disclosed(NendoEntitySnapshot entity, string id)
        {
            var field = entity.Fields.Single(f => f.FieldId == id);
            if (field.Reference is not { } reference) return field.DisplayName;
            var target = schema.Entities.Single(e => e.EntityId == reference.TargetEntityId);
            return $"{field.DisplayName} (the {Label(target, reference.LabelFieldId)} of each {target.DisplayName} record)";
        }
        string[] Names(NendoEntitySnapshot entity, IEnumerable<string> ids) =>
            ids.Where(id => entity.Fields.Any(f => f.FieldId == id)).Select(id => Disclosed(entity, id)).ToArray();
        string[] Plain(NendoEntitySnapshot entity, IEnumerable<string> ids) =>
            ids.Where(id => entity.Fields.Any(f => f.FieldId == id)).Select(id => Label(entity, id)).ToArray();
        var disclosure = new DesktopExtensionDisclosure(nodes.DisplayName, Label(nodes, binding.LabelFieldId), edges?.DisplayName,
            edges is null ? null : Label(edges, binding.SourceFieldId!), edges is null ? null : Label(edges, binding.TargetFieldId!),
            binding.StatusFieldId is { } status ? Label(nodes, status) : null)
        {
            NodeFields = Names(nodes, binding.FieldIds ?? []),
            EdgeFields = edges is null ? [] : Names(edges, binding.FieldIds ?? []),
            FilterFields = Plain(nodes, (binding.Filters ?? []).Select(f => f.FieldId)).Concat(edges is null ? [] : Plain(edges, (binding.Filters ?? []).Select(f => f.FieldId)))
                .Distinct(StringComparer.Ordinal).ToArray(),
        };
        var packageState = "available";
        try { using var package = ExtensionPackages.Acquire(view.Definition.PackageDigest, view.Definition.PackageId, view.Definition.PackageVersion, view.Definition.ProtocolVersion); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { packageState = "missing"; }
        catch (NendoPreconditionException error) when (error.Code == "extension-protocol-mismatch") { packageState = "incompatible"; }
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
