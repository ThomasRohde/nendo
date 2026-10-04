using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

// Contract version 3, accepted by the ADR-0004 2026-09-09 amendment and widened
// by the 2026-09-12 one. It is the only shape this host compiles: one compile
// path, one plan shape, one digest projection. The plan is an ordered node tree,
// and the permitted children of each kind come from NendoSemanticVocabulary
// rather than from a hard-coded depth rule. What a rule cannot say in that flat
// table — which parent admits a property, how a bounded query composes, whether
// a tab group already encloses a node — travels down the recursion as
// SurfaceContext.
public sealed partial class NendoSemanticCompiler
{
    private static NendoCompileResult CompileComposableApplications(NendoSessionSnapshot source)
    {
        var diagnostics = new List<NendoCompilerDiagnostic>();
        var nodes = source.UiNodes;
        ValidateComposableTree(nodes, diagnostics);
        var roots = nodes.Where(node => node.ParentNodeId is null).ToArray();
        if (ReadContractVersion(roots, diagnostics) != NendoSemanticVocabulary.ContractVersion) return Invalid(diagnostics);

        // The overview belongs to the file, so it is the one root that is not
        // grouped by a record type. Splitting here rather than inside the group
        // keeps NUI150 meaning what it has always meant for every other root.
        var fileScoped = roots.Where(root => IsFileScopedRoot(root.Kind)).ToArray();
        var assigned = roots
            .Where(root => !IsFileScopedRoot(root.Kind))
            .Select(root => (Root: root, EntityId: ReadRequiredString(root, "entityId", "NUI150", diagnostics)))
            .ToArray();
        // A view of the file may say what it is about; the front page names nothing.
        foreach (var overview in fileScoped.Where(root => root.Properties.ContainsKey("entityId") &&
                     !NendoSemanticVocabulary.Kinds[root.Kind].Properties.Contains("entityId")))
            AddError(diagnostics, "NUI390", $"A {overview.Kind} belongs to the file, so it has no record type of its own.",
                overview.NodeId, "entityId",
                "Remove entityId from the root, and name the record type on each tile, chart and recent list inside it.");
        foreach (var duplicate in fileScoped.GroupBy(root => root.Kind, StringComparer.Ordinal)
                     .Where(items => items.Count() > MaximumRootsPerFile(items.Key)))
            AddError(diagnostics, "NUI391",
                $"The file has {duplicate.Count()} {duplicate.Key} roots, and at most {MaximumRootsPerFile(duplicate.Key)} are accepted.",
                duplicate.First().NodeId, null,
                NendoSemanticVocabulary.RootCardinalityHint(duplicate.Key));
        if (HasErrors(diagnostics)) return Invalid(diagnostics);

        var plans = new List<NendoApplicationPlan>();
        foreach (var group in assigned
                     .GroupBy(item => item.EntityId!, StringComparer.Ordinal)
                     .OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            var entity = source.Entities.SingleOrDefault(value => value.EntityId == group.Key && !value.Retired);
            if (entity is null)
            {
                AddError(diagnostics, "NUI152", "The surface entity is missing or retired.", group.Key, "entityId", "Use an active stable entity ID.");
                continue;
            }
            // The ceiling and the remedy both come from the vocabulary table the
            // client reads, so a refusal cannot name a rule the published
            // description does not carry. The message counts, because "more than
            // one" was already wrong against a table-driven ceiling of eight.
            foreach (var duplicate in group.GroupBy(item => item.Root.Kind, StringComparer.Ordinal)
                         .Where(items => items.Count() > MaximumRootsPerEntity(items.Key)))
                AddError(diagnostics, "NUI153",
                    $"The entity has {duplicate.Count()} {duplicate.Key} roots, and at most {MaximumRootsPerEntity(duplicate.Key)} are accepted.",
                    entity.EntityId, null,
                    NendoSemanticVocabulary.RootCardinalityHint(duplicate.Key));
            if (HasErrors(diagnostics)) continue;

            var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
            var derived = DerivedFieldsOf(entity);
            var surfaces = group
                .OrderBy(item => item.Root.Position)
                .ThenBy(item => item.Root.NodeId, StringComparer.Ordinal)
                .Select(item => CompileNode(item.Root, nodes, source, entity, fields, derived, SurfaceContext.Page, diagnostics))
                .Where(node => node is not null)
                .Select(node => node!)
                .ToArray();

            ValidateRecords(source.Records, entity, fields, diagnostics);
            if (HasErrors(diagnostics)) continue;

            var entityPlan = ToEntityPlan(entity);
            plans.Add(WithComposableDigest(new NendoApplicationPlan(
                NendoSemanticVocabulary.ContractVersion,
                source.Manifest.ApplicationId,
                source.Manifest.DefinitionRevision,
                source.Manifest.DataRevision,
                "",
                entityPlan,
                surfaces,
                source.Records.Where(record => record.EntityId == entity.EntityId)
                    .OrderBy(record => record.RecordId, StringComparer.Ordinal).Select(ToRecordPlan).ToArray())));
        }

        var views = CompileFileViews(fileScoped, nodes, source, diagnostics);
        var overviewPlan = fileScoped
            .Where(root => root.Kind == "overviewSurface")
            .OrderBy(root => root.Position)
            .ThenBy(root => root.NodeId, StringComparer.Ordinal)
            .Select(root => CompileOverviewNode(root, nodes, source, SurfaceContext.Overview, diagnostics))
            .FirstOrDefault(node => node is not null);

        return HasErrors(diagnostics)
            ? Invalid(diagnostics)
            : new(true, OrderDiagnostics(diagnostics))
            {
                Applications = plans.AsReadOnly(),
                Views = views,
                Overview = overviewPlan is null
                    ? null
                    : new NendoOverviewPlan(
                        NendoSemanticVocabulary.ContractVersion,
                        source.Manifest.ApplicationId,
                        source.Manifest.DefinitionRevision,
                        overviewPlan,
                        OverviewEntities(overviewPlan, source)),
            };
    }

