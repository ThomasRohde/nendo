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
        foreach (var overview in fileScoped.Where(root => root.Properties.ContainsKey("entityId")))
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

        var overviewPlan = fileScoped
            .OrderBy(root => root.Position)
            .ThenBy(root => root.NodeId, StringComparer.Ordinal)
            .Select(root => CompileOverviewNode(root, nodes, source, SurfaceContext.Overview, diagnostics))
            .FirstOrDefault(node => node is not null);

        return HasErrors(diagnostics)
            ? Invalid(diagnostics)
            : new(true, OrderDiagnostics(diagnostics))
            {
                Applications = plans.AsReadOnly(),
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
            !DescendantKinds(children, "recentList").Any() && !DescendantKinds(children, "rankedList").Any())
            AddError(diagnostics, "NUI400", "The front page shows nothing.", node.NodeId, null,
                "Add a tile, a chart, a recent list or a ranking, each naming the record type it reads.");

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
        // The front page holds no records of its own, so a data revision changes
        // nothing about it and it travels through unchanged.
        return HasErrors(diagnostics)
            ? Invalid(diagnostics)
            : new(true, OrderDiagnostics(diagnostics)) { Applications = plans.AsReadOnly(), Overview = definition.Overview };
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
        if (node.Kind == NendoExtensionViewDefinition.NodeKind) ValidateExtensionView(node, source, diagnostics);

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

        var children = nodes
            .Where(value => value.ParentNodeId == node.NodeId && value.SurfaceId == node.SurfaceId)
            .OrderBy(value => value.Position)
            .ThenBy(value => value.NodeId, StringComparer.Ordinal)
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
    /// One effective-filter budget check. The composition and the ceiling both
    /// come from the published vocabulary, so the refusal cannot name a rule the
    /// description does not carry. A clause is never dropped and the query is
    /// never widened to fit.
    /// </summary>
    private static void RequireFilterBudget(
        NendoUiNodeSnapshot node,
        SurfaceContext scope,
        int ownClauses,
        string? extraPredicate,
        ICollection<NendoCompilerDiagnostic> diagnostics,
        int extraPredicateCount = 1)
    {
        var extra = extraPredicate is null ? 0 : extraPredicateCount;
        var effective = scope.DeclaredClauses + scope.ImplicitClauses + ownClauses + extra;
        if (effective <= NendoSemanticVocabulary.MaximumEffectiveFilters) return;

        var parts = new List<string>();
        if (scope.DeclaredClauses > 0) parts.Add($"{scope.DeclaredClauses} declared on the {scope.Kind}");
        if (ownClauses > 0) parts.Add($"{ownClauses} on this node");
        if (scope.ImplicitClauses > 0)
            parts.Add(scope.Kind is "calendarSurface" or "timelineSurface"
                ? $"{scope.ImplicitClauses} date bounds the host adds"
                : $"{scope.ImplicitClauses} reference predicate the host adds");
        if (extraPredicate is not null) parts.Add($"{extra} {extraPredicate} the host adds");

        AddError(diagnostics, "NUI300",
            $"This query composes {effective} effective filters, and one query carries at most {NendoSemanticVocabulary.MaximumEffectiveFilters}.",
            node.NodeId, "filterClause",
            $"It is {string.Join(" plus ", parts)}. Remove {effective - NendoSemanticVocabulary.MaximumEffectiveFilters} " +
            "filterClause child, or narrow the records with a stored field instead.");
    }

    /// <summary>
    /// A tile states one exact number over the whole filtered set. `count` needs
    /// no field; `sum`, `min` and `max` each read one integer or decimal field,
    /// resolved against the record type in context — so a tile inside a relation
    /// aggregates the related type, not the surface's own.
    /// <para>
    /// On a list or board the tile covers the records that surface shows, not the
    /// page in view. `scope` group narrows it to one board column and is accepted
    /// only on a direct child of a <c>boardSurface</c>: a tile nested deeper has
    /// no column to belong to, and searching upward for one would invent a
    /// grouping rule nothing published states.
    /// </para>
    /// </summary>
    private static void ValidateSummaryTile(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            groupScoped ? "column predicate" : null, diagnostics);

        ValidateAggregateReading(node, fields, derived, diagnostics);
    }

    /// <summary>
    /// Both ends of one field, from the two exact aggregates a summary tile
    /// already states one of. It has no grouping, so it is not a chart and spends
    /// no budget on one; a Date is accepted here and nowhere else, because the
    /// smallest and largest of a set of civil dates is a comparison and needs no
    /// arithmetic the exact-number rules would have to answer for.
    /// </summary>
    private static void ValidateRangeTile(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            groupScoped ? "column predicate" : null, diagnostics);

        var declared = ReadRequiredString(node, "fieldId", "NUI397", diagnostics);
        if (declared is null) return;
        if (RefuseCalculatedQueryField(node, "fieldId", declared, derived, "take a range of it", diagnostics)) return;
        if (!fields.TryGetValue(declared, out var field))
        {
            AddError(diagnostics, "NUI397", $"Field '{declared}' does not exist or is retired.", node.NodeId, "fieldId",
                "Name an active Integer, Decimal or Date field of this record type.");
            return;
        }
        if (field.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal or NendoStorageKind.Date))
            AddError(diagnostics, "NUI397",
                $"Field '{declared}' has no smallest and largest value to state.", node.NodeId, "fieldId",
                "A range reads an Integer, Decimal or Date field. A DateTime is refused for the reason a calendar refuses one: " +
                "its ends would depend on a time zone this contract version does not choose.");
    }

    /// <summary>
    /// The last few records of one type, on the front page. It is a list's ordered
    /// window with a stated ceiling, and it exists only where there is no record
    /// type in context: on a surface that has one, a list already does this and
    /// does it with a pager.
    /// </summary>
    private static void ValidateRecentList(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!scope.FileScoped)
            AddError(diagnostics, "NUI395", "A recentList belongs on the front page.", node.NodeId, "parentNodeId",
                "Use a recordList here: on a surface that already has a record type, a list shows the same records with a pager.");

        ValidateOrdering(node, fields, derived, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes), null, diagnostics);

        if (!node.Properties.TryGetValue("limit", out var limit)) return;
        if (limit.ValueKind != JsonValueKind.Number || !limit.TryGetInt32(out var rows) ||
            rows < 1 || rows > NendoSemanticVocabulary.MaximumRecentListRows)
            AddError(diagnostics, "NUI396",
                $"A recent list shows between 1 and {NendoSemanticVocabulary.MaximumRecentListRows} records.",
                node.NodeId, "limit",
                $"Declare a whole number from 1 to {NendoSemanticVocabulary.MaximumRecentListRows}, or leave limit out to show " +
                "the ceiling. It is refused rather than narrowed, so the stored definition and the screen cannot disagree.");
    }

    /// <summary>
    /// Where a board's columns come from (ADR-0004, 2026-09-17 amendment, S7). A
    /// single-choice field, whose options are written down in the definition, or a bound
    /// Reference field, whose columns are records of another record type.
    /// <para>
    /// The reference case is the first grouping in the product whose members are neither in
    /// the definition nor computed from a range, and that is why only half of its validation
    /// is here. What the definition can be held to — that the field exists, is active, is not
    /// calculated, and has a target type and a label to draw a heading with — is refused now.
    /// How many records that type holds is data, so the ceiling is a read-time rule and lives
    /// with the read.
    /// </para>
    /// </summary>
    private static void ValidateBoardGrouping(
        NendoUiNodeSnapshot node,
        NendoSessionSnapshot source,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupId = ReadRequiredString(node, "groupByFieldId", "NUI234", diagnostics);
        if (groupId is null) return;
        // Refused as a calculated field; a second complaint about the choice or reference
        // field it is not would name the wrong problem.
        if (RefuseCalculatedQueryField(node, "groupByFieldId", groupId, derived, "group by it", diagnostics)) return;
        if (!fields.TryGetValue(groupId, out var grouping))
        {
            AddError(diagnostics, "NUI236", "The board needs an active bounded choice field or a bound reference.",
                node.NodeId, "groupByFieldId",
                "Select a single-choice field on this entity, or a Reference field whose target type and label are configured.");
            return;
        }

        if (grouping.StorageKind == NendoStorageKind.Reference)
        {
            // An unbound reference has no target type to read columns from and no label field
            // to put in a heading. Binding one is a reviewed proposal of its own, so this names
            // that rather than repeating the choice-field diagnostic, which would send an author
            // looking for the wrong fix.
            if (grouping.Reference is null)
            {
                AddError(diagnostics, "NUI237",
                    $"Reference field '{groupId}' has no target record type, so it has no columns.",
                    node.NodeId, "groupByFieldId",
                    "Configure the reference's target record type and label field in Structure, then group the board by it.");
                return;
            }
            var target = source.Entities.SingleOrDefault(value => value.EntityId == grouping.Reference.TargetEntityId && !value.Retired);
            if (target is null)
            {
                AddError(diagnostics, "NUI238",
                    $"Record type '{grouping.Reference.TargetEntityId}' is missing or retired, so '{groupId}' has no columns.",
                    node.NodeId, "groupByFieldId", "Point the reference at an active record type, or group the board by another field.");
                return;
            }
            if (!target.Fields.Any(field => field.FieldId == grouping.Reference.LabelFieldId && !field.Retired))
                AddError(diagnostics, "NUI239",
                    $"Label field '{grouping.Reference.LabelFieldId}' is missing or retired on '{target.EntityId}', so the columns have no headings.",
                    node.NodeId, "groupByFieldId", "Choose an active text field on the target record type as the reference's label.");
            return;
        }

        if (grouping.Presentation != "singleChoice" || grouping.Options.Count == 0)
            AddError(diagnostics, "NUI236", "The board needs an active bounded choice field or a bound reference.",
                node.NodeId, "groupByFieldId",
                "Select a single-choice field on this entity, or a Reference field whose target type and label are configured.");
    }

    /// <summary>
    /// Two crossed closed groupings (ADR-0004, 2026-09-17 amendment). Neither axis is a
    /// filter, so a matrix spends none of the budget on its grouping, and the pair must be
    /// two different fields: a field against itself is a diagonal with empty corners, which
    /// states nothing a breakdown chart does not state better.
    /// </summary>
    private static void ValidateMatrixSurface(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var rowId = ValidateMatrixAxis(node, "rowByFieldId", "NUI410", "rows", fields, derived, diagnostics);
        var columnId = ValidateMatrixAxis(node, "columnByFieldId", "NUI411", "columns", fields, derived, diagnostics);

        if (rowId is not null && columnId is not null && string.Equals(rowId, columnId, StringComparison.Ordinal))
        {
            AddError(diagnostics, "NUI412", "A matrix crosses two different fields.", node.NodeId, "columnByFieldId",
                "A field against itself fills one diagonal and leaves every other cell empty. Use a breakdownChart to " +
                "state one field's groups, or name a second field here.");
            return;
        }

        if (rowId is null || columnId is null ||
            !fields.TryGetValue(rowId, out var rowField) || !fields.TryGetValue(columnId, out var columnField)) return;

        // The ceiling is spent on the cross product, and the same refusal the read would
        // raise is raised here first: an author finds out while building rather than a
        // person finding out while reading.
        var rows = AxisKeyCount(rowField);
        var columns = AxisKeyCount(columnField);
        var cells = (long)(rows + 1) * (columns + 1);
        if (cells > NendoSemanticVocabulary.MaximumAggregateGroups)
            AddError(diagnostics, "NUI413",
                $"This grid is {rows + 1} rows by {columns + 1} columns, which is {cells} cells; one grouped read answers " +
                $"at most {NendoSemanticVocabulary.MaximumAggregateGroups}.",
                node.NodeId, "rowByFieldId",
                "The unset lane on each axis is one row and one column of that total. Cross two fields with fewer options, " +
                "or narrow one of them with a filterClause on the axis field, which removes its column as well as its records.");
    }

    /// <summary>One axis of a matrix: the grouping rule a chart already uses, named for its side.</summary>
    private static string? ValidateMatrixAxis(
        NendoUiNodeSnapshot node,
        string property,
        string code,
        string side,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var fieldId = ReadRequiredString(node, property, code, diagnostics);
        if (fieldId is null) return null;
        if (RefuseCalculatedQueryField(node, property, fieldId, derived, "group by it", diagnostics)) return null;
        if (!fields.TryGetValue(fieldId, out var field) || !IsChartGrouping(field))
        {
            AddError(diagnostics, code, $"The matrix needs an active single-choice or Boolean field for its {side}.",
                node.NodeId, property,
                "Its values are the closed set the cells are crossed from, so only a field whose values are written down can be an axis.");
            return null;
        }
        return fieldId;
    }

    /// <summary>
    /// Whether a field's values are a closed set a grouping can be built from: a
    /// single-choice field with options, or a Boolean's two. The same rule the breakdown
    /// chart applies, so a matrix axis and a chart grouping cannot drift apart.
    /// </summary>
    private static bool IsChartGrouping(NendoFieldSnapshot field) =>
        field.StorageKind == NendoStorageKind.Boolean || (field.Presentation == "singleChoice" && field.Options.Count > 0);

    /// <summary>How many lanes an axis field contributes, before its unset lane.</summary>
    private static int AxisKeyCount(NendoFieldSnapshot field) =>
        field.StorageKind == NendoStorageKind.Boolean ? 2 : field.Options.Count;

    /// <summary>
    /// The few records at the top of one stored number (ADR-0004, 2026-09-17 amendment).
    /// It is a recentList ordered by size rather than by recency, and it lives where a
    /// recent list lives, for the same reason: on a surface that already has a record type,
    /// a list shows the same records with a pager.
    /// </summary>
    private static void ValidateRankedList(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!scope.FileScoped)
            AddError(diagnostics, "NUI422", "A rankedList belongs on the front page.", node.NodeId, "parentNodeId",
                "Use a recordList here, ordered by the same field: on a surface that already has a record type, a list " +
                "shows the same records with a pager.");

        // The predicate that keeps records with a number is one the host adds, so the
        // author carries seven rather than eight, and the refusal says which one it is.
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            "predicate keeping the records that have a number to rank", diagnostics);

        ValidateRankField(node, fields, derived, diagnostics);

        if (node.Properties.TryGetValue("orderDirection", out var direction))
        {
            var declared = direction.ValueKind == JsonValueKind.String ? direction.GetString() : null;
            if (declared is null || !NendoSemanticVocabulary.OrderDirections.Contains(declared))
                AddError(diagnostics, "NUI424", $"'{declared ?? direction.GetRawText()}' is not an order direction.",
                    node.NodeId, "orderDirection",
                    $"Use one of: {Words(NendoSemanticVocabulary.OrderDirections)}. Without it a ranking is largest first.");
        }

        if (!node.Properties.TryGetValue("limit", out var limit)) return;
        if (limit.ValueKind != JsonValueKind.Number || !limit.TryGetInt32(out var rows) ||
            rows < 1 || rows > NendoSemanticVocabulary.MaximumRankedListRows)
            AddError(diagnostics, "NUI421",
                $"A ranked list ranks between 1 and {NendoSemanticVocabulary.MaximumRankedListRows} records.",
                node.NodeId, "limit",
                $"Declare a whole number from 1 to {NendoSemanticVocabulary.MaximumRankedListRows}, or leave limit out to " +
                "rank the ceiling. It is refused rather than narrowed, so the stored definition and the screen cannot disagree.");
    }

    /// <summary>
    /// The number a ranking is by. A Date is refused by name, and it is the one place a
    /// Date is refused where a rangeTile accepts one: min and max over a Date are
    /// comparisons, and a bar proportional to a date is a bar proportional to nothing.
    /// </summary>
    private static void ValidateRankField(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var fieldId = ReadRequiredString(node, "rankByFieldId", "NUI420", diagnostics);
        if (fieldId is null) return;
        if (RefuseCalculatedQueryField(node, "rankByFieldId", fieldId, derived, "rank by it", diagnostics)) return;
        if (!fields.TryGetValue(fieldId, out var field))
        {
            AddError(diagnostics, "NUI420", $"Field '{fieldId}' is not an active field of this record type.",
                node.NodeId, "rankByFieldId", "Name a stored Integer or Decimal field of the record type this ranking reads.");
            return;
        }
        if (field.StorageKind is NendoStorageKind.Integer or NendoStorageKind.Decimal) return;
        AddError(diagnostics, "NUI420",
            field.StorageKind == NendoStorageKind.Date
                ? $"'{field.DisplayName}' is a Date, and a ranking draws a bar proportional to the largest value."
                : $"'{field.DisplayName}' is not a number, and a ranking ranks by one.",
            node.NodeId, "rankByFieldId",
            field.StorageKind == NendoStorageKind.Date
                ? "A rangeTile states both ends of a Date by comparison; a bar is arithmetic, so a ranking needs an Integer or a Decimal."
                : "Name a stored Integer or Decimal field.");
    }

    /// <summary>
    /// The aggregate a tile or chart states and the field it reads. Shared, so a
    /// breakdown chart cannot accept a number a summary tile would refuse.
    /// </summary>
    private static void ValidateAggregateReading(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var aggregate = ReadRequiredString(node, "aggregate", "NUI290", diagnostics);
        if (aggregate is null) return;

        if (NendoSemanticVocabulary.RefusedAggregates.TryGetValue(aggregate, out var reason))
        {
            AddError(diagnostics, "NUI292", $"Aggregate '{aggregate}' is refused by this host. {reason}", node.NodeId, "aggregate",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.Aggregates.OrderBy(value => value, StringComparer.Ordinal))}.");
            return;
        }

        if (!NendoSemanticVocabulary.Aggregates.Contains(aggregate))
        {
            AddError(diagnostics, "NUI291", $"Aggregate '{aggregate}' is not supported by this host.", node.NodeId, "aggregate",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.Aggregates.OrderBy(value => value, StringComparer.Ordinal))}.");
            return;
        }

        var declared = node.Properties.TryGetValue("fieldId", out var raw) && raw.ValueKind == JsonValueKind.String
            ? raw.GetString()
            : null;

        if (!NendoSemanticVocabulary.NumericAggregates.Contains(aggregate))
        {
            if (declared is not null)
                AddError(diagnostics, "NUI295", $"'{aggregate}' counts records and does not read a field.", node.NodeId, "fieldId",
                    "Remove fieldId, or use sum, min or max.");
            return;
        }

        if (declared is null)
        {
            AddError(diagnostics, "NUI293", $"'{aggregate}' needs the field it aggregates.", node.NodeId, "fieldId",
                "Set fieldId to an active integer or decimal field of this record type.");
            return;
        }

        if (RefuseCalculatedQueryField(node, "fieldId", declared, derived, "total it", diagnostics)) return;

        if (!fields.TryGetValue(declared, out var field))
        {
            AddError(diagnostics, "NUI294", $"Field '{declared}' does not exist or is retired.", node.NodeId, "fieldId",
                "Set an active field of the record type this tile covers.");
            return;
        }

        if (field.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
            AddError(diagnostics, "NUI294", $"Field '{declared}' is not a number, so '{aggregate}' cannot read it.", node.NodeId, "fieldId",
                "Aggregate an integer or decimal field.");
    }

    /// <summary>
    /// A breakdown chart (ADR-0004, 2026-09-14 amendment, S1): one exact number per
    /// group of a closed grouping, over the records its scope covers. The scope, the
    /// filter budget, the aggregate and the field it reads follow a summary tile's
    /// rules exactly; what is its own is the grouping field, which must be an active
    /// single-choice or Boolean field, and which is not a filter.
    /// </summary>
    private static void ValidateBreakdownChart(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes), groupScoped ? "column predicate" : null, diagnostics);
        ValidateAggregateReading(node, fields, derived, diagnostics);

        var groupId = ReadRequiredString(node, "groupByFieldId", "NUI350", diagnostics);
        if (groupId is null) return;
        if (RefuseCalculatedQueryField(node, "groupByFieldId", groupId, derived, "break numbers down by it", diagnostics)) return;
        if (!fields.TryGetValue(groupId, out var field))
            AddError(diagnostics, "NUI350", $"Field '{groupId}' does not exist or is retired.", node.NodeId, "groupByFieldId",
                "Break the numbers down by an active single-choice or Boolean field of this record type.");
        else if (field.StorageKind != NendoStorageKind.Boolean && (field.Presentation != "singleChoice" || field.Options.Count == 0))
            AddError(diagnostics, "NUI350", $"Field '{groupId}' is {HeaderShape(field)}, so it cannot group a chart.", node.NodeId, "groupByFieldId",
                "Break the numbers down by a single-choice or Boolean field: the groups of a chart are closed, and only those two kinds close them.");
        else if (groupScoped && BoardGroupingOf(node, nodes) == groupId)
            AddError(diagnostics, "NUI352", $"Field '{groupId}' is the board's own grouping, so every column would break down into itself.",
                node.NodeId, "groupByFieldId",
                "Break a column down by a second choice field, or use scope surface to break the whole board down by this one.");
    }

    /// <summary>
    /// One exact number per month or per week of a resolved range (ADR-0004 2026-09-16
    /// amendment, S5). Two rules are particular to it and both come from the groups being
    /// generated rather than declared: the range is a closed word, never a date, so the
    /// stored definition cannot go stale; and the host adds the two bounds of that range to
    /// the effective filter budget, so an author gets two fewer clauses than elsewhere and
    /// the refusal says which two it lost them to.
    /// </summary>
    private static void ValidateTrendChart(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            groupScoped ? "column predicate and 2 date bounds" : "date bounds of its range",
            diagnostics, groupScoped ? 3 : 2);
        ValidateAggregateReading(node, fields, derived, diagnostics);
        ValidateBucketDate(node, "NUI354", "charts a trend", "carry a trend", fields, derived, diagnostics);

        var bucket = ReadRequiredString(node, "bucket", "NUI355", diagnostics);
        if (bucket is not null && !NendoSemanticVocabulary.TrendBuckets.Contains(bucket))
            AddError(diagnostics, "NUI355", $"'{bucket}' is not a bucket a trend is divided into.", node.NodeId, "bucket",
                $"Use one of: {Words(NendoSemanticVocabulary.TrendBuckets)}. A day bucket over a year is an activityGrid, which draws it as squares.");

        var range = ReadRequiredString(node, "range", "NUI356", diagnostics);
        if (range is not null && !NendoSemanticVocabulary.TrendRanges.Contains(range))
            AddError(diagnostics, "NUI356", $"'{range}' is not a range a trend covers.", node.NodeId, "range",
                $"Use one of: {Words(NendoSemanticVocabulary.TrendRanges)}. The host resolves the word to civil-date bounds each time it reads, so a stored date is neither needed nor accepted.");
    }

    /// <summary>
    /// One exact count per day of a year, drawn as toned squares. It counts, so it takes no
    /// aggregate and no field to read: a square toned by a sum is a heat map of a number a
    /// person cannot recover from the square. Its ranges are the two year-shaped ones,
    /// because a day grid spends the published group ceiling and a leap year meets it exactly.
    /// </summary>
    private static void ValidateActivityGrid(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            groupScoped ? "column predicate and 2 date bounds" : "date bounds of its range",
            diagnostics, groupScoped ? 3 : 2);
        ValidateBucketDate(node, "NUI357", "draws an activity grid", "carry an activity grid", fields, derived, diagnostics);

        var range = ReadRequiredString(node, "range", "NUI358", diagnostics);
        if (range is not null && !NendoSemanticVocabulary.ActivityRanges.Contains(range))
            AddError(diagnostics, "NUI358", $"'{range}' is not a range an activity grid covers.", node.NodeId, "range",
                $"Use one of: {Words(NendoSemanticVocabulary.ActivityRanges)}. A grid draws one square per day, so only a year-shaped range fits the {NendoSemanticVocabulary.MaximumAggregateGroups}-group ceiling.");
    }

    /// <summary>
    /// The date field both over-time kinds bucket by: active, stored and a Date. A DateTime
    /// is refused by name here as it is on a calendar and a timeline, because truncating one
    /// to its date means choosing a time zone, which this contract version does not define.
    /// </summary>
    private static void ValidateBucketDate(
        NendoUiNodeSnapshot node,
        string code,
        string places,
        string verb,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var dateFieldId = ReadRequiredString(node, "dateFieldId", code, diagnostics);
        if (dateFieldId is null) return;
        if (RefuseCalculatedQueryField(node, "dateFieldId", dateFieldId, derived, "bucket records by it", diagnostics)) return;
        RequireActiveDateField(node, "dateFieldId", dateFieldId, fields, code, places, verb, diagnostics);
    }

    /// <summary>A closed word set, in the order it is published, for a refusal that lists it.</summary>
    private static string Words(IReadOnlySet<string> values) =>
        string.Join(", ", values.OrderBy(value => value, StringComparer.Ordinal));

    private static string? BoardGroupingOf(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes)
    {
        var parent = nodes.FirstOrDefault(candidate => candidate.NodeId == node.ParentNodeId && candidate.SurfaceId == node.SurfaceId);
        return parent is null ? null : NendoSemanticCapability.Tree.Text(parent, "groupByFieldId");
    }

    /// <summary>
    /// A progress ring: the records matching its own clauses over the records its
    /// scope covers. A ring with no clause narrows nothing and would always be full,
    /// so it is refused rather than drawn.
    /// </summary>
    private static void ValidateProgressTile(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var clauses = DeclaredClauseCount(node, nodes);
        RequireFilterBudget(node, scope, clauses, null, diagnostics);
        if (clauses == 0)
            AddError(diagnostics, "NUI360", "The progress ring narrows nothing, so it would always be full.", node.NodeId, null,
                "Add at least one filterClause child: the ring shows the records matching them over everything its surface shows.");
    }

    /// <summary>
    /// A calendar places each record on one civil date. This first slice takes a
    /// Date field only: a DateTime carries a time and an offset, and putting one
    /// on a month grid means choosing a time zone to group by. That needs its own
    /// contract change, so the refusal names it rather than guessing UTC.
    /// </summary>
    private static void ValidateCalendarBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var dateFieldId = ReadRequiredString(node, "dateFieldId", "NUI320", diagnostics);
        if (dateFieldId is null) return;
        if (RefuseCalculatedQueryField(node, "dateFieldId", dateFieldId, derived, "place records on a calendar by it", diagnostics)) return;
        RequireActiveDateField(node, "dateFieldId", dateFieldId, fields, "NUI321",
            "places records on a calendar", "place a record on a calendar", diagnostics);
    }

    /// <summary>
    /// The shape rule a calendar and a timeline share: the field must be an active
    /// Date. The refusal names a DateTime rather than guessing UTC, because
    /// placing one on a civil date means choosing a time zone to group by.
    /// </summary>
    private static bool RequireActiveDateField(
        NendoUiNodeSnapshot node,
        string propertyName,
        string fieldId,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        string code,
        string places,
        string verb,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!fields.TryGetValue(fieldId, out var field))
        {
            AddError(diagnostics, code, $"Field '{fieldId}' does not exist or is retired.", node.NodeId, propertyName,
                "Set an active Date field of this record type.");
            return false;
        }
        if (field.StorageKind == NendoStorageKind.DateTime)
        {
            AddError(diagnostics, code,
                $"Field '{fieldId}' is a DateTime, and this host {places} by Date only.",
                node.NodeId, propertyName,
                "Use a Date field. A DateTime needs a declared time zone to group by, which this contract version does not define.");
            return false;
        }
        if (field.StorageKind != NendoStorageKind.Date)
        {
            AddError(diagnostics, code,
                $"Field '{fieldId}' is a {field.StorageKind}, so it cannot {verb}.",
                node.NodeId, propertyName, "Set an active Date field of this record type.");
            return false;
        }
        return true;
    }

    /// <summary>
    /// A timeline, ADR-0004 2026-09-14 amendment (S3): each record on a spine by one
    /// civil date, with an optional end date that turns the entry into a span, a
    /// stored Text field that titles it and a single-choice field that tones its
    /// dot. The date rule is the calendar's and the title and accent rules are the
    /// record page's, shared rather than copied; each is refused by name rather than
    /// drawn as an empty entry.
    /// </summary>
    private static void ValidateTimelineBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var dateFieldId = ReadRequiredString(node, "dateFieldId", "NUI370", diagnostics);
        if (dateFieldId is not null &&
            !RefuseCalculatedQueryField(node, "dateFieldId", dateFieldId, derived, "place records on a timeline by it", diagnostics))
            RequireActiveDateField(node, "dateFieldId", dateFieldId, fields, "NUI371",
                "places records on a timeline", "place a record on a timeline", diagnostics);

        if (node.Properties.ContainsKey("endDateFieldId"))
        {
            var endDateFieldId = HeaderField(node, "endDateFieldId");
            if (endDateFieldId is null)
                AddError(diagnostics, "NUI372", "The end date must name a field.", node.NodeId, "endDateFieldId",
                    "Set the fieldId of an active Date field, or remove endDateFieldId.");
            else if (endDateFieldId == dateFieldId)
                AddError(diagnostics, "NUI372", "The end date repeats the start date.", node.NodeId, "endDateFieldId",
                    "End each span at a different Date field, or remove endDateFieldId.");
            else if (!RefuseCalculatedQueryField(node, "endDateFieldId", endDateFieldId, derived, "end a span by it", diagnostics))
                RequireActiveDateField(node, "endDateFieldId", endDateFieldId, fields, "NUI372",
                    "ends a span", "end a span", diagnostics);
        }

        ValidateTitleField(node, fields, derived, EntryTitle, diagnostics);
        ValidateAccentField(node, fields, derived, EntryAccent, diagnostics);
    }

    /// <summary>
    /// A gallery, ADR-0004 2026-09-14 amendment (S2): a card per record over exactly a
    /// list's window. Both field roles are the record page's rules with card wording, and
    /// both are optional — a card without a declared title leads with its first bound
    /// field, as a timeline entry does, so a gallery card and a board card are titled by
    /// one rule rather than two.
    /// </summary>
    private static void ValidateGalleryBinding(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        ValidateTitleField(node, fields, derived, CardTitle, diagnostics);
        ValidateAccentField(node, fields, derived, CardAccent, diagnostics);
    }

    /// <summary>
    /// The record-page header, ADR-0004 2026-09-14 amendment (S0). Three optional
    /// properties on a <c>detailSurface</c>: the stored Text field that heads the
    /// page, a field shown under it, and the single-choice field whose option's tone
    /// colours it. Each is refused by name rather than drawn as an empty band: a page
    /// headed by a choice, or coloured by a date, is a definition nobody meant.
    /// </summary>
    private static void ValidateRecordPageHeader(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var title = HeaderField(node, "titleFieldId");
        ValidateTitleField(node, fields, derived, PageTitle, diagnostics);

        if (node.Properties.ContainsKey("subtitleFieldId"))
        {
            var subtitle = HeaderField(node, "subtitleFieldId");
            if (subtitle is null)
                AddError(diagnostics, "NUI341", "The page subtitle must name a field.", node.NodeId, "subtitleFieldId",
                    "Set the fieldId of an active field, or remove subtitleFieldId.");
            else if (!fields.ContainsKey(subtitle) && !derived.ContainsKey(subtitle))
                AddError(diagnostics, "NUI341", $"Field '{subtitle}' does not exist or is retired.", node.NodeId, "subtitleFieldId",
                    "Set the fieldId of an active stored or calculated field of this record type.");
            else if (subtitle == title)
                AddError(diagnostics, "NUI341", "The subtitle repeats the title.", node.NodeId, "subtitleFieldId",
                    "Show a different field under the title, or remove subtitleFieldId.");
        }

        ValidateAccentField(node, fields, derived, PageAccent, diagnostics);
    }

    /// <summary>
    /// What a field-role refusal says depends on what the role does: a title heads
    /// a page or titles an entry, an accent colours a page or an entry. The rule is
    /// one; the wording names the surface a person will see.
    /// </summary>
    private sealed record FieldRoleWording(string Code, string Subject, string Verb, string CalculatedHint, string ShapeHint);

    private static readonly FieldRoleWording PageTitle = new("NUI340", "The page title", "head the page",
        "Head the page with a stored Text field, and bind the calculated field inside the page instead.",
        "Head the page with a stored Text field. A choice can colour the page through accentFieldId instead.");

    private static readonly FieldRoleWording EntryTitle = new("NUI373", "The entry title", "title each entry",
        "Title each entry with a stored Text field, and bind the calculated field on the timeline instead.",
        "Title each entry with a stored Text field. A choice can tone each entry's dot through accentFieldId instead.");

    private static readonly FieldRoleWording PageAccent = new("NUI342", "The page accent", "colour the page",
        "Colour the page by a stored single-choice field whose options carry tones.",
        "Colour the page by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    private static readonly FieldRoleWording CardTitle = new("NUI380", "The card title", "title each card",
        "Title each card with a stored Text field, and bind the calculated field on the gallery instead.",
        "Title each card with a stored Text field. A choice can tone each card's edge through accentFieldId instead.");

    private static readonly FieldRoleWording CardAccent = new("NUI381", "The card accent", "colour each card",
        "Colour each card by a stored single-choice field whose options carry tones.",
        "Colour each card by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    private static readonly FieldRoleWording EntryAccent = new("NUI374", "The entry accent", "colour each entry",
        "Colour each entry by a stored single-choice field whose options carry tones.",
        "Colour each entry by a single-choice field; each option's tone is set with schema.setChoiceMetadata.");

    /// <summary>A stored Text field that is not a single choice, when the property is present at all.</summary>
    private static void ValidateTitleField(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        FieldRoleWording wording,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.ContainsKey("titleFieldId")) return;
        var title = HeaderField(node, "titleFieldId");
        if (title is null)
            AddError(diagnostics, wording.Code, $"{wording.Subject} must name a field.", node.NodeId, "titleFieldId",
                "Set the fieldId of an active Text field, or remove titleFieldId.");
        else if (derived.ContainsKey(title))
            AddError(diagnostics, wording.Code, $"Field '{title}' is calculated, so it cannot {wording.Verb}.", node.NodeId, "titleFieldId",
                wording.CalculatedHint);
        else if (!fields.TryGetValue(title, out var field))
            AddError(diagnostics, wording.Code, $"Field '{title}' does not exist or is retired.", node.NodeId, "titleFieldId",
                "Set the fieldId of an active Text field of this record type.");
        else if (field.StorageKind != NendoStorageKind.Text || field.Presentation == "singleChoice")
            AddError(diagnostics, wording.Code, $"Field '{title}' is {HeaderShape(field)}, so it cannot {wording.Verb}.", node.NodeId, "titleFieldId",
                wording.ShapeHint);
    }

    /// <summary>An active single-choice field, when the property is present at all.</summary>
    private static void ValidateAccentField(
        NendoUiNodeSnapshot node,
        IReadOnlyDictionary<string, NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        FieldRoleWording wording,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.ContainsKey("accentFieldId")) return;
        var accent = HeaderField(node, "accentFieldId");
        if (accent is null)
            AddError(diagnostics, wording.Code, $"{wording.Subject} must name a field.", node.NodeId, "accentFieldId",
                "Set the fieldId of an active single-choice field, or remove accentFieldId.");
        else if (derived.ContainsKey(accent))
            AddError(diagnostics, wording.Code, $"Field '{accent}' is calculated, so it cannot {wording.Verb}.", node.NodeId, "accentFieldId",
                wording.CalculatedHint);
        else if (!fields.TryGetValue(accent, out var field))
            AddError(diagnostics, wording.Code, $"Field '{accent}' does not exist or is retired.", node.NodeId, "accentFieldId",
                "Set the fieldId of an active single-choice field of this record type.");
        else if (field.Presentation != "singleChoice")
            AddError(diagnostics, wording.Code, $"Field '{accent}' is {HeaderShape(field)}, so it cannot {wording.Verb}.", node.NodeId, "accentFieldId",
                wording.ShapeHint);
    }

    private static string? HeaderField(NendoUiNodeSnapshot node, string propertyName) =>
        node.Properties.TryGetValue(propertyName, out var value) &&
        value.ValueKind == JsonValueKind.String &&
        !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()
            : null;

    private static string HeaderShape(NendoFieldSnapshot field) =>
        field.Presentation == "singleChoice" ? "a single choice" : $"a {field.StorageKind}";

    /// <summary>
    /// Whether the tile asks for one board column. The parent decides: `group` on
    /// anything but a direct <c>boardSurface</c> child is refused rather than
    /// resolved by an ancestor search.
    /// </summary>
    private static bool ValidateSummaryScope(
        NendoUiNodeSnapshot node,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        if (!node.Properties.TryGetValue("scope", out var raw)) return false;
        var declared = raw.ValueKind == JsonValueKind.String ? raw.GetString() : null;
        if (declared is null || !NendoSemanticVocabulary.SummaryScopes.Contains(declared))
        {
            AddError(diagnostics, "NUI296", $"Summary scope '{declared ?? raw.GetRawText()}' is not supported.",
                node.NodeId, "scope",
                $"Use one of: {string.Join(", ", NendoSemanticVocabulary.SummaryScopes.OrderBy(value => value, StringComparer.Ordinal))}. " +
                $"The default is {NendoSemanticVocabulary.DefaultSummaryScope}.");
            return false;
        }
        if (declared != "group") return false;
        if (scope.ParentKind == "boardSurface") return true;

        AddError(diagnostics, "NUI297",
            "A per-column summary belongs to a board column, and this tile is not a direct child of a board.",
            node.NodeId, "scope",
            "Declare scope group on a summaryTile whose parent is the boardSurface itself, or use scope " +
            $"{NendoSemanticVocabulary.DefaultSummaryScope} to count everything the surface shows.");
        return false;
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
        if (!RefuseCalculatedQueryField(node, "fieldId", fieldId, derived, "filter on it", diagnostics) &&
            fieldId is not null && !fields.TryGetValue(fieldId, out _))
            AddError(diagnostics, "NUI272", $"Filter field '{fieldId}' does not exist or is retired.", node.NodeId, "fieldId", "Filter on an active field of this record type.");
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
            if (!RefuseCalculatedQueryField(node, "orderByFieldId", fieldId, derived, "sort by it", diagnostics) &&
                (fieldId is null || !fields.ContainsKey(fieldId)))
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
    /// Sorting, filtering, grouping and placing a record on a calendar are decided
    /// by the database over every matching record, not by the page in view. A
    /// calculated field has no column to read, so honouring one of these would mean
    /// either computing the whole collection or quietly ordering the loaded page and
    /// calling it the collection's order. A command step is refused for the opposite
    /// reason: there is nowhere to write the value to.
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
            "but nothing writes to one and no bounded query reads one.");
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
