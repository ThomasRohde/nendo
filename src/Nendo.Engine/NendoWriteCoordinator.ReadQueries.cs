namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly NendoQueryCursor _queryCursors = new();

    internal NendoReadDiagnostics ReadDiagnostics => new(_store?.FullAuthorityScanCount ?? 0,
        _store?.FullRecordReadCount ?? 0, _store?.FullHistoryReadCount ?? 0, _store?.IntegrityCheckCount ?? 0);

    public async Task<NendoSessionSnapshot> GetDefinitionSnapshotAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null) return _readOnlySnapshot with { Records = [] };
            return await GetStore().GetSessionSnapshotAsync(FileName, Health, cancellationToken, includeRecords: false);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoStorageHealthSnapshot> VerifyIntegrityAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
                throw new NendoPreconditionException("reopen-to-verify", "Close and inspect this read-only file again for a fresh integrity check.");
            return await GetStore().VerifyIntegrityAsync(cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoRecordCount> CountRecordsAsync(
        NendoRecordCountQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        RecordQuerySemantics.Validate(new NendoRecordQuery(query.EntityId) { Filters = query.Filters });
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var matching = _readOnlySnapshot.Records.Count(record => record.EntityId == query.EntityId);
                return new(query.EntityId, matching, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().CountRecordsAsync(query, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoRecordAggregate> AggregateRecordsAsync(
        NendoRecordAggregateQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.FieldId);
        if (!NendoSemanticVocabulary.NumericAggregates.Contains(query.Aggregate))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is not supported by this host.");
        RecordQuerySemantics.Validate(new NendoRecordQuery(query.EntityId) { Filters = query.Filters });
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                // A safe-mode snapshot is already in memory and its values are
                // the same exact lexemes, so the fold is the same fold.
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var accumulator = new ExactAggregate(query.Aggregate, integral: false);
                foreach (var record in _readOnlySnapshot.Records.Where(record => record.EntityId == query.EntityId))
                {
                    if (!record.Values.TryGetValue(query.FieldId, out var value)) continue;
                    if (value.ValueKind == System.Text.Json.JsonValueKind.Number) accumulator.Add(value.GetDecimal());
                    // A civil date is a string in the snapshot as it is TEXT in the
                    // column. Safe mode answers a date range too, because a tile that
                    // is exact in SQLite and Unavailable here would be two answers to
                    // one question; a string that is not a date is refused rather than
                    // ordered as text.
                    else if (value.ValueKind == System.Text.Json.JsonValueKind.String) accumulator.AddDate(value.GetString() ?? string.Empty);
                }
                return new(query.EntityId, query.Aggregate, query.FieldId,
                    accumulator.Value(), accumulator.ContributingRecords, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().AggregateRecordsAsync(query, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// One exact number per group of a closed grouping, in one read (ADR-0004,
    /// 2026-09-14 amendment). A chart costs one read rather than one per option,
    /// and the grouping is not a filter, so it spends none of the budget of eight.
    /// </summary>
    public async Task<NendoRecordGroupedAggregate> GroupAggregateRecordsAsync(
        NendoRecordGroupedAggregateQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.GroupByFieldId);
        if (NendoSemanticVocabulary.RefusedAggregates.TryGetValue(query.Aggregate, out var reason))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is refused by this host. {reason}");
        if (!NendoSemanticVocabulary.Aggregates.Contains(query.Aggregate))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is not supported by this host.");
        var numeric = NendoSemanticVocabulary.NumericAggregates.Contains(query.Aggregate);
        if (numeric && string.IsNullOrWhiteSpace(query.FieldId))
            throw new NendoValidationException($"'{query.Aggregate}' needs the field it aggregates.");
        if (!numeric && query.FieldId is not null)
            throw new NendoValidationException("'count' counts records and does not read a field.");
        RecordQuerySemantics.Validate(new NendoRecordQuery(query.EntityId) { Filters = query.Filters });
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var entity = _readOnlySnapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == query.EntityId)
                    ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
                var grouping = entity.Fields.SingleOrDefault(field => field.FieldId == query.GroupByFieldId)
                    ?? throw new NendoPreconditionException("field-not-found", "The grouping field does not exist on this record type.");
                var fold = new GroupedAggregateFold(
                    GroupedAggregateFold.KeysOf(grouping.StorageKind, grouping.Presentation, grouping.Options), query.Aggregate, integral: false);
                // The same fold over the same exact lexemes, so the snapshot answers what the file would.
                foreach (var record in _readOnlySnapshot.Records.Where(record => record.EntityId == query.EntityId))
                {
                    var key = record.Values.TryGetValue(query.GroupByFieldId, out var stored) ? GroupedAggregateFold.KeyText(stored) : null;
                    decimal? value = query.FieldId is not null &&
                        record.Values.TryGetValue(query.FieldId, out var raw) && raw.ValueKind == System.Text.Json.JsonValueKind.Number
                        ? raw.GetDecimal() : null;
                    fold.Add(key, value);
                }
                return fold.Result(query, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().GroupAggregateRecordsAsync(query, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// One exact number per civil-date bucket of a resolved range (ADR-0004, 2026-09-16
    /// amendment). The range word is resolved here, against this machine's civil today, so
    /// the stored screen that asked never carries a date and never goes stale.
    /// <para>
    /// Safe mode folds the same buckets over the snapshot rather than declining. A chart
    /// that is exact against the file and <em>Unavailable</em> against a read-only copy of
    /// it would be two answers to one question, which is the rule the range tile already
    /// follows for a Date.
    /// </para>
    /// </summary>
    public async Task<NendoRecordDateBucketAggregate> BucketAggregateRecordsAsync(
        NendoRecordDateBucketQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.DateFieldId);
        if (NendoSemanticVocabulary.RefusedAggregates.TryGetValue(query.Aggregate, out var reason))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is refused by this host. {reason}");
        if (!NendoSemanticVocabulary.Aggregates.Contains(query.Aggregate))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is not supported by this host.");
        var numeric = NendoSemanticVocabulary.NumericAggregates.Contains(query.Aggregate);
        if (numeric && string.IsNullOrWhiteSpace(query.FieldId))
            throw new NendoValidationException($"'{query.Aggregate}' needs the field it aggregates.");
        if (!numeric && query.FieldId is not null)
            throw new NendoValidationException("'count' counts records and does not read a field.");
        RecordQuerySemantics.Validate(new NendoRecordQuery(query.EntityId) { Filters = query.Filters });
        var buckets = DateBuckets.Resolve(query.Range, query.Bucket, DateOnly.FromDateTime(DateTime.Now));
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var entity = _readOnlySnapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == query.EntityId)
                    ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
                _ = entity.Fields.SingleOrDefault(field => field.FieldId == query.DateFieldId)
                    ?? throw new NendoPreconditionException("field-not-found", "The date field does not exist on this record type.");
                var fold = new GroupedAggregateFold(buckets.Keys, query.Aggregate, integral: false);
                foreach (var record in _readOnlySnapshot.Records.Where(record => record.EntityId == query.EntityId))
                {
                    var stored = record.Values.TryGetValue(query.DateFieldId, out var raw) ? GroupedAggregateFold.KeyText(raw) : null;
                    var key = buckets.KeyOf(stored);
                    // Outside the range is outside the read: the file's own path never
                    // returns such a row, so the snapshot must not fold one either.
                    if (key is null) continue;
                    decimal? value = query.FieldId is not null &&
                        record.Values.TryGetValue(query.FieldId, out var amount) && amount.ValueKind == System.Text.Json.JsonValueKind.Number
                        ? amount.GetDecimal() : null;
                    fold.Add(key, value);
                }
                return fold.Result(query, buckets, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().BucketAggregateRecordsAsync(query, buckets, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// One exact number per cell of two crossed closed groupings (ADR-0004, 2026-09-17
    /// amendment). The cells are the cross product of the two option sets, each axis
    /// carrying its own unset lane, and every one of them is produced before a row is
    /// read — so an empty cell is a cell, for the same reason an empty month is a month.
    /// <para>
    /// The two axes must be different fields. A field against itself is a diagonal with
    /// empty corners, which states nothing a grouped aggregate does not state better.
    /// </para>
    /// <para>
    /// Safe mode folds the same cells over the snapshot rather than declining, as the
    /// bucketed read does: a grid that is exact against the file and <em>Unavailable</em>
    /// against a read-only copy of it would be two answers to one question.
    /// </para>
    /// </summary>
    public async Task<NendoRecordCellAggregate> CellAggregateRecordsAsync(
        NendoRecordCellAggregateQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.RowByFieldId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.ColumnByFieldId);
        if (string.Equals(query.RowByFieldId, query.ColumnByFieldId, StringComparison.Ordinal))
            throw new NendoValidationException(
                "A grid crosses two different fields; a field against itself is a diagonal with empty corners.");
        if (NendoSemanticVocabulary.RefusedAggregates.TryGetValue(query.Aggregate, out var reason))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is refused by this host. {reason}");
        if (!NendoSemanticVocabulary.Aggregates.Contains(query.Aggregate))
            throw new NendoValidationException($"Aggregate '{query.Aggregate}' is not supported by this host.");
        var numeric = NendoSemanticVocabulary.NumericAggregates.Contains(query.Aggregate);
        if (numeric && string.IsNullOrWhiteSpace(query.FieldId))
            throw new NendoValidationException($"'{query.Aggregate}' needs the field it aggregates.");
        if (!numeric && query.FieldId is not null)
            throw new NendoValidationException("'count' counts records and does not read a field.");
        RecordQuerySemantics.Validate(new NendoRecordQuery(query.EntityId) { Filters = query.Filters });
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var entity = _readOnlySnapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == query.EntityId)
                    ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
                var rowField = entity.Fields.SingleOrDefault(field => field.FieldId == query.RowByFieldId)
                    ?? throw new NendoPreconditionException("field-not-found", "The row field does not exist on this record type.");
                var columnField = entity.Fields.SingleOrDefault(field => field.FieldId == query.ColumnByFieldId)
                    ?? throw new NendoPreconditionException("field-not-found", "The column field does not exist on this record type.");
                var fold = new CellAggregateFold(
                    GroupedAggregateFold.KeysOf(rowField.StorageKind, rowField.Presentation, rowField.Options),
                    GroupedAggregateFold.KeysOf(columnField.StorageKind, columnField.Presentation, columnField.Options),
                    query.Aggregate, integral: false);
                // The same fold over the same exact lexemes, so the snapshot answers what the file would.
                foreach (var record in _readOnlySnapshot.Records.Where(record => record.EntityId == query.EntityId))
                {
                    var rowKey = record.Values.TryGetValue(query.RowByFieldId, out var storedRow) ? GroupedAggregateFold.KeyText(storedRow) : null;
                    var columnKey = record.Values.TryGetValue(query.ColumnByFieldId, out var storedColumn) ? GroupedAggregateFold.KeyText(storedColumn) : null;
                    decimal? value = query.FieldId is not null &&
                        record.Values.TryGetValue(query.FieldId, out var raw) && raw.ValueKind == System.Text.Json.JsonValueKind.Number
                        ? raw.GetDecimal() : null;
                    fold.Add(rowKey, columnKey, value);
                }
                return fold.Result(query, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().CellAggregateRecordsAsync(query, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoPage<NendoRecordSnapshot>> QueryRecordsAsync(
        NendoRecordQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        NendoQueryCursor.RequireLimit(query.Limit);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        RecordQuerySemantics.Validate(query);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                if (!_readOnlySnapshot.Entities.Any(entity => entity.EntityId == query.EntityId))
                    throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
                var entity = _readOnlySnapshot.Entities.Single(entity => entity.EntityId == query.EntityId);
                Storage.SqliteNendoStore.ValidateRecordQuery(query, entity.Fields);
                var scope = RecordScope(query);
                var after = _queryCursors.Decode(query.Cursor, _readOnlySnapshot.Manifest, scope);
                var rows = _readOnlySnapshot.Records.Where(record => record.EntityId == query.EntityId)
                    .Where(record => query.RecordId is null || record.RecordId == query.RecordId)
                    .Where(record => query.Filters.All(filter => RecordQuerySemantics.Matches(filter.Operator,
                        entity.Fields.Single(f => f.FieldId == filter.FieldId).StorageKind,
                        RecordQuerySemantics.Text(record.Values.GetValueOrDefault(filter.FieldId)), RecordQuerySemantics.Text(filter.Value))));
                var comparer = Comparer<NendoRecordSnapshot>.Create((left, right) => {
                    var primary = query.SortFieldId is null ? StringComparer.Ordinal.Compare(left.RecordId, right.RecordId)
                        : RecordQuerySemantics.Compare(entity.Fields.Single(f => f.FieldId == query.SortFieldId).StorageKind,
                            RecordQuerySemantics.Text(left.Values.GetValueOrDefault(query.SortFieldId)),
                            RecordQuerySemantics.Text(right.Values.GetValueOrDefault(query.SortFieldId)));
                    if (primary != 0) return query.Descending ? -Math.Sign(primary) : Math.Sign(primary);
                    return StringComparer.Ordinal.Compare(left.RecordId, right.RecordId);
                });
                var previous = after is null ? null : _readOnlySnapshot.Records.Single(record => record.EntityId == query.EntityId && record.RecordId == after);
                var items = rows.OrderBy(record => record, comparer)
                    .Where(record => previous is null || comparer.Compare(record, previous) > 0).Take(query.Limit + 1).ToArray();
                return RecordPage(items, query.Limit, _readOnlySnapshot.Manifest, scope);
            }
            return await GetStore().QueryRecordsAsync(query, _queryCursors, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoPage<NendoRevisionSummary>> QueryHistoryAsync(
        NendoHistoryQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        NendoQueryCursor.RequireLimit(query.Limit);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadHistory) throw new NendoPreconditionException("history-unavailable", "History cannot be safely interpreted for this file.");
                var scope = HistoryScope(query);
                var after = _queryCursors.Decode(query.Cursor, _readOnlySnapshot.Manifest, scope);
                var rows = _readOnlyHistory!.Where(row => after is null ||
                    (query.NewestFirst ? row.ChangeSequence < long.Parse(after, System.Globalization.CultureInfo.InvariantCulture)
                        : row.ChangeSequence > long.Parse(after, System.Globalization.CultureInfo.InvariantCulture)));
                rows = query.NewestFirst ? rows.OrderByDescending(row => row.ChangeSequence) : rows.OrderBy(row => row.ChangeSequence);
                var items = rows.Take(query.Limit + 1).Select(row => new NendoRevisionSummary(
                    row.RevisionId, row.CreatedAt, row.Origin, row.Description, row.Lane,
                    row.DefinitionRevisionBefore, row.DefinitionRevisionAfter, row.DataRevisionBefore, row.DataRevisionAfter,
                    row.ChangeSequence, row.OperationDigest, row.ProposalId, row.ProposalDigest,
                    row.CompensationOfRevisionId, row.Operations.Count, false)).ToArray();
                return HistoryPage(items, query.Limit, _readOnlySnapshot.Manifest, scope);
            }
            return await GetStore().QueryHistoryAsync(query, _queryCursors, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    public async Task<NendoPage<NendoStoredOperationSnapshot>> QueryRevisionOperationsAsync(
        NendoRevisionOperationsQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        NendoQueryCursor.RequireLimit(query.Limit);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.RevisionId);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadHistory) throw new NendoPreconditionException("history-unavailable", "History cannot be safely interpreted for this file.");
                var row = _readOnlyHistory!.SingleOrDefault(row => row.RevisionId == query.RevisionId)
                    ?? throw new NendoPreconditionException("revision-not-found", "The requested revision does not exist.");
                var scope = OperationScope(query);
                var after = _queryCursors.Decode(query.Cursor, _readOnlySnapshot.Manifest, scope);
                var offset = after is null ? 0 : int.Parse(after, System.Globalization.CultureInfo.InvariantCulture) + 1;
                var items = row.Operations.Skip(offset).Take(query.Limit).ToArray();
                return new(items, offset + items.Length < row.Operations.Count
                    ? _queryCursors.Encode(_readOnlySnapshot.Manifest, scope, (offset + items.Length - 1).ToString(System.Globalization.CultureInfo.InvariantCulture))
                    : null, _readOnlySnapshot.Manifest.ChangeSequence);
            }
            return await GetStore().QueryRevisionOperationsAsync(query, _queryCursors, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    internal static string OperationScope(NendoRevisionOperationsQuery query) => $"operations/ordinal/{query.RevisionId}";
    internal static string RecordScope(NendoRecordQuery query) => RecordQuerySemantics.Scope(query);
    internal static string HistoryScope(NendoHistoryQuery query) => $"history/sequence/{query.NewestFirst}";

    private NendoPage<NendoRecordSnapshot> RecordPage(NendoRecordSnapshot[] items, int limit, NendoManifestSnapshot manifest, string scope) =>
        new(items.Take(limit).ToArray(), items.Length > limit ? _queryCursors.Encode(manifest, scope, items[limit - 1].RecordId) : null, manifest.ChangeSequence);

    private NendoPage<NendoRevisionSummary> HistoryPage(NendoRevisionSummary[] items, int limit, NendoManifestSnapshot manifest, string scope) =>
        new(items.Take(limit).ToArray(), items.Length > limit ? _queryCursors.Encode(manifest, scope,
            items[limit - 1].ChangeSequence.ToString(System.Globalization.CultureInfo.InvariantCulture)) : null, manifest.ChangeSequence);
}