    /// <summary>
    /// One record type as a surface sees it: its active stored fields, and its
    /// calculated ones beside them but apart from them, so nothing offers an
    /// editor for a field with no column behind it.
    /// </summary>
    private static NendoEntityPlan ToEntityPlan(NendoEntitySnapshot entity) =>
        new(entity.EntityId, AutomationTarget(entity.EntityId), entity.DisplayName,
            entity.Fields.Where(field => !field.Retired)
                .OrderBy(field => field.FieldId, StringComparer.Ordinal).Select(ToFieldPlan).ToArray())
        {
            DerivedFields = entity.DerivedFields
                .OrderBy(field => field.FieldId, StringComparer.Ordinal)
                .Select(field => ToDerivedFieldPlan(field, field.Expression))
                .ToArray(),
        };

    /// <summary>
    /// The record types the front page names, with their fields. They travel with
    /// the overview rather than being looked up among the application plans,
    /// because a type can be read by a tile without owning a single surface of its
    /// own — and a chart still has to label its groups and tone them.
    /// </summary>
    private static IReadOnlyList<NendoEntityPlan> OverviewEntities(
        NendoSurfaceNodePlan surface,
        NendoSessionSnapshot source)
    {
        var named = new HashSet<string>(StringComparer.Ordinal);
        void Walk(NendoSurfaceNodePlan node)
        {
            if (node.Properties.TryGetValue("entityId", out var value) && value.ValueKind == JsonValueKind.String &&
                value.GetString() is { Length: > 0 } entityId)
                named.Add(entityId);
            foreach (var child in node.Children) Walk(child);
        }
        Walk(surface);
        return source.Entities
            .Where(entity => !entity.Retired && named.Contains(entity.EntityId))
            .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
            .Select(ToEntityPlan)
            .ToArray();
    }

    private static bool IsFileScopedRoot(string kind) =>
        NendoSemanticVocabulary.Kinds.TryGetValue(kind, out var rule) && rule.IsFileScopedRoot;

    private static int MaximumRootsPerFile(string kind) =>
        NendoSemanticVocabulary.Kinds.TryGetValue(kind, out var rule) ? rule.MaxRootsPerFile ?? 1 : 1;

    /// <summary>
    /// The front page, compiled without a record type in context. Its children are
    /// either organisational — a section, a tab group — or they name the record
    /// type they read, at which point the ordinary node compiler takes over with
    /// that entity in hand, exactly as a related list rebinds to its target.
    /// </summary>
    private static NendoSurfaceNodePlan? CompileOverviewNode(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        NendoSessionSnapshot source,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        // A record page hides a section when a calculation on the record says so.
        // There is no record here for one to read.
        if (node.Properties.ContainsKey("visibleWhen"))
            AddError(diagnostics, "NUI399", "There is no record on the front page for a visibility calculation to read.",
                node.NodeId, "visibleWhen",
                "Remove visibleWhen. A calculated field answers per record, and the front page shows no single record.");

        var children = nodes
            .Where(value => value.ParentNodeId == node.NodeId && value.SurfaceId == node.SurfaceId)
            .OrderBy(value => value.Position)
            .ThenBy(value => value.NodeId, StringComparer.Ordinal)
            .Select(child => CompileOverviewChild(child, nodes, source, scope, diagnostics))
            .Where(child => child is not null)
            .Select(child => child!)
            .ToArray();

        if (node.Kind == "tabGroup" && children.All(child => child.Kind != "section"))
            AddError(diagnostics, "NUI310", "The tab group has no tabs.", node.NodeId, null,
                "Add at least one section; each section is one tab, named by its title.");

        // A front page that reads nothing is a heading over an empty space. The
        // description does not count: saying what the file is for is not the same
        // as showing any of it.
        if (node.Kind == "overviewSurface" &&
            !DescendantKinds(children, "summaryTile").Any() && !DescendantKinds(children, "breakdownChart").Any() &&
            !DescendantKinds(children, "progressTile").Any() && !DescendantKinds(children, "rangeTile").Any() &&
            !DescendantKinds(children, "recentList").Any() && !DescendantKinds(children, "rankedList").Any() &&
            !DescendantKinds(children, "trendChart").Any() && !DescendantKinds(children, "activityGrid").Any())
            AddError(diagnostics, "NUI400", "The front page shows nothing.", node.NodeId, null,
                "Add a tile, a chart, an activity grid, a recent list or a ranking, each naming the record type it reads.");

        var properties = node.Properties
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(pair => pair.Key, pair => pair.Value.Clone(), StringComparer.Ordinal);

        return new NendoSurfaceNodePlan(node.NodeId, AutomationTarget(node.NodeId), node.Kind, properties, children);
    }

