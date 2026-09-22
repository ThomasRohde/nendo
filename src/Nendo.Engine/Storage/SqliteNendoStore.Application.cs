using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// What the file is for, ADR-0004 2026-09-15 amendment. Its own table rather than a
    /// column on <c>__nendo_manifest</c>, for the reason the tone and scale tables give: the
    /// protected layout is a fingerprint of verbatim DDL, so a fresh file and an older one
    /// that gains a purpose must end with byte-identical schema text, which an ALTER TABLE
    /// rewrite does not promise.
    /// <para>
    /// A singleton like the manifest, and a row exists only for a file that has said
    /// something. Clearing deletes the row rather than storing a blank, so an absent purpose
    /// is absent in the storage as well as in the read — there is no empty string for a
    /// client to draw, and nothing for a later reader to mistake for an author's silence.
    /// </para>
    /// </summary>
    private const string ApplicationPurposeSchemaSql = """
        CREATE TABLE __nendo_application_purpose (
            singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
            purpose TEXT NOT NULL,
            CHECK (length(purpose) BETWEEN 1 AND 4000)
        );
        """;

    /// <summary>Brings the protected layout up to the purpose rung: the whole ladder, then the purpose table.</summary>
    private async Task EnsureApplicationPurposeLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureRatingScaleLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_application_purpose", transaction, ct))
            await NonQueryAsync(ApplicationPurposeSchemaSql, transaction, ct);
    }

    /// <summary>
    /// Reads the file's purpose, if it has one. A file that has never said anything carries
    /// no table and reads as though nobody had.
    /// </summary>
    private async Task<string?> ReadApplicationPurposeAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_application_purpose", transaction, ct)) return null;
        await using var query = Command("SELECT purpose FROM __nendo_application_purpose WHERE singleton_id = 1;", transaction);
        return await query.ExecuteScalarAsync(ct) as string;
    }

    private async Task<OperationEvidence> ExecuteSetApplicationPurposeAsync(
        SetApplicationPurposeOperation operation,
        SqliteTransaction transaction,
        CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        if (operation.Purpose is { Length: var length } && length > SetApplicationPurposeOperation.MaximumCharacters)
            throw new NendoValidationException(
                $"A purpose is at most {SetApplicationPurposeOperation.MaximumCharacters} characters, and this one is {length}.");

        // Saying something creates the rung; clearing never does. A file that has never had a
        // purpose, and is now told it has none, is unchanged — it must not gain a table, and
        // it must not be told it needs a newer host to open what it does not carry.
        if (operation.Purpose is not null) await EnsureApplicationPurposeLayoutAsync(transaction, ct);
        if (await TableExistsAsync("__nendo_application_purpose", transaction, ct))
        {
            await using var save = Command(operation.Purpose is null
                ? "DELETE FROM __nendo_application_purpose WHERE singleton_id = 1;"
                : """
                  INSERT INTO __nendo_application_purpose(singleton_id,purpose) VALUES(1,@purpose)
                  ON CONFLICT(singleton_id) DO UPDATE SET purpose=excluded.purpose;
                  """, transaction);
            if (operation.Purpose is not null) save.Parameters.AddWithValue("@purpose", operation.Purpose);
            await save.ExecuteNonQueryAsync(ct);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            previousPurpose = manifest.Purpose,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = operation.Purpose is null
                ? NendoFormat.MinimumHostVersion
                : NendoFormat.ApplicationPurposeMinimumHostVersion,
        };
    }

    /// <summary>
    /// A stored purpose is prose within its published bound. There is no cross-referential
    /// invariant to check — a purpose answers to no entity, field or node — so this asks only
    /// what the DDL asks, at the moment a file is inspected rather than written.
    /// </summary>
    private static bool ApplicationPurposeIsValid(string? purpose) =>
        purpose is null || (purpose.Length >= 1 && purpose.Length <= SetApplicationPurposeOperation.MaximumCharacters);

    private static SetApplicationPurposeOperation CreatePurposeInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var prior = evidence.RootElement;
        var previous = prior.TryGetProperty("previousPurpose", out var purpose) && purpose.ValueKind == JsonValueKind.String
            ? purpose.GetString()
            : null;
        return new(
            NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            previous,
            prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }
}
