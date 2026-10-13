using System.Globalization;
using System.Text.Json;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// A compensation that would leave a skill package it touched without a SKILL.md that names it
    /// is refused (EXT-14). A proposal is checked for this as a whole, but each of its mutations is
    /// a revision of its own, and undoing the one that put SKILL.md left every later proposal
    /// invalid until someone repaired the package.
    /// </summary>
    private async Task RequireCompensatedSkillPackagesAsync(IReadOnlyList<OperationEvidence> evidence,
        Microsoft.Data.Sqlite.SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var packages = evidence.Select(item => item.Operation switch
            {
                PutExtensionFileOperation put => put.PackageId,
                RemoveExtensionFileOperation remove => remove.PackageId,
                SetExtensionPackageOperation set => set.PackageId,
                _ => null,
            })
            .OfType<string>()
            .Distinct(StringComparer.Ordinal);
        foreach (var packageId in packages)
        {
            // A package the compensation removed is no skill package any more.
            if (!await IsSkillPackageAsync(packageId, transaction, cancellationToken)) continue;
            var skill = await ReadExtensionFileAsync(packageId, NendoAgentSkill.FileName, transaction, cancellationToken);
            if (!NendoAgentSkill.TryRead(packageId, skill?.Content, out _, out var problem))
                throw new NendoCompensationNotSupportedException(
                    $"Undoing this change would leave the skill package {packageId} without a usable {NendoAgentSkill.FileName} ({problem}), " +
                    "and every later proposal would be refused until it was repaired. Change the package in a new proposal instead.");
        }
    }

    private async Task<IReadOnlyList<NendoOperation>> CreateExtensionRemovalInverseAsync(string revisionId,
        string evidenceJson, string key, bool exactReplay, CancellationToken cancellationToken)
    {
        using var evidence = JsonDocument.Parse(evidenceJson);
        var rows = evidence.RootElement.GetProperty("retainedSubtree").EnumerateArray().ToArray();
        var kind = rows.Length == 0 ? null : rows[0].GetProperty("kind").GetString();
        if (rows.Length is 0 or > 16 || !NendoExtensionViewDefinition.IsViewKind(kind) || rows.Any(row => row.GetProperty("kind").GetString() != kind ||
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
        _ = NendoExtensionViewDefinition.Read(nodeId, properties, [], kind!);
        var operations = new List<NendoOperation>
        {
            new AddUiNodeOperation(NendoCanonical.DeterministicId("operation", "extension.restore", key, 0),
                surfaceId, nodeId, null, kind!, rows[0].GetProperty("position").GetInt32()),
        };
        foreach (var property in properties.OrderBy(p => p.Key, StringComparer.Ordinal))
            operations.Add(new SetUiPropertyOperation(NendoCanonical.DeterministicId("operation", "extension.restore", key, operations.Count),
                surfaceId, nodeId, property.Key, property.Value));
        return operations;
    }
}
