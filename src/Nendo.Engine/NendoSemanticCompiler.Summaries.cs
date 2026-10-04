using System.Text.Json;

namespace Nendo.Engine;

// The summary and chart validators of contract version 3: filter budgets, tiles,
// lists, groupings, matrices and the date-ranged charts.
public sealed partial class NendoSemanticCompiler
{
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
        ValidateDateRangeBudget(node, nodes, scope, diagnostics);
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
        ValidateDateRangeBudget(node, nodes, scope, diagnostics);
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

    /// <summary>
    /// The scope and filter budget a date-ranged chart shares: its range spends the two date
    /// bounds, and a group-scoped one spends the column predicate as well.
    /// </summary>
    private static void ValidateDateRangeBudget(
        NendoUiNodeSnapshot node,
        IReadOnlyList<NendoUiNodeSnapshot> nodes,
        SurfaceContext scope,
        ICollection<NendoCompilerDiagnostic> diagnostics)
    {
        var groupScoped = ValidateSummaryScope(node, scope, diagnostics);
        RequireFilterBudget(node, scope, DeclaredClauseCount(node, nodes),
            groupScoped ? "column predicate and 2 date bounds" : "date bounds of its range",
            diagnostics, groupScoped ? 3 : 2);
    }

    /// <summary>A closed word set, in the order it is published, for a refusal that lists it.</summary>
    private static string Words(IReadOnlySet<string> values) =>
        string.Join(", ", values.OrderBy(value => value, StringComparer.Ordinal));

    private static string? BoardGroupingOf(NendoUiNodeSnapshot node, IReadOnlyList<NendoUiNodeSnapshot> nodes)
    {
        var parent = nodes.FirstOrDefault(candidate => candidate.NodeId == node.ParentNodeId && candidate.SurfaceId == node.SurfaceId);
        return parent is null ? null : NendoSemanticCapability.Tree.Text(parent, "groupByFieldId");
    }
}
