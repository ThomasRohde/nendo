using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// Custom-view packages carried in the file, ADR-0013. Four tables on one rung, created on
    /// the first extension write and never at file creation, so a file that never carries a
    /// package keeps its layout and the host version it states.
    /// <para>
    /// Content lives once per distinct SHA-256 in <c>__nendo_extension_blob</c>, and a file row
    /// names it. A replaced or removed version stays in the store — that is what reverses a
    /// put exactly — and identical content is kept once however many paths hold it. The
    /// operation rows carry the hash rather than the bytes, so history stays small and opening
    /// a file does not read every version of every script.
    /// </para>
    /// <para>
    /// <c>__nendo_extension_state</c> holds what a view keeps between runs. It arrives on this
    /// rung with the rest, so a later host that writes it does not need a rung of its own.
    /// </para>
    /// </summary>
    private const string ExtensionPackageSchemaSql = """
        CREATE TABLE __nendo_extension_package (
            package_id TEXT NOT NULL PRIMARY KEY,
            title TEXT NOT NULL,
            version TEXT NULL,
            entry_point TEXT NOT NULL,
            description TEXT NULL,
            CHECK (length(package_id) BETWEEN 3 AND 80),
            CHECK (length(title) BETWEEN 1 AND 200),
            CHECK (version IS NULL OR length(version) BETWEEN 1 AND 40),
            CHECK (length(entry_point) BETWEEN 1 AND 240),
            CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1000)
        );
        CREATE TABLE __nendo_extension_blob (
            sha256 TEXT NOT NULL PRIMARY KEY,
            byte_length INTEGER NOT NULL,
            content BLOB NOT NULL,
            CHECK (length(sha256) = 64),
            CHECK (byte_length = length(content) AND byte_length <= 4194304)
        );
        CREATE TABLE __nendo_extension_file (
            package_id TEXT NOT NULL,
            path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            PRIMARY KEY (package_id, path),
            FOREIGN KEY (package_id) REFERENCES __nendo_extension_package(package_id),
            FOREIGN KEY (sha256) REFERENCES __nendo_extension_blob(sha256),
            CHECK (length(path) BETWEEN 1 AND 240),
            CHECK (length(media_type) BETWEEN 3 AND 100)
        );
        CREATE TABLE __nendo_extension_state (
            package_id TEXT NOT NULL,
            view_id TEXT NOT NULL,
            state_key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            version INTEGER NOT NULL,
            PRIMARY KEY (package_id, view_id, state_key),
            CHECK (length(package_id) BETWEEN 3 AND 80),
            CHECK (length(view_id) <= 200),
            CHECK (length(state_key) BETWEEN 1 AND 200),
            CHECK (length(value_json) BETWEEN 1 AND 65536),
            CHECK (version >= 1)
        );
        """;

    /// <summary>Brings the protected layout up to the extension rung: the whole ladder, then the package tables.</summary>
    private async Task EnsureExtensionLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureApplicationPurposeLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_extension_package", transaction, ct))
            await NonQueryAsync(ExtensionPackageSchemaSql, transaction, ct);
    }

    private Task<bool> ExtensionLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_extension_package", transaction, ct);

    /// <summary>Every package the file carries and its files, without their contents. A file with none reads as empty.</summary>
    internal async Task<IReadOnlyList<NendoExtensionPackageSnapshot>> ReadExtensionPackagesAsync(
        SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return [];
        var files = new Dictionary<string, List<NendoExtensionFileSnapshot>>(StringComparer.Ordinal);
        await using (var query = Command("""
            SELECT f.package_id, f.path, f.media_type, f.sha256, b.byte_length
            FROM __nendo_extension_file f JOIN __nendo_extension_blob b ON b.sha256 = f.sha256
            ORDER BY f.package_id, f.path;
            """, transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
            {
                var packageId = rows.GetString(0);
                if (!files.TryGetValue(packageId, out var list)) files.Add(packageId, list = []);
                list.Add(new(rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetInt64(4)));
            }
        }
        var packages = new List<NendoExtensionPackageSnapshot>();
        await using (var query = Command("""
            SELECT package_id, title, version, entry_point, description
            FROM __nendo_extension_package ORDER BY package_id;
            """, transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
        {
            while (await rows.ReadAsync(ct))
            {
                var packageId = rows.GetString(0);
                packages.Add(new(packageId, rows.GetString(1), rows.IsDBNull(2) ? null : rows.GetString(2), rows.GetString(3),
                    rows.IsDBNull(4) ? null : rows.GetString(4),
                    files.TryGetValue(packageId, out var list) ? list.ToArray() : []));
            }
        }
        return packages;
    }

    /// <summary>One file of a package with its bytes, or null when the package or path holds nothing.</summary>
    internal async Task<NendoExtensionFileContent?> ReadExtensionFileAsync(
        string packageId, string path, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("""
            SELECT f.media_type, f.sha256, b.content
            FROM __nendo_extension_file f JOIN __nendo_extension_blob b ON b.sha256 = f.sha256
            WHERE f.package_id = @package AND f.path = @path;
            """, transaction);
        query.Parameters.AddWithValue("@package", packageId);
        query.Parameters.AddWithValue("@path", path);
        await using var rows = await query.ExecuteReaderAsync(ct);
        if (!await rows.ReadAsync(ct)) return null;
        return new(packageId, path, rows.GetString(0), rows.GetString(1), (byte[])rows.GetValue(2));
    }

    /// <summary>Stored content by its SHA-256, or null when the file holds no such content.</summary>
    private async Task<byte[]?> ReadExtensionBlobAsync(string sha256, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("SELECT content FROM __nendo_extension_blob WHERE sha256 = @sha;", transaction);
        query.Parameters.AddWithValue("@sha", sha256);
        return await query.ExecuteScalarAsync(ct) as byte[];
    }

    private sealed record StoredPackage(string Title, string EntryPoint, string? Version, string? Description);

    private sealed record StoredFile(string MediaType, string Sha256, long ByteLength);

    private async Task<StoredPackage?> ReadStoredPackageAsync(string packageId, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command(
            "SELECT title, entry_point, version, description FROM __nendo_extension_package WHERE package_id = @package;", transaction);
        query.Parameters.AddWithValue("@package", packageId);
        await using var rows = await query.ExecuteReaderAsync(ct);
        return await rows.ReadAsync(ct)
            ? new(rows.GetString(0), rows.GetString(1), rows.IsDBNull(2) ? null : rows.GetString(2), rows.IsDBNull(3) ? null : rows.GetString(3))
            : null;
    }

    private async Task<StoredFile?> ReadStoredFileAsync(string packageId, string path, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("""
            SELECT f.media_type, f.sha256, b.byte_length
            FROM __nendo_extension_file f JOIN __nendo_extension_blob b ON b.sha256 = f.sha256
            WHERE f.package_id = @package AND f.path = @path;
            """, transaction);
        query.Parameters.AddWithValue("@package", packageId);
        query.Parameters.AddWithValue("@path", path);
        await using var rows = await query.ExecuteReaderAsync(ct);
        return await rows.ReadAsync(ct) ? new(rows.GetString(0), rows.GetString(1), rows.GetInt64(2)) : null;
    }

    private static object? PackageEvidence(StoredPackage? package) => package is null ? null : new
    {
        title = package.Title, entryPoint = package.EntryPoint, version = package.Version, description = package.Description,
    };

    private static object? FileEvidence(StoredFile? file) => file is null ? null : new
    {
        mediaType = file.MediaType, sha256 = file.Sha256, byteLength = file.ByteLength,
    };

    private async Task<OperationEvidence> ExecuteSetExtensionPackageAsync(
        SetExtensionPackageOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureExtensionLayoutAsync(transaction, ct);
        var previous = await ReadStoredPackageAsync(operation.PackageId, transaction, ct);
        if (previous is null)
        {
            var count = Convert.ToInt64(await ScalarAsync("SELECT COUNT(*) FROM __nendo_extension_package;", transaction, ct), CultureInfo.InvariantCulture);
            if (count >= NendoExtensionLimits.Packages)
                throw new NendoPreconditionException("extension-limit",
                    $"A file carries at most {NendoExtensionLimits.Packages} packages, and this one already has {count}.");
        }
        await using (var save = Command("""
            INSERT INTO __nendo_extension_package(package_id, title, version, entry_point, description)
            VALUES (@package, @title, @version, @entry, @description)
            ON CONFLICT(package_id) DO UPDATE SET title = excluded.title, version = excluded.version,
                entry_point = excluded.entry_point, description = excluded.description;
            """, transaction))
        {
            save.Parameters.AddWithValue("@package", operation.PackageId);
            save.Parameters.AddWithValue("@title", operation.Title);
            save.Parameters.AddWithValue("@version", (object?)operation.Version ?? DBNull.Value);
            save.Parameters.AddWithValue("@entry", operation.EntryPoint);
            save.Parameters.AddWithValue("@description", (object?)operation.Description ?? DBNull.Value);
            await save.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { previous = PackageEvidence(previous) }))
        {
            RequiredHostVersion = NendoFormat.ExtensionPackagesMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteRemoveExtensionPackageAsync(
        RemoveExtensionPackageOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var previous = await ReadStoredPackageAsync(operation.PackageId, transaction, ct)
            ?? throw new NendoPreconditionException("extension-package-not-found",
                $"The file carries no package {operation.PackageId}.");
        await using (var count = Command("SELECT COUNT(*) FROM __nendo_extension_file WHERE package_id = @package;", transaction))
        {
            count.Parameters.AddWithValue("@package", operation.PackageId);
            var files = Convert.ToInt64(await count.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
            if (files != 0)
                throw new NendoPreconditionException("extension-package-not-empty",
                    $"Package {operation.PackageId} still holds {files} files. Remove them with extension.removeFile first, in the same change set if you like.");
        }
        await using (var delete = Command("DELETE FROM __nendo_extension_package WHERE package_id = @package;", transaction))
        {
            delete.Parameters.AddWithValue("@package", operation.PackageId);
            await delete.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { previous = PackageEvidence(previous) }))
        {
            RequiredHostVersion = NendoFormat.ExtensionPackagesMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecutePutExtensionFileAsync(
        PutExtensionFileOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureExtensionLayoutAsync(transaction, ct);
        if (await ReadStoredPackageAsync(operation.PackageId, transaction, ct) is null)
            throw new NendoPreconditionException("extension-package-not-found",
                $"The file carries no package {operation.PackageId}. Create it with extension.setPackage before putting files in it.");
        await using (var clash = Command("""
            SELECT path FROM __nendo_extension_file
            WHERE package_id = @package AND lower(path) = lower(@path) AND path != @path LIMIT 1;
            """, transaction))
        {
            clash.Parameters.AddWithValue("@package", operation.PackageId);
            clash.Parameters.AddWithValue("@path", operation.Path);
            if (await clash.ExecuteScalarAsync(ct) is string existing)
                throw new NendoPreconditionException("extension-path-conflict",
                    $"Package {operation.PackageId} already holds {existing}, which differs from {operation.Path} only in case. A browser on Windows would not tell them apart.");
        }
        var previous = await ReadStoredFileAsync(operation.PackageId, operation.Path, transaction, ct);
        RequireExpectedContent(operation.PackageId, operation.Path, operation.ExpectedSha256, previous);

        if (operation.ContentArray is { } content)
        {
            await using var store = Command("""
                INSERT INTO __nendo_extension_blob(sha256, byte_length, content) VALUES (@sha, @length, @content)
                ON CONFLICT(sha256) DO NOTHING;
                """, transaction);
            store.Parameters.AddWithValue("@sha", operation.Sha256);
            store.Parameters.AddWithValue("@length", content.LongLength);
            store.Parameters.Add("@content", Microsoft.Data.Sqlite.SqliteType.Blob).Value = content;
            await store.ExecuteNonQueryAsync(ct);
        }
        await using (var stored = Command("SELECT byte_length FROM __nendo_extension_blob WHERE sha256 = @sha;", transaction))
        {
            stored.Parameters.AddWithValue("@sha", operation.Sha256);
            var length = await stored.ExecuteScalarAsync(ct);
            if (length is null or DBNull)
                throw new NendoPreconditionException("extension-content-missing",
                    $"The file holds no content with SHA-256 {operation.Sha256}. Send the file's text or base64 bytes.");
            if (Convert.ToInt64(length, CultureInfo.InvariantCulture) != operation.ByteLength)
                throw new NendoValidationException($"Content {operation.Sha256} is not {operation.ByteLength} bytes long.");
        }
        await using (var save = Command("""
            INSERT INTO __nendo_extension_file(package_id, path, media_type, sha256) VALUES (@package, @path, @type, @sha)
            ON CONFLICT(package_id, path) DO UPDATE SET media_type = excluded.media_type, sha256 = excluded.sha256;
            """, transaction))
        {
            save.Parameters.AddWithValue("@package", operation.PackageId);
            save.Parameters.AddWithValue("@path", operation.Path);
            save.Parameters.AddWithValue("@type", operation.MediaType);
            save.Parameters.AddWithValue("@sha", operation.Sha256);
            await save.ExecuteNonQueryAsync(ct);
        }
        await RequireExtensionBoundsAsync(operation.PackageId, transaction, ct);
        return new(operation, Evidence(new { previous = FileEvidence(previous) }))
        {
            RequiredHostVersion = NendoFormat.ExtensionPackagesMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteRemoveExtensionFileAsync(
        RemoveExtensionFileOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var previous = await ReadStoredFileAsync(operation.PackageId, operation.Path, transaction, ct)
            ?? throw new NendoPreconditionException("extension-file-not-found",
                $"Package {operation.PackageId} holds no file {operation.Path}.");
        RequireExpectedContent(operation.PackageId, operation.Path, operation.ExpectedSha256, previous);
        await using (var delete = Command("DELETE FROM __nendo_extension_file WHERE package_id = @package AND path = @path;", transaction))
        {
            delete.Parameters.AddWithValue("@package", operation.PackageId);
            delete.Parameters.AddWithValue("@path", operation.Path);
            await delete.ExecuteNonQueryAsync(ct);
        }
        return new(operation, Evidence(new { previous = FileEvidence(previous) }))
        {
            RequiredHostVersion = NendoFormat.ExtensionPackagesMinimumHostVersion,
        };
    }

    private static void RequireExpectedContent(string packageId, string path, string? expected, StoredFile? current)
    {
        if (expected is null) return;
        if (expected == PutExtensionFileOperation.ExpectAbsent)
        {
            if (current is not null)
                throw new NendoPreconditionException("extension-file-changed",
                    $"{path} in {packageId} was expected to be absent, and it holds {current.Sha256}.");
            return;
        }
        if (current?.Sha256 != expected)
            throw new NendoPreconditionException("extension-file-changed",
                $"{path} in {packageId} was expected to hold {expected}, and it holds {current?.Sha256 ?? "nothing"}. Something changed it since.");
    }

    /// <summary>
    /// Refuses a put that leaves a package, or all of them, past the published bounds. Checked
    /// after the row is staged, so the numbers are what the file would hold, and the whole
    /// mutation rolls back when they are too large.
    /// </summary>
    private async Task RequireExtensionBoundsAsync(string packageId, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var query = Command("""
            SELECT
                (SELECT COUNT(*) FROM __nendo_extension_file WHERE package_id = @package),
                (SELECT COALESCE(SUM(b.byte_length), 0) FROM __nendo_extension_file f
                    JOIN __nendo_extension_blob b ON b.sha256 = f.sha256 WHERE f.package_id = @package),
                (SELECT COALESCE(SUM(b.byte_length), 0) FROM __nendo_extension_file f
                    JOIN __nendo_extension_blob b ON b.sha256 = f.sha256);
            """, transaction);
        query.Parameters.AddWithValue("@package", packageId);
        await using var rows = await query.ExecuteReaderAsync(ct);
        await rows.ReadAsync(ct);
        var files = rows.GetInt64(0);
        var packageBytes = rows.GetInt64(1);
        var totalBytes = rows.GetInt64(2);
        if (files > NendoExtensionLimits.PackageFiles)
            throw new NendoPreconditionException("extension-limit",
                $"A package holds at most {NendoExtensionLimits.PackageFiles} files, and {packageId} would hold {files}.");
        if (packageBytes > NendoExtensionLimits.PackageBytes)
            throw new NendoPreconditionException("extension-limit",
                $"A package holds at most {NendoExtensionLimits.PackageBytes} bytes, and {packageId} would hold {packageBytes}.");
        if (totalBytes > NendoExtensionLimits.TotalBytes)
            throw new NendoPreconditionException("extension-limit",
                $"The packages in a file hold at most {NendoExtensionLimits.TotalBytes} bytes together, and these would hold {totalBytes}.");
    }

    /// <summary>
    /// What an inspection asks of the package tables: every ID, path and type in its published
    /// shape, and every bound held. The foreign keys are checked with the rest of the file's;
    /// the content hashes are checked by a full integrity verification, which reads every byte.
    /// </summary>
    private async Task<bool> ExtensionPackagesAreValidAsync(CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(null, ct)) return true;
        var packages = await ReadExtensionPackagesAsync(null, ct);
        if (packages.Count > NendoExtensionLimits.Packages) return false;
        long total = 0;
        foreach (var package in packages)
        {
            if (!NendoExtensionContent.ValidPackageId(package.PackageId) || !NendoExtensionContent.ValidPath(package.EntryPoint) ||
                package.Version is { } version && !NendoExtensionContent.ValidVersion(version))
                return false;
            if (package.Files.Count > NendoExtensionLimits.PackageFiles || package.TotalBytes > NendoExtensionLimits.PackageBytes)
                return false;
            if (package.Files.Any(file => !NendoExtensionContent.ValidPath(file.Path) || !NendoExtensionContent.ValidMediaType(file.MediaType) ||
                    !NendoExtensionContent.IsSha256(file.Sha256)))
                return false;
            if (package.Files.Select(file => file.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != package.Files.Count)
                return false;
            total += package.TotalBytes;
        }
        if (total > NendoExtensionLimits.TotalBytes) return false;
        var badHashes = Convert.ToInt64(await ScalarAsync(
            "SELECT COUNT(*) FROM __nendo_extension_blob WHERE length(sha256) != 64 OR sha256 GLOB '*[^0-9a-f]*';", null, ct),
            CultureInfo.InvariantCulture);
        return badHashes == 0;
    }

    /// <summary>
    /// Reads every stored content and compares it with the hash it is stored under. Part of a
    /// full integrity verification, never of an ordinary open: it reads every byte.
    /// </summary>
    private async Task<string?> FirstMismatchedExtensionContentAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await ExtensionLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("SELECT sha256, content FROM __nendo_extension_blob ORDER BY sha256;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var expected = rows.GetString(0);
            if (NendoExtensionContent.Sha256((byte[])rows.GetValue(1)) != expected) return expected;
        }
        return null;
    }

    private static bool IsExtensionOperation(string operationType) =>
        operationType is "extension.setPackage" or "extension.putFile" or "extension.removeFile" or "extension.removePackage";

    /// <summary>
    /// The operation that reverses one package operation, built from its canonical payload and
    /// the evidence it retained. Each reversal states what it expects to find, so a file changed
    /// again since refuses rather than being overwritten.
    /// </summary>
    private static NendoOperation CreateExtensionInverse(string type, string canonicalJson, string evidenceJson, string key, int ordinal)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var previous = evidence.RootElement.TryGetProperty("previous", out var value) && value.ValueKind == JsonValueKind.Object
            ? value : (JsonElement?)null;
        var operationId = NendoCanonical.DeterministicId("operation", "studio.p2.compensation", key, ordinal);
        var packageId = payload.GetProperty("packageId").GetString()!;
        static string? Optional(JsonElement element, string name) =>
            element.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;
        switch (type)
        {
            case "extension.setPackage":
            case "extension.removePackage":
                if (previous is not { } package)
                    return type == "extension.setPackage"
                        ? new RemoveExtensionPackageOperation(operationId, packageId)
                        : throw new NendoCompensationNotSupportedException("The removed package retained no metadata to restore.");
                return new SetExtensionPackageOperation(operationId, packageId, package.GetProperty("title").GetString()!,
                    package.GetProperty("entryPoint").GetString()!, Optional(package, "version"), Optional(package, "description"));
            case "extension.putFile":
            {
                var path = payload.GetProperty("path").GetString()!;
                var applied = payload.GetProperty("sha256").GetString()!;
                return previous is { } file
                    ? PutExtensionFileOperation.FromStoredContent(operationId, packageId, path, file.GetProperty("mediaType").GetString(),
                        file.GetProperty("sha256").GetString()!, file.GetProperty("byteLength").GetInt64(), applied)
                    : new RemoveExtensionFileOperation(operationId, packageId, path, applied);
            }
            case "extension.removeFile":
            {
                var path = payload.GetProperty("path").GetString()!;
                if (previous is not { } file)
                    throw new NendoCompensationNotSupportedException($"The removal of {path} retained nothing to restore.");
                return PutExtensionFileOperation.FromStoredContent(operationId, packageId, path, file.GetProperty("mediaType").GetString(),
                    file.GetProperty("sha256").GetString()!, file.GetProperty("byteLength").GetInt64(), PutExtensionFileOperation.ExpectAbsent);
            }
            default:
                throw new NendoCompensationNotSupportedException($"Compensation is not implemented for {type}.");
        }
    }

    /// <summary>
    /// Reverses a revision made only of package operations — the usual shape, since a package
    /// arrives with its files in one change — in the opposite order, so files leave before
    /// the package that holds them.
    /// </summary>
    private static NendoOperation[] CreateExtensionInverses(
        IReadOnlyList<(string Type, string Reversibility, string Canonical, string Evidence)> operations, string key)
    {
        if (operations.Count > MaximumCausalInverses)
            throw new NendoCompensationNotSupportedException(
                $"This revision carries {operations.Count} operations, and a compensation reverses at most {MaximumCausalInverses} together.");
        return operations.Reverse()
            .Select((operation, ordinal) => CreateExtensionInverse(operation.Type, operation.Canonical, operation.Evidence, key, ordinal))
            .ToArray();
    }
}
