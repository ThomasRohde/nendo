using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The icon each record type chose from Nendo's set (ADR-0038), the last rung of the ladder.
    /// Its own table rather than a column on <c>__nendo_entity</c>, for the reason the tone and
    /// scale tables give: the protected layout is a fingerprint of verbatim DDL. A row exists only
    /// for a record type that chose; clearing deletes it, so the guessed icon is an absence.
    /// </summary>
    private const string EntityIconSchemaSql = """
        CREATE TABLE __nendo_entity_icon (
            entity_id TEXT NOT NULL PRIMARY KEY,
            icon TEXT NOT NULL,
            CHECK (length(icon) BETWEEN 1 AND 64),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id)
        );
        """;

    /// <summary>Brings the protected layout up to the entity-icon rung: the whole ladder, then the icon table.</summary>
    private async Task EnsureEntityIconLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureApplicationIconLayoutAsync(transaction, ct);
        if (!await EntityIconLayoutExistsAsync(transaction, ct)) await NonQueryAsync(EntityIconSchemaSql, transaction, ct);
    }

    private Task<bool> EntityIconLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_entity_icon", transaction, ct);

    /// <summary>
    /// Every chosen icon by record type, as stored. A file that never chose one carries no table and
    /// reads as though no record type had.
    /// </summary>
    private async Task<Dictionary<string, string>> ReadEntityIconsAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var icons = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!await EntityIconLayoutExistsAsync(transaction, ct)) return icons;
        await using var query = Command("SELECT entity_id, icon FROM __nendo_entity_icon ORDER BY entity_id;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) icons[rows.GetString(0)] = rows.GetString(1);
        return icons;
    }

    /// <summary>
    /// The icon a snapshot shows: the stored name when this version of Nendo knows it, and none
    /// otherwise, so a name from a newer set is drawn as the guessed icon rather than as nothing.
    /// </summary>
    private static string? KnownIcon(string? stored) => NendoIconSet.Contains(stored) ? stored : null;

    private async Task<OperationEvidence> ExecuteSetEntityIconAsync(
        SetEntityIconOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(entity);

        // Choosing creates the rung; going back to the guessed icon never does, for the purpose's
        // reason: a file told what it already is must not gain a table or a newer host.
        if (operation.Icon is not null) await EnsureEntityIconLayoutAsync(transaction, ct);
        if (await EntityIconLayoutExistsAsync(transaction, ct))
        {
            await using var save = Command(operation.Icon is null
                ? "DELETE FROM __nendo_entity_icon WHERE entity_id = @entity;"
                : """
                  INSERT INTO __nendo_entity_icon(entity_id, icon) VALUES(@entity, @icon)
                  ON CONFLICT(entity_id) DO UPDATE SET icon = excluded.icon;
                  """, transaction);
            save.Parameters.AddWithValue("@entity", entity.EntityId);
            if (operation.Icon is not null) save.Parameters.AddWithValue("@icon", operation.Icon);
            await save.ExecuteNonQueryAsync(ct);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            previousIcon = entity.Icon,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = operation.Icon is null ? NendoFormat.MinimumHostVersion : NendoFormat.IconsMinimumHostVersion,
        };
    }

    /// <summary>
    /// Every stored icon belongs to a record type the file declares and has the shape of an icon
    /// name. A well-formed name this version does not know is not drift: it is read as no choice.
    /// </summary>
    private async Task<bool> EntityIconMetadataIsValidAsync(IReadOnlyList<EntityMapping> entities, CancellationToken ct)
    {
        var known = entities.Select(entity => entity.EntityId).ToHashSet(StringComparer.Ordinal);
        return (await ReadEntityIconsAsync(null, ct)).All(pair => known.Contains(pair.Key) && NendoIconSet.IsWellFormed(pair.Value));
    }

    private static SetEntityIconOperation CreateEntityIconInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var previous = evidence.RootElement.TryGetProperty("previousIcon", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
        // A name this version does not know cannot be written back, so its undo is the guessed icon.
        return new(NendoCanonical.DeterministicId("operation", "schema.entity-icon.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            KnownIcon(previous),
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }
}
