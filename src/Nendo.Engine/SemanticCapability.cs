using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// One widened vocabulary feature, the lowest host version that compiles it, and
/// how to recognise it in a stored node tree.
/// </summary>
/// <param name="Name">
/// The feature in owner-facing words. It names the reason a file's minimum host
/// version moved, which the operations alone do not state.
/// </param>
internal sealed record NendoCapabilityFeature(
    string MinimumHostVersion,
    string Name,
    Func<NendoSemanticCapability.Tree, bool> Present);

/// <summary>
/// One entity's stored fields, as the ladder needs to read them: which storage kind a
/// field holds. Passed beside the node tree because one feature is not a shape of the
/// tree at all — see <see cref="NendoFormat.ReferenceBoardMinimumHostVersion"/>.
/// </summary>
internal sealed record NendoCapabilityField(string EntityId, string FieldId, NendoStorageKind StorageKind);

/// <summary>
/// The lowest host version that compiles a stored semantic definition, computed
/// from the definition itself rather than from whichever operation happened to
/// write it.
/// <para>
/// Contract version 3's tree is preserved across the vocabulary widening, so a
/// version number on a root no longer says what a host must understand: a second
/// list root, a tile under a board and a tab group are all version 3 and all need
/// a host that knows them. Reading the shape closes the gap that let a widened
/// definition reach an older host with a minimum of 1.11.
/// </para>
/// <para>
/// It reads the stored fields beside the tree, because one feature is not a shape of
/// the tree: a board grouped by a reference and a board grouped by a choice carry the
/// same kind, the same property and the same children, and only the grouping field's
/// storage kind tells them apart. Every other entry asks the nodes alone.
/// </para>
/// <para>
/// It is computed over the tree a mutation leaves behind, not over the operations
/// it submitted, for two reasons. An inline <c>ui.addNode</c> expands to a node
/// operation plus one property operation each, so judging the operations one at a
/// time would refuse — or fail to notice — depending on expansion order. And a
/// <c>ui.moveNode</c> that relocates an existing tile under a list adds no node
/// and sets no property, yet changes what the definition needs.
/// </para>
/// </summary>
internal static class NendoSemanticCapability
{
    /// <summary>
    /// A stored node tree indexed for the questions the feature table asks of it:
    /// which kinds are present, what each node's parent kind is, and how many
    /// roots of a kind one entity owns.
    /// </summary>
    internal sealed class Tree
    {
        private readonly IReadOnlyList<NendoUiNodeSnapshot> _nodes;
        private readonly Dictionary<string, NendoUiNodeSnapshot> _byId;

        private readonly Dictionary<(string Entity, string Field), NendoStorageKind> _fields;

        internal Tree(IReadOnlyList<NendoUiNodeSnapshot> nodes, IReadOnlyList<NendoCapabilityField> fields)
        {
            _nodes = nodes;
            _byId = nodes
                .GroupBy(node => node.NodeId, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
            _fields = fields
                .GroupBy(field => (field.EntityId, field.FieldId))
                .ToDictionary(group => group.Key, group => group.First().StorageKind);
        }

        /// <summary>
        /// The storage kind of one root's field, or null when the field is unknown here.
        /// <para>
        /// This is the one question the ladder asks outside the tree, and it exists because
        /// a board grouped by a reference and a board grouped by a choice are the same
        /// shape. Everything else a widened definition needs is visible in the nodes; this
        /// is not, so a ladder reading only the nodes would return a number it can see is
        /// wrong. A file with no fields to hand answers null and the feature is absent,
        /// which keeps a tree-only caller honest rather than optimistic.
        /// </para>
        /// </summary>
        internal NendoStorageKind? FieldKind(NendoUiNodeSnapshot root, string propertyName) =>
            Text(root, "entityId") is { } entityId && Text(root, propertyName) is { } fieldId &&
            _fields.TryGetValue((entityId, fieldId), out var kind)
                ? kind
                : null;

        internal IReadOnlyList<NendoUiNodeSnapshot> Nodes => _nodes;

        /// <summary>Whether the fields to hand include any of this record type's, so a missing field means absent rather than unknown.</summary>
        internal bool KnowsEntity(string entityId) => _fields.Keys.Any(key => key.Entity == entityId);

        /// <summary>The storage kind of one stored field of a record type, or null when it is not a stored field of it.</summary>
        internal NendoStorageKind? StoredKind(string entityId, string fieldId) =>
            _fields.TryGetValue((entityId, fieldId), out var kind) ? kind : null;

        internal bool HasKind(string kind) => _nodes.Any(node => node.Kind == kind);

        /// <summary>The kind of a node's parent, or null for a root or a dangling reference.</summary>
        internal string? ParentKind(NendoUiNodeSnapshot node) =>
            node.ParentNodeId is not null && _byId.TryGetValue(node.ParentNodeId, out var parent) ? parent.Kind : null;

        internal IEnumerable<NendoUiNodeSnapshot> OfKind(string kind) => _nodes.Where(node => node.Kind == kind);

        /// <summary>
        /// The largest number of roots of this kind that one entity owns. Roots
        /// are grouped by their declared entity, because the ceiling is per entity.
        /// </summary>
        internal int MostRootsOfKindPerEntity(string kind) => _nodes
            .Where(node => node.ParentNodeId is null && node.Kind == kind)
            .GroupBy(node => Text(node, "entityId") ?? string.Empty, StringComparer.Ordinal)
            .Select(group => group.Count())
            .DefaultIfEmpty(0)
            .Max();

        internal bool DeclaresCurrentContractVersion() => _nodes.Any(node =>
            node.ParentNodeId is null &&
            node.Properties.TryGetValue("definitionVersion", out var value) &&
            value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out var version) &&
            version == NendoSemanticVocabulary.ContractVersion);

