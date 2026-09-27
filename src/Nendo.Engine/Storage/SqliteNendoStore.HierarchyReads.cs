using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The predicates every filtered read shares: the page, the count and each aggregate. A
    /// comparison becomes a deterministic function over the column; <c>descendantOf</c>
    /// (ADR-0019) becomes the record's membership of the named record's subtree in the declared
    /// hierarchy, refused past <see cref="NendoHierarchyLimits.MaximumDescendants"/> rather
    /// than read slowly.
    /// </summary>
    private async Task AddFilterPredicatesAsync(EntityMapping entity, IReadOnlyList<NendoRecordFilter> filters, string functionPrefix,
        List<string> predicates, Dictionary<string, object> parameters, SqliteTransaction transaction, CancellationToken ct)
    {
        for (var index = 0; index < filters.Count; index++)
        {
            var filter = filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            if (filter.Operator == "descendantOf")
            {
                RequireHierarchyParent(entity, field);
                var root = filter.Value.GetString()!;
                await RequireSubtreeWithinBoundAsync(entity, field, root, transaction, ct);
                predicates.Add($"source_record.{Quote("__nendo_record_id")} IN ({SubtreeSql(entity, field, $"@filter{index}", $"subtree_{index}")})");
                parameters[$"@filter{index}"] = root;
                continue;
            }
            var function = $"{functionPrefix}_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }
    }

    private static void RequireHierarchyParent(EntityMapping entity, FieldMapping field)
    {
        if (entity.Hierarchy?.ParentFieldId != field.FieldId)
            throw new NendoPreconditionException("hierarchy-not-declared",
                $"descendantOf reads {entity.DisplayName}'s declared hierarchy, and {field.DisplayName} is not its parent field.");
    }

    /// <summary>A subquery of every record under <paramref name="rootParameter"/>, bounded by depth.</summary>
    private static string SubtreeSql(EntityMapping entity, FieldMapping parent, string rootParameter, string name)
    {
        var table = Quote(entity.PhysicalTableName);
        var column = Quote(parent.PhysicalColumnName);
        return $"""
            WITH RECURSIVE {name}(id, d) AS (
              SELECT {Quote("__nendo_record_id")}, 1 FROM {table} WHERE {column} = {rootParameter}
              UNION ALL
              SELECT n.{Quote("__nendo_record_id")}, {name}.d + 1 FROM {table} n JOIN {name} ON n.{column} = {name}.id
              WHERE {name}.d < {NendoHierarchyLimits.MaximumDepth})
            SELECT id FROM {name}
            """;
    }

    private async Task RequireSubtreeWithinBoundAsync(EntityMapping entity, FieldMapping parent, string root, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var count = Command($"SELECT count(*) FROM ({SubtreeSql(entity, parent, "@root", "bound")} LIMIT @limit);", transaction);
        count.Parameters.AddWithValue("@root", root);
        count.Parameters.AddWithValue("@limit", NendoHierarchyLimits.MaximumDescendants + 1);
        if (Convert.ToInt64(await count.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) > NendoHierarchyLimits.MaximumDescendants)
            throw new NendoPreconditionException("hierarchy-too-wide",
                $"More than {NendoHierarchyLimits.MaximumDescendants} records sit under {root}, which is more than one hierarchy read folds. Read a lower record's subtree.");
    }

    /// <summary>
    /// A window of a declared hierarchy in depth-first order (ADR-0019): the records under a root,
    /// or the whole tree from the top level, down to <paramref name="query"/>'s depth, each with
    /// its parent, depth and child count. Siblings follow the order field, unordered last, then
    /// record ID. The walk is refused past <see cref="NendoHierarchyLimits.MaximumDescendants"/>
    /// records; within it, pages are cut by position and bound to the change they were read at.
    /// </summary>
    internal async Task<NendoPage<NendoTreeNode>> TreeRecordsAsync(NendoTreeQuery query, NendoQueryCursor cursors, CancellationToken ct)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, ct);
        var manifest = await ReadManifestAsync(transaction, ct);
        var mappings = await ReadEntityMappingsAsync(transaction, ct);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var hierarchy = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy to read as a tree.");
        var parent = entity.Fields.Single(field => field.FieldId == hierarchy.ParentFieldId);
        var order = hierarchy.OrderFieldId is null ? null : entity.Fields.Single(field => field.FieldId == hierarchy.OrderFieldId);
        var scope = NendoWriteCoordinator.TreeScope(query);
        var offset = cursors.Decode(query.Cursor, manifest, scope) is { } after
            ? int.Parse(after, NumberStyles.None, CultureInfo.InvariantCulture) : 0;
        var table = Quote(entity.PhysicalTableName);
        var id = Quote("__nendo_record_id");
        var column = Quote(parent.PhysicalColumnName);

        if (query.RootRecordId is not null)
        {
            await using var exists = Command($"SELECT count(*) FROM {table} WHERE {id} = @root;", transaction);
            exists.Parameters.AddWithValue("@root", query.RootRecordId);
            if (Convert.ToInt64(await exists.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) == 0)
                throw new NendoPreconditionException("record-not-found", $"Record {query.RootRecordId} does not exist.");
        }

        // Each level adds a segment that sorts siblings as the hierarchy orders them, so the
        // concatenated path sorts the whole walk depth-first. char(1) ends a segment and sorts
        // below any record ID, which keeps a record's subtree ahead of its next sibling.
        string Segment(string alias)
        {
            var key = order is null ? "''" : $"""
                CASE WHEN {alias}.{Quote(order.PhysicalColumnName)} IS NULL THEN 'z'
                     WHEN {alias}.{Quote(order.PhysicalColumnName)} < 0 THEN 'a' || printf('%019d', 9223372036854775807 + {alias}.{Quote(order.PhysicalColumnName)})
                     ELSE 'b' || printf('%019d', {alias}.{Quote(order.PhysicalColumnName)}) END || char(2)
                """;
            return $"{key} || {alias}.{id} || char(1)";
        }
        var walk = $"""
            WITH RECURSIVE walk(id, d, path) AS (
              SELECT t.{id}, 1, {Segment("t")} FROM {table} t WHERE {(query.RootRecordId is null ? $"t.{column} IS NULL" : $"t.{column} = @root")}
              UNION ALL
              SELECT n.{id}, walk.d + 1, walk.path || {Segment("n")} FROM {table} n JOIN walk ON n.{column} = walk.id WHERE walk.d < @depth)
            """;

        await using (var bound = Command($"{walk} SELECT count(*) FROM (SELECT 1 FROM walk LIMIT @limit);", transaction))
        {
            if (query.RootRecordId is not null) bound.Parameters.AddWithValue("@root", query.RootRecordId);
            bound.Parameters.AddWithValue("@depth", query.Depth);
            bound.Parameters.AddWithValue("@limit", NendoHierarchyLimits.MaximumDescendants + 1);
            if (Convert.ToInt64(await bound.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) > NendoHierarchyLimits.MaximumDescendants)
                throw new NendoPreconditionException("hierarchy-too-wide",
                    $"More than {NendoHierarchyLimits.MaximumDescendants} records lie within {query.Depth} levels of {query.RootRecordId ?? "the top level"}. Read fewer levels or a lower record's subtree.");
        }

        var (columns, references) = RecordColumns(entity, mappings);
        var nodes = new List<(NendoRecordSnapshot Record, int Depth, int Children)>(query.Limit + 1);
        await using (var page = Command($"""
            {walk}
            SELECT {string.Join(", ", columns)}, walk.d,
                   (SELECT count(*) FROM {table} child WHERE child.{column} = source_record.{id})
            FROM walk JOIN {table} source_record ON source_record.{id} = walk.id
            ORDER BY walk.path LIMIT @limit OFFSET @offset;
            """, transaction))
        {
            if (query.RootRecordId is not null) page.Parameters.AddWithValue("@root", query.RootRecordId);
            page.Parameters.AddWithValue("@depth", query.Depth);
            page.Parameters.AddWithValue("@limit", query.Limit + 1);
            page.Parameters.AddWithValue("@offset", offset);
            await using var reader = await page.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                nodes.Add((ReadRecordRow(reader, entity, references), reader.GetInt32(columns.Count), reader.GetInt32(columns.Count + 1)));
        }
        var next = nodes.Count > query.Limit
            ? cursors.Encode(manifest, scope, (offset + query.Limit).ToString(CultureInfo.InvariantCulture)) : null;
        var shown = nodes.Take(query.Limit).ToArray();
        var records = await WithCalculationsAsync(shown.Select(node => node.Record).ToArray(), mappings, transaction, ct);
        var items = shown.Select((node, index) => new NendoTreeNode(records[index],
            records[index].Values.GetValueOrDefault(parent.FieldId) is { ValueKind: JsonValueKind.String } up ? up.GetString() : null,
            node.Depth, node.Children)).ToArray();
        return new(items, next, manifest.ChangeSequence);
    }
}
