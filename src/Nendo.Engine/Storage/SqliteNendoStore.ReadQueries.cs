using System.Globalization;
using System.Text.Json;

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
        ValidateRecordQuery(query, entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray());
        var columns = new[] { Quote("__nendo_record_id"), Quote("__nendo_record_version") }
            .Concat(entity.Fields.Select(field => Quote(field.PhysicalColumnName))).ToList();
        var references = entity.Fields.Where(field => field.Reference is not null).ToArray();
        foreach (var field in references)
        {
            var target = mappings.Single(mapping => mapping.EntityId == field.Reference!.TargetEntityId);
            var label = target.Fields.Single(candidate => candidate.FieldId == field.Reference!.LabelFieldId);
            columns.Add($"(SELECT ref_target.{Quote(label.PhysicalColumnName)} FROM {Quote(target.PhysicalTableName)} ref_target WHERE ref_target.{Quote("__nendo_record_id")} = source_record.{Quote(field.PhysicalColumnName)})");
        }
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
        if (query.SortFieldId is not null)
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
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_query_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }
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
            while (await reader.ReadAsync(cancellationToken))
            {
                var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                for (var index = 0; index < entity.Fields.Count; index++)
                    values[entity.Fields[index].FieldId] = ToJsonElement(
                        reader.IsDBNull(index + 2) ? null : reader.GetValue(index + 2), entity.Fields[index].StorageKind);
                var labels = references.Select((field, index) => (field.FieldId, Value: reader.IsDBNull(2 + entity.Fields.Count + index) ? null : reader.GetString(2 + entity.Fields.Count + index)))
                    .ToDictionary(pair => pair.FieldId, pair => pair.Value, StringComparer.Ordinal);
                records.Add(new(entity.EntityId, reader.GetString(0), reader.GetInt64(1), values) { ReferenceLabels = labels });
            }
        }
        var next = records.Count > query.Limit ? cursors.Encode(manifest, scope, records[query.Limit - 1].RecordId) : null;
        // The same calculations a full snapshot shows, computed the same way. Studio,
        // a custom surface and an agent read through different entry points and must
        // never disagree about what a calculated field currently is.
        var page = await WithCalculationsAsync(
            records.Take(query.Limit).ToArray(), mappings, transaction, cancellationToken);
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
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        ValidateRecordQuery(new NendoRecordQuery(query.EntityId) { Filters = query.Filters }, fields);

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_count_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }

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
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        ValidateRecordQuery(new NendoRecordQuery(query.EntityId) { Filters = query.Filters }, fields);

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
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_aggregate_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }

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
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        ValidateRecordQuery(new NendoRecordQuery(query.EntityId) { Filters = query.Filters }, fields);

        var grouping = entity.Fields.SingleOrDefault(f => f.FieldId == query.GroupByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The grouping field does not exist on this record type.");
        var keys = GroupedAggregateFold.KeysOf(grouping.StorageKind, grouping.Presentation, grouping.Options);
        FieldMapping? target = null;
        if (query.FieldId is not null)
        {
            target = entity.Fields.SingleOrDefault(f => f.FieldId == query.FieldId)
                ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
            if (target.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
                throw new NendoValidationException("Only an integer or decimal field can be aggregated.");
        }

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_group_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }

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
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        ValidateRecordQuery(new NendoRecordQuery(query.EntityId) { Filters = query.Filters }, fields);

        var dateField = entity.Fields.SingleOrDefault(f => f.FieldId == query.DateFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The date field does not exist on this record type.");
        if (dateField.StorageKind != NendoStorageKind.Date)
            throw new NendoValidationException("Only a Date field buckets a grouped read by civil date.");
        FieldMapping? target = null;
        if (query.FieldId is not null)
        {
            target = entity.Fields.SingleOrDefault(f => f.FieldId == query.FieldId)
                ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
            if (target.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
                throw new NendoValidationException("Only an integer or decimal field can be aggregated.");
        }

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_bucket_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }
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
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var entity = mappings.SingleOrDefault(value => value.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var fields = entity.Fields.Select(f => new NendoFieldSnapshot(
            f.FieldId, f.DisplayName, f.StorageKind, f.Required, f.Presentation, f.Options)).ToArray();
        ValidateRecordQuery(new NendoRecordQuery(query.EntityId) { Filters = query.Filters }, fields);

        var rowField = entity.Fields.SingleOrDefault(f => f.FieldId == query.RowByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The row field does not exist on this record type.");
        var columnField = entity.Fields.SingleOrDefault(f => f.FieldId == query.ColumnByFieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The column field does not exist on this record type.");
        var rowKeys = GroupedAggregateFold.KeysOf(rowField.StorageKind, rowField.Presentation, rowField.Options);
        var columnKeys = GroupedAggregateFold.KeysOf(columnField.StorageKind, columnField.Presentation, columnField.Options);
        FieldMapping? target = null;
        if (query.FieldId is not null)
        {
            target = entity.Fields.SingleOrDefault(f => f.FieldId == query.FieldId)
                ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
            if (target.StorageKind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
                throw new NendoValidationException("Only an integer or decimal field can be aggregated.");
        }

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        for (var index = 0; index < query.Filters.Count; index++)
        {
            var filter = query.Filters[index];
            var field = entity.Fields.Single(f => f.FieldId == filter.FieldId);
            var function = $"nendo_cell_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(filter.Operator, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Operator is "isNull" or "isNotNull" ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, filter.Value);
        }

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

    internal static void ValidateRecordQuery(NendoRecordQuery query, IReadOnlyList<NendoFieldSnapshot> fields)
    {
        if (query.SortFieldId is not null && !fields.Any(f => f.FieldId == query.SortFieldId && f.StorageKind != NendoStorageKind.Unsupported))
            throw new NendoValidationException("The sort field is not a supported field of this record type.");
        foreach (var filter in query.Filters)
        {
            var field = fields.SingleOrDefault(f => f.FieldId == filter.FieldId)
                ?? throw new NendoValidationException("The filter field does not belong to this record type.");
            if (field.StorageKind == NendoStorageKind.Unsupported || (filter.Operator == "contains" && field.StorageKind != NendoStorageKind.Text))
                throw new NendoValidationException("This filter is not supported for the selected field type.");
            if (filter.Operator is not ("isNull" or "isNotNull"))
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
                CASE WHEN r.compensation_of_revision_id IS NULL AND (
                    (COUNT(o.operation_id) = 1
                        AND MIN(CASE WHEN o.operation_type IN (
                            'data.setField', 'data.deleteRecord', 'data.backfillRetiredField',
                            'schema.setChoiceMetadata', 'schema.setRetired', 'schema.setFieldRequired',
                            'schema.renameEntity', 'schema.renameField',
                            'behaviour.setDefinition', 'behaviour.removeDefinition',
                            'ui.setProperty', 'application.setPurpose')
                            OR (o.operation_type = 'ui.removeNode'
                                AND json_extract(o.inverse_evidence_json, '$.retainedSubtree[0].kind') = 'extensionGraphSurface'
                                AND json_array_length(o.inverse_evidence_json, '$.retainedSubtree') BETWEEN 1 AND 16)
                            THEN 1 ELSE 0 END) = 1
                        AND MIN(CASE WHEN o.reversibility = 'IrreversibleDeclared' THEN 1 ELSE 0 END) = 0
                        AND MIN(CASE WHEN o.operation_type = 'ui.setProperty'
                            AND json_extract(o.inverse_evidence_json, '$.previousValuePresent') IS NOT 1
                            THEN 0 ELSE 1 END) = 1)
                    OR
                    (COUNT(o.operation_id) BETWEEN 2 AND 128
                        AND MIN(CASE WHEN o.operation_type IN (
                            'data.setField', 'data.backfillRetiredField', 'data.deleteRecord') THEN 1 ELSE 0 END) = 1)
                ) THEN 1 ELSE 0 END
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
