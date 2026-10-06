using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The file's full-text index (ADR-0028): the last rung of the protected layout ladder, added by
    /// the first <see cref="BuildSearchIndexOperation"/>. One FTS5 row per record and searched field,
    /// keyed through an ordinary rowid table so a record's rows are found without scanning the
    /// index, and so a record ID never depends on a rowid that a table rebuild or VACUUM renumbers.
    /// The index keeps its own copy of the text so FTS5 can excerpt it and check itself; it is
    /// derived from the records and is never history.
    /// </summary>
    private const string SearchSchemaSql = """
        CREATE TABLE __nendo_search_doc (
            doc INTEGER PRIMARY KEY,
            entity_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            field_id TEXT NOT NULL,
            UNIQUE (entity_id, record_id, field_id)
        );
        CREATE VIRTUAL TABLE __nendo_search USING fts5(body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
        """;

    /// <summary>
    /// The tables FTS5 creates for <c>__nendo_search</c>. SQLite writes their DDL itself, so the
    /// layout signature leaves them out and a test pins them instead: a SQLite that wrote them
    /// differently would otherwise turn every indexed file into an unknown layout.
    /// </summary>
    internal static readonly IReadOnlyList<string> SearchShadowTables =
        ["__nendo_search_config", "__nendo_search_content", "__nendo_search_data", "__nendo_search_docsize", "__nendo_search_idx"];

    /// <summary>Whether a storage object is part of the search index rather than the file's content.</summary>
    internal static bool IsSearchStorage(string name) =>
        name is "__nendo_search" or "__nendo_search_doc" || SearchShadowTables.Contains(name);

    /// <summary>Brings the protected layout up to the search rung: the whole ladder, then the index.</summary>
    private async Task EnsureSearchLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureLinkRuleLayoutAsync(transaction, ct);
        if (!await SearchLayoutExistsAsync(transaction, ct)) await NonQueryAsync(SearchSchemaSql, transaction, ct);
    }

    private Task<bool> SearchLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_search_doc", transaction, ct);

    /// <summary>
    /// The fields a search reads: active text fields of an active record type. A choice keeps its
    /// option ID in a text column, which is not something anyone types, so choices are left out.
    /// </summary>
    internal static bool IsSearchedField(NendoStorageKind kind, bool retired, int choices, int options) =>
        kind == NendoStorageKind.Text && !retired && choices == 0 && options == 0;

    private static IReadOnlyList<FieldMapping> SearchedFields(EntityMapping entity) => entity.Retired
        ? []
        : [.. entity.Fields.Where(field => IsSearchedField(field.StorageKind, field.Retired, field.Choices.Count, field.Options.Count))];

    private async Task<OperationEvidence> ExecuteBuildSearchIndexAsync(
        BuildSearchIndexOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var existed = await SearchLayoutExistsAsync(transaction, ct);
        await EnsureSearchLayoutAsync(transaction, ct);
        // The rows are written once the mutation's tables exist; see MaintainSearchIndexAsync.
        return new(operation, Evidence(new { rebuilt = existed })) { RequiredHostVersion = NendoFormat.SearchMinimumHostVersion };
    }

    /// <summary>What each record type's searched fields were before a definition change, or null.</summary>
    private async Task<IReadOnlyDictionary<string, string>?> CaptureSearchedFieldsAsync(
        IReadOnlyList<NendoOperation> operations, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!operations.Any(operation => operation.Lane == NendoRevisionLane.Definition) ||
            !await SearchLayoutExistsAsync(transaction, ct)) return null;
        return SearchedFieldSignatures(await ReadEntityMappingsAsync(transaction, ct));
    }

    private static Dictionary<string, string> SearchedFieldSignatures(IReadOnlyList<EntityMapping> mappings) =>
        mappings.ToDictionary(entity => entity.EntityId,
            entity => string.Join('\n', SearchedFields(entity).Select(field => field.FieldId + "\t" + field.PhysicalColumnName)),
            StringComparer.Ordinal);

    /// <summary>
    /// Keeps the index in step with what one mutation wrote, inside its transaction, after its
    /// tables exist and before the commit is measured. Every write reaches the records through a
    /// mutation, so this is the one place the index is maintained: a record an operation wrote is
    /// indexed again from its row, and a record type whose searched fields changed is indexed
    /// again whole. A file below the rung has no index and nothing is done.
    /// </summary>
    private async Task MaintainSearchIndexAsync(
        IReadOnlyList<OperationEvidence> evidence,
        IReadOnlyDictionary<string, string>? searchedBefore,
        SqliteTransaction transaction,
        CancellationToken ct)
    {
        if (!await SearchLayoutExistsAsync(transaction, ct)) return;
        if (evidence.Any(item => item.Operation is BuildSearchIndexOperation))
        {
            await RebuildSearchIndexAsync(transaction, ct);
            return;
        }
        var reindexed = new HashSet<string>(StringComparer.Ordinal);
        if (searchedBefore is not null)
        {
            var mappings = await ReadEntityMappingsAsync(transaction, ct);
            var after = SearchedFieldSignatures(mappings);
            foreach (var entity in mappings)
            {
                if (searchedBefore.TryGetValue(entity.EntityId, out var before) && before == after[entity.EntityId]) continue;
                await IndexEntityAsync(entity.EntityId, entity, transaction, ct);
                reindexed.Add(entity.EntityId);
            }
        }
        var entities = new Dictionary<string, EntityMapping>(StringComparer.Ordinal);
        foreach (var (entityId, recordId) in evidence.Select(item => SearchedRecord(item.Operation)).OfType<(string, string)>().Distinct())
        {
            if (reindexed.Contains(entityId)) continue;
            if (!entities.TryGetValue(entityId, out var entity))
                entities[entityId] = entity = await GetEntityMappingAsync(entityId, transaction, ct);
            await IndexRecordAsync(entity, recordId, transaction, ct);
        }
    }

    /// <summary>The record an operation writes the values of, or null.</summary>
    private static (string EntityId, string RecordId)? SearchedRecord(NendoOperation operation) => operation switch
    {
        CreateRecordOperation create => (create.EntityId, create.RecordId),
        SetFieldOperation set => (set.EntityId, set.RecordId),
        DeleteRecordOperation delete => (delete.EntityId, delete.RecordId),
        RestoreDeletedRecordOperation restore => (restore.EntityId, restore.RecordId),
        BackfillRetiredFieldOperation backfill => (backfill.Edit.EntityId, backfill.Edit.RecordId),
        _ => null,
    };

    /// <summary>Empties the index and indexes every record of every record type again.</summary>
    private async Task RebuildSearchIndexAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await NonQueryAsync("DELETE FROM __nendo_search; DELETE FROM __nendo_search_doc;", transaction, ct);
        using var writer = new SearchRowWriter(this, transaction);
        foreach (var entity in await ReadEntityMappingsAsync(transaction, ct))
            await IndexRowsAsync(entity, null, writer, transaction, ct);
        await NonQueryAsync("INSERT INTO __nendo_search(__nendo_search) VALUES ('optimize');", transaction, ct);
    }

    private async Task IndexEntityAsync(string entityId, EntityMapping? entity, SqliteTransaction transaction, CancellationToken ct)
    {
        await using (var remove = Command("""
            DELETE FROM __nendo_search WHERE rowid IN (SELECT doc FROM __nendo_search_doc WHERE entity_id = @entity);
            DELETE FROM __nendo_search_doc WHERE entity_id = @entity;
            """, transaction))
        {
            remove.Parameters.AddWithValue("@entity", entityId);
            await remove.ExecuteNonQueryAsync(ct);
        }
        if (entity is null) return;
        using var writer = new SearchRowWriter(this, transaction);
        await IndexRowsAsync(entity, null, writer, transaction, ct);
    }

    private async Task IndexRecordAsync(EntityMapping entity, string recordId, SqliteTransaction transaction, CancellationToken ct)
    {
        await using (var remove = Command("""
            DELETE FROM __nendo_search WHERE rowid IN (SELECT doc FROM __nendo_search_doc WHERE entity_id = @entity AND record_id = @record);
            DELETE FROM __nendo_search_doc WHERE entity_id = @entity AND record_id = @record;
            """, transaction))
        {
            remove.Parameters.AddWithValue("@entity", entity.EntityId);
            remove.Parameters.AddWithValue("@record", recordId);
            await remove.ExecuteNonQueryAsync(ct);
        }
        using var writer = new SearchRowWriter(this, transaction);
        await IndexRowsAsync(entity, recordId, writer, transaction, ct);
    }

    /// <summary>Indexes a record type's rows, or one row of it; a deleted record has no row and stays out.</summary>
    private async Task IndexRowsAsync(EntityMapping entity, string? recordId, SearchRowWriter writer,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var fields = SearchedFields(entity);
        if (fields.Count == 0 || !await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) return;
        var columns = new List<FieldMapping>();
        foreach (var field in fields)
            if (await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) columns.Add(field);
        if (columns.Count == 0) return;
        await using var select = Command(
            $"SELECT {Quote("__nendo_record_id")}, {string.Join(", ", columns.Select(field => Quote(field.PhysicalColumnName)))} " +
            $"FROM {Quote(entity.PhysicalTableName)}" + (recordId is null ? ";" : $" WHERE {Quote("__nendo_record_id")} = @record;"),
            transaction);
        if (recordId is not null) select.Parameters.AddWithValue("@record", recordId);
        await using var rows = await select.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var id = rows.GetString(0);
            for (var index = 0; index < columns.Count; index++)
            {
                if (rows.IsDBNull(index + 1)) continue;
                var text = Convert.ToString(rows.GetValue(index + 1), CultureInfo.InvariantCulture);
                if (!string.IsNullOrWhiteSpace(text)) await writer.WriteAsync(entity.EntityId, id, columns[index].FieldId, text, ct);
            }
        }
    }

    /// <summary>Two prepared statements reused for every row one maintenance pass writes.</summary>
    private sealed class SearchRowWriter : IDisposable
    {
        private readonly SqliteCommand _doc;
        private readonly SqliteCommand _body;

        internal SearchRowWriter(SqliteNendoStore store, SqliteTransaction? transaction)
        {
            _doc = store.Command("INSERT INTO __nendo_search_doc(entity_id, record_id, field_id) VALUES (@entity, @record, @field) RETURNING doc;", transaction);
            _doc.Parameters.Add("@entity", Microsoft.Data.Sqlite.SqliteType.Text);
            _doc.Parameters.Add("@record", Microsoft.Data.Sqlite.SqliteType.Text);
            _doc.Parameters.Add("@field", Microsoft.Data.Sqlite.SqliteType.Text);
            _body = store.Command("INSERT INTO __nendo_search(rowid, body) VALUES (@doc, @body);", transaction);
            _body.Parameters.Add("@doc", Microsoft.Data.Sqlite.SqliteType.Integer);
            _body.Parameters.Add("@body", Microsoft.Data.Sqlite.SqliteType.Text);
        }

        internal async Task WriteAsync(string entityId, string recordId, string fieldId, string text, CancellationToken ct)
        {
            _doc.Parameters["@entity"].Value = entityId;
            _doc.Parameters["@record"].Value = recordId;
            _doc.Parameters["@field"].Value = fieldId;
            var doc = Convert.ToInt64(await _doc.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
            _body.Parameters["@doc"].Value = doc;
            _body.Parameters["@body"].Value = text;
            await _body.ExecuteNonQueryAsync(ct);
        }

        public void Dispose()
        {
            _doc.Dispose();
            _body.Dispose();
        }
    }

    /// <summary>
    /// Where the index differs from what the records say it should hold: each line names a row
    /// that is missing or should not be there. Empty when the index is in step, or when the file
    /// has none. The index is checked against the records themselves, not against itself.
    /// </summary>
    internal async Task<IReadOnlyList<string>> SearchIndexDriftAsync(CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using var transaction = _connection.BeginTransaction(deferred: true);
        if (!await SearchLayoutExistsAsync(transaction, ct)) return [];
        var expected = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entity in await ReadEntityMappingsAsync(transaction, ct))
        {
            var fields = SearchedFields(entity);
            if (fields.Count == 0 || !await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) continue;
            await using var select = Command(
                $"SELECT {Quote("__nendo_record_id")}, {string.Join(", ", fields.Select(field => Quote(field.PhysicalColumnName)))} FROM {Quote(entity.PhysicalTableName)};",
                transaction);
            await using var rows = await select.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
                for (var index = 0; index < fields.Count; index++)
                    if (!rows.IsDBNull(index + 1) && Convert.ToString(rows.GetValue(index + 1), CultureInfo.InvariantCulture) is { } text &&
                        !string.IsNullOrWhiteSpace(text))
                        expected.Add(string.Join('\t', entity.EntityId, rows.GetString(0), fields[index].FieldId, text));
        }
        var actual = new HashSet<string>(StringComparer.Ordinal);
        await using (var select = Command("""
            SELECT d.entity_id, d.record_id, d.field_id, s.body
            FROM __nendo_search_doc d LEFT JOIN __nendo_search s ON s.rowid = d.doc;
            """, transaction))
        await using (var rows = await select.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
                actual.Add(string.Join('\t', rows.GetString(0), rows.GetString(1), rows.GetString(2), rows.IsDBNull(3) ? "<no text>" : rows.GetString(3)));
        var orphans = Convert.ToInt64(await ScalarAsync(
            "SELECT COUNT(*) FROM __nendo_search WHERE rowid NOT IN (SELECT doc FROM __nendo_search_doc);", transaction, ct), CultureInfo.InvariantCulture);
        return [.. expected.Except(actual).Select(row => "missing\t" + row),
            .. actual.Except(expected).Select(row => "extra\t" + row),
            .. Enumerable.Repeat("extra\tindex row without a record", (int)Math.Min(orphans, 10))];
    }

    /// <summary>The records a search finds, from the file's own index (ADR-0028).</summary>
    internal async Task<NendoPage<NendoSearchHit>> SearchRecordsAsync(
        NendoSearchQuery query, NendoQueryCursor cursors, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        SearchSemantics.Validate(query);
        using var transaction = _connection.BeginTransaction(deferred: true);
        var manifest = await ReadManifestAsync(transaction, ct);
        if (!await SearchLayoutExistsAsync(transaction, ct))
            throw new NendoPreconditionException("search-index-missing",
                "This file has no search index yet. Build it once, and Nendo keeps it current from then on.");
        var mappings = await ReadEntityMappingsAsync(transaction, ct);
        RequireSearchScope(query, mappings.Select(entity => (entity.EntityId, entity.Fields.Select(field => field.FieldId))));
        var byId = mappings.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        return await SearchIndexAsync(this, query, cursors, manifest, transaction, async (entityId, recordIds) =>
        {
            var entity = byId[entityId];
            var label = SearchedFields(entity).FirstOrDefault();
            var found = new Dictionary<string, (long, string?)>(StringComparer.Ordinal);
            var parameters = recordIds.Select((_, index) => $"@r{index}").ToArray();
            await using var select = Command(
                $"SELECT {Quote("__nendo_record_id")}, {Quote("__nendo_record_version")}, " +
                (label is null ? "NULL" : Quote(label.PhysicalColumnName)) +
                $" FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} IN ({string.Join(", ", parameters)});",
                transaction);
            for (var index = 0; index < parameters.Length; index++) select.Parameters.AddWithValue(parameters[index], recordIds[index]);
            await using var rows = await select.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
                found[rows.GetString(0)] = (rows.GetInt64(1), rows.IsDBNull(2) ? null : Convert.ToString(rows.GetValue(2), CultureInfo.InvariantCulture));
            return found;
        }, ct);
    }

    /// <summary>
    /// The same search over records held in memory, for a file open read-only: the records are
    /// indexed into a private in-memory database first, so read-only search answers exactly as the
    /// file's own index would.
    /// </summary>
    internal static async Task<NendoPage<NendoSearchHit>> SearchSnapshotAsync(
        NendoSearchQuery query, NendoQueryCursor cursors, NendoManifestSnapshot manifest,
        IReadOnlyList<NendoEntitySnapshot> entities, IReadOnlyList<NendoRecordSnapshot> records, CancellationToken ct)
    {
        SearchSemantics.Validate(query);
        RequireSearchScope(query, entities.Select(entity => (entity.EntityId, entity.Fields.Select(field => field.FieldId))));
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync(ct);
        var store = new SqliteNendoStore(":memory:", connection);
        await store.NonQueryAsync(SearchSchemaSql, null, ct);
        var searched = entities.ToDictionary(entity => entity.EntityId,
            entity => entity.Retired ? [] : entity.Fields
                .Where(field => IsSearchedField(field.StorageKind, field.Retired, field.Choices.Count, field.Options.Count)).ToArray(),
            StringComparer.Ordinal);
        var byKey = new Dictionary<(string, string), NendoRecordSnapshot>();
        using (var transaction = connection.BeginTransaction())
        {
            using var writer = new SearchRowWriter(store, transaction);
            foreach (var record in records)
            {
                byKey[(record.EntityId, record.RecordId)] = record;
                foreach (var field in searched.GetValueOrDefault(record.EntityId) ?? [])
                    if (SnapshotText(record, field.FieldId) is { } text) await writer.WriteAsync(record.EntityId, record.RecordId, field.FieldId, text, ct);
            }
            transaction.Commit();
        }
        return await SearchIndexAsync(store, query, cursors, manifest, null, (entityId, recordIds) =>
        {
            var label = searched.GetValueOrDefault(entityId)?.FirstOrDefault();
            var found = new Dictionary<string, (long, string?)>(StringComparer.Ordinal);
            foreach (var recordId in recordIds)
                if (byKey.TryGetValue((entityId, recordId), out var record))
                    found[recordId] = (record.RecordVersion, label is null ? null : SnapshotText(record, label.FieldId));
            return Task.FromResult(found);
        }, ct);

        static string? SnapshotText(NendoRecordSnapshot record, string fieldId) =>
            record.Values.TryGetValue(fieldId, out var value) && value.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString() : null;
    }

    private static void RequireSearchScope(NendoSearchQuery query, IEnumerable<(string EntityId, IEnumerable<string> FieldIds)> entities)
    {
        var known = entities.ToDictionary(entity => entity.EntityId, entity => entity.FieldIds.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        foreach (var entityId in query.EntityIds)
            if (!known.ContainsKey(entityId))
                throw new NendoPreconditionException("entity-not-found", $"Record type {entityId} does not exist.");
        var scoped = query.EntityIds.Count == 0 ? known.Values : query.EntityIds.Select(entityId => known[entityId]);
        foreach (var fieldId in query.FieldIds)
            if (!scoped.Any(fields => fields.Contains(fieldId)))
                throw new NendoPreconditionException("field-not-found", $"Field {fieldId} does not belong to a searched record type.");
    }

    /// <summary>
    /// The search itself, over a connection that holds the index tables. Words are matched per
    /// record, not per field: each required term finds the records with it in any searched field,
    /// the records every term found are kept, and a left-out term removes the records it finds.
    /// The kept records rank by their best-matching field.
    /// </summary>
    private static async Task<NendoPage<NendoSearchHit>> SearchIndexAsync(
        SqliteNendoStore store,
        NendoSearchQuery query,
        NendoQueryCursor cursors,
        NendoManifestSnapshot manifest,
        SqliteTransaction? transaction,
        Func<string, IReadOnlyList<string>, Task<Dictionary<string, (long Version, string? Label)>>> lookup,
        CancellationToken ct)
    {
        var scope = SearchSemantics.Scope(query);
        var offset = SearchSemantics.Offset(cursors.Decode(query.Cursor, manifest, scope));
        var terms = SearchTerms.Parse(query.Text);
        if (terms.Required.Count == 0) return new([], null, manifest.ChangeSequence);

        var parameters = new List<(string Name, object Value)>();
        string Parameter(object value)
        {
            var name = $"@p{parameters.Count}";
            parameters.Add((name, value));
            return name;
        }
        var filter = new StringBuilder();
        if (query.EntityIds.Count > 0)
            filter.Append(" AND d.entity_id IN (").AppendJoin(", ", query.EntityIds.Select(id => Parameter(id))).Append(')');
        if (query.FieldIds.Count > 0)
            filter.Append(" AND d.field_id IN (").AppendJoin(", ", query.FieldIds.Select(id => Parameter(id))).Append(')');
        var where = filter.ToString();
        string Matching(string term) =>
            $"SELECT d.entity_id, d.record_id FROM __nendo_search s CROSS JOIN __nendo_search_doc d ON d.doc = s.rowid WHERE __nendo_search MATCH {Parameter(term)}{where}";
        var kept = string.Join(" INTERSECT ", terms.Required.Select(Matching)) +
            string.Concat(terms.Excluded.Select(term => " EXCEPT " + Matching(term)));
        var any = Parameter(terms.Any);
        var sql = $"""
            WITH kept(entity_id, record_id) AS ({kept})
            SELECT d.entity_id, d.record_id, MIN(s.rank) AS score
            FROM __nendo_search s CROSS JOIN __nendo_search_doc d ON d.doc = s.rowid
            WHERE __nendo_search MATCH {any}{where} AND (d.entity_id, d.record_id) IN (SELECT entity_id, record_id FROM kept)
            GROUP BY d.entity_id, d.record_id
            ORDER BY score, d.entity_id, d.record_id
            LIMIT {Parameter(query.Limit + 1)} OFFSET {Parameter(offset)};
            """;
        var ranked = new List<(string EntityId, string RecordId, double Score)>();
        await using (var command = store.Command(sql, transaction))
        {
            foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
            await using var rows = await command.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct)) ranked.Add((rows.GetString(0), rows.GetString(1), rows.GetDouble(2)));
        }
        var more = ranked.Count > query.Limit;
        if (more) ranked.RemoveAt(ranked.Count - 1);
        if (ranked.Count == 0) return new([], null, manifest.ChangeSequence);

        var excerpts = new Dictionary<(string, string), List<(double Score, NendoSearchFieldMatch Match)>>();
        parameters.Clear();
        var anyAgain = Parameter(terms.Any);
        var filterAgain = new StringBuilder();
        if (query.FieldIds.Count > 0)
            filterAgain.Append(" AND d.field_id IN (").AppendJoin(", ", query.FieldIds.Select(id => Parameter(id))).Append(')');
        var pairs = string.Join(", ", ranked.Select(hit => $"({Parameter(hit.EntityId)}, {Parameter(hit.RecordId)})"));
        await using (var command = store.Command($"""
            SELECT d.entity_id, d.record_id, d.field_id,
                   snippet(__nendo_search, 0, char({(int)SearchSemantics.MatchStart}), char({(int)SearchSemantics.MatchEnd}), '…', 16),
                   bm25(__nendo_search)
            FROM __nendo_search s CROSS JOIN __nendo_search_doc d ON d.doc = s.rowid
            WHERE __nendo_search MATCH {anyAgain}{filterAgain} AND (d.entity_id, d.record_id) IN (VALUES {pairs});
            """, transaction))
        {
            foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
            await using var rows = await command.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                var key = (rows.GetString(0), rows.GetString(1));
                if (!excerpts.TryGetValue(key, out var list)) excerpts[key] = list = [];
                list.Add((rows.GetDouble(4), SearchSemantics.Excerpt(rows.GetString(2), rows.GetString(3))));
            }
        }

        var records = new Dictionary<(string, string), (long Version, string? Label)>();
        foreach (var group in ranked.GroupBy(hit => hit.EntityId, StringComparer.Ordinal))
            foreach (var (recordId, found) in await lookup(group.Key, [.. group.Select(hit => hit.RecordId)]))
                records[(group.Key, recordId)] = found;
        var hits = new List<NendoSearchHit>(ranked.Count);
        foreach (var (entityId, recordId, score) in ranked)
        {
            // A record the index names but the record type no longer holds is not answered: the
            // index is derived, and a guess at a record would be worse than a missing hit.
            if (!records.TryGetValue((entityId, recordId), out var record)) continue;
            var fields = excerpts.GetValueOrDefault((entityId, recordId)) ?? [];
            hits.Add(new(entityId, recordId, record.Version, Shorten(record.Label), -score,
                [.. fields.OrderBy(field => field.Score).ThenBy(field => field.Match.FieldId, StringComparer.Ordinal).Select(field => field.Match)]));
        }
        var next = more ? cursors.Encode(manifest, scope, (offset + query.Limit).ToString(CultureInfo.InvariantCulture)) : null;
        return new(hits, next, manifest.ChangeSequence);

        // A label is a title to show, so a long text gives its first line, and at most 200 characters of it.
        static string? Shorten(string? label)
        {
            var line = label?.Split('\n').Select(part => part.Trim()).FirstOrDefault(part => part.Length > 0);
            return line is null ? null : line.Length <= 200 ? line : line[..200].TrimEnd() + "…";
        }
    }
}
