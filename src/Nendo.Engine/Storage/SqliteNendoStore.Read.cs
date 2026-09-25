using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<NendoSessionSnapshot> GetSessionSnapshotAsync(
        string fileName,
        NendoSessionHealth health,
        CancellationToken cancellationToken,
        bool includeRecords = true)
    {
        using var transaction = _authorityCache is not null ? _connection.BeginTransaction(deferred: true) : null;
        if (transaction is not null) _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        var derived = await ReadDerivedFieldsAsync(transaction, cancellationToken);
        var entities = mappings
            .Select(mapping => new NendoEntitySnapshot(
                mapping.EntityId,
                mapping.DisplayName,
                mapping.Fields.Select(field => new NendoFieldSnapshot(
                    field.FieldId,
                    field.DisplayName,
                    field.StorageKind,
                    field.Required,
                    field.Presentation,
                    field.Options) { UnsupportedStorageKind = field.UnsupportedStorageKind, Reference = field.Reference, Choices = field.Choices, Scale = field.Scale, Retired = field.Retired }).ToArray())
            {
                Retired = mapping.Retired,
                DerivedFields = derived.TryGetValue(mapping.EntityId, out var calculated) ? calculated : [],
            })
            .ToArray();
        var records = includeRecords ? await ReadRecordsAsync(mappings, transaction, cancellationToken) : [];
        var uiNodes = await ReadUiNodesAsync(transaction, cancellationToken);
        var storage = await GetStorageHealthAsync(cancellationToken, transaction, verifyIntegrity: false);
        return new NendoSessionSnapshot(fileName, health, manifest, entities, records, uiNodes, storage)
        {
            ExtensionPackages = await ReadExtensionPackagesAsync(transaction, cancellationToken),
        };
    }

    internal async Task<IReadOnlyList<NendoRevisionSnapshot>> GetRevisionsAsync(
        CancellationToken cancellationToken)
    {
        using var transaction = _authorityCache is not null ? _connection.BeginTransaction(deferred: true) : null;
        if (transaction is not null) _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        return await ReadRevisionsAsync(transaction, cancellationToken);
    }

    private string? _integrityResult;
    private DateTimeOffset? _integrityCheckedAt;
    private long? _integrityChangeSequence;
    internal long IntegrityCheckCount { get; private set; }
    internal long FullRecordReadCount { get; private set; }
    internal long FullHistoryReadCount { get; private set; }

    internal async Task<NendoStorageHealthSnapshot> VerifyIntegrityAsync(CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var health = await GetStorageHealthAsync(cancellationToken, transaction);
        if (!string.Equals(health.IntegrityResult, "ok", StringComparison.OrdinalIgnoreCase))
        {
            _authorityTainted = true;
            throw new NendoRecoveryRequiredException("The explicit integrity check failed. Reopen for recovery inspection.");
        }
        // SQLite checks its pages, not what a stored script says it is. A package file is
        // named by the hash of its bytes, so the explicit check reads every one and compares.
        if (await FirstMismatchedExtensionContentAsync(transaction, cancellationToken) is { } mismatched)
        {
            _authorityTainted = true;
            throw new NendoRecoveryRequiredException(
                $"Stored custom-view content {mismatched} no longer matches its SHA-256. Reopen for recovery inspection.");
        }
        return health;
    }

    internal async Task<NendoStorageHealthSnapshot> GetStorageHealthAsync(
        CancellationToken cancellationToken, SqliteTransaction? transaction = null, bool verifyIntegrity = true)
    {
        var journal = Convert.ToString(
            await ScalarAsync("PRAGMA journal_mode;", transaction, cancellationToken),
            CultureInfo.InvariantCulture) ?? string.Empty;
        var synchronous = Convert.ToInt64(
            await ScalarAsync("PRAGMA synchronous;", transaction, cancellationToken),
            CultureInfo.InvariantCulture);
        var busy = Convert.ToInt32(
            await ScalarAsync("PRAGMA busy_timeout;", transaction, cancellationToken),
            CultureInfo.InvariantCulture);
        if (verifyIntegrity || _integrityResult is null)
        {
            IntegrityCheckCount++;
            var integrity = Convert.ToString(await ScalarAsync("PRAGMA integrity_check;", transaction, cancellationToken),
                CultureInfo.InvariantCulture) ?? string.Empty;
            var manifest = await ReadManifestAsync(transaction, cancellationToken);
            _integrityResult = integrity;
            _integrityCheckedAt = DateTimeOffset.UtcNow;
            _integrityChangeSequence = manifest.ChangeSequence;
        }
        var sidecars = new[]
        {
            $"{_path}-journal",
            $"{_path}-wal",
            $"{_path}-shm",
            $"{_path}.write-owner",
        }
            .Where(File.Exists)
            .Select(Path.GetFileName)
            .OfType<string>()
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        return new NendoStorageHealthSnapshot(
            journal.ToUpperInvariant(),
            synchronous == 2 ? "FULL" : synchronous.ToString(CultureInfo.InvariantCulture),
            busy,
            _integrityResult!,
            sidecars)
        {
            IntegrityCheckedAt = _integrityCheckedAt,
            IntegrityChangeSequence = _integrityChangeSequence,
        };
    }

    private async Task<NendoManifestSnapshot> ReadManifestAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT format_identifier, format_version, minimum_host_version,
                   application_id, instance_id, created_at, modified_at,
                   definition_revision, data_revision, change_sequence
            FROM __nendo_manifest
            WHERE singleton_id = 1;
            """;
        NendoManifestSnapshot manifest;
        await using (var command = Command(sql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new NendoValidationException("The protected Nendo manifest is missing.");
            }

            manifest = new NendoManifestSnapshot(
                reader.GetString(0),
                reader.GetInt64(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                ParseTimestamp(reader.GetString(5)),
                ParseTimestamp(reader.GetString(6)),
                reader.GetInt64(7),
                reader.GetInt64(8),
                reader.GetInt64(9));
        }

        // The purpose is read here rather than beside it, because it lives in its own
        // protected table: every caller that reads the manifest is a caller that should be
        // able to say what the file is for, and there is only this one place to add it.
        return manifest with { Purpose = await ReadApplicationPurposeAsync(transaction, cancellationToken) };
    }

    private async Task<IReadOnlyList<EntityMapping>> ReadEntityMappingsAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        const string entitySql = """
            SELECT entity_id, display_name, physical_table_name
            FROM __nendo_entity
            ORDER BY entity_id;
            """;
        var entities = new List<(string Id, string DisplayName, string PhysicalName)>();
        await using (var command = Command(entitySql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                entities.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
            }
        }

        var hasPresentation = await ColumnExistsAsync(
            "__nendo_field",
            "presentation",
            transaction,
            cancellationToken);
        var hasOptions = await ColumnExistsAsync(
            "__nendo_field",
            "options_json",
            transaction,
            cancellationToken);
        var fieldSql = $"""
            SELECT field_id, entity_id, display_name, physical_column_name, storage_kind, required,
                   {(hasPresentation ? "presentation" : "NULL")},
                   {(hasOptions ? "options_json" : "'[]'")}
            FROM __nendo_field
            ORDER BY entity_id, rowid;
            """;
        var fields = new List<FieldMapping>();
        await using (var command = Command(fieldSql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var kindName = reader.GetString(4);
                var knownKind = Enum.TryParse<NendoStorageKind>(kindName, ignoreCase: false, out var kind) &&
                    Enum.IsDefined(kind) && kind != NendoStorageKind.Unsupported && kind.ToString() == kindName;
                fields.Add(new FieldMapping(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    knownKind ? kind : NendoStorageKind.Unsupported,
                    reader.GetInt64(5) == 1,
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    ParseOptions(reader.GetString(7))) { UnsupportedStorageKind = knownKind ? null : kindName });
            }
        }

        await PopulateReferencesAsync(fields, transaction, cancellationToken);
        await PopulateChoicesAsync(fields, transaction, cancellationToken);
        await PopulateRatingScalesAsync(fields, transaction, cancellationToken);
        var retiredFields = await RetiredIdsAsync("field", transaction, cancellationToken);
        var retiredEntities = await RetiredIdsAsync("entity", transaction, cancellationToken);
        for (var index = 0; index < fields.Count; index++) fields[index] = fields[index] with { Retired = retiredFields.Contains(fields[index].FieldId) };
        return entities
            .Select(entity => new EntityMapping(
                entity.Id,
                entity.DisplayName,
                entity.PhysicalName,
                fields.Where(field => field.EntityId == entity.Id).ToArray()) { Retired = retiredEntities.Contains(entity.Id) })
            .ToArray();
    }

    private async Task<IReadOnlyList<NendoRecordSnapshot>> ReadRecordsAsync(
        IReadOnlyList<EntityMapping> entities,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        FullRecordReadCount++;
        var records = new List<NendoRecordSnapshot>();
        foreach (var entity in entities)
        {
            var columns = new[] { Quote("__nendo_record_id"), Quote("__nendo_record_version") }
                .Concat(entity.Fields.Select(field => Quote(field.PhysicalColumnName)));
            var sql = $"SELECT {string.Join(", ", columns)} FROM {Quote(entity.PhysicalTableName)} ORDER BY {Quote("__nendo_record_id")};";
            await using var command = Command(sql, transaction);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                for (var index = 0; index < entity.Fields.Count; index++)
                {
                    var field = entity.Fields[index];
                    values[field.FieldId] = ToJsonElement(
                        reader.IsDBNull(index + 2) ? null : reader.GetValue(index + 2),
                        field.StorageKind);
                }
                records.Add(new NendoRecordSnapshot(
                    entity.EntityId,
                    reader.GetString(0),
                    reader.GetInt64(1),
                    values));
            }
        }
        var targets = records.ToDictionary(record => (record.EntityId, record.RecordId));
        var references = entities.ToDictionary(entity => entity.EntityId,
            entity => entity.Fields.Where(field => field.Reference is not null).ToArray(), StringComparer.Ordinal);
        var labelled = records.Select(record => record with {
            ReferenceLabels = references[record.EntityId].ToDictionary(field => field.FieldId, field =>
                record.Values.TryGetValue(field.FieldId, out var id) && id.ValueKind == JsonValueKind.String &&
                targets.TryGetValue((field.Reference!.TargetEntityId, id.GetString()!), out var target) &&
                target.Values.TryGetValue(field.Reference.LabelFieldId, out var label) && label.ValueKind == JsonValueKind.String
                    ? label.GetString() : null, StringComparer.Ordinal)
        }).ToArray();
        return await WithCalculationsAsync(labelled, entities, transaction, cancellationToken);
    }

    private async Task<IReadOnlyList<NendoUiNodeSnapshot>> ReadUiNodesAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync("__nendo_ui_node", transaction, cancellationToken))
        {
            return [];
        }

        const string nodeSql = """
            SELECT surface_id, node_id, parent_node_id, kind, position
            FROM __nendo_ui_node
            ORDER BY surface_id, parent_node_id, position, node_id;
            """;
        var nodes = new List<(string SurfaceId, string NodeId, string? ParentNodeId, string Kind, int Position)>();
        await using (var command = Command(nodeSql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                nodes.Add((
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.IsDBNull(2) ? null : reader.GetString(2),
                    reader.GetString(3),
                    reader.GetInt32(4)));
            }
        }

        const string propertySql = """
            SELECT property_name, value_json
            FROM __nendo_ui_property
            WHERE node_id = @nodeId
            ORDER BY property_name;
            """;
        var result = new List<NendoUiNodeSnapshot>(nodes.Count);
        foreach (var node in nodes)
        {
            var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            await using var command = Command(propertySql, transaction);
            command.Parameters.AddWithValue("@nodeId", node.NodeId);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                using var document = JsonDocument.Parse(reader.GetString(1));
                properties.Add(reader.GetString(0), document.RootElement.Clone());
            }
            result.Add(new NendoUiNodeSnapshot(
                node.SurfaceId,
                node.NodeId,
                node.ParentNodeId,
                node.Kind,
                node.Position,
                properties));
        }
        return result;
    }

    private async Task<IReadOnlyList<NendoRevisionSnapshot>> ReadRevisionsAsync(
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        FullHistoryReadCount++;
        var hasProposalId = await ColumnExistsAsync(
            "__nendo_revision",
            "proposal_id",
            transaction,
            cancellationToken);
        var hasProposalDigest = await ColumnExistsAsync(
            "__nendo_revision",
            "proposal_digest",
            transaction,
            cancellationToken);
        var hasCompensation = await ColumnExistsAsync(
            "__nendo_revision",
            "compensation_of_revision_id",
            transaction,
            cancellationToken);
        var revisionSql = $"""
            SELECT revision_id, created_at, origin, description, lane,
                   definition_revision_before, definition_revision_after,
                   data_revision_before, data_revision_after, change_sequence,
                   operation_digest, idempotency_scope, idempotency_key,
                   {(hasProposalId ? "proposal_id" : "NULL")},
                   {(hasProposalDigest ? "proposal_digest" : "NULL")},
                   {(hasCompensation ? "compensation_of_revision_id" : "NULL")}
            FROM __nendo_revision
            ORDER BY change_sequence;
            """;
        var rows = new List<RevisionRow>();
        await using (var command = Command(revisionSql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                rows.Add(new RevisionRow(
                    reader.GetString(0),
                    ParseTimestamp(reader.GetString(1)),
                    reader.GetString(2),
                    reader.GetString(3),
                    Enum.Parse<NendoRevisionLane>(reader.GetString(4), ignoreCase: false),
                    reader.GetInt64(5),
                    reader.GetInt64(6),
                    reader.GetInt64(7),
                    reader.GetInt64(8),
                    reader.GetInt64(9),
                    reader.GetString(10),
                    reader.IsDBNull(11) ? null : reader.GetString(11),
                    reader.IsDBNull(12) ? null : reader.GetString(12),
                    reader.IsDBNull(13) ? null : reader.GetString(13),
                    reader.IsDBNull(14) ? null : reader.GetString(14),
                    reader.IsDBNull(15) ? null : reader.GetString(15)));
            }
        }

        const string operationSql = """
            SELECT revision_id, operation_id, operation_type, reversibility, canonical_json
            FROM __nendo_operation
            ORDER BY revision_id, ordinal;
            """;
        var operationsByRevision = new Dictionary<string, List<NendoStoredOperationSnapshot>>(StringComparer.Ordinal);
        await using (var command = Command(operationSql, transaction))
        await using (var reader = await command.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var revisionId = reader.GetString(0);
                if (!operationsByRevision.TryGetValue(revisionId, out var operations))
                    operationsByRevision.Add(revisionId, operations = []);
                operations.Add(new(reader.GetString(1), reader.GetString(2),
                    Enum.Parse<NendoReversibilityClass>(reader.GetString(3), ignoreCase: false), reader.GetString(4)));
            }
        }
        var revisions = new List<NendoRevisionSnapshot>(rows.Count);
        foreach (var row in rows)
        {
            revisions.Add(new NendoRevisionSnapshot(
                row.RevisionId,
                row.CreatedAt,
                row.Origin,
                row.Description,
                row.Lane,
                row.DefinitionBefore,
                row.DefinitionAfter,
                row.DataBefore,
                row.DataAfter,
                row.ChangeSequence,
                row.OperationDigest,
                row.IdempotencyScope,
                row.IdempotencyKey,
                row.ProposalId,
                row.ProposalDigest,
                row.CompensationOfRevisionId,
                operationsByRevision.GetValueOrDefault(row.RevisionId) ?? []));
        }
        return revisions;
    }

    private sealed record RevisionRow(
        string RevisionId,
        DateTimeOffset CreatedAt,
        string Origin,
        string Description,
        NendoRevisionLane Lane,
        long DefinitionBefore,
        long DefinitionAfter,
        long DataBefore,
        long DataAfter,
        long ChangeSequence,
        string OperationDigest,
        string? IdempotencyScope,
        string? IdempotencyKey,
        string? ProposalId,
        string? ProposalDigest,
        string? CompensationOfRevisionId);

    private sealed record SchemaObjectRow(string Type, string Name, string TableName, string Sql);

    private sealed record IdempotencyRow(string Scope, string Key, string PayloadDigest, string RevisionId);

    private static IReadOnlyList<string> ParseOptions(string value)
    {
        try
        {
            return JsonSerializer.Deserialize<string[]>(value) ?? [];
        }
        catch (JsonException)
        {
            throw new NendoValidationException("A protected field option list is invalid.");
        }
    }
}
