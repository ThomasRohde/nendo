using System.Globalization;
using System.Text.Json;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private async Task<IReadOnlyList<NendoOperation>> CreateExtensionRemovalInverseAsync(string revisionId,
        string evidenceJson, string key, bool exactReplay, CancellationToken cancellationToken)
    {
        using var evidence = JsonDocument.Parse(evidenceJson);
        var rows = evidence.RootElement.GetProperty("retainedSubtree").EnumerateArray().ToArray();
        if (rows.Length is 0 or > 16 || rows.Any(row => row.GetProperty("kind").GetString() != NendoExtensionViewDefinition.NodeKind ||
            row.GetProperty("parentNodeId").ValueKind != JsonValueKind.Null) ||
            rows.Select(row => row.GetProperty("nodeId").GetString()).Distinct(StringComparer.Ordinal).Count() != 1)
            throw new NendoCompensationNotSupportedException("Only a single removed custom-view root can be restored by this inverse.");
        if (!exactReplay)
        {
            await using var revision = Command("SELECT definition_revision_after FROM __nendo_revision WHERE revision_id = @id;", null);
            revision.Parameters.AddWithValue("@id", revisionId);
            var expected = Convert.ToInt64(await revision.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture);
            if ((await ReadManifestAsync(null, cancellationToken)).DefinitionRevision != expected)
                throw new NendoPreconditionException("definition-revision-conflict", "The definition changed after this view was removed. Review a new proposal to restore it.");
        }
        var nodeId = rows[0].GetProperty("nodeId").GetString()!;
        var surfaceId = rows[0].GetProperty("surfaceId").GetString()!;
        var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            using var value = JsonDocument.Parse(row.GetProperty("valueJson").GetString()!);
            properties.Add(row.GetProperty("propertyName").GetString()!, value.RootElement.Clone());
        }
        _ = NendoExtensionViewDefinition.Read(nodeId, properties);
        var operations = new List<NendoOperation>
        {
            new AddUiNodeOperation(NendoCanonical.DeterministicId("operation", "extension.restore", key, 0),
                surfaceId, nodeId, null, NendoExtensionViewDefinition.NodeKind, rows[0].GetProperty("position").GetInt32()),
        };
        foreach (var property in properties.OrderBy(p => p.Key, StringComparer.Ordinal))
            operations.Add(new SetUiPropertyOperation(NendoCanonical.DeterministicId("operation", "extension.restore", key, operations.Count),
                surfaceId, nodeId, property.Key, property.Value));
        return operations;
    }
}