    /// <summary>
    /// One child of the front page. A section or a tab group stays here, where
    /// there is still no record type; anything that reads records names one, and is
    /// compiled against it by the ordinary path.
    /// </summary>
    private static NendoSurfaceNodePlan? CompileOverviewChild(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        NendoSessionSnapshot source,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (node.Kind is "fieldBinding" or "relatedList")
        {
            AddError(diagnostics, "NUI398", $"A {node.Kind} needs a record in context, and the front page has none.",
                node.NodeId, "parentNodeId",
                "Use a recentList to show records of one type on the front page, or move this onto that record type's own surface.");
            return null;
        }

        if (node.Kind is "section" or "tabGroup")
        {
            if (node.Kind == "tabGroup" && scope.InsideTabGroup)
                AddError(diagnostics, "NUI311", "A tab group cannot contain another tab group.", node.NodeId, "parentNodeId",
                    "Keep one level of tabs. A section inside a tab may hold further sections, but not another tabGroup.");
            ValidateOpens(node, scope, diagnostics);
            return CompileOverviewNode(node, nodes, source, scope.Within(node), diagnostics);
        }

        var entityId = ReadRequiredString(node, "entityId", "NUI392", diagnostics);
        if (entityId is null) return null;
        var entity = source.Entities.SingleOrDefault(value => value.EntityId == entityId && !value.Retired);
        if (entity is null)
        {
            AddError(diagnostics, "NUI393", $"Record type '{entityId}' does not exist or is retired.", node.NodeId, "entityId",
                "Name an active record type. Every tile on the front page states the one it reads.");
            return null;
        }

        var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        return CompileNode(node, nodes, source, entity, fields, DerivedFieldsOf(entity),
            scope with { Kind = "overviewSurface", DeclaredClauses = 0, ImplicitClauses = 0, ParentKind = node.Kind },
            diagnostics);
    }

