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

    /// <summary>
    /// The file's own look (W-089), the last rung of the ladder. A singleton like the purpose:
    /// a row exists only for a file that chose something, and a part it did not choose is null
    /// rather than a copy of the default, so the default can follow the file's name.
    /// </summary>
    private const string ApplicationLookSchemaSql = """
        CREATE TABLE __nendo_application_look (
            singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
            tone TEXT NULL CHECK (tone IS NULL OR tone IN ('red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey')),
            letter TEXT NULL CHECK (letter IS NULL OR length(letter) = 1),
            CHECK (tone IS NOT NULL OR letter IS NOT NULL)
        );
        """;

    /// <summary>Brings the protected layout up to the look rung: the whole ladder, then the look table.</summary>
    private async Task EnsureApplicationLookLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureFieldRuleLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_application_look", transaction, ct))
            await NonQueryAsync(ApplicationLookSchemaSql, transaction, ct);
    }

    /// <summary>The look the file chose, if it chose one. A file that never did carries no table.</summary>
    private async Task<NendoApplicationLook?> ReadApplicationLookAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_application_look", transaction, ct)) return null;
        await using var query = Command("SELECT tone, letter FROM __nendo_application_look WHERE singleton_id = 1;", transaction);
        await using var reader = await query.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new NendoApplicationLook(
            reader.IsDBNull(0) ? null : reader.GetString(0),
            reader.IsDBNull(1) ? null : reader.GetString(1));
    }

    private async Task<OperationEvidence> ExecuteSetApplicationLookAsync(
        SetApplicationLookOperation operation,
        SqliteTransaction transaction,
        CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var chooses = operation.Tone is not null || operation.Letter is not null;

        // Choosing creates the rung; returning to the defaults never does, for the purpose's
        // reason: a file told to look as it already looks must not gain a table, nor be told
        // it needs a newer host to open what it does not carry.
        if (chooses) await EnsureApplicationLookLayoutAsync(transaction, ct);
        if (await TableExistsAsync("__nendo_application_look", transaction, ct))
        {
            await using var save = Command(chooses
                ? """
                  INSERT INTO __nendo_application_look(singleton_id,tone,letter) VALUES(1,@tone,@letter)
                  ON CONFLICT(singleton_id) DO UPDATE SET tone=excluded.tone, letter=excluded.letter;
                  """
                : "DELETE FROM __nendo_application_look WHERE singleton_id = 1;", transaction);
            if (chooses)
            {
                save.Parameters.AddWithValue("@tone", (object?)operation.Tone ?? DBNull.Value);
                save.Parameters.AddWithValue("@letter", (object?)operation.Letter ?? DBNull.Value);
            }
            await save.ExecuteNonQueryAsync(ct);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            previousTone = manifest.Look?.Tone,
            previousLetter = manifest.Look?.Letter,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = chooses ? NendoFormat.ApplicationLookMinimumHostVersion : NendoFormat.MinimumHostVersion,
        };
    }

    /// <summary>A stored look is a tone the vocabulary names and a single letter or digit, and at least one of them.</summary>
    private static bool ApplicationLookIsValid(NendoApplicationLook? look) =>
        look is null || ((look.Tone is not null || look.Letter is not null) &&
            (look.Tone is null || NendoLook.IsTone(look.Tone)) &&
            (look.Letter is null || NendoLook.IsLetter(look.Letter)));

    private static SetApplicationLookOperation CreateLookInverse(string evidenceJson, string key)
    {
        using var evidence = JsonDocument.Parse(evidenceJson);
        var prior = evidence.RootElement;
        static string? Text(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return new(
            NendoCanonical.DeterministicId("operation", "application.look.compensation", key, 0),
            Text(prior, "previousTone"),
            Text(prior, "previousLetter"),
            prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }

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