        internal static string? Text(NendoUiNodeSnapshot node, string propertyName) =>
            node.Properties.TryGetValue(propertyName, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
    }

    /// <summary>
    /// Ordered by the version each feature needs. Every entry is a shape an older
    /// host refuses, so a file carrying one must state the newer host it needs.
    /// </summary>
    internal static IReadOnlyList<NendoCapabilityFeature> Features { get; } =
    [
        new(NendoFormat.SemanticMinimumHostVersion,
            "a custom surface",
            tree => tree.Nodes.Count > 0),
        new(NendoFormat.ComposableSurfacesMinimumHostVersion,
            "composable semantic surfaces",
            tree => tree.DeclaresCurrentContractVersion()),
        new(NendoFormat.SurfaceSummaryTilesMinimumHostVersion,
            "summary tiles on a list or board",
            tree => tree.OfKind("summaryTile").Any(tile =>
                tree.ParentKind(tile) is "recordList" or "boardSurface" or "gallerySurface" || tile.Properties.ContainsKey("scope"))),
        new(NendoFormat.MultipleCommandRootsMinimumHostVersion,
            "more than one command on a record type",
            tree => tree.MostRootsOfKindPerEntity("recordCommand") > 1),
        new(NendoFormat.MultipleSurfaceRootsMinimumHostVersion,
            "more than one list or board on a record type",
            tree => tree.MostRootsOfKindPerEntity("recordList") > 1 ||
                    tree.MostRootsOfKindPerEntity("boardSurface") > 1),
        new(NendoFormat.TabbedRecordPagesMinimumHostVersion,
            "named tabs on a record page",
            tree => tree.HasKind("tabGroup")),
        new(NendoFormat.DateCalendarMinimumHostVersion,
            "a Date calendar",
            tree => tree.HasKind("calendarSurface")),
        new(NendoFormat.ConditionalVisibilityMinimumHostVersion,
            "a field or section shown only when a calculation says so",
            tree => tree.Nodes.Any(node => node.Properties.ContainsKey("visibleWhen"))),
        // A choice tone reaches the same rung through the choice operation's own
        // evidence; only the page header is a shape of the tree.
        new(NendoFormat.ColourAndHeaderMinimumHostVersion,
            "a record-page header",
            tree => tree.OfKind("detailSurface").Any(page =>
                page.Properties.ContainsKey("titleFieldId") ||
                page.Properties.ContainsKey("subtitleFieldId") ||
                page.Properties.ContainsKey("accentFieldId"))),
        new(NendoFormat.FirstChartsMinimumHostVersion,
            "a chart",
            tree => tree.HasKind("breakdownChart") || tree.HasKind("progressTile")),
        new(NendoFormat.TimelineMinimumHostVersion,
            "a timeline",
            tree => tree.HasKind("timelineSurface")),
        // A rating scale reaches the same rung through the field operation's own
        // evidence; only the gallery is a shape of the tree.
        new(NendoFormat.GalleryAndRatingMinimumHostVersion,
            "a gallery",
            tree => tree.HasKind("gallerySurface")),
        // The front page and the two kinds that only it can hold, plus the range
        // tile, which a list may also carry. One rung: a host that understands the
        // overview understands all three, and a file with a range on a list still
        // needs the host that compiles rangeTile.
        new(NendoFormat.OverviewMinimumHostVersion,
            "an overview page",
            tree => tree.HasKind("overviewSurface") || tree.HasKind("recentList") || tree.HasKind("rangeTile")),
        // The two kinds that group by a civil date. One rung for both: they stand on the
        // same generated buckets, and a host that resolves a range word for one resolves it
        // for the other.
        new(NendoFormat.OverTimeMinimumHostVersion,
            "a chart over time",
            tree => tree.HasKind("trendChart") || tree.HasKind("activityGrid")),
        // The two grid kinds. One rung for both: a host that answers a grouped read over
        // two crossed fields is the host that answers a ranking's window and its maximum.
        new(NendoFormat.GridsMinimumHostVersion,
            "a matrix or a ranked list",
            tree => tree.HasKind("matrixSurface") || tree.HasKind("rankedList")),
        // The one rung that is not a node kind. A board grouped by a reference draws a
        // column per record of another record type, which a host that only knows how to
        // read a field's options cannot do -- and cannot tell it is failing to do, because
        // the two boards are the same shape. So this entry reads the grouping field.
        new(NendoFormat.ReferenceBoardMinimumHostVersion,
            "a board grouped by a reference",
            tree => tree.OfKind("boardSurface")
                .Any(board => tree.FieldKind(board, "groupByFieldId") == NendoStorageKind.Reference)),
        // A section that says how it starts. Only the property is a shape in the file: a
        // host without it refuses the surface, while every section folding is what the
        // renderer does and asks nothing of the file.
        new(NendoFormat.FoldedSectionMinimumHostVersion,
            "a section that says how it starts",
            tree => tree.OfKind("section").Any(section => section.Properties.ContainsKey("opens"))),
        new(NendoFormat.ExtensionViewsMinimumHostVersion,
            "an isolated custom view",
            tree => tree.HasKind(NendoExtensionViewDefinition.NodeKind)),
        new(NendoFormat.ExtensionProtocol2MinimumHostVersion,
            "a custom view that discloses more fields or filters",
            tree => tree.OfKind(NendoExtensionViewDefinition.NodeKind).Concat(tree.OfKind(NendoExtensionViewDefinition.RecordsKind))
                .Concat(tree.OfKind(NendoExtensionViewDefinition.PanelKind)).Any(view =>
                view.Properties.TryGetValue("protocolVersion", out var protocol) &&
                protocol.ValueKind == System.Text.Json.JsonValueKind.Number &&
                protocol.TryGetInt32(out var number) && number >= 2)),
        new(NendoFormat.ExtensionRecordsMinimumHostVersion,
            "a custom view of records as typed columns",
            tree => tree.HasKind(NendoExtensionViewDefinition.RecordsKind)),
        new(NendoFormat.ExtensionRecordPanelMinimumHostVersion,
            "a custom view on a record page",
            tree => tree.HasKind(NendoExtensionViewDefinition.PanelKind)),
        new(NendoFormat.OpenCustomViewsMinimumHostVersion,
            "a custom view defined beyond what earlier hosts read",
            tree => tree.Nodes.Any(view => NendoExtensionViewDefinition.IsViewKind(view.Kind) && BeyondEarlierHosts(tree, view))),
    ];

