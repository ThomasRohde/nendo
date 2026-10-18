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
        var ordinals = new List<long>(query.Limit + 1);
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
                ordinals.Add(reader.GetInt64(4));
                if (items.Count <= query.Limit) lastOrdinal = reader.GetInt64(4);
            }
        }
        var page = items.Take(query.Limit).ToArray();
        if (page.Length > 0)
        {
            var attribution = await ReadOperationAttributionAsync(
                query.RevisionId, ordinals[0], ordinals[page.Length - 1], transaction, cancellationToken);
            for (var index = 0; index < page.Length; index++)
            {
                if (attribution.TryGetValue((query.RevisionId, ordinals[index]), out var made))
                    page[index] = page[index] with { Attribution = made };
            }
            // Only a page that holds a record operation reads the record types.
            var targets = page.Select(item => RecordOf(item.CanonicalJson)).ToArray();
            var entities = targets.Any(target => target is not null)
                ? (await ReadEntityMappingsAsync(transaction, cancellationToken)).ToDictionary(entity => entity.EntityId, StringComparer.Ordinal)
                : new Dictionary<string, EntityMapping>(StringComparer.Ordinal);
            var labels = new Dictionary<(string Entity, string Record), string?>();
            for (var index = 0; index < page.Length; index++)
            {
                if (targets[index] is not { } target || !entities.TryGetValue(target.Entity, out var entity)) continue;
                if (!labels.TryGetValue(target, out var label))
                    labels[target] = label = await RecordLabelAsync(entity, target.Record, transaction, cancellationToken);
                if (label is not null) page[index] = page[index] with { RecordLabel = label };
            }
        }
        return new(page, items.Count > query.Limit
            ? cursors.Encode(manifest, scope, lastOrdinal.ToString(CultureInfo.InvariantCulture)) : null, manifest.ChangeSequence);
    }

    /// <summary>The record type and record a stored operation's payload names, directly or in its edit.</summary>
    private static (string Entity, string Record)? RecordOf(string canonicalJson)
    {
        try
        {
            using var document = JsonDocument.Parse(canonicalJson);
            if (!document.RootElement.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return null;
            var source = payload.TryGetProperty("edit", out var edit) && edit.ValueKind == JsonValueKind.Object ? edit : payload;
            return source.TryGetProperty("entityId", out var entity) && entity.ValueKind == JsonValueKind.String &&
                   source.TryGetProperty("recordId", out var record) && record.ValueKind == JsonValueKind.String
                ? (entity.GetString()!, record.GetString()!)
                : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// A record's label: its type's first active text field, from the row, or from the values its
    /// deletion kept when the row is gone. Cut to 120 characters, as a line of History is.
    /// </summary>
    private async Task<string?> RecordLabelAsync(EntityMapping entity, string recordId, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var field = entity.Fields.FirstOrDefault(candidate => candidate.StorageKind == NendoStorageKind.Text && !candidate.Retired);
        if (field is null || !await TableExistsAsync(entity.PhysicalTableName, transaction, cancellationToken)) return null;
        object? found;
        await using (var row = Command($"SELECT {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} WHERE __nendo_record_id = @record;", transaction))
        {
            row.Parameters.AddWithValue("@record", recordId);
            found = await row.ExecuteScalarAsync(cancellationToken);
        }
        if (found is null && await TableExistsAsync("__nendo_deleted_record", transaction, cancellationToken))
        {
            // Read in C# rather than through a JSON path, which a field ID holding a quote would
            // break, taking the whole page of operations down with it.
            await using var kept = Command("SELECT values_json FROM __nendo_deleted_record WHERE entity_id = @entity AND record_id = @record;", transaction);
            kept.Parameters.AddWithValue("@entity", entity.EntityId);
            kept.Parameters.AddWithValue("@record", recordId);
            if (await kept.ExecuteScalarAsync(cancellationToken) is string values)
            {
                try
                {
                    using var document = JsonDocument.Parse(values);
                    if (document.RootElement.ValueKind == JsonValueKind.Object &&
                        document.RootElement.TryGetProperty(field.FieldId, out var retained) && retained.ValueKind == JsonValueKind.String)
                        found = retained.GetString();
                }
                catch (JsonException) { found = null; }
            }
        }
        var text = found is string value ? value.Trim() : null;
        return string.IsNullOrEmpty(text) ? null : text.Length > 120 ? text[..120] + "…" : text;
    }

    /// <summary>
    /// Which automatic action made each generated operation, keyed by revision and ordinal:
    /// the attribution a save stores beside its operations, with the trigger's and the
    /// action's display names as the file holds them now. Every operation of a page, or of
    /// the whole history when <paramref name="revisionId"/> is null.
    /// <para>
    /// Stored since automatic actions were, and read by nothing but receipts until
    /// 2026-10-10, so History could not say which action made a change though Help said it
    /// recorded that. The names come straight from the definitions' bodies rather than
    /// through the codec, so reading History never depends on this host being able to run
    /// them; a definition no longer in the file leaves its name null and its ID stands.
    /// </para>
    /// </summary>
    private async Task<Dictionary<(string RevisionId, long Ordinal), NendoOperationAttribution>> ReadOperationAttributionAsync(
        string? revisionId, long firstOrdinal, long lastOrdinal, SqliteTransaction? transaction, CancellationToken cancellationToken)
    {
        var attribution = new Dictionary<(string RevisionId, long Ordinal), NendoOperationAttribution>();
        if (!await HasBehaviourAsync(transaction, cancellationToken)) return attribution;
        var rows = new List<(string RevisionId, long Ordinal, string TriggerId, string ActionId, string StepId,
            NendoRecordEventKind EventKind, string EventEntityId, string EventRecordId)>();
        await using (var command = Command($"""
            SELECT revision_id, ordinal, trigger_id, action_id, step_id, event_kind, event_entity_id, event_record_id
            FROM __nendo_attribution
            {(revisionId is null ? "" : "WHERE revision_id = @revision AND ordinal BETWEEN @first AND @last")};
            """, transaction))
        {
            if (revisionId is not null)
            {
                command.Parameters.AddWithValue("@revision", revisionId);
                command.Parameters.AddWithValue("@first", firstOrdinal);
                command.Parameters.AddWithValue("@last", lastOrdinal);
            }
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                rows.Add((reader.GetString(0), reader.GetInt64(1), reader.GetString(2), reader.GetString(3), reader.GetString(4),
                    Enum.Parse<NendoRecordEventKind>(reader.GetString(5), ignoreCase: false), reader.GetString(6), reader.GetString(7)));
            }
        }
        if (rows.Count == 0) return attribution;
        var names = await ReadTriggerAndActionNamesAsync(transaction, cancellationToken);
        foreach (var row in rows)
        {
            attribution[(row.RevisionId, row.Ordinal)] = new(
                row.TriggerId, names.GetValueOrDefault(row.TriggerId),
                row.ActionId, names.GetValueOrDefault(row.ActionId),
                row.StepId, row.EventKind, row.EventEntityId, row.EventRecordId);
        }
        return attribution;
    }

    private async Task<Dictionary<string, string>> ReadTriggerAndActionNamesAsync(
        SqliteTransaction? transaction, CancellationToken cancellationToken)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var command = Command(
            "SELECT definition_id, body_json FROM __nendo_behaviour WHERE definition_kind IN ('Trigger', 'Action');", transaction);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            try
            {
                using var body = JsonDocument.Parse(reader.GetString(1));
                if (body.RootElement.ValueKind == JsonValueKind.Object &&
                    body.RootElement.TryGetProperty("displayName", out var name) && name.ValueKind == JsonValueKind.String)
                    names[reader.GetString(0)] = name.GetString()!;
            }
            catch (JsonException)
            {
                // A body this host cannot read names nothing; History still shows the ID.
            }
        }
        return names;
    }

    internal async Task<NendoRecordRead> QueryRecordReadAsync(
        NendoRecordQuery query, NendoQueryCursor cursors, CancellationToken cancellationToken, NendoRecordWindowQuery? window = null)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var scope = NendoWriteCoordinator.RecordScope(query);
        var token = window is null ? null : RecordWindowSemantics.Token(window, cursors, manifest);
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
            // A reference sorts by its target's label, the text its cell shows, compared as the
            // label field's kind; a single choice in its options' order (ESQ-16).
            (EntityMapping Target, FieldMapping Field)? label = null;
            if (field.Reference is { } reference &&
                mappings.SingleOrDefault(mapping => mapping.EntityId == reference.TargetEntityId) is { } target &&
                target.Fields.SingleOrDefault(candidate => candidate.FieldId == reference.LabelFieldId) is { } labelField)
                label = (target, labelField);
            var sort = label is { } shown
                ? RecordQuerySemantics.SortComparison(shown.Field.StorageKind, null, [])
                : RecordQuerySemantics.SortComparison(field.StorageKind, field.Presentation, field.Options);
            string SortValue(string row) => label is { } named
                ? $"(SELECT CAST(sort_target.{Quote(named.Field.PhysicalColumnName)} AS TEXT) FROM {Quote(named.Target.PhysicalTableName)} sort_target WHERE sort_target.{id} = {row}.{column})"
                : $"CAST({row}.{column} AS TEXT)";
            _connection.CreateCollation("NENDO_QUERY", (left, right) => sort(left, right));
            _connection.CreateFunction<string?, string?, int>("nendo_query_compare", (left, right) => sort(left, right), isDeterministic: true);
            order = $"{SortValue("source_record")} COLLATE NENDO_QUERY {direction}, {id} COLLATE BINARY ASC";
            if (after is not null)
            {
                var previous = $"(SELECT {SortValue("sort_previous")} FROM {Quote(entity.PhysicalTableName)} sort_previous WHERE sort_previous.{id} = @after)";
                var compare = $"nendo_query_compare({SortValue("source_record")}, {previous})";
                predicates.Add($"({compare} {comparison} 0 OR ({compare} = 0 AND {id} > @after COLLATE BINARY))");
            }
        }
        else if (after is not null) predicates.Add($"{id} {comparison} @after COLLATE BINARY");
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_query_filter", predicates, parameters, transaction, cancellationToken);
        if (selection?.KeepPredicate is { } keep) predicates.Add(keep);
        // Only storage-owned mappings become identifiers. User values are parameters.
        var from = $"FROM {Quote(entity.PhysicalTableName)} source_record " +
            (predicates.Count == 0 ? string.Empty : $"WHERE {string.Join(" AND ", predicates)} ");
        var start = window?.Start ?? 0;
        int? located = null;
        if (window?.LocateRecordId is { } locatedRecordId)
        {
            // Rank IDs inside storage; no intervening records cross the service boundary.
            await using var locate = Command($"SELECT position FROM (SELECT {id} AS record_id, ROW_NUMBER() OVER (ORDER BY {order}) - 1 AS position {from}) WHERE record_id = @target;", transaction);
            foreach (var parameter in parameters) locate.Parameters.AddWithValue(parameter.Key, parameter.Value);
            locate.Parameters.AddWithValue("@target", locatedRecordId);
            var value = await locate.ExecuteScalarAsync(cancellationToken);
            if (value is long position) { located = checked((int)position); start = located.Value / query.Limit * query.Limit; }
            else start = 0; // A removed/filtered anchor cannot leave an empty far-away viewport.
        }
        var sql = $"SELECT {string.Join(", ", columns)} {from}ORDER BY {order} LIMIT @limit OFFSET @offset;";
        var records = new List<NendoRecordSnapshot>(query.Limit + 1);
        await using (var command = Command(sql, transaction))
        {
            command.Parameters.AddWithValue("@limit", query.Limit + 1);
            command.Parameters.AddWithValue("@offset", start);
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
        return new(new(page, next, manifest.ChangeSequence), start, token, located);
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

        // A calculated number is totalled over the same bounded read a calculated filter stands on,
        // each record's result exact, and refused whole if any record's could not be worked out (W-249).
        if (derived.TryGetValue(query.FieldId, out var calculated))
        {
            RequireCalculatedNumber(calculated);
            var totalled = new ExactAggregate(query.Aggregate, calculated.ResultType == NendoBehaviourScalar.Integer);
            foreach (var member in await CalculatedMembersAsync(entity, mappings, derived, query.Filters, "nendo_aggregate_members", transaction, cancellationToken))
                if (CalculatedContribution(member, calculated) is { } value) totalled.Add(value);
            return new(entity.EntityId, query.Aggregate, query.FieldId, totalled.Value(), totalled.ContributingRecords, manifest.ChangeSequence);
        }

        var target = entity.Fields.SingleOrDefault(f => f.FieldId == query.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
        var dateExtreme = RequireAggregatedField(target.StorageKind, query.Aggregate);

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
        // A reference groups by the records it points at, an open set read from the data and
        // labelled by the target's label field (W-249); every other grouping is closed.
        var open = grouping.StorageKind == NendoStorageKind.Reference;
        var calculated = query.FieldId is not null && derived.TryGetValue(query.FieldId, out var derivedTarget)
            ? RequireCalculatedNumber(derivedTarget) : null;
        var target = calculated is null ? AggregatedTarget(entity, query.FieldId) : null;
        var integral = calculated is not null ? calculated.ResultType == NendoBehaviourScalar.Integer : target?.StorageKind == NendoStorageKind.Integer;
        if (open && grouping.Reference is null)
            throw new NendoValidationException("A reference groups a breakdown only once its target record type and label are set.");
        var fold = open
            ? GroupedAggregateFold.Open(query.Aggregate, integral)
            : new GroupedAggregateFold(GroupedAggregateFold.KeysOf(grouping.StorageKind, grouping.Presentation, grouping.Options), query.Aggregate, integral);

        if (calculated is not null)
        {
            foreach (var member in await CalculatedMembersAsync(entity, mappings, derived, query.Filters, "nendo_group_members", transaction, cancellationToken))
            {
                var stored = member.Values.TryGetValue(query.GroupByFieldId, out var raw) ? GroupedAggregateFold.KeyText(raw) : null;
                fold.Add(stored, CalculatedContribution(member, calculated),
                    open && member.ReferenceLabels is { } labels && labels.TryGetValue(query.GroupByFieldId, out var memberLabel) ? memberLabel : null);
            }
            return fold.Result(query, manifest.ChangeSequence);
        }

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(query.Filters, derived), "nendo_group_filter", predicates, parameters, transaction, cancellationToken);
        if ((await SelectByCalculationAsync(entity, mappings, derived, query.Filters, null, false, "nendo_group_calculated", transaction, cancellationToken))?.KeepPredicate is { } keep)
            predicates.Add(keep);

        var columns = new List<string> { Quote(grouping.PhysicalColumnName) };
        if (target is not null) columns.Add(Quote(target.PhysicalColumnName));
        if (open)
        {
            var targetType = mappings.Single(mapping => mapping.EntityId == grouping.Reference!.TargetEntityId);
            var label = targetType.Fields.Single(candidate => candidate.FieldId == grouping.Reference!.LabelFieldId);
            columns.Add($"(SELECT ref_target.{Quote(label.PhysicalColumnName)} FROM {Quote(targetType.PhysicalTableName)} ref_target " +
                $"WHERE ref_target.{Quote("__nendo_record_id")} = source_record.{Quote(grouping.PhysicalColumnName)})");
        }
        var sql = $"SELECT {string.Join(", ", columns)} FROM {Quote(entity.PhysicalTableName)} source_record" +
            (predicates.Count == 0 ? string.Empty : $" WHERE {string.Join(" AND ", predicates)}") + ";";
        await using var command = Command(sql, transaction);
        foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var labelColumn = target is null ? 1 : 2;
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = GroupedAggregateFold.KeyText(reader.IsDBNull(0) ? null : reader.GetValue(0), grouping.StorageKind);
            var value = target is null ? null : ExactAggregate.Read(reader.IsDBNull(1) ? null : reader.GetValue(1));
            fold.Add(key, value, open && !reader.IsDBNull(labelColumn) ? reader.GetString(labelColumn) : null);
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
        RequireBucketDateField(dateField.StorageKind);
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
        var target = entity.Fields.SingleOrDefault(f => f.FieldId == fieldId);
        RequireGroupedTarget(fieldId, target?.StorageKind);
        return target;
    }

    // The field checks a read makes of what it folds, shared with the read-only snapshot's
    // folds so a file opened read-only refuses what the file refuses (ESQ-10). A null kind is
    // a field the record type does not have.

    /// <summary>
    /// The field one aggregate folds, and whether it folds a date's extremes: a Date joins the
    /// numbers for min and max only (ADR-0004 2026-09-14 amendment, S4), since the range of a
    /// set of civil dates is a comparison, while a sum of them is not a question with an answer.
    /// </summary>
    internal static bool RequireAggregatedField(NendoStorageKind? kind, string aggregate)
    {
        if (kind is not { } known)
            throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
        var dateExtreme = known == NendoStorageKind.Date && aggregate is "min" or "max";
        if (!dateExtreme && known is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
            throw new NendoValidationException(known == NendoStorageKind.Date
                ? "A date field has a smallest and a largest value, not a sum."
                : "Only an integer, decimal or date field can be aggregated.");
        return dateExtreme;
    }

    /// <summary>The integer or decimal field a grouped, bucketed or crossed read folds, when it names one.</summary>
    internal static void RequireGroupedTarget(string? fieldId, NendoStorageKind? kind)
    {
        if (fieldId is null) return;
        if (kind is null)
            throw new NendoPreconditionException("field-not-found", "The aggregated field does not exist on this record type.");
        if (kind is not (NendoStorageKind.Integer or NendoStorageKind.Decimal))
            throw new NendoValidationException("Only an integer or decimal field can be aggregated.");
    }

    /// <summary>The field a bucketed read buckets by: a civil Date.</summary>
    internal static void RequireBucketDateField(NendoStorageKind kind)
    {
        if (kind != NendoStorageKind.Date)
            throw new NendoValidationException("Only a Date field buckets a grouped read by civil date.");
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
            ),
            -- The page's revisions that already have their undo: one pass over the revisions,
            -- not one per row, since the column carries no index.
            compensated AS (
                SELECT compensation_of_revision_id AS revision_id FROM __nendo_revision
                WHERE compensation_of_revision_id IN (SELECT revision_id FROM page)
            )
            SELECT r.revision_id, r.created_at, r.origin, r.description, r.lane,
                r.definition_revision_before, r.definition_revision_after,
                r.data_revision_before, r.data_revision_after, r.change_sequence,
                r.operation_digest, r.proposal_id, r.proposal_digest, r.compensation_of_revision_id,
                COUNT(o.operation_id),
                -- Eligibility must match the operation TYPES CreateCompensationMutationAsync
                -- actually reverses, not the reversibility class. A general ui.removeNode is
                -- ReversibleWithRetainedState yet has no inverse, and a
                -- multi-operation revision is reversed only when every operation is a data
                -- write. A class-based flag offered a Compensate button the engine refused.
                -- A ui.setProperty that gave a property its first value is reversed by
                -- ui.removeProperty, so every one is offered (ESM-11).
                -- A revision is undone once: one that already has its undo, wherever that sits
                -- in History, is refused by the engine, so it is not offered (ESC-02).
                -- extension.setState is left out on purpose: it is a view's own saved state (a
                -- zoom, a layout), written as the person works in the view, and the view keeps
                -- it; History does not offer to undo it, though the engine reverses one if asked.
                CASE WHEN r.revision_id NOT IN (SELECT revision_id FROM compensated) AND (
                (r.compensation_of_revision_id IS NULL AND (
                    (COUNT(o.operation_id) = 1
                        AND MIN(CASE WHEN o.operation_type IN (
                            'data.setField', 'data.deleteRecord', 'data.backfillRetiredField',
                            'schema.setChoiceMetadata', 'schema.addChoice', 'schema.setRetired', 'schema.setFieldRequired',
                            'schema.renameEntity', 'schema.renameField',
                            'schema.setFieldUnique', 'schema.setFieldPresentation', 'schema.setFieldSequence', 'schema.setReferenceLabel',
                            'behaviour.setDefinition', 'behaviour.removeDefinition',
                            'ui.setProperty', 'ui.removeProperty', 'ui.addNode', 'ui.moveNode', 'application.setPurpose', 'application.setLook', 'schema.declareHierarchy', 'schema.removeHierarchy',
                            'schema.declareLinkRule', 'schema.removeLinkRule',
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
                        -- Every definition change but a package's is reversed only while it is the
                        -- file's latest: its inverse expects the definition as it left it, and an
                        -- undo or a search-index build moves the definition on too. A package's
                        -- inverses check the package itself instead (ESM-04, R2RM-02).
                        AND (r.lane <> 'Definition'
                            OR MIN(CASE WHEN substr(o.operation_type, 1, 10) = 'extension.' THEN 1 ELSE 0 END) = 1
                            OR r.definition_revision_after = (SELECT definition_revision FROM __nendo_manifest WHERE singleton_id = 1)))
                    OR
                    -- A package and its files arrive together and are reversed together, up to the
                    -- engine's bound on one compensation (MaximumCausalInverses, ESC-03).
                    (COUNT(o.operation_id) BETWEEN 2 AND 12800
                        AND MIN(CASE WHEN o.operation_type IN (
                            'extension.setPackage', 'extension.putFile', 'extension.removeFile', 'extension.removePackage')
                            THEN 1 ELSE 0 END) = 1)
                ))
                OR
                -- Record changes are reversed as a whole, creates and restores by a delete, and a
                -- compensation of record changes can be compensated again: redo (ADR-0023). A
                -- record's keep mark is one of them (ADR-0022): a batch may set it beside a create.
                (COUNT(o.operation_id) BETWEEN 1 AND 12800
                    AND MIN(CASE WHEN o.operation_type IN (
                        'data.setField', 'data.backfillRetiredField', 'data.deleteRecord',
                        'data.createRecord', 'data.restoreDeletedRecord', 'data.setKeptInNewFiles') THEN 1 ELSE 0 END) = 1))
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