    private static NendoCompileResult ProjectComposableRecords(NendoCompileResult definition, NendoSessionSnapshot source)
    {
        var diagnostics = definition.Diagnostics.ToList();
        var plans = new List<NendoApplicationPlan>();
        foreach (var plan in definition.Applications)
        {
            var entity = source.Entities.Single(value => value.EntityId == plan.Entity.SemanticId);
            ValidateRecords(source.Records, entity,
                entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal), diagnostics);
            plans.Add(WithComposableDigest(plan with
            {
                DataRevision = source.Manifest.DataRevision,
                Records = source.Records.Where(record => record.EntityId == entity.EntityId)
                    .OrderBy(record => record.RecordId, StringComparer.Ordinal).Select(ToRecordPlan).ToArray(),
            }));
        }
        // The front page and the file's views hold no records of their own, so a data
        // revision changes nothing about them and they travel through unchanged.
        return HasErrors(diagnostics)
            ? Invalid(diagnostics)
            : new(true, OrderDiagnostics(diagnostics)) { Applications = plans.AsReadOnly(), Overview = definition.Overview, Views = definition.Views };
    }

    /// <summary>
    /// Identity, kind, property and parenting rules for contract version 3. Every
    /// structural rule is read from the vocabulary table; depth is bounded by
    /// which kinds may contain which, not by a constant.
    /// </summary>
    private static void ValidateComposableTree(
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        foreach (var duplicate in nodes
                     .GroupBy(value => value.NodeId, StringComparer.Ordinal)
                     .Where(group => group.Count() > 1)
                     .OrderBy(group => group.Key, StringComparer.Ordinal))
            AddError(diagnostics, "NUI010", $"Node ID '{duplicate.Key}' is declared more than once.", duplicate.Key, null, "Use a globally unique stable node ID.");

        var byId = nodes
            .GroupBy(value => value.NodeId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var permitted = string.Join(", ", NendoSemanticVocabulary.Kinds.Keys.OrderBy(value => value, StringComparer.Ordinal));

        foreach (var node in nodes.OrderBy(value => value.NodeId, StringComparer.Ordinal))
        {
            if (!NendoSemanticVocabulary.Kinds.TryGetValue(node.Kind, out var rule))
            {
                AddError(diagnostics, "NUI011", $"Node kind '{node.Kind}' is not supported by contract version {NendoSemanticVocabulary.ContractVersion}.", node.NodeId, "kind", $"Use one of: {permitted}.");
                continue;
            }

            foreach (var property in node.Properties.Keys
                         .Where(value => !rule.Properties.Contains(value))
                         .OrderBy(value => value, StringComparer.Ordinal))
                AddError(diagnostics, "NUI090", $"Property '{property}' is not supported on '{node.Kind}'.", node.NodeId, property, "Remove renderer-specific or unknown state from the semantic definition.");

            foreach (var required in rule.RequiredProperties
                         .Where(value => !node.Properties.ContainsKey(value))
                         .OrderBy(value => value, StringComparer.Ordinal))
                AddError(diagnostics, "NUI091", $"Property '{required}' is required on '{node.Kind}'.", node.NodeId, required, $"Declare {required} on this node.");

            if (node.ParentNodeId is null)
            {
                if (!rule.CanBeRoot)
                    AddError(diagnostics, "NUI012", $"Node kind '{node.Kind}' cannot be a surface root.", node.NodeId, "parentNodeId", "Place it inside a permitted parent node.");
                continue;
            }

            if (!byId.TryGetValue(node.ParentNodeId, out var parent))
            {
                AddError(diagnostics, "NUI014", $"Parent node '{node.ParentNodeId}' is missing.", node.NodeId, "parentNodeId", "Reference a stable node in the same definition.");
                continue;
            }
            if (parent.SurfaceId != node.SurfaceId)
            {
                AddError(diagnostics, "NUI016", $"Parent node '{node.ParentNodeId}' belongs to another surface.", node.NodeId, "parentNodeId", "Keep a node and its parent on one surface.");
                continue;
            }
            if (!NendoSemanticVocabulary.Kinds.TryGetValue(parent.Kind, out var parentRule) || !parentRule.Children.Contains(node.Kind))
                AddError(diagnostics, "NUI013", $"Node kind '{node.Kind}' cannot be a child of '{parent.Kind}'.", node.NodeId, "parentNodeId", $"Permitted children of '{parent.Kind}': {(parentRule is null || parentRule.Children.Count == 0 ? "none" : string.Join(", ", parentRule.Children.OrderBy(value => value, StringComparer.Ordinal)))}.");
        }

        foreach (var node in nodes.OrderBy(value => value.NodeId, StringComparer.Ordinal))
        {
            var seen = new HashSet<string>(StringComparer.Ordinal) { node.NodeId };
            var current = node;
            while (current.ParentNodeId is not null && byId.TryGetValue(current.ParentNodeId, out var parent))
            {
                if (!seen.Add(parent.NodeId))
                {
                    AddError(diagnostics, "NUI015", "The semantic node tree contains a parent cycle.", node.NodeId, "parentNodeId", "Break the cycle so every node reaches one root.");
                    break;
                }
                current = parent;
            }
        }
    }

    /// <summary>
    /// Where a node sits: the bounded query it is inside, what an effective-filter
    /// budget already owes before the node's own clauses are counted, and the
    /// ancestor facts a contextual rule needs. A tile is validated against
    /// composition rather than its own clause count, because composition is what
    /// the host actually sends; `scope` and tab nesting are decided by ancestry,
    /// which a flat kind table cannot express.
    /// </summary>
    /// <param name="Kind">
    /// The enclosing queried node's kind, or <c>page</c> on a record page, where a
    /// tile keeps its existing entity-wide meaning.
    /// </param>
    /// <param name="DeclaredClauses">The enclosing queried node's own filter clauses.</param>
    /// <param name="ImplicitClauses">
    /// Predicates the host adds for that context: one reference predicate for a
    /// relation, two date bounds for a calendar month.
    /// </param>
    /// <param name="ParentKind">The immediate parent's kind, for contextual property rules.</param>
    /// <param name="InsideTabGroup">
    /// Whether a tab group already encloses this node, at any depth. `section` is
    /// shared, so a second group can be reached through an intervening section and
    /// the ancestor has to be tracked rather than inferred from the parent.
    /// </param>
    private sealed record SurfaceContext(
        string Kind,
        int DeclaredClauses,
        int ImplicitClauses,
        string? ParentKind,
        bool InsideTabGroup = false,
        bool FileScoped = false)
    {
        internal static SurfaceContext Page { get; } = new("page", 0, 0, null);

        /// <summary>
        /// Inside the file's front page, where there is no record type in context.
        /// A tile here names its own, and a node that needs a record in hand —
        /// a field binding, a related list, a visibility calculation — has nothing
        /// to read and is refused rather than drawn empty.
        /// </summary>
        internal static SurfaceContext Overview { get; } = new("overviewSurface", 0, 0, null, FileScoped: true);

        internal SurfaceContext Within(NendoUiNodeSnapshot parent) => this with
        {
            ParentKind = parent.Kind,
            InsideTabGroup = InsideTabGroup || parent.Kind == "tabGroup",
        };
    }

    private static int DeclaredClauseCount(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes) =>
        nodes.Count(value => value.ParentNodeId == node.NodeId && value.SurfaceId == node.SurfaceId &&
                             value.Kind == "filterClause");

    private static NendoSurfaceNodePlan? CompileNode(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        NendoSessionSnapshot source,
        NendoEntitySnapshot entity,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (node.Kind == "fieldBinding")
        {
            var fieldId = ReadRequiredString(node, "fieldId", "NUI212", diagnostics);
            if (fieldId is null) return null;
            // A calculated field binds here like a stored one. Showing it is the
            // whole point of having it; what a surface may not do with it is sort,
            // filter or group by it, and each of those refuses separately below.
            if (!fields.ContainsKey(fieldId) && !derived.ContainsKey(fieldId))
            {
                AddError(diagnostics, "NUI213", $"Field '{fieldId}' does not exist on the surface entity.", node.NodeId, "fieldId", "Reference a stable field ID from Structure.");
                return null;
            }
        }

        // A related list reads the inverse of a configured reference, so its
        // children bind to the related entity rather than to this surface's.
        var childEntity = entity;
        var childFields = fields;
        var childDerived = derived;
        if (node.Kind == "relatedList")
        {
            if (ResolveRelation(node, source, entity, diagnostics) is not { } relation) return null;
            childEntity = relation;
            childFields = relation.Fields.Where(field => !field.Retired)
                .ToDictionary(field => field.FieldId, StringComparer.Ordinal);
            childDerived = DerivedFieldsOf(relation);
            ValidateOrdering(node, childFields, childDerived, diagnostics);
        }

        // ADR-0008 P8: the first consumer of the bounded expression service outside
        // calculated fields. It reads one, and it can only hide — it never conceals
        // Studio, never removes the field from the form and never decides what a save
        // may write.
        ValidateVisibility(node, derived, diagnostics);
        ValidateOpens(node, scope, diagnostics);
        if (NendoExtensionViewDefinition.IsViewKind(node.Kind)) ValidateExtensionView(node, nodes, source, diagnostics);

        if (node.Kind == "filterClause") ValidateFilterClause(node, fields, derived, diagnostics);

        if (node.Kind == "summaryTile") ValidateSummaryTile(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "breakdownChart") ValidateBreakdownChart(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "progressTile") ValidateProgressTile(node, nodes, scope, diagnostics);

        if (node.Kind == "rangeTile") ValidateRangeTile(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "recentList") ValidateRecentList(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "trendChart") ValidateTrendChart(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "activityGrid") ValidateActivityGrid(node, nodes, fields, derived, scope, diagnostics);

        if (node.Kind == "matrixSurface") ValidateMatrixSurface(node, fields, derived, diagnostics);

        if (node.Kind == "rankedList") ValidateRankedList(node, nodes, fields, derived, scope, diagnostics);

        // A tile takes its record type from the surface it sits on. The front page
        // is the one surface that has none to lend, so naming one is required
        // there and refused everywhere else rather than resolved: a tile that
        // disagreed with its surface would have two answers to one question.
        if (node.Kind is "summaryTile" or "breakdownChart" or "progressTile" or "rangeTile" or "trendChart" or "activityGrid" &&
            !scope.FileScoped && node.Properties.ContainsKey("entityId"))
            AddError(diagnostics, "NUI394", $"A {node.Kind} takes its record type from the surface it is on.",
                node.NodeId, "entityId",
                "Remove entityId. Only a tile on an overviewSurface names one, because the front page has no record type of its own.");

        if (node.Kind is "recordList" or "boardSurface" or "calendarSurface" or "timelineSurface" or "gallerySurface" or "matrixSurface") ValidateOrdering(node, fields, derived, diagnostics);

        if (node.Kind == "calendarSurface") ValidateCalendarBinding(node, fields, derived, diagnostics);

        if (node.Kind == "timelineSurface") ValidateTimelineBinding(node, fields, derived, diagnostics);

        if (node.Kind == "gallerySurface") ValidateGalleryBinding(node, fields, derived, diagnostics);

        if (node.Kind == "outlineSurface") ValidateOutlineSurface(node, entity, fields, derived, diagnostics);

        if (node.Kind == "boardSurface") ValidateBoardGrouping(node, source, fields, derived, diagnostics);

        if (node.Kind == "detailSurface") ValidateRecordPageHeader(node, fields, derived, diagnostics);

        if (node.Kind == "commandStep") ValidateCommandStep(node, fields, derived, diagnostics);

        // `section` is shared, so a second tab group is reachable through an
        // intervening section. Tabs organise named record information; nesting
        // them makes the page a layout API, which is not what this admits.
        if (node.Kind == "tabGroup" && scope.InsideTabGroup)
            AddError(diagnostics, "NUI311", "A tab group cannot contain another tab group.", node.NodeId, "parentNodeId",
                "Keep one level of tabs on a record page. A section inside a tab may hold further sections, but not another tabGroup.");

        // A node that owns a bounded query opens a new budget scope; anything
        // else — a section, a tab group — passes its parent's through unchanged so
        // a tile keeps paying for the surface it is actually inside.
        var childScope = SurfaceContextFor(node, nodes, scope, diagnostics);

        // A custom view's children name fields of two record types, the node type and the
        // edge type, so the view validates them itself (ValidateExtensionView); compiled here
        // against the surface's one type they would refuse every edge field. They are still
        // in the plan, as they are, so a reader of the compiled surfaces sees the whole view.
        var ordered = nodes
            .Where(value => value.ParentNodeId == node.NodeId && value.SurfaceId == node.SurfaceId)
            .OrderBy(value => value.Position)
            .ThenBy(value => value.NodeId, StringComparer.Ordinal);
        // A view on a record page carries none into the plan at all: its fieldBinding children
        // are what the view reads, not fields of the form around it, and every walk that
        // collects a page's bindings would otherwise take them for the form's own.
        var children = node.Kind == NendoExtensionViewDefinition.PanelKind ? []
            : NendoExtensionViewDefinition.IsViewKind(node.Kind)
            ? ordered.Select(child => new NendoSurfaceNodePlan(child.NodeId, AutomationTarget(child.NodeId), child.Kind, child.Properties, [])).ToArray()
            : ordered
                .Select(child => CompileNode(child, nodes, source, childEntity, childFields, childDerived, childScope, diagnostics))
                .Where(child => child is not null)
                .Select(child => child!)
                .ToArray();

        if (node.Kind is "recordForm" or "recordList" or "boardSurface" or "calendarSurface" or "timelineSurface" or "gallerySurface" or "matrixSurface" &&
            !DescendantBindings(children).Any())
            AddError(diagnostics, "NUI211", "The surface has no fields.", node.NodeId, null, "Add at least one stable field binding.");

        // A form is where a record is typed in. One made entirely of calculated
        // fields would offer Save with nothing to save, so it is refused here
        // rather than rendered as a page that cannot do what its button says.
        if (node.Kind == "recordForm" && DescendantBindings(children).Any() &&
            DescendantBindings(children).All(binding => BoundFieldId(binding) is { } bound && derived.ContainsKey(bound)))
            AddError(diagnostics, "NUI215", "The form shows only calculated fields, so there is nothing to fill in.",
                node.NodeId, null, "Bind at least one stored field. A calculated field can be shown beside it, but nobody types into one.");

        if (node.Kind == "recordCommand" && children.All(child => child.Kind != "commandStep"))
            AddError(diagnostics, "NUI280", "The command does nothing.", node.NodeId, null, "Add at least one commandStep.");

        if (node.Kind == "relatedList" && children.All(child => child.Kind != "fieldBinding"))
            AddError(diagnostics, "NUI264", "The related list shows no fields.", node.NodeId, null, "Bind at least one field of the related record type.");

        if (node.Kind == "recentList" && children.All(child => child.Kind != "fieldBinding"))
            AddError(diagnostics, "NUI401", "The recent list shows no fields.", node.NodeId, null,
                "Bind at least one field of the record type it names; the first one titles each row.");

        if (node.Kind == "rankedList" && children.All(child => child.Kind != "fieldBinding"))
            AddError(diagnostics, "NUI423", "The ranked list shows no fields.", node.NodeId, null,
                "Bind at least one field of the record type it names; the first one titles each row, beside its rank and its bar.");

        // Each section of a group is one tab, named by its existing required
        // title. A group with no section is a tab strip with no tabs.
        if (node.Kind == "tabGroup" && children.All(child => child.Kind != "section"))
            AddError(diagnostics, "NUI310", "The tab group has no tabs.", node.NodeId, null,
                "Add at least one section; each section is one tab, named by its title.");

        // A record page must show something: its own fields, or a relation.
        if (node.Kind == "detailSurface" &&
            !DescendantBindings(children).Any() &&
            !DescendantKinds(children, "relatedList").Any())
            AddError(diagnostics, "NUI265", "The record page shows nothing.", node.NodeId, null, "Add a field binding or a related list.");

        var properties = node.Properties
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(pair => pair.Key, pair => pair.Value.Clone(), StringComparer.Ordinal);

        return new NendoSurfaceNodePlan(node.NodeId, AutomationTarget(node.NodeId), node.Kind, properties, children);
    }

    /// <summary>
    /// The budget and ancestry a node's children sit in. A list, board, related list or
    /// calendar owns a bounded query and states what it already spends; the node
    /// itself is checked here, because a surface over the ceiling refuses before
    /// any tile inside it is considered.
    /// </summary>
    private static SurfaceContext SurfaceContextFor(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        // Only a node that owns a bounded query opens a scope, and only such a
        // node is checked here. Checking every node would report the same surface
        // once per child it happens to have.
        var implicitClauses = node.Kind switch
        {
            // A gallery is a list's window drawn as cards, so it adds no predicate of its
            // own. Left out of this table it would be scoped as a page, and its clauses
            // would not be counted against a tile's budget while the renderer composed them.
            "recordList" or "boardSurface" or "gallerySurface" or "matrixSurface" => 0,
            // One reference predicate binds the relation to the selected record.
            "relatedList" => 1,
            // A month is two date bounds, so six declared clauses is the most a
            // calendar can carry, and a timeline's year is two bounds in the same
            // way. The undated view spends one of the same budget.
            "calendarSurface" or "timelineSurface" => 2,
            _ => -1,
        };
        if (implicitClauses < 0)
            return (node.Kind is "detailSurface" or "recordForm" ? SurfaceContext.Page : scope).Within(node);

        var opened = new SurfaceContext(node.Kind, DeclaredClauseCount(node, nodes), implicitClauses, node.Kind,
            scope.InsideTabGroup || node.Kind == "tabGroup");
        RequireFilterBudget(node, opened, 0, null, diagnostics);
        return opened;
    }

    /// <summary>
    /// One field a command sets. The value is validated but never resolved here:
    /// today and now become concrete at execution, so a compiled definition stays
    /// deterministic and its digest does not move with the clock.
    /// </summary>
    private static void ValidateCommandStep(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var fieldId = ReadRequiredString(node, "fieldId", "NUI281", diagnostics);
        if (RefuseCalculatedQueryField(node, "fieldId", fieldId, derived, "assign to it", diagnostics)) return;
        var valueKind = ReadRequiredString(node, "valueKind", "NUI282", diagnostics);
        if (valueKind is not null && !NendoSemanticVocabulary.ValueKinds.Contains(valueKind))
        {
            AddError(diagnostics, "NUI283", $"Value kind '{valueKind}' is not supported.", node.NodeId, "valueKind",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.ValueKinds.OrderBy(value => value, StringComparer.Ordinal))}.");
            return;
        }
        if (fieldId is null || valueKind is null) return;
        if (!fields.TryGetValue(fieldId, out var field))
        {
            AddError(diagnostics, "NUI284", $"Field '{fieldId}' does not exist or is retired.", node.NodeId, "fieldId", "Set an active field of the command's record type.");
            return;
        }

        var hasValue = node.Properties.TryGetValue("value", out var value);
        switch (valueKind)
        {
            case "literal" when !hasValue:
                AddError(diagnostics, "NUI285", "The step has no value to assign.", node.NodeId, "value", "Declare the literal this step assigns.");
                break;
            case "literal":
                ValidateLiteral(node, field, value, diagnostics);
                if (field.Options.Count > 0 &&
                    (value.ValueKind != JsonValueKind.String || !field.Options.Contains(value.GetString() ?? string.Empty, StringComparer.Ordinal)))
                    AddError(diagnostics, "NUI286", "The value is outside the field's declared choices.", node.NodeId, "value", "Use one of the ordered field choices.");
                break;
            case "today" when field.StorageKind is not (NendoStorageKind.Date or NendoStorageKind.DateTime):
                AddError(diagnostics, "NUI287", "today can only be assigned to a date field.", node.NodeId, "valueKind", "Assign today to a Date or DateTime field.");
                break;
            case "now" when field.StorageKind != NendoStorageKind.DateTime:
                AddError(diagnostics, "NUI287", "now can only be assigned to a datetime field.", node.NodeId, "valueKind", "Assign now to a DateTime field.");
                break;
            case "null" when field.Required:
                AddError(diagnostics, "NUI288", "A required field cannot be cleared.", node.NodeId, "valueKind", "Clear an optional field, or assign a value.");
                break;
            default:
                if (valueKind != "literal" && hasValue)
                    AddError(diagnostics, "NUI289", $"'{valueKind}' does not take a value.", node.NodeId, "value", "Remove the value, or use a literal.");
                break;
        }
    }

    /// <summary>
    /// A filter clause is one ANDed comparison against one active field of the
    /// record type it is declared on. Operator, value kind and literal type all
    /// come from the closed vocabulary; anything else is a diagnostic.
    /// </summary>
    private static void ValidateFilterClause(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var fieldId = ReadRequiredString(node, "fieldId", "NUI270", diagnostics);
        var comparison = ReadRequiredString(node, "operator", "NUI271", diagnostics);
        // A calculated field filters as a stored field of its result type does (F-222): the host
        // works out the records it could match first, within a published bound.
        var calculated = fieldId is not null && derived.TryGetValue(fieldId, out var derivedField) ? derivedField : null;
        if (calculated is null && fieldId is not null && !fields.TryGetValue(fieldId, out _))
            AddError(diagnostics, "NUI272", $"Filter field '{fieldId}' does not exist or is retired.", node.NodeId, "fieldId", "Filter on an active field of this record type.");
        if (calculated is not null && (comparison == "descendantOf" ||
            (comparison == "contains" && calculated.ResultType != NendoBehaviourScalar.Text)))
            RefuseCalculatedQueryField(node, "fieldId", fieldId, derived, $"take '{comparison}' on it", diagnostics);
        if (comparison is not null && !NendoSemanticVocabulary.FilterOperators.Contains(comparison))
            AddError(diagnostics, "NUI273", $"Filter operator '{comparison}' is not supported.", node.NodeId, "operator",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.FilterOperators.OrderBy(value => value, StringComparer.Ordinal))}.");

        var valueKind = node.Properties.TryGetValue("valueKind", out var declared) && declared.ValueKind == JsonValueKind.String
            ? declared.GetString() ?? "literal"
            : "literal";
        if (node.Properties.ContainsKey("valueKind") && !NendoSemanticVocabulary.ValueKinds.Contains(valueKind))
        {
            AddError(diagnostics, "NUI274", $"Value kind '{valueKind}' is not supported.", node.NodeId, "valueKind",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.ValueKinds.OrderBy(value => value, StringComparer.Ordinal))}.");
            return;
        }

        var presenceOnly = comparison is "isNull" or "isNotNull";
        var hasValue = node.Properties.TryGetValue("value", out var value);
        if (presenceOnly)
        {
            if (hasValue)
                AddError(diagnostics, "NUI275", $"'{comparison}' does not take a value.", node.NodeId, "value", "Remove the value, or use a comparing operator.");
            return;
        }
        if (valueKind == "literal" && !hasValue)
        {
            AddError(diagnostics, "NUI276", "The filter has no value to compare.", node.NodeId, "value", "Declare a literal value, or use isNull or isNotNull.");
            return;
        }
        if (valueKind == "literal" && fieldId is not null && fields.TryGetValue(fieldId, out var field))
            ValidateLiteral(node, field, value, diagnostics);
        else if (valueKind == "literal" && calculated is not null)
            ValidateLiteral(node, new NendoFieldSnapshot(calculated.FieldId, calculated.DisplayName,
                Storage.SqliteNendoStore.KindOf(calculated.ResultType), false, null, []), value, diagnostics);
    }

    /// <summary>A literal must match the storage kind it is compared against.</summary>
    private static void ValidateLiteral(
        NendoUiNodeSnapshot node,
        NendoFieldSnapshot field,
        JsonElement value,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var matches = field.StorageKind switch
        {
            NendoStorageKind.Boolean => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            NendoStorageKind.Integer => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
            NendoStorageKind.Decimal => value.ValueKind == JsonValueKind.Number,
            NendoStorageKind.Date or NendoStorageKind.DateTime or NendoStorageKind.Uuid
                or NendoStorageKind.Text or NendoStorageKind.Reference => value.ValueKind == JsonValueKind.String,
            _ => false,
        };
        if (!matches)
            AddError(diagnostics, "NUI277",
                $"The value does not match the {field.StorageKind} field it is compared against.",
                node.NodeId, "value", $"Declare a {field.StorageKind} literal.");
    }

    private static void ValidateOrdering(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (node.Properties.TryGetValue("orderByFieldId", out var orderBy))
        {
            var fieldId = orderBy.ValueKind == JsonValueKind.String ? orderBy.GetString() : null;
            // A calculated field sorts too (F-222), in the order the host works out before the page.
            if ((fieldId is null || !derived.ContainsKey(fieldId)) && (fieldId is null || !fields.ContainsKey(fieldId)))
                AddError(diagnostics, "NUI278", "The ordering field does not exist or is retired.", node.NodeId, "orderByFieldId", "Order by an active field of the listed record type.");
        }
        if (node.Properties.TryGetValue("orderDirection", out var direction))
        {
            var name = direction.ValueKind == JsonValueKind.String ? direction.GetString() : null;
            if (name is null || !NendoSemanticVocabulary.OrderDirections.Contains(name))
                AddError(diagnostics, "NUI279", "The ordering direction is not supported.", node.NodeId, "orderDirection", "Use ascending or descending.");
        }
    }

    private static IEnumerable<NendoSurfaceNodePlan> DescendantBindings(IReadOnlyList<NendoSurfaceNodePlan> nodes) =>
        DescendantKinds(nodes, "fieldBinding");

    /// <summary>
    /// Checks <c>visibleWhen</c>: it names a Boolean calculated field of the record
    /// type this node is in.
    /// <para>
    /// A stored Boolean is refused deliberately. A stored flag somebody can type into
    /// is a field, and hiding a field behind another field's value is a form rule this
    /// contract does not define; what P8 adds is a read-only consumer of a calculation.
    /// </para>
    /// </summary>
    private static void ValidateVisibility(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.TryGetValue("visibleWhen", out var raw)) return;
        var fieldId = raw.ValueKind == JsonValueKind.String ? raw.GetString() : null;
        if (fieldId is null || !derived.TryGetValue(fieldId, out var calculation))
        {
            AddError(diagnostics, "NUI330",
                $"'{fieldId ?? raw.GetRawText()}' is not a calculated field of this record type.",
                node.NodeId, "visibleWhen",
                "Name a calculated field that produces a yes-or-no answer. Visibility reads a calculation, not a stored value.");
            return;
        }
        if (calculation.ResultType != NendoBehaviourScalar.Boolean)
            AddError(diagnostics, "NUI331",
                $"Calculated field '{fieldId}' produces {calculation.ResultType.ToString().ToLowerInvariant()}, and visibility needs a yes-or-no answer.",
                node.NodeId, "visibleWhen",
                "Use a calculation whose result type is Boolean.");
    }

    /// <summary>
    /// Checks <c>opens</c> (ADR-0004, 2026-09-20 amendment): one of the closed words,
    /// and never on a tab's body, where the tab strip already answers what a fold
    /// would ask. Every section folds; this is only how it starts.
    /// </summary>
    private static void ValidateOpens(
        NendoUiNodeSnapshot node,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (node.Kind != "section" || !node.Properties.TryGetValue("opens", out var raw)) return;
        var word = raw.ValueKind == JsonValueKind.String ? raw.GetString() : null;
        if (word is null || !NendoSemanticVocabulary.SectionOpens.Contains(word))
        {
            AddError(diagnostics, "NUI312",
                $"'{word ?? raw.GetRawText()}' is not a way a section can start.",
                node.NodeId, "opens",
                $"Use one of {string.Join(", ", NendoSemanticVocabulary.SectionOpens.OrderBy(value => value, StringComparer.Ordinal))}, or leave opens out to start open.");
            return;
        }
        if (scope.ParentKind == "tabGroup")
            AddError(diagnostics, "NUI313",
                "A tab's body cannot say how it starts: the tab strip already opens and closes it.",
                node.NodeId, "opens",
                "Remove opens from this section, or put it on a section inside the tab.");
    }

    private static string? BoundFieldId(NendoSurfaceNodePlan binding) =>
        binding.Properties.TryGetValue("fieldId", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>The calculated fields one record type shows, by stable field ID.</summary>
    private static IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> DerivedFieldsOf(NendoEntitySnapshot entity) =>
        entity.DerivedFields.ToDictionary(field => field.FieldId, StringComparer.Ordinal);

    /// <summary>
    /// Refuses a calculated field where a bounded query needs a stored one.
    /// <para>
    /// Grouping, ranking, totalling and placing a record on a calendar are decided by the
    /// database over every matching record, not by the page in view, and a calculated field
    /// has no column to read. Filtering and sorting are the exception (F-222): the host works
    /// out the records a query could match first, bounded, and hands SQL the result. A
    /// command step is refused for the opposite reason: there is nowhere to write the value to.
    /// </para>
    /// </summary>
    /// <param name="action">The verb phrase completing "this host cannot …".</param>
    private static bool RefuseCalculatedQueryField(
        NendoUiNodeSnapshot node,
        string property,
        string? fieldId,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        string action,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (fieldId is null || !derived.ContainsKey(fieldId)) return false;
        AddError(diagnostics, "NUI214",
            $"Field '{fieldId}' is calculated, so this host cannot {action}.",
            node.NodeId, property,
            "Name a stored field. A calculated field can be bound for display on the same surface, " +
            "and filtered or sorted by, but nothing writes to one and nothing groups, ranks or totals it.");
        return true;
    }

    private static IEnumerable<NendoSurfaceNodePlan> DescendantKinds(IReadOnlyList<NendoSurfaceNodePlan> nodes, string kind) =>
        nodes.SelectMany(node => node.Kind == kind ? [node] : DescendantKinds(node.Children, kind));

    /// <summary>
    /// A related list is the inverse of one configured reference. The named field
    /// must live on the related entity, be an active reference, and point back at
    /// the entity whose surface this is. Anything else is an arbitrary join and
    /// is refused.
    /// </summary>
    private static NendoEntitySnapshot? ResolveRelation(
        NendoUiNodeSnapshot node,
        NendoSessionSnapshot source,
        NendoEntitySnapshot entity,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var targetEntityId = ReadRequiredString(node, "targetEntityId", "NUI260", diagnostics);
        var viaFieldId = ReadRequiredString(node, "viaFieldId", "NUI261", diagnostics);
        if (targetEntityId is null || viaFieldId is null) return null;

        var target = source.Entities.SingleOrDefault(value => value.EntityId == targetEntityId && !value.Retired);
        if (target is null)
        {
            AddError(diagnostics, "NUI262", $"Related record type '{targetEntityId}' is missing or retired.", node.NodeId, "targetEntityId", "Reference an active stable record type.");
            return null;
        }

        var via = target.Fields.SingleOrDefault(field => field.FieldId == viaFieldId && !field.Retired);
        if (via is null || via.StorageKind != NendoStorageKind.Reference)
        {
            AddError(diagnostics, "NUI263", $"Field '{viaFieldId}' is not an active reference on '{targetEntityId}'.", node.NodeId, "viaFieldId", "Name the reference field that points back at this record type.");
            return null;
        }
        if (via.Reference is null || via.Reference.TargetEntityId != entity.EntityId)
        {
            AddError(diagnostics, "NUI266", $"Reference '{viaFieldId}' does not point at '{entity.EntityId}'.", node.NodeId, "viaFieldId", "A related list shows the inverse of a reference aimed at this record type.");
            return null;
        }
        return target;
    }

    private static NendoApplicationPlan WithComposableDigest(NendoApplicationPlan plan) => plan with
    {
        Digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            NendoRenderPlanJson.SerializeForDigest(NendoComposableApplicationPlanPayload.From(plan))))).ToLowerInvariant(),
    };
}