    private static readonly string[] EarlierPins = ["packageVersion", "packageDigest", "protocolVersion", "configurationVersion", "configuration"];

    /// <summary>
    /// Whether a view says something the 1.32 rules refused. Only shapes those rules certainly
    /// refused count: raising a file whose view they accepted would disable editing it in the
    /// host that opened it, while missing a new shape costs a 1.32 host one view it cannot draw.
    /// A question the tree cannot answer without fields counts as not beyond.
    /// </summary>
    private static bool BeyondEarlierHosts(Tree tree, NendoUiNodeSnapshot view)
    {
        if (EarlierPins.Any(pin => !view.Properties.ContainsKey(pin))) return true;
        try
        {
            using var configuration = JsonDocument.Parse(Tree.Text(view, "configuration") ?? "{}");
            if (configuration.RootElement.ValueKind == JsonValueKind.Object && configuration.RootElement.EnumerateObject().Any()) return true;
        }
        catch (JsonException) { return false; }
        var children = tree.Nodes.Where(node => node.ParentNodeId == view.NodeId && node.SurfaceId == view.SurfaceId).ToArray();
        var protocol = view.Properties.TryGetValue("protocolVersion", out var declared) && declared.ValueKind == JsonValueKind.Number &&
            declared.TryGetInt32(out var number) ? number : 0;
        if (protocol == 1 && children.Length > 0) return true;
        if (children.Any(child => child.Kind == "filterClause" && Tree.Text(child, "valueKind") is { } kind && kind != "literal")) return true;
        if (view.Kind == NendoExtensionViewDefinition.PanelKind &&
            tree.Nodes.Count(node => node.SurfaceId == view.SurfaceId && node.Kind == NendoExtensionViewDefinition.PanelKind) > 4) return true;
        var bindings = children.Where(child => child.Kind == "fieldBinding").Select(child => Tree.Text(child, "fieldId")).OfType<string>().ToArray();
        if (bindings.Length > 16) return true;
        var nodeEntity = view.Kind == NendoExtensionViewDefinition.PanelKind
            ? tree.Nodes.FirstOrDefault(node => node.SurfaceId == view.SurfaceId && node.ParentNodeId is null) is { } page ? Tree.Text(page, "entityId") : null
            : Tree.Text(view, "entityId");
        var edgeEntity = Tree.Text(view, "edgeEntityId");
        if (nodeEntity is null || !tree.KnowsEntity(nodeEntity)) return false;
        // What 1.32 read: a stored Text label, a stored non-reference status, and at most eight
        // stored fields of each record type. A calculated field is none of these.
        if (Tree.Text(view, "labelFieldId") is { } label && tree.StoredKind(nodeEntity, label) is not NendoStorageKind.Text) return true;
        if (Tree.Text(view, "statusFieldId") is { } status && tree.StoredKind(nodeEntity, status) is null or NendoStorageKind.Reference) return true;
        var perType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var fieldId in bindings.Concat(children.Where(child => child.Kind == "filterClause").Select(child => Tree.Text(child, "fieldId")).OfType<string>()))
        {
            var owner = tree.StoredKind(nodeEntity, fieldId) is not null ? nodeEntity
                : edgeEntity is not null && tree.StoredKind(edgeEntity, fieldId) is not null ? edgeEntity : null;
            if (owner is null) return true;
            if (bindings.Contains(fieldId, StringComparer.Ordinal) && (perType[owner] = perType.GetValueOrDefault(owner) + 1) > 8) return true;
        }
        return false;
    }

    /// <summary>
    /// The lowest host version that compiles this node tree. An empty-but-valid
    /// file needs nothing at all, so the floor is the format's own minimum; the
    /// caller raises its recorded minimum against this and never lowers it, so
    /// removing a feature leaves the file stating the host it once needed.
    /// </summary>
    internal static string RequiredHostVersion(
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyList<NendoCapabilityField> fields)
    {
        var tree = new Tree(nodes, fields);
        var required = NendoFormat.MinimumHostVersion;
        foreach (var feature in Features)
        {
            if (feature.Present(tree)) required = NendoFormat.RequireAtLeast(required, feature.MinimumHostVersion);
        }
        return required;
    }

    /// <summary>
    /// The widened features this tree uses, in version order. Stated so a
    /// compatibility refusal or an inspection finding can name what the file
    /// needs rather than only the number it needs.
    /// </summary>
    internal static IReadOnlyList<NendoCapabilityFeature> PresentFeatures(
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyList<NendoCapabilityField> fields)
    {
        var tree = new Tree(nodes, fields);
        return Features.Where(feature => feature.Present(tree)).ToArray();
    }
}
