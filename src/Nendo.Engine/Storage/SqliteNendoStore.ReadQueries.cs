using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<NendoPage<NendoStoredOperationSnapshot>> QueryRevisionOperationsAsync(
        NendoRevisionOperationsQuery query, NendoQueryCursor cursors, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var scope = NendoWriteCoordinator.OperationScope(query);
        var after = cursors.Decode(query.Cursor, manifest, scope);
        await using (var exists = Command("SELECT 1 FROM __nendo_revision WHERE revision_id = @revision;", transaction))
        {
            exists.Parameters.AddWithValue("@revision", query.RevisionId);
            if (await exists.ExecuteScalarAsync(cancellationToken) is null)
                throw new NendoPreconditionException("revision-not-found", "The requested revision does not exist.");
        }
        var items = new List<NendoStoredOperationSnapshot>(query.Limit + 1);
        var lastOrdinal = -1L;
        await using (var command = Command("""
            SELECT operation_id, operation_type, reversibility, canonical_json, ordinal
            FROM __nendo_operation WHERE revision_id = @revision AND ordinal > @after
            ORDER BY ordinal LIMIT @limit;
            """, transaction))
        {
            command.Parameters.AddWithValue("@revision", query.RevisionId);
            command.Parameters.AddWithValue("@after", after is null ? -1L : long.Parse(after, CultureInfo.InvariantCulture));
            command.Parameters.AddWithValue("@limit", query.Limit + 1);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                items.Add(new(reader.GetString(0), reader.GetString(1),
                    Enum.Parse<NendoReversibilityClass>(reader.GetString(2)), reader.GetString(3)));
                if (items.Count <= query.Limit) lastOrdinal = reader.GetInt64(4);
            }
        }
        return new(items.Take(query.Limit).ToArray(), items.Count > query.Limit
            ? cursors.Encode(manifest, scope, lastOrdinal.ToString(CultureInfo.InvariantCulture)) : null, manifest.ChangeSequence);
    }

    internal async Task<NendoPage<NendoRecordSnapshot>> QueryRecordsAsync(
        NendoRecordQuery query, NendoQueryCursor cursors, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var scope = NendoWriteCoordinator.RecordScope(query);
        var after = cursors.Decode(query.Cursor, manifest, scope);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings
            .SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var derived = await DerivedFieldsOfAsync(entity.EntityId, transaction, cancellationToken);
        ValidateRecordQuery(query, entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray(), derived);
        var selection = await SelectByCalculationAsync(entity, mappings, derived, query.Filters, query.SortFieldId, query.Descending,
            "nendo_query_calculated", transaction, cancellationToken);
        var (columns, references) = RecordColumns(entity, mappings);
        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        var id = Quote("__nendo_record_id");
        if (query.RecordId is not null)
        {
            predicates.Add($"{id} = @recordId COLLATE BINARY");
            parameters["@recordId"] = query.RecordId;
        }
        var direction = query.Descending ? "DESC" : "ASC";
        var comparison = query.Descending ? "<" : ">";
        var order = $"{id} COLLATE BINARY {direction}";
        if (selection?.RankFunction is { } rank)
        {
            // The order was worked out before the page; its direction is already in the rank.
            order = $"{rank}(source_record.{id}) ASC";
            if (after is not null) predicates.Add($"{rank}(source_record.{id}) > {rank}(@after)");
        }
        else if (query.SortFieldId is not null)
        {
            var field = entity.Fields.Single(f => f.FieldId == query.SortFieldId);
            var column = Quote(field.PhysicalColumnName);
            _connection.CreateCollation("NENDO_QUERY", (left, right) => RecordQuerySemantics.Compare(field.StorageKind, left, right));
            _connection.CreateFunction<string?, string?, int>("nendo_query_compare",
                (left, right) => RecordQuerySemantics.Compare(field.StorageKind, left, right), isDeterministic: true);
            order = $"CAST({column} AS TEXT) COLLATE NENDO_QUERY {direction}, {id} COLLATE BINARY ASC";
            if (after is not null)
            {
                var previous = $"(SELECT CAST({column} AS TEXT) FROM {Quote(entity.PhysicalTableName)} WHERE {id} = @after)";
                var compare = $"nendo_query_compare(CAST({column} AS TEXT), {previous})";
                predicates.Add($"({compare} {comparison} 0 OR ({compare} = 0 AND {id} > @after COLLATE BINARY))");
            }
        }
        else if (after is not null) predicates.Add($"{id} {comparison} @after COLLATE BINARY");
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_query_filter", predicates, parameters, transaction, cancellationToken);
        if (selection?.KeepPredicate is { } keep) predicates.Add(keep);
        // Only storage-owned mappings become identifiers. User values are parameters.
        var sql = $"SELECT {string.Join(", ", columns)} FROM {Quote(entity.PhysicalTableName)} source_record " +
            (predicates.Count == 0 ? string.Empty : $"WHERE {string.Join(" AND ", predicates)} ") +
            $"ORDER BY {order} LIMIT @limit;";
        var records = new List<NendoRecordSnapshot>(query.Limit + 1);
        await using (var command = Command(sql, transaction))
        {
            command.Parameters.AddWithValue("@limit", query.Limit + 1);
            if (after is not null) command.Parameters.AddWithValue("@after", after);
            foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) records.Add(ReadRecordRow(reader, entity, references));
        }
        var next = records.Count > query.Limit ? cursors.Encode(manifest, scope, records[query.Limit - 1].RecordId) : null;
        // The same calculations a full snapshot shows, computed the same way. Studio,
        // a custom surface and an agent read through different entry points and must
        // never disagree about what a calculated field currently is.
        var page = await WithKeptMarksAsync(await WithCalculationsAsync(
            records.Take(query.Limit).ToArray(), mappings, transaction, cancellationToken), transaction, cancellationToken, entity.EntityId);
        return new(page, next, manifest.ChangeSequence);
    }

    /// <summary>
    /// An exact count over the same predicates the page query uses. A summary
    /// tile must describe the whole filtered set, not the page in view, so this
    /// never takes a limit.
    /// </summary>
    internal async Task<NendoRecordCount> CountRecordsAsync(
        NendoRecordCountQuery query, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (manifest, mappings, entity, derived) = await OpenRecordQueryAsync(query.EntityId, query.Filters, transaction, cancellationToken);

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_count_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_count_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);

        var sql = $"SELECT COUNT(*) FROM {Quote(entity.PhysicalTableName)} source_record " +
            (predicates.Count == 0 ? string.Empty : $"WHERE {string.Join(" AND ", predicates)}") + ";";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);
        var count = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
        return new(entity.EntityId, count, manifest.ChangeSequence);
    }

    /// <summary>
    /// An exact numeric aggregate over the same predicates the page query uses.
    /// Like the count, it never takes a limit: a tile must describe the whole
    /// filtered set rather than the page in view. The fold happens in the host,
    /// one streamed row at a time, so memory stays constant and the stored
    /// decimal lexemes are read exactly.
    /// </summary>
    internal async Task<NendoRecordAggregate> AggregateRecordsAsync(
        NendoRecordAggregateQuery query, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (manifest, mappings, entity, derived) = await OpenRecordQueryAsync(query.EntityId, query.Filters, transaction, cancellationToken);

        var target = entity.Fields.SingleOrDefault(f => f.FieldId == query.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
        // A Date joins the numbers for min and max only (ADR-0004 2026-09-14
        // amendment, S4): the range of a set of civil dates is a comparison, while
        // a sum of them is not a question with an answer.
        var dateExtreme = target.StorageKind == NendoStorageKind.Date && query.Aggregate is "min" or "max";
        if (!dateExtreme && target.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
            throw new NendoValidationException(target.StorageKind == NendoStorageKind.Date
                ? "A date field has a smallest and a largest value, not a sum."
                : "Only an integer, decimal or date field can be aggregated.");

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_aggregate_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_aggregate_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);

        // An unset field contributes nothing, so it is excluded in SQL rather
        // than fetched and discarded. This predicate is always present, so the
        // WHERE clause is unconditional.
        predicates.Add($"{Quote(target.PhysicalColumnName)} IS NOT NULL");
        var sql = $"SELECT {Quote(target.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} source_record " +
            $"WHERE {string.Join(" AND ", predicates)};";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);

        var accumulator = new ExactAggregate(query.Aggregate, target.StorageKind == NendoStorageKind.Integer);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            if (reader.IsDBNull(0)) continue;
            if (dateExtreme) accumulator.AddDate(reader.GetValue(0)?.ToString() ?? string.Empty);
            else if (ExactAggregate.Read(reader.GetValue(0)) is { } value) accumulator.Add(value);
        }

        return new(entity.EntityId, query.Aggregate, query.FieldId,
            accumulator.Value(), accumulator.ContributingRecords, manifest.ChangeSequence);
    }

    /// <summary>
    /// The grouped form of <see cref="AggregateRecordsAsync"/>: one streamed scan of
    /// the grouping column and, for a numeric aggregate, the target column, folded
    /// into one bucket per group. Unset targets are read and skipped here rather
    /// than excluded in SQL, because a count must still see the row.
    /// </summary>
    internal async Task<NendoRecordGroupedAggregate> GroupAggregateRecordsAsync(
        NendoRecordGroupedAggregateQuery query, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (manifest, mappings, entity, derived) = await OpenRecordQueryAsync(query.EntityId, query.Filters, transaction, cancellationToken);

        var grouping = entity.Fields.SingleOrDefault(f => f.FieldId == query.GroupByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The grouping field does not exist on this record type.");
        var keys = GroupedAggregateFold.KeysOf(grouping.StorageKind, grouping.Presentation, grouping.Options);
        var target = AggregatedTarget(entity, query.FieldId);

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_group_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_group_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);

        var columns = target is null
            ? Quote(grouping.PhysicalColumnName)
            : $"{Quote(grouping.PhysicalColumnName)}, {Quote(target.PhysicalColumnName)}";
        var sql = $"SELECT {columns} FROM {Quote(entity.PhysicalTableName)} source_record" +
            (predicates.Count == 0 ? string.Empty : $" WHERE {string.Join(" AND ", predicates)}") + ";";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);

        var fold = new GroupedAggregateFold(keys, query.Aggregate, target?.StorageKind == NendoStorageKind.Integer);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = GroupedAggregateFold.KeyText(reader.IsDBNull(0) ? null : reader.GetValue(0), grouping.StorageKind);
            var value = target is null ? null : ExactAggregate.Read(reader.IsDBNull(1) ? null : reader.GetValue(1));
            fold.Add(key, value);
        }
        return fold.Result(query, manifest.ChangeSequence);
    }

    /// <summary>
    /// The same streamed fold over civil-date buckets (ADR-0004, 2026-09-16 amendment). The
    /// two bounds of the resolved range are predicates in the query rather than a filter the
    /// fold applies, so a record with no date, or one outside the range, never reaches the
    /// fold — which is why this result has no unset group and why a day grid over a leap
    /// year spends the published ceiling exactly rather than one short.
    /// </summary>
    internal async Task<NendoRecordDateBucketAggregate> BucketAggregateRecordsAsync(
        NendoRecordDateBucketQuery query, DateBuckets buckets, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (manifest, mappings, entity, derived) = await OpenRecordQueryAsync(query.EntityId, query.Filters, transaction, cancellationToken);

        var dateField = entity.Fields.SingleOrDefault(f => f.FieldId == query.DateFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The date field does not exist on this record type.");
        if (dateField.StorageKind != NendoStorageKind.Date)
            throw new NendoValidationException("Only a Date field buckets a grouped read by civil date.");
        var target = AggregatedTarget(entity, query.FieldId);

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_bucket_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_bucket_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);
        // The range itself, as the two predicates the compiler already charged the author for.
        predicates.Add($"{Quote(dateField.PhysicalColumnName)} >= @rangeStart");
        predicates.Add($"{Quote(dateField.PhysicalColumnName)} <= @rangeEnd");
        parameters["@rangeStart"] = buckets.Start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        parameters["@rangeEnd"] = buckets.End.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var columns = target is null
            ? Quote(dateField.PhysicalColumnName)
            : $"{Quote(dateField.PhysicalColumnName)}, {Quote(target.PhysicalColumnName)}";
        var sql = $"SELECT {columns} FROM {Quote(entity.PhysicalTableName)} source_record" +
            $" WHERE {string.Join(" AND ", predicates)};";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);

        var fold = new GroupedAggregateFold(buckets.Keys, query.Aggregate, target?.StorageKind == NendoStorageKind.Integer);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = buckets.KeyOf(reader.IsDBNull(0) ? null : Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture));
            var value = target is null ? null : ExactAggregate.Read(reader.IsDBNull(1) ? null : reader.GetValue(1));
            fold.Add(key, value);
        }
        return fold.Result(query, buckets, manifest.ChangeSequence);
    }

    /// <summary>
    /// The same streamed fold over the cross product of two closed groupings (ADR-0004,
    /// 2026-09-17 amendment). One scan of both grouping columns and, for a numeric
    /// aggregate, the target column: a grid costs one read whether it is four cells or two
    /// hundred, which is why every cell can state an exact number over everything the
    /// surface covers rather than over the page of records in view.
    /// </summary>
    internal async Task<NendoRecordCellAggregate> CellAggregateRecordsAsync(
        NendoRecordCellAggregateQuery query, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (manifest, mappings, entity, derived) = await OpenRecordQueryAsync(query.EntityId, query.Filters, transaction, cancellationToken);

        var rowField = entity.Fields.SingleOrDefault(f => f.FieldId == query.RowByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The row field does not exist on this record type.");
        var columnField = entity.Fields.SingleOrDefault(f => f.FieldId == query.ColumnByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The column field does not exist on this record type.");
        var rowKeys = GroupedAggregateFold.KeysOf(rowField.StorageKind, rowField.Presentation, rowField.Options);
        var columnKeys = GroupedAggregateFold.KeysOf(columnField.StorageKind, columnField.Presentation, columnField.Options);
        var target = AggregatedTarget(entity, query.FieldId);

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_cell_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_cell_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);

        var columns = $"{Quote(rowField.PhysicalColumnName)}, {Quote(columnField.PhysicalColumnName)}" +
            (target is null ? string.Empty : $", {Quote(target.PhysicalColumnName)}");
        var sql = $"SELECT {columns} FROM {Quote(entity.PhysicalTableName)} source_record" +
            (predicates.Count == 0 ? string.Empty : $" WHERE {string.Join(" AND ", predicates)}") + ";";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);

        var fold = new CellAggregateFold(rowKeys, columnKeys, query.Aggregate, target?.StorageKind == NendoStorageKind.Integer);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var rowKey = GroupedAggregateFold.KeyText(reader.IsDBNull(0) ? null : reader.GetValue(0), rowField.StorageKind);
            var columnKey = GroupedAggregateFold.KeyText(reader.IsDBNull(1) ? null : reader.GetValue(1), columnField.StorageKind);
            var value = target is null ? null : ExactAggregate.Read(reader.IsDBNull(2) ? null : reader.GetValue(2));
            fold.Add(rowKey, columnKey, value);
        }
        return fold.Result(query, manifest.ChangeSequence);
    }

    /// <summary>
    /// A record's columns as a read selects them, qualified by the <c>source_record</c> alias so
    /// a joined walk cannot shadow one: the ID, the version, every field, then each reference's
    /// label read from its target.
    /// </summary>
    private static (List<string> Columns, FieldMapping[] References) RecordColumns(EntityMapping entity, IReadOnlyList<EntityMapping> mappings)
    {
        var columns = new[] { Quote("__nendo_record_id"), Quote("__nendo_record_version") }
            .Concat(entity.Fields.Select(field => Quote(field.PhysicalColumnName)))
            .Select(column => $"source_record.{column}").ToList();
        var references = entity.Fields.Where(field => field.Reference is not null).ToArray();
        foreach (var field in references)
        {
            var target = mappings.Single(mapping => mapping.EntityId == field.Reference!.TargetEntityId);
            var label = target.Fields.Single(candidate => candidate.FieldId == field.Reference!.LabelFieldId);
            columns.Add($"(SELECT ref_target.{Quote(label.PhysicalColumnName)} FROM {Quote(target.PhysicalTableName)} ref_target WHERE ref_target.{Quote("__nendo_record_id")} = source_record.{Quote(field.PhysicalColumnName)})");
        }
        return (columns, references);
    }

    private static NendoRecordSnapshot ReadRecordRow(Microsoft.Data.Sqlite.SqliteDataReader reader, EntityMapping entity, FieldMapping[] references)
    {
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        for (var index = 0; index < entity.Fields.Count; index++)
            values[entity.Fields[index].FieldId] = ToJsonElement(
                reader.IsDBNull(index + 2) ? null : reader.GetValue(index + 2), entity.Fields[index].StorageKind);
        var labels = references.Select((field, index) => (field.FieldId, Value: reader.IsDBNull(2 + entity.Fields.Count + index) ? null : reader.GetString(2 + entity.Fields.Count + index)))
            .ToDictionary(pair => pair.FieldId, pair => pair.Value, StringComparer.Ordinal);
        return new(entity.EntityId, reader.GetString(0), reader.GetInt64(1), values) { ReferenceLabels = labels };
    }

    /// <summary>
    /// What an exact count or aggregate over one record type reads first, inside the
    /// caller's deferred transaction: the authority, the manifest, the mappings, the
    /// record type and its calculated fields, with the filters validated against them.
    /// </summary>
    private async Task<RecordQueryScope> OpenRecordQueryAsync(
        string entityId,
        IReadOnlyList<NendoRecordFilter> filters,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        var derived = await DerivedFieldsOfAsync(entity.EntityId, transaction, cancellationToken);
        ValidateRecordQuery(new NendoRecordQuery(entityId) { Filters = filters }, fields, derived);
        return new(manifest, mappings, entity, derived);
    }

    private sealed record RecordQueryScope(
        NendoManifestSnapshot Manifest,
        IReadOnlyList<EntityMapping> Mappings,
        EntityMapping Entity,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> Derived);

    /// <summary>The integer or decimal field a grouped read aggregates, or null when it counts.</summary>
    private static FieldMapping? AggregatedTarget(EntityMapping entity, string? fieldId)
    {
        if (fieldId is null) return null;
        var target = entity.Fields.SingleOrDefault(f => f.FieldId == fieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
        if (target.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
            throw new NendoValidationException("Only an integer or decimal field can be aggregated.");
        return target;
    }

    internal static void ValidateRecordQuery(NendoRecordQuery query, IReadOnlyList<NendoFieldSnapshot> fields,
        IReadOnlyDictionary<string, NendoDerivedFieldSnapshot>? derived = null)
    {
        derived ??= new Dictionary<string, NendoDerivedFieldSnapshot>();
        if (query.SortFieldId is not null && !derived.ContainsKey(query.SortFieldId) &&
            !fields.Any(f => f.FieldId == query.SortFieldId && f.StorageKind != NendoStorageKind.Unsupported))
            throw new NendoValidationException("The sort field is not a supported field of this record type.");
        foreach (var filter in query.Filters)
        {
            if (derived.TryGetValue(filter.FieldId, out var calculated))
            {
                // A calculated field is compared as a stored field of its result type would be.
                var kind = KindOf(calculated.ResultType);
                if (filter.Operator == "descendantOf" || (filter.Operator == "contains" && kind != NendoStorageKind.Text))
                    throw new NendoValidationException("This filter is not supported for the selected field type.");
                if (filter.Operator is not ("isNull" or "isNotNull"))
                    _ = ConvertValue(new(calculated.FieldId, query.EntityId, calculated.DisplayName, "", kind, false, null, []), filter.Value);
                continue;
            }
            var field = fields.SingleOrDefault(f => f.FieldId == filter.FieldId)
                ?? throw new NendoValidationException("The filter field does not belong to this record type.");
            if (field.StorageKind == NendoStorageKind.Unsupported || (filter.Operator == "contains" && field.StorageKind != NendoStorageKind.Text) ||
                (filter.Operator == "descendantOf" && field.StorageKind != NendoStorageKind.Reference))
                throw new NendoValidationException("This filter is not supported for the selected field type.");
            if (filter.Operator is not ("isNull" or "isNotNull" or "descendantOf"))
                _ = ConvertValue(new(field.FieldId, query.EntityId, field.DisplayName, "", field.StorageKind,
                    false, null, []), filter.Value);
        }
    }

    internal async Task<NendoPage<NendoRevisionSummary>> QueryHistoryAsync(
        NendoHistoryQuery query, NendoQueryCursor cursors, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var scope = NendoWriteCoordinator.HistoryScope(query);
        var after = cursors.Decode(query.Cursor, manifest, scope);
        var order = query.NewestFirst ? "DESC" : "ASC";
        var comparison = query.NewestFirst ? "<" : ">";
        var sql = $"""
            WITH page AS (
                SELECT * FROM __nendo_revision
                {(after is null ? string.Empty : $"WHERE change_sequence {comparison} @after")}
                ORDER BY change_sequence {order} LIMIT @limit
            )
            SELECT r.revision_id, r.created_at, r.origin, r.description, r.lane,
                r.definition_revision_before, r.definition_revision_after,
                r.data_revision_before, r.data_revision_after, r.change_sequence,
                r.operation_digest, r.proposal_id, r.proposal_digest, r.compensation_of_revision_id,
                COUNT(o.operation_id),
                -- Eligibility must match the operation TYPES CreateCompensationMutationAsync
                -- actually reverses, not the reversibility class. A ui.moveNode or
                -- general ui.removeNode is ReversibleWithRetainedState yet has no inverse, and a
                -- multi-operation revision is reversed only when every operation is a data
                -- write. A class-based flag offered a Compensate button the engine refused.
                -- A ui.setProperty is reversed only when it retained a prior value: the
                -- first value a property ever took has nothing to go back to, and the
                -- inverse refuses it, so the flag reads the same evidence the inverse does.
                CASE WHEN (r.compensation_of_revision_id IS NULL AND (
                    (COUNT(o.operation_id) = 1
                        AND MIN(CASE WHEN o.operation_type IN (
                            'data.setField', 'data.deleteRecord', 'data.backfillRetiredField',
                            'schema.setChoiceMetadata', 'schema.setRetired', 'schema.setFieldRequired',
                            'schema.renameEntity', 'schema.renameField',
                            'behaviour.setDefinition', 'behaviour.removeDefinition',
                            'ui.setProperty', 'application.setPurpose', 'application.setLook', 'schema.declareHierarchy', 'schema.removeHierarchy',
                            'application.setNewFileLabel', 'schema.setKeptInNewFiles', 'data.setKeptInNewFiles',
                            'extension.setPackage', 'extension.putFile', 'extension.removeFile', 'extension.removePackage')
                            OR (o.operation_type = 'ui.removeNode'
                                AND json_extract(o.inverse_evidence_json, '$.retainedSubtree[0].kind') IN ('extensionGraphSurface', 'extensionRecordsSurface', 'extensionView')
                                AND json_array_length(o.inverse_evidence_json, '$.retainedSubtree') BETWEEN 1 AND 16
                                -- The inverse restores a childless root only, so a view that
                                -- carried disclosed fields or filters is not offered it. Every
                                -- retained child row names its parent; evidence escapes a quote
                                -- inside a value as \u0022, so this text occurs only as a key.
                                AND instr(o.inverse_evidence_json, '"parentNodeId":"') = 0)
                            THEN 1 ELSE 0 END) = 1
                        AND MIN(CASE WHEN o.reversibility = 'IrreversibleDeclared' THEN 1 ELSE 0 END) = 0
                        AND MIN(CASE WHEN o.operation_type = 'ui.setProperty'
                            AND json_extract(o.inverse_evidence_json, '$.previousValuePresent') IS NOT 1
                            THEN 0 ELSE 1 END) = 1)
                    OR
                    -- A package and its files arrive together and are reversed together.
                    (COUNT(o.operation_id) BETWEEN 2 AND 128
                        AND MIN(CASE WHEN o.operation_type IN (
                            'extension.setPackage', 'extension.putFile', 'extension.removeFile', 'extension.removePackage')
                            THEN 1 ELSE 0 END) = 1)
                ))
                OR
                -- Record changes are reversed as a whole, creates and restores by a delete, and a
                -- compensation of record changes can be compensated again: redo (ADR-0023).
                (COUNT(o.operation_id) BETWEEN 1 AND 12800
                    AND MIN(CASE WHEN o.operation_type IN (
                        'data.setField', 'data.backfillRetiredField', 'data.deleteRecord',
                        'data.createRecord', 'data.restoreDeletedRecord') THEN 1 ELSE 0 END) = 1)
                THEN 1 ELSE 0 END
            FROM page r LEFT JOIN __nendo_operation o ON o.revision_id = r.revision_id
            GROUP BY r.revision_id ORDER BY r.change_sequence {order};
            """;
        var items = new List<NendoRevisionSummary>(query.Limit + 1);
        await using (var command = Command(sql, transaction))
        {
            command.Parameters.AddWithValue("@limit", query.Limit + 1);
            if (after is not null) command.Parameters.AddWithValue("@after", long.Parse(after, CultureInfo.InvariantCulture));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                items.Add(new(reader.GetString(0), ParseTimestamp(reader.GetString(1)), reader.GetString(2), reader.GetString(3),
                    Enum.Parse<NendoRevisionLane>(reader.GetString(4)), reader.GetInt64(5), reader.GetInt64(6),
                    reader.GetInt64(7), reader.GetInt64(8), reader.GetInt64(9), reader.GetString(10),
                    reader.IsDBNull(11) ? null : reader.GetString(11), reader.IsDBNull(12) ? null : reader.GetString(12),
                    reader.IsDBNull(13) ? null : reader.GetString(13), reader.GetInt64(14), reader.GetInt64(15) == 1));
            }
        }
        var next = items.Count > query.Limit ? cursors.Encode(manifest, scope,
            items[query.Limit - 1].ChangeSequence.ToString(CultureInfo.InvariantCulture)) : null;
        return new(items.Take(query.Limit).ToArray(), next, manifest.ChangeSequence);
    }
}
