using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>How many rows a filter's function was asked about; a test reads it.</summary>
    internal long FilterCallbacks { get; private set; }

    /// <summary>How many sibling rows the tree read's seeks returned; a test reads it.</summary>
    internal long TreeRowsSought { get; private set; }

    /// <summary>
    /// The predicates every filtered read shares: the page, the count and each aggregate. A
    /// comparison becomes a deterministic function over the column; <c>descendantOf</c>
    /// (ADR-0019) becomes the record's membership of the named record's subtree in the declared
    /// hierarchy. The subtree is walked once per statement, so its cost is the subtree's size;
    /// since the 2026-10-16 amendment no size is refused.
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
                predicates.Add($"source_record.{Quote("__nendo_record_id")} IN ({SubtreeSql(entity, field, $"@filter{index}", $"subtree_{index}")})");
                parameters[$"@filter{index}"] = root;
                continue;
            }
            var function = $"{functionPrefix}_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) =>
                {
                    FilterCallbacks++;
                    return RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected);
                }, isDeterministic: true);
            var column = Quote(field.PhysicalColumnName);
            // The function stays the authority; beside it, where SQLite's own comparison gives the
            // same answer, a plain one an index can seek (PERF-02). Equality on text, a reference or
            // a date is ordinal, which is SQLite's; a UUID compares in either case (ESQ-17), so it
            // has none. Without it no index served a filter, the related list's reference index included.
            var seek = filter.Operator switch
            {
                "eq" when field.StorageKind is NendoStorageKind.Text or NendoStorageKind.Reference or NendoStorageKind.Date
                    => $"{column} = @filter{index} AND ",
                "isNull" => $"{column} IS NULL AND ",
                "isNotNull" => $"{column} IS NOT NULL AND ",
                _ => "",
            };
            predicates.Add($"({seek}{function}(CAST({column} AS TEXT), @filter{index}))");
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

    /// <summary>
    /// A window of a declared hierarchy in depth-first order (ADR-0019): the records under a root,
    /// or the whole tree from the top level, down to <paramref name="query"/>'s depth, each with
    /// its parent, depth and child count. Siblings follow the order field, unordered last, then
    /// record ID. Since the 2026-10-16 amendment a page resumes after the record the previous one
    /// ended on (<see cref="NendoTreeWalk"/>): the cursor names that record, bound to the change it
    /// was read at, so its ancestors are the same ones when the next page reads them. No subtree
    /// size is refused.
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
        var after = cursors.Decode(query.Cursor, manifest, scope);
        var table = Quote(entity.PhysicalTableName);
        var id = Quote("__nendo_record_id");
        var column = Quote(parent.PhysicalColumnName);
        var ordered = order is null ? null : Quote(order.PhysicalColumnName);

        if (query.RootRecordId is not null)
        {
            await using var exists = Command($"SELECT count(*) FROM {table} WHERE {id} = @root;", transaction);
            exists.Parameters.AddWithValue("@root", query.RootRecordId);
            if (Convert.ToInt64(await exists.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) == 0)
                throw new NendoPreconditionException("record-not-found", $"Record {query.RootRecordId} does not exist.");
        }

        IReadOnlyList<NendoTreeChild> chain = after is null ? [] : await TreeChainAsync(after);
        var steps = await NendoTreeWalk.CollectAsync(query.RootRecordId, query.Depth, query.Limit + 1, chain, SeekAsync, ct);
        var shown = steps.Take(query.Limit).ToArray();

        var (columns, references) = RecordColumns(entity, mappings);
        var read = new Dictionary<string, NendoRecordSnapshot>(StringComparer.Ordinal);
        if (shown.Length > 0)
        {
            var names = shown.Select((_, index) => $"@r{index}").ToArray();
            await using var page = Command(
                $"SELECT {string.Join(", ", columns)} FROM {table} source_record WHERE source_record.{id} IN ({string.Join(", ", names)});", transaction);
            for (var index = 0; index < shown.Length; index++) page.Parameters.AddWithValue(names[index], shown[index].RecordId);
            await using var reader = await page.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var record = ReadRecordRow(reader, entity, references);
                read[record.RecordId] = record;
            }
        }
        var next = steps.Count > query.Limit ? cursors.Encode(manifest, scope, shown[^1].RecordId) : null;
        var records = await WithKeptMarksAsync(await WithCalculationsAsync(shown.Select(step => read[step.RecordId]).ToArray(), mappings, transaction, ct), transaction, ct, entity.EntityId);
        var items = shown.Select((step, index) => new NendoTreeNode(records[index], step.ParentRecordId, step.Depth, step.ChildCount)).ToArray();
        return new(items, next, manifest.ChangeSequence);

        // The record a page ended on and its ancestors below the root, top first, with each one's
        // order: one indexed step a level. The cursor is signed and bound to the change it was read
        // at, so a chain that does not reach the root within the depth cannot come from this query.
        async Task<IReadOnlyList<NendoTreeChild>> TreeChainAsync(string last)
        {
            await using var up = Command($"""
                WITH RECURSIVE up(id, parent, ord, n) AS (
                  SELECT {id}, {column}, {ordered ?? "NULL"}, 1 FROM {table} WHERE {id} = @last
                  UNION ALL
                  SELECT t.{id}, t.{column}, {(ordered is null ? "NULL" : $"t.{ordered}")}, up.n + 1 FROM {table} t JOIN up ON t.{id} = up.parent
                  WHERE up.parent IS NOT @root AND up.n < @depth)
                SELECT id, parent, ord FROM up ORDER BY n DESC;
                """, transaction);
            up.Parameters.AddWithValue("@last", last);
            up.Parameters.AddWithValue("@root", (object?)query.RootRecordId ?? DBNull.Value);
            up.Parameters.AddWithValue("@depth", query.Depth);
            var found = new List<NendoTreeChild>();
            string? top = null;
            await using (var rows = await up.ExecuteReaderAsync(ct))
                while (await rows.ReadAsync(ct))
                {
                    if (found.Count == 0) top = rows.IsDBNull(1) ? null : rows.GetString(1);
                    found.Add(new(rows.GetString(0), rows.IsDBNull(2) ? null : rows.GetInt64(2), 0));
                }
            if (found.Count == 0 || top != query.RootRecordId)
                throw NendoQueryCursor.Invalid();
            return found;
        }

        // The children of one parent after one sibling, in sibling order, each with its child
        // count. With an order field, the ordered children come first by (order, ID) and the
        // unordered ones after them by ID, so each half is one range of the tree index
        // (parent, order, ID) that the declaration creates, or of the reference index (parent, ID).
        async Task<IReadOnlyList<NendoTreeChild>> SeekAsync(string? under, NendoTreeChild? from, int limit, CancellationToken cancellation)
        {
            var found = new List<NendoTreeChild>(limit);
            var level = under is null ? $"s.{column} IS NULL" : $"s.{column} = @parent";
            async Task ReadAsync(string where, string sort, int count)
            {
                await using var seek = Command($"""
                    SELECT s.{id}, {(ordered is null ? "NULL" : $"s.{ordered}")}, (SELECT count(*) FROM {table} c WHERE c.{column} = s.{id})
                    FROM {table} s WHERE {level}{where} ORDER BY {sort} LIMIT @limit;
                    """, transaction);
                if (under is not null) seek.Parameters.AddWithValue("@parent", under);
                if (from is { } previous)
                {
                    seek.Parameters.AddWithValue("@afterId", previous.RecordId);
                    seek.Parameters.AddWithValue("@afterOrder", (object?)previous.Order ?? DBNull.Value);
                }
                seek.Parameters.AddWithValue("@limit", count);
                await using var rows = await seek.ExecuteReaderAsync(cancellation);
                while (await rows.ReadAsync(cancellation))
                {
                    TreeRowsSought++;
                    found.Add(new(rows.GetString(0), rows.IsDBNull(1) ? null : rows.GetInt64(1), rows.GetInt32(2)));
                }
            }
            if (ordered is null)
            {
                await ReadAsync(from is null ? "" : $" AND s.{id} > @afterId", $"s.{id}", limit);
                return found;
            }
            if (from is not { Order: null })
                await ReadAsync(from is null ? $" AND s.{ordered} IS NOT NULL" : $" AND s.{ordered} IS NOT NULL AND (s.{ordered}, s.{id}) > (@afterOrder, @afterId)",
                    $"s.{ordered}, s.{id}", limit);
            if (found.Count < limit)
                await ReadAsync(from is { Order: null } ? $" AND s.{ordered} IS NULL AND s.{id} > @afterId" : $" AND s.{ordered} IS NULL",
                    $"s.{id}", limit - found.Count);
            return found;
        }
    }

    /// <summary>
    /// The children of one parent, or the top level, with their versions and orders: what a move
    /// places a record among (ADR-0019 point 5). One statement over the reference index, so its
    /// cost is the number of siblings, read from one change.
    /// </summary>
    internal async Task<IReadOnlyList<(string RecordId, long Version, long? Order)>> HierarchySiblingsAsync(
        string entityId, string? parentRecordId, CancellationToken ct)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, ct);
        var entity = (await ReadEntityMappingsAsync(transaction, ct)).SingleOrDefault(value => value.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var hierarchy = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy.");
        var column = Quote(entity.Fields.Single(field => field.FieldId == hierarchy.ParentFieldId).PhysicalColumnName);
        var order = hierarchy.OrderFieldId is { } orderId ? Quote(entity.Fields.Single(field => field.FieldId == orderId).PhysicalColumnName) : "NULL";
        await using var read = Command(
            $"SELECT {Quote("__nendo_record_id")}, {Quote("__nendo_record_version")}, {order} FROM {Quote(entity.PhysicalTableName)} " +
            $"WHERE {(parentRecordId is null ? $"{column} IS NULL" : $"{column} = @parent")};", transaction);
        if (parentRecordId is not null) read.Parameters.AddWithValue("@parent", parentRecordId);
        var siblings = new List<(string, long, long?)>();
        await using var rows = await read.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            siblings.Add((rows.GetString(0), rows.GetInt64(1), rows.IsDBNull(2) ? null : rows.GetInt64(2)));
        return siblings;
    }
}
