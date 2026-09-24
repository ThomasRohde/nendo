using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<NendoGraphProjection> ReadGraphProjectionAsync(NendoGraphBinding binding, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        return await ReadGraphProjectionAsync(binding, transaction, cancellationToken);
    }

    internal async Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, CancellationToken cancellationToken)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var nodes = await ReadUiNodesAsync(transaction, cancellationToken);
        var node = nodes.SingleOrDefault(n => n.NodeId == viewId && n.ParentNodeId is null && NendoExtensionViewDefinition.IsViewKind(n.Kind))
            ?? throw new NendoPreconditionException("extension-view-missing", "The custom view is no longer defined. Use Studio to inspect the records.");
        var children = nodes.Where(n => n.ParentNodeId == node.NodeId && n.SurfaceId == node.SurfaceId)
            .OrderBy(n => n.Position).ThenBy(n => n.NodeId, StringComparer.Ordinal).ToArray();
        var definition = NendoExtensionViewDefinition.Read(node.NodeId, node.Properties, children, node.Kind);
        if (!definition.IsSupported)
            throw new NendoPreconditionException("extension-version-unsupported", "This host preserves this view's configuration but cannot execute its version.");
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var projection = await ReadGraphProjectionAsync(definition.Binding, transaction, cancellationToken);
        return new(manifest.ApplicationId, manifest.InstanceId, definition, projection);
    }

    private async Task<NendoGraphProjection> ReadGraphProjectionAsync(NendoGraphBinding binding, SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        _ = await ReadAuthoritySnapshotAsync(transaction, cancellationToken);
        var manifest = await ReadManifestAsync(transaction, cancellationToken);
        var mappings = await ReadEntityMappingsAsync(transaction, cancellationToken);
        EntityMapping Entity(string id) => mappings.SingleOrDefault(e => e.EntityId == id && !e.Retired)
            ?? throw new NendoPreconditionException("graph-binding-invalid", "A graph record type is missing or retired.");
        FieldMapping Field(EntityMapping entity, string id) => entity.Fields.SingleOrDefault(f => f.FieldId == id && !f.Retired)
            ?? throw new NendoPreconditionException("graph-binding-invalid", "A graph field is missing, calculated or retired.");
        // A record set (ADR-0013, 2026-09-24) reads its one record type and no links.
        var recordSet = binding.EdgeEntityId is null;
        var nodeEntity = Entity(binding.NodeEntityId);
        var label = Field(nodeEntity, binding.LabelFieldId);
        var status = binding.StatusFieldId is null ? null : Field(nodeEntity, binding.StatusFieldId);
        if (label.StorageKind != NendoStorageKind.Text || status?.StorageKind == NendoStorageKind.Reference)
            throw new NendoPreconditionException("graph-binding-invalid", "A custom view needs a stored Text label and, optionally, a stored scalar status.");
        // A record set has no edge type; these stand for nothing and are never read.
        var edgeEntity = recordSet ? nodeEntity with { Fields = [] } : Entity(binding.EdgeEntityId!);
        var source = recordSet ? label : Field(edgeEntity, binding.SourceFieldId!);
        var target = recordSet ? label : Field(edgeEntity, binding.TargetFieldId!);
        if (!recordSet && (source.FieldId == target.FieldId
            || source.StorageKind != NendoStorageKind.Reference || target.StorageKind != NendoStorageKind.Reference
            || source.Reference?.TargetEntityId != nodeEntity.EntityId || target.Reference?.TargetEntityId != nodeEntity.EntityId))
            throw new NendoPreconditionException("graph-binding-invalid", "Graph edges need two distinct references to the node type and a stored Text label.");

        // Protocol 2 (ADR-0013, 2026-09-24). Each disclosed field and each filter belongs to
        // whichever of the two record types holds it; field IDs are unique across the file.
        var disclosed = (binding.FieldIds ?? []).Select(id => Disclosed(id)).ToArray();
        (FieldMapping Field, string Of) Disclosed(string id)
        {
            var field = nodeEntity.Fields.SingleOrDefault(f => f.FieldId == id && !f.Retired) is { } onNode ? (onNode, "node")
                : edgeEntity.Fields.SingleOrDefault(f => f.FieldId == id && !f.Retired) is { } onEdge ? (onEdge, "edge")
                : throw new NendoPreconditionException("graph-binding-invalid", "A disclosed field is missing, calculated or retired.");
            if (field.Item1.StorageKind == NendoStorageKind.Unsupported ||
                field.Item1.StorageKind == NendoStorageKind.Reference && field.Item1.Reference is null)
                throw new NendoPreconditionException("graph-binding-invalid", "A disclosed field must be a stored scalar or a configured reference.");
            return field;
        }
        var nodeFields = disclosed.Where(d => d.Of == "node").Select(d => d.Field).ToArray();
        var edgeFields = disclosed.Where(d => d.Of == "edge").Select(d => d.Field).ToArray();
        var parameters = new Dictionary<string, object>(StringComparer.Ordinal);
        var nodePredicates = new List<string>();
        var edgePredicates = new List<string>();
        var filters = binding.Filters ?? [];
        for (var index = 0; index < filters.Count; index++)
        {
            var filter = filters[index];
            var (field, predicates) = nodeEntity.Fields.SingleOrDefault(f => f.FieldId == filter.FieldId && !f.Retired) is { } onNode ? (onNode, nodePredicates)
                : edgeEntity.Fields.SingleOrDefault(f => f.FieldId == filter.FieldId && !f.Retired) is { } onEdge ? (onEdge, edgePredicates)
                : throw new NendoPreconditionException("graph-binding-invalid", "A filter field is missing, calculated or retired.");
            // The vocabulary's words, mapped onto the query semantics every surface shares.
            var comparison = filter.Operator switch { "lte" => "le", "gte" => "ge", var same => same };
            if (comparison is not ("eq" or "ne" or "lt" or "le" or "gt" or "ge" or "isNull" or "isNotNull") || field.StorageKind == NendoStorageKind.Unsupported)
                throw new NendoPreconditionException("graph-binding-invalid", "A filter uses an operator or a field type this host cannot compare.");
            var function = $"nendo_graph_filter_{index}";
            _connection.CreateFunction<string?, string?, bool>(function,
                (actual, expected) => RecordQuerySemantics.Matches(comparison, field.StorageKind, actual, expected), isDeterministic: true);
            predicates.Add($"{function}(CAST({Quote(field.PhysicalColumnName)} AS TEXT), @filter{index})");
            parameters[$"@filter{index}"] = filter.Value is null ? DBNull.Value
                : ConvertValue(field with { Required = false, Presentation = null, Options = [] }, JsonDocument.Parse(filter.Value).RootElement.Clone());
        }
        string Where(List<string> predicates, string prefix = " WHERE ") => predicates.Count == 0 ? string.Empty : prefix + string.Join(" AND ", predicates);
        void Bind(SqliteCommand command) { foreach (var parameter in parameters) command.Parameters.AddWithValue(parameter.Key, parameter.Value); }
        // Substring bounds individual cells as well as rows; no unselected field is read. A
        // disclosed reference reads the label of the record it points at, and only that.
        string Column(FieldMapping field, EntityMapping owner)
        {
            if (field.StorageKind == NendoStorageKind.Reference && field.Reference is { } reference)
            {
                var targetType = Entity(reference.TargetEntityId);
                var targetLabel = Field(targetType, reference.LabelFieldId);
                // Aliased, because a reference may point back at its own record type, and the
                // unaliased name would then bind the outer column to the inner row.
                return $"(SELECT substr(nendo_target.{Quote(targetLabel.PhysicalColumnName)},1,4097) FROM {Quote(targetType.PhysicalTableName)} AS nendo_target " +
                    $"WHERE nendo_target.{Quote("__nendo_record_id")} = {Quote(owner.PhysicalTableName)}.{Quote(field.PhysicalColumnName)})";
            }
            return field.StorageKind is NendoStorageKind.Integer or NendoStorageKind.Boolean
                ? Quote(field.PhysicalColumnName) : $"substr({Quote(field.PhysicalColumnName)},1,4097)";
        }
        string? Scalar(SqliteDataReader reader, int ordinal, FieldMapping field)
        {
            if (reader.IsDBNull(ordinal)) return null;
            var scalar = ToJsonElement(reader.GetValue(ordinal), field.StorageKind == NendoStorageKind.Reference ? NendoStorageKind.Text : field.StorageKind);
            var text = scalar.ValueKind == JsonValueKind.String ? scalar.GetString() : scalar.GetRawText();
            return text?.Length > 4096 ? throw TooLarge() : text;
        }
        Dictionary<string, string?> Values(SqliteDataReader reader, int first, FieldMapping[] fields)
        {
            var values = new Dictionary<string, string?>(StringComparer.Ordinal);
            for (var i = 0; i < fields.Length; i++) values[fields[i].FieldId] = Scalar(reader, first + i, fields[i]);
            return values;
        }
        var protocol2 = binding.FieldIds is not null;

        var nodes = new List<NendoGraphNode>();
        var edges = new List<NendoGraphEdge>();
        var statusSql = status is null ? "NULL" : Column(status, nodeEntity);
        var nodeColumns = string.Concat(nodeFields.Select(f => ", " + Column(f, nodeEntity)));
        await using (var command = Command($"SELECT {Quote("__nendo_record_id")}, substr({Quote(label.PhysicalColumnName)},1,4097), {statusSql}{nodeColumns} FROM {Quote(nodeEntity.PhysicalTableName)}{Where(nodePredicates)} ORDER BY {Quote("__nendo_record_id")} COLLATE BINARY LIMIT @limit;", transaction))
        {
            var maximum = recordSet ? NendoExtensionViewDefinition.MaximumRecords : NendoExtensionViewSession.MaximumNodes;
            command.Parameters.AddWithValue("@limit", maximum + 1);
            Bind(command);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                if (nodes.Count == maximum) throw TooLarge();
                var id = reader.GetString(0);
                var text = reader.IsDBNull(1) ? id : reader.GetString(1);
                var value = status is null ? null : Scalar(reader, 2, status);
                if (text.Length > 4096) throw TooLarge();
                nodes.Add(new(id, text, value) { Values = protocol2 ? Values(reader, 3, nodeFields) : null });
            }
        }
        var ids = nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        // Without a node filter every endpoint must be present, as in protocol 1. With one,
        // a link whose endpoint the filter left out is dropped and counted, so the page can
        // say so. An unset endpoint is refused either way: that is incomplete data, not a filter.
        var edgeColumns = string.Concat(edgeFields.Select(f => ", " + Column(f, edgeEntity)));
        var hidden = 0;
        if (recordSet) return Finish();
        // Bounded either way: the links kept are capped as before, and with a node filter the
        // links read to find them are capped too, refusing rather than returning part of a graph.
        var scanLimit = nodePredicates.Count == 0 ? NendoExtensionViewSession.MaximumEdges + 1 : MaximumScannedEdges + 1;
        var scanned = 0;
        await using (var command = Command($"SELECT {Quote("__nendo_record_id")}, {Quote(source.PhysicalColumnName)}, {Quote(target.PhysicalColumnName)}{edgeColumns} FROM {Quote(edgeEntity.PhysicalTableName)}{Where(edgePredicates)} ORDER BY {Quote("__nendo_record_id")} COLLATE BINARY LIMIT @limit;", transaction))
        {
            command.Parameters.AddWithValue("@limit", scanLimit);
            Bind(command);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                if (++scanned > MaximumScannedEdges) throw TooLarge();
                if (reader.IsDBNull(1) || reader.IsDBNull(2))
                    throw new NendoPreconditionException("graph-endpoint-unavailable", "An edge has an unset or unavailable endpoint. Complete the reference in Studio before opening the graph.");
                if (!ids.Contains(reader.GetString(1)) || !ids.Contains(reader.GetString(2)))
                {
                    if (nodePredicates.Count == 0)
                        throw new NendoPreconditionException("graph-endpoint-unavailable", "An edge has an unset or unavailable endpoint. Complete the reference in Studio before opening the graph.");
                    hidden++;
                    continue;
                }
                if (edges.Count == NendoExtensionViewSession.MaximumEdges) throw TooLarge();
                edges.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2)) { Values = protocol2 ? Values(reader, 3, edgeFields) : null });
            }
        }
        return Finish();

        NendoGraphProjection Finish()
        {
            var projection = new NendoGraphProjection(manifest.ChangeSequence, nodes.ToArray(), edges.ToArray())
            {
                Fields = protocol2 ? disclosed.Select(d => new NendoGraphField(d.Field.FieldId, d.Field.DisplayName, TypeOf(d.Field), d.Of)).ToArray() : null,
                HiddenEdges = protocol2 && !recordSet ? hidden : null,
                IsRecordSet = recordSet,
            };
            if (JsonSerializer.SerializeToUtf8Bytes(projection).Length > NendoExtensionViewSession.MaximumProjectionBytes) throw TooLarge();
            return projection;
        }
    }

    /// <summary>How many links a filtered graph may read to find the ones it keeps.</summary>
    private const int MaximumScannedEdges = 10_000;

    /// <summary>What a page needs to read a value: the storage kind, and whether a Text is a single choice.</summary>
    private static string TypeOf(FieldMapping field) => field.Presentation == "singleChoice" ? "choice" : field.StorageKind switch
    {
        NendoStorageKind.Text => "text",
        NendoStorageKind.Integer => "integer",
        NendoStorageKind.Decimal => "decimal",
        NendoStorageKind.Boolean => "boolean",
        NendoStorageKind.Date => "date",
        NendoStorageKind.Reference => "reference",
        var other => other.ToString().ToLowerInvariant(),
    };

    private static NendoPreconditionException TooLarge() => new("graph-projection-too-large", "The graph exceeds its bounded projection. Use Studio to inspect the complete data; no partial graph was returned.");
}
