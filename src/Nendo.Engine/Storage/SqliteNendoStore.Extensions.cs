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
        var node = nodes.SingleOrDefault(n => n.NodeId == viewId && n.ParentNodeId is null && n.Kind == NendoExtensionViewDefinition.NodeKind)
            ?? throw new NendoPreconditionException("extension-view-missing", "The custom view is no longer defined. Use Studio to inspect the records.");
        var definition = NendoExtensionViewDefinition.Read(node.NodeId, node.Properties);
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
        var nodeEntity = Entity(binding.NodeEntityId);
        var edgeEntity = Entity(binding.EdgeEntityId);
        var label = Field(nodeEntity, binding.LabelFieldId);
        var source = Field(edgeEntity, binding.SourceFieldId);
        var target = Field(edgeEntity, binding.TargetFieldId);
        var status = binding.StatusFieldId is null ? null : Field(nodeEntity, binding.StatusFieldId);
        if (label.StorageKind != NendoStorageKind.Text || source.FieldId == target.FieldId
            || source.StorageKind != NendoStorageKind.Reference || target.StorageKind != NendoStorageKind.Reference
            || source.Reference?.TargetEntityId != nodeEntity.EntityId || target.Reference?.TargetEntityId != nodeEntity.EntityId
            || status?.StorageKind == NendoStorageKind.Reference)
            throw new NendoPreconditionException("graph-binding-invalid", "Graph edges need two distinct references to the node type and a stored Text label.");
        var nodes = new List<NendoGraphNode>();
        var edges = new List<NendoGraphEdge>();
        // Substring bounds individual cells as well as rows; no unselected field is read.
        var statusSql = status is null ? "NULL" : status.StorageKind is NendoStorageKind.Integer or NendoStorageKind.Boolean
            ? Quote(status.PhysicalColumnName) : $"substr({Quote(status.PhysicalColumnName)},1,4097)";
        await using (var command = Command($"SELECT {Quote("__nendo_record_id")}, substr({Quote(label.PhysicalColumnName)},1,4097), {statusSql} FROM {Quote(nodeEntity.PhysicalTableName)} ORDER BY {Quote("__nendo_record_id")} COLLATE BINARY LIMIT @limit;", transaction))
        {
            command.Parameters.AddWithValue("@limit", NendoExtensionViewSession.MaximumNodes + 1);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                if (nodes.Count == NendoExtensionViewSession.MaximumNodes) throw TooLarge();
                var id = reader.GetString(0);
                var text = reader.IsDBNull(1) ? id : reader.GetString(1);
                string? value = null;
                if (!reader.IsDBNull(2) && status is not null)
                {
                    var scalar = ToJsonElement(reader.GetValue(2), status.StorageKind);
                    value = scalar.ValueKind == JsonValueKind.String ? scalar.GetString() : scalar.GetRawText();
                }
                if (text.Length > 4096 || value?.Length > 4096) throw TooLarge();
                nodes.Add(new(id, text, value));
            }
        }
        var ids = nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        await using (var command = Command($"SELECT {Quote("__nendo_record_id")}, {Quote(source.PhysicalColumnName)}, {Quote(target.PhysicalColumnName)} FROM {Quote(edgeEntity.PhysicalTableName)} ORDER BY {Quote("__nendo_record_id")} COLLATE BINARY LIMIT @limit;", transaction))
        {
            command.Parameters.AddWithValue("@limit", NendoExtensionViewSession.MaximumEdges + 1);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                if (edges.Count == NendoExtensionViewSession.MaximumEdges) throw TooLarge();
                if (reader.IsDBNull(1) || reader.IsDBNull(2) || !ids.Contains(reader.GetString(1)) || !ids.Contains(reader.GetString(2)))
                    throw new NendoPreconditionException("graph-endpoint-unavailable", "An edge has an unset or unavailable endpoint. Complete the reference in Studio before opening the graph.");
                edges.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
            }
        }
        var projection = new NendoGraphProjection(manifest.ChangeSequence, nodes.ToArray(), edges.ToArray());
        if (JsonSerializer.SerializeToUtf8Bytes(projection).Length > NendoExtensionViewSession.MaximumProjectionBytes) throw TooLarge();
        return projection;
    }

    private static NendoPreconditionException TooLarge() => new("graph-projection-too-large", "The graph exceeds its bounded projection. Use Studio to inspect the complete data; no partial graph was returned.");
}
