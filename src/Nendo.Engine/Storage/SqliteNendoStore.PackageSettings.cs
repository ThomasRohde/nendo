using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The settings a view package declares and the values the file keeps for them (ADR-0038), on
    /// the rung above a record type's icon. The manifest is never stored as a file: a declaration
    /// is a row, in the order the manifest gives it, holding its canonical JSON. A value is a row
    /// only while the file keeps one; clearing deletes it, so the package's default is an absence.
    /// A personal value is never here: the host keeps it on each computer.
    /// </summary>
    private const string PackageSettingSchemaSql = """
        CREATE TABLE __nendo_package_setting (
            package_id TEXT NOT NULL,
            setting_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            declaration_json TEXT NOT NULL,
            PRIMARY KEY (package_id, setting_id),
            UNIQUE (package_id, ordinal),
            FOREIGN KEY (package_id) REFERENCES __nendo_extension_package(package_id),
            CHECK (length(setting_id) BETWEEN 1 AND 64),
            CHECK (ordinal BETWEEN 0 AND 63),
            CHECK (length(declaration_json) BETWEEN 2 AND 65536)
        );
        CREATE TABLE __nendo_package_setting_value (
            package_id TEXT NOT NULL,
            setting_id TEXT NOT NULL,
            value_json TEXT NOT NULL,
            PRIMARY KEY (package_id, setting_id),
            FOREIGN KEY (package_id, setting_id) REFERENCES __nendo_package_setting(package_id, setting_id),
            CHECK (length(value_json) BETWEEN 1 AND 8192)
        );
        """;

    /// <summary>Brings the protected layout up to the settings rung: the whole ladder, then the two settings tables.</summary>
    private async Task EnsurePackageSettingLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureEntityIconLayoutAsync(transaction, ct);
        if (!await PackageSettingLayoutExistsAsync(transaction, ct)) await NonQueryAsync(PackageSettingSchemaSql, transaction, ct);
    }

    private Task<bool> PackageSettingLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_package_setting", transaction, ct);

    /// <summary>
    /// Every package's declarations as stored, in order. A file whose packages never declared one
    /// carries no table and reads as though none had. A declaration this version cannot read, such
    /// as a type a newer Nendo added, is left out rather than guessed at.
    /// </summary>
    private async Task<Dictionary<string, List<NendoPackageSettingDeclaration>>> ReadPackageSettingsAsync(
        string? packageId, SqliteTransaction? transaction, CancellationToken ct)
    {
        var declared = new Dictionary<string, List<NendoPackageSettingDeclaration>>(StringComparer.Ordinal);
        if (!await PackageSettingLayoutExistsAsync(transaction, ct)) return declared;
        await using var query = Command(packageId is null
            ? "SELECT package_id, declaration_json FROM __nendo_package_setting ORDER BY package_id, ordinal;"
            : "SELECT package_id, declaration_json FROM __nendo_package_setting WHERE package_id = @package ORDER BY ordinal;", transaction);
        if (packageId is not null) query.Parameters.AddWithValue("@package", packageId);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var owner = rows.GetString(0);
            if (!declared.TryGetValue(owner, out var list)) declared.Add(owner, list = []);
            if (NendoPackageSettings.TryRead(rows.GetString(1)) is { } declaration) list.Add(declaration);
        }
        return declared;
    }

    /// <summary>Every value the file keeps, by package and setting, as stored JSON.</summary>
    private async Task<Dictionary<string, Dictionary<string, string>>> ReadPackageSettingValuesAsync(
        string? packageId, SqliteTransaction? transaction, CancellationToken ct)
    {
        var values = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        if (!await PackageSettingLayoutExistsAsync(transaction, ct)) return values;
        await using var query = Command(packageId is null
            ? "SELECT package_id, setting_id, value_json FROM __nendo_package_setting_value ORDER BY package_id, setting_id;"
            : "SELECT package_id, setting_id, value_json FROM __nendo_package_setting_value WHERE package_id = @package ORDER BY setting_id;", transaction);
        if (packageId is not null) query.Parameters.AddWithValue("@package", packageId);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var owner = rows.GetString(0);
            if (!values.TryGetValue(owner, out var map)) values.Add(owner, map = new(StringComparer.Ordinal));
            map[rows.GetString(1)] = rows.GetString(2);
        }
        return values;
    }

    /// <summary>
    /// The values a snapshot shows: each one that parses, belongs to a setting the package declares
    /// with a shared layer, and fits it. Anything else is not used, and the default is.
    /// </summary>
    private static Dictionary<string, JsonElement> UsableSharedSettings(
        IReadOnlyList<NendoPackageSettingDeclaration> declarations, IReadOnlyDictionary<string, string>? stored)
    {
        var usable = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (stored is null) return usable;
        foreach (var declaration in declarations)
        {
            if (!NendoPackageSettings.AllowsShared(declaration) || !stored.TryGetValue(declaration.Id, out var json)) continue;
            if (TryValue(json) is { } value && NendoPackageSettings.Fits(declaration, value, out _)) usable[declaration.Id] = value;
        }
        return usable;
    }

    private static JsonElement? TryValue(string json)
    {
        try
        {
            var value = NendoPackageSettings.Element(json);
            return NendoPackageSettings.IsScalar(value) ? value : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Replaces a package's declarations with <paramref name="declarations"/>, keeping each shared
    /// value that still fits and dropping the rest. <paramref name="restored"/> are values a reversal
    /// puts back where the file holds none. Declaring none on a file below the rung creates nothing.
    /// </summary>
    private async Task WritePackageSettingsAsync(string packageId, IReadOnlyList<NendoPackageSettingDeclaration> declarations,
        IReadOnlyDictionary<string, string>? restored, SqliteTransaction transaction, CancellationToken ct)
    {
        if (declarations.Count > 0) await EnsurePackageSettingLayoutAsync(transaction, ct);
        if (!await PackageSettingLayoutExistsAsync(transaction, ct)) return;
        var kept = (await ReadPackageSettingValuesAsync(packageId, transaction, ct)).GetValueOrDefault(packageId)
            ?? new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (settingId, value) in restored ?? new Dictionary<string, string>())
            kept.TryAdd(settingId, value);
        await DeletePackageSettingsAsync(packageId, transaction, ct);
        for (var ordinal = 0; ordinal < declarations.Count; ordinal++)
        {
            await using var insert = Command("""
                INSERT INTO __nendo_package_setting(package_id, setting_id, ordinal, declaration_json)
                VALUES (@package, @setting, @ordinal, @declaration);
                """, transaction);
            insert.Parameters.AddWithValue("@package", packageId);
            insert.Parameters.AddWithValue("@setting", declarations[ordinal].Id);
            insert.Parameters.AddWithValue("@ordinal", ordinal);
            insert.Parameters.AddWithValue("@declaration", NendoPackageSettings.CanonicalDeclaration(declarations[ordinal]));
            await insert.ExecuteNonQueryAsync(ct);
        }
        foreach (var (settingId, value) in UsableSharedSettings(declarations, kept))
            await SavePackageSettingValueAsync(packageId, settingId, NendoPackageSettings.CanonicalValue(value), transaction, ct);
    }

    /// <summary>Removes a package's declarations and values, as removing the package does.</summary>
    private async Task DeletePackageSettingsAsync(string packageId, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await PackageSettingLayoutExistsAsync(transaction, ct)) return;
        await using var delete = Command("""
            DELETE FROM __nendo_package_setting_value WHERE package_id = @package;
            DELETE FROM __nendo_package_setting WHERE package_id = @package;
            """, transaction);
        delete.Parameters.AddWithValue("@package", packageId);
        await delete.ExecuteNonQueryAsync(ct);
    }

    private async Task SavePackageSettingValueAsync(string packageId, string settingId, string valueJson, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var save = Command("""
            INSERT INTO __nendo_package_setting_value(package_id, setting_id, value_json) VALUES (@package, @setting, @value)
            ON CONFLICT(package_id, setting_id) DO UPDATE SET value_json = excluded.value_json;
            """, transaction);
        save.Parameters.AddWithValue("@package", packageId);
        save.Parameters.AddWithValue("@setting", settingId);
        save.Parameters.AddWithValue("@value", valueJson);
        await save.ExecuteNonQueryAsync(ct);
    }

    private async Task<OperationEvidence> ExecuteSetPackageSettingAsync(
        SetPackageSettingOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        if (!await ExtensionLayoutExistsAsync(transaction, ct) || !await ExtensionPackageExistsAsync(operation.PackageId, transaction, ct))
            throw new NendoPreconditionException("extension-package-not-found",
                $"This file carries no package {operation.PackageId}, so it keeps no setting for it.");
        var declaration = (await ReadPackageSettingsAsync(operation.PackageId, transaction, ct)).GetValueOrDefault(operation.PackageId)?
            .FirstOrDefault(candidate => candidate.Id == operation.SettingId)
            ?? throw new NendoPreconditionException("package-setting-not-found",
                $"The package {operation.PackageId} declares no setting {operation.SettingId}. nendo://application/extensions lists the ones it declares.");
        if (!NendoPackageSettings.AllowsShared(declaration))
            throw new NendoPreconditionException("package-setting-personal",
                $"The setting {operation.SettingId} of {operation.PackageId} is kept on each computer, never in the file: its layers are personal.");
        if (operation.Value is { } value && !NendoPackageSettings.Fits(declaration, value, out var reason))
            throw new NendoPreconditionException("package-setting-invalid", reason!);

        var previous = (await ReadPackageSettingValuesAsync(operation.PackageId, transaction, ct))
            .GetValueOrDefault(operation.PackageId)?.GetValueOrDefault(operation.SettingId);
        if (operation.Value is { } kept)
        {
            await SavePackageSettingValueAsync(operation.PackageId, operation.SettingId, NendoPackageSettings.CanonicalValue(kept), transaction, ct);
        }
        else if (previous is not null)
        {
            await using var delete = Command(
                "DELETE FROM __nendo_package_setting_value WHERE package_id = @package AND setting_id = @setting;", transaction);
            delete.Parameters.AddWithValue("@package", operation.PackageId);
            delete.Parameters.AddWithValue("@setting", operation.SettingId);
            await delete.ExecuteNonQueryAsync(ct);
        }

        return new OperationEvidence(operation, Evidence(new
        {
            previousValue = previous is null ? (JsonElement?)null : TryValue(previous),
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = NendoFormat.PackageSettingsMinimumHostVersion,
        };
    }

    private static SetPackageSettingOperation CreatePackageSettingInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        JsonElement? previous = evidence.RootElement.TryGetProperty("previousValue", out var value) && value.ValueKind != JsonValueKind.Null
            ? value.Clone()
            : null;
        return new(NendoCanonical.DeterministicId("operation", "package.setting.compensation", key, 0),
            payload.GetProperty("packageId").GetString()!,
            payload.GetProperty("settingId").GetString()!,
            previous,
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    /// <summary>
    /// Every declaration row is a JSON object naming the setting its row does, and every value row
    /// a scalar. A declaration of a type this version does not know is not drift: it is left out.
    /// </summary>
    private async Task<bool> PackageSettingsAreValidAsync(CancellationToken ct)
    {
        if (!await PackageSettingLayoutExistsAsync(null, ct)) return true;
        var skills = await ReadSkillPackageIdsAsync(null, ct);
        await using (var query = Command("SELECT package_id, setting_id, declaration_json FROM __nendo_package_setting;", null))
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
            {
                if (skills.Contains(rows.GetString(0)) || !NendoPackageSettings.ValidId(rows.GetString(1))) return false;
                try
                {
                    using var document = JsonDocument.Parse(rows.GetString(2));
                    if (document.RootElement.ValueKind != JsonValueKind.Object ||
                        !document.RootElement.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String ||
                        id.GetString() != rows.GetString(1))
                        return false;
                }
                catch (JsonException)
                {
                    return false;
                }
            }
        }
        await using (var query = Command("SELECT value_json FROM __nendo_package_setting_value;", null))
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
                if (TryValue(rows.GetString(0)) is null) return false;
        }
        return true;
    }
}
