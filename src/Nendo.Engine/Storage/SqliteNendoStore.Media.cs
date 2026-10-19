using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// Embedded media (ADR-0031): the last rung of the protected layout ladder, added by the first
    /// <see cref="PutMediaOperation"/> and never at file creation, so a file that never embeds a
    /// picture keeps its layout and the host version it states.
    /// <para>
    /// Metadata and content are two tables so that whatever reads a file whole — the open
    /// inspection, the content digest, the open bound — reads the small one and leaves the bytes
    /// alone. Each distinct content is stored once, by its SHA-256, and nothing but
    /// <em>Remove unused media</em> takes one away, so an undone field still finds its picture.
    /// </para>
    /// </summary>
    private const string MediaSchemaSql = """
        CREATE TABLE __nendo_media (
            sha256 TEXT NOT NULL PRIMARY KEY,
            media_type TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            name TEXT NULL,
            width INTEGER NULL,
            height INTEGER NULL,
            CHECK (length(sha256) = 64),
            CHECK (length(media_type) BETWEEN 3 AND 100),
            CHECK (byte_length BETWEEN 1 AND 67108864),
            CHECK (name IS NULL OR length(name) BETWEEN 1 AND 240),
            CHECK (width IS NULL OR width > 0),
            CHECK (height IS NULL OR height > 0)
        );
        CREATE TABLE __nendo_media_content (
            sha256 TEXT NOT NULL PRIMARY KEY,
            content BLOB NOT NULL,
            FOREIGN KEY (sha256) REFERENCES __nendo_media(sha256),
            CHECK (length(content) BETWEEN 1 AND 67108864)
        );
        """;

    /// <summary>The table whose pages the open bound, the integrity check and the digest leave out.</summary>
    internal const string MediaContentTable = "__nendo_media_content";

    /// <summary>
    /// Brings the protected layout up to the media rung: the whole ladder, then the media tables.
    /// The rung below is the search index, which a file may not have built yet; it is built here,
    /// from the records, so the file gains a whole index rather than an empty one that later
    /// writes would fill in part.
    /// </summary>
    private async Task EnsureMediaLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (await MediaLayoutExistsAsync(transaction, ct)) return;
        var indexed = await SearchLayoutExistsAsync(transaction, ct);
        await EnsureSearchLayoutAsync(transaction, ct);
        if (!indexed) await RebuildSearchIndexAsync(transaction, ct);
        await NonQueryAsync(MediaSchemaSql, transaction, ct);
    }

    private Task<bool> MediaLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_media", transaction, ct);

    private async Task<OperationEvidence> ExecutePutMediaAsync(PutMediaOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureMediaLayoutAsync(transaction, ct);
        var stored = await ReadMediaAsync(operation.Sha256, transaction, ct);
        if (stored is null)
        {
            if (operation.ContentArray is not { } content)
                throw new NendoPreconditionException("media-missing",
                    $"The file holds no picture {operation.Address}, and this operation carries none.");
            var (_, total) = await ReadMediaTotalsAsync(transaction, ct);
            if (total + content.LongLength > NendoMedia.MaximumFileBytes)
                throw new NendoPreconditionException("media-budget-exceeded",
                    $"A file holds at most {NendoMedia.MaximumFileBytes / (1024 * 1024)} MiB of embedded media. It holds {total / (1024 * 1024)} MiB, " +
                    $"and this picture would add {Math.Ceiling(content.LongLength / (1024.0 * 1024))} MiB. Remove unused media, or link the picture instead.");
            await using (var metadata = Command("""
                INSERT INTO __nendo_media(sha256, media_type, byte_length, name, width, height)
                VALUES (@sha, @type, @length, @name, @width, @height);
                """, transaction))
            {
                metadata.Parameters.AddWithValue("@sha", operation.Sha256);
                metadata.Parameters.AddWithValue("@type", operation.MediaType);
                metadata.Parameters.AddWithValue("@length", content.LongLength);
                metadata.Parameters.AddWithValue("@name", (object?)operation.Name ?? DBNull.Value);
                metadata.Parameters.AddWithValue("@width", (object?)operation.Width ?? DBNull.Value);
                metadata.Parameters.AddWithValue("@height", (object?)operation.Height ?? DBNull.Value);
                await metadata.ExecuteNonQueryAsync(ct);
            }
            await using (var bytes = Command("INSERT INTO __nendo_media_content(sha256, content) VALUES (@sha, @content);", transaction))
            {
                bytes.Parameters.AddWithValue("@sha", operation.Sha256);
                bytes.Parameters.Add("@content", Microsoft.Data.Sqlite.SqliteType.Blob).Value = content;
                await bytes.ExecuteNonQueryAsync(ct);
            }
        }
        return new(operation, Evidence(new { stored = stored is null, address = operation.Address }))
        {
            RequiredHostVersion = NendoFormat.MediaMinimumHostVersion,
        };
    }

    /// <summary>
    /// What an open needs to know about the file's media before it reads anything else: how many
    /// bytes the media content holds by its metadata, and how large the rest of the file is. Null for
    /// a file that embeds none.
    /// </summary>
    internal async Task<(long Bytes, long NonMediaBytes)?> ReadMediaInspectionAsync(CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(null, ct)) return null;
        var pages = Convert.ToInt64(await ScalarAsync("PRAGMA page_count;", null, ct), CultureInfo.InvariantCulture);
        var pageSize = Convert.ToInt64(await ScalarAsync("PRAGMA page_size;", null, ct), CultureInfo.InvariantCulture);
        var (_, bytes) = await ReadMediaTotalsAsync(null, ct);
        return (bytes, (pages - await ReadMediaContentPagesAsync(pageSize, null, ct)) * pageSize);
    }

    /// <summary>
    /// SQLite's integrity check, as its result: "ok" or what failed. A file without media, and an
    /// explicit check of the whole file, read every page as they always did. A file that embeds
    /// media is otherwise checked table by table, each with its indexes, leaving out the media
    /// content, so opening does not read the pictures (ADR-0031 point 7): the metadata, which names
    /// every item, is checked like any table, every item is paired with its content, and the
    /// explicit check hashes every item.
    /// </summary>
    internal async Task<string> IntegrityResultAsync(bool wholeFile, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (wholeFile || !await MediaLayoutExistsAsync(transaction, ct))
            return Convert.ToString(await ScalarAsync("PRAGMA integrity_check;", transaction, ct), CultureInfo.InvariantCulture) ?? string.Empty;
        // One check, however many tables it reads, as the counter has always counted.
        IntegrityCheckCount++;
        var tables = new List<string> { "sqlite_schema" };
        await using (var query = Command("SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name;", transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct)) tables.Add(rows.GetString(0));
        foreach (var table in tables.Where(table => table != MediaContentTable))
        {
            await using var check = Command($"PRAGMA integrity_check({Quote(table)});", transaction);
            var result = Convert.ToString(await check.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) ?? string.Empty;
            if (!string.Equals(result, "ok", StringComparison.Ordinal)) return result;
        }
        await using var pairs = Command("""
            SELECT (SELECT COUNT(*) FROM __nendo_media m WHERE NOT EXISTS (SELECT 1 FROM __nendo_media_content c WHERE c.sha256 = m.sha256))
                 + (SELECT COUNT(*) FROM __nendo_media_content c WHERE NOT EXISTS (SELECT 1 FROM __nendo_media m WHERE m.sha256 = c.sha256));
            """, transaction);
        return Convert.ToInt64(await pairs.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) == 0
            ? "ok"
            : "An embedded picture's metadata and content do not pair up.";
    }

    /// <summary>The first embedded item whose bytes no longer hash to the SHA-256 that names them, or null.</summary>
    private async Task<string?> FirstMismatchedMediaContentAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("SELECT sha256, content FROM __nendo_media_content ORDER BY sha256;", transaction);
        await using var rows = await query.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, ct);
        while (await rows.ReadAsync(ct))
        {
            var sha = rows.GetString(0);
            await using var content = rows.GetStream(1);
            var actual = Convert.ToHexStringLower(await System.Security.Cryptography.SHA256.HashDataAsync(content, ct));
            if (actual != sha) return NendoMediaAddress.Embedded(sha);
        }
        return null;
    }

    /// <summary>One embedded item's metadata, or null when the file does not hold it.</summary>
    internal async Task<NendoMediaItem?> ReadMediaAsync(string sha256, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("""
            SELECT m.sha256, m.media_type, m.byte_length, m.name, m.width, m.height
            FROM __nendo_media m JOIN __nendo_media_content c ON c.sha256 = m.sha256
            WHERE m.sha256 = @sha;
            """, transaction);
        query.Parameters.AddWithValue("@sha", sha256);
        await using var rows = await query.ExecuteReaderAsync(ct);
        return await rows.ReadAsync(ct) ? ReadMediaItem(rows) : null;
    }

    private static NendoMediaItem ReadMediaItem(SqliteDataReader rows) => new(
        rows.GetString(0), rows.GetString(1), rows.GetInt64(2),
        rows.IsDBNull(3) ? null : rows.GetString(3),
        rows.IsDBNull(4) ? null : rows.GetInt32(4),
        rows.IsDBNull(5) ? null : rows.GetInt32(5));

    /// <summary>One embedded item's bytes, or null when the file does not hold it.</summary>
    internal async Task<byte[]?> ReadMediaContentAsync(string sha256, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return null;
        await using var query = Command("SELECT content FROM __nendo_media_content WHERE sha256 = @sha;", transaction);
        query.Parameters.AddWithValue("@sha", sha256);
        return await query.ExecuteScalarAsync(ct) as byte[];
    }

    /// <summary>
    /// Part of one embedded item's bytes, read through SQLite's incremental blob reader into the
    /// caller's buffer, so serving a large picture never holds it whole. Returns how many bytes it
    /// read: fewer than the buffer at the end of the item, and -1 when the file does not hold it.
    /// </summary>
    internal async Task<int> ReadMediaRangeAsync(string sha256, long offset, Memory<byte> buffer, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(null, ct)) return -1;
        await using var query = Command("SELECT rowid FROM __nendo_media_content WHERE sha256 = @sha;", null);
        query.Parameters.AddWithValue("@sha", sha256);
        if (await query.ExecuteScalarAsync(ct) is not long rowid) return -1;
        using var blob = new SqliteBlob(_connection, MediaContentTable, "content", rowid, readOnly: true);
        if (offset >= blob.Length) return 0;
        blob.Position = offset;
        var read = 0;
        while (read < buffer.Length)
        {
            var count = await blob.ReadAsync(buffer[read..], ct);
            if (count == 0) break;
            read += count;
        }
        return read;
    }

    /// <summary>How many items the file embeds and how many bytes they hold, from the metadata alone.</summary>
    internal async Task<(long Count, long Bytes)> ReadMediaTotalsAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return (0, 0);
        await using var query = Command("SELECT COUNT(*), COALESCE(SUM(byte_length), 0) FROM __nendo_media;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        await rows.ReadAsync(ct);
        return (rows.GetInt64(0), rows.GetInt64(1));
    }

    /// <summary>
    /// The pages the media content occupies, as the open bound counts them: each item's bytes over
    /// the room an overflow page has for them, rounded up. It is an upper bound that never counts a
    /// page twice and needs no read of the content.
    /// </summary>
    private async Task<long> ReadMediaContentPagesAsync(long pageSize, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return 0;
        await using var query = Command("SELECT COALESCE(SUM((byte_length + @room - 1) / @room), 0) FROM __nendo_media;", transaction);
        query.Parameters.AddWithValue("@room", pageSize - 4);
        return Convert.ToInt64(await query.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Removes every embedded item that no current value of any media field names, and that is
    /// not the file's icon, which a new file keeps with the look (W-001). Only where
    /// nothing can undo back to one: a new file, whose history is folded whole. Removing unused media
    /// from an open file also keeps what retained history names, and is its own operation.
    /// </summary>
    private async Task RemoveUnreferencedMediaAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await MediaLayoutExistsAsync(transaction, ct)) return;
        var named = new List<string>();
        foreach (var entity in await ReadEntityMappingsAsync(transaction, ct))
        {
            if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) continue;
            foreach (var field in entity.Fields.Where(field => field.Presentation == NendoMedia.Presentation))
            {
                if (!await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) continue;
                var column = Quote(field.PhysicalColumnName);
                named.Add($"SELECT substr({column}, {NendoMedia.EmbeddedScheme.Length + 1}) FROM {Quote(entity.PhysicalTableName)} " +
                    $"WHERE {column} LIKE '{NendoMedia.EmbeddedScheme}%'");
            }
        }
        if (await ApplicationIconLayoutExistsAsync(transaction, ct))
            named.Add("SELECT sha256 FROM __nendo_application_icon");
        var kept = named.Count == 0 ? "SELECT NULL WHERE 0" : string.Join(" UNION ", named);
        await NonQueryAsync($"""
            DELETE FROM __nendo_media_content WHERE sha256 NOT IN ({kept});
            DELETE FROM __nendo_media WHERE sha256 NOT IN ({kept});
            """, transaction, ct);
    }

    /// <summary>
    /// The media rule at the end of a mutation (ADR-0031 point 5): every <c>media:</c> address the
    /// mutation wrote names content the file holds, whichever path wrote it — a create, a set, a
    /// form save, an import, a command step, an automatic action, a view, an agent, an undo or a
    /// restore. Runs after every operation and automatic action, so a put and the set that names
    /// it may arrive in either order within one mutation.
    /// </summary>
    private async Task RequireEmbeddedMediaPresentAsync(IReadOnlyList<OperationEvidence> evidence, SqliteTransaction transaction, CancellationToken ct)
    {
        var touched = new Dictionary<string, (HashSet<string> Records, HashSet<string>? Fields)>(StringComparer.Ordinal);
        // A create or restore reads every media field of its record; a set reads its own field.
        void Touch(string entityId, string recordId, string? fieldId)
        {
            if (!touched.TryGetValue(entityId, out var entry)) entry = (new(StringComparer.Ordinal), new(StringComparer.Ordinal));
            entry.Records.Add(recordId);
            var fields = fieldId is null ? null : entry.Fields;
            fields?.Add(fieldId!);
            touched[entityId] = (entry.Records, fields);
        }
        foreach (var operation in evidence.Select(item => item.Operation))
        {
            switch (operation)
            {
                case CreateRecordOperation create: Touch(create.EntityId, create.RecordId, null); break;
                case RestoreDeletedRecordOperation restore: Touch(restore.EntityId, restore.RecordId, null); break;
                case SetFieldOperation set: Touch(set.EntityId, set.RecordId, set.FieldId); break;
            }
        }
        if (touched.Count == 0) return;
        foreach (var (entityId, (records, onlyFields)) in touched)
        {
            var entity = await GetEntityMappingAsync(entityId, transaction, ct);
            var fields = entity.Fields
                .Where(field => field.Presentation == NendoMedia.Presentation && !field.Retired && (onlyFields is null || onlyFields.Contains(field.FieldId)))
                .ToArray();
            if (fields.Length == 0 || !await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) continue;
            await RequireMediaPresentAsync(entity, fields, records, transaction, ct);
        }
    }

    /// <summary>
    /// Refuses with <c>media-missing</c> the first value among the named records (or every record,
    /// when none are named) whose <c>media:</c> address names content the file does not hold.
    /// </summary>
    private async Task RequireMediaPresentAsync(EntityMapping entity, IReadOnlyList<FieldMapping> fields, IReadOnlyCollection<string>? records,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var hasStore = await MediaLayoutExistsAsync(transaction, ct);
        const int SliceSize = 400;
        string[]?[] slices = records is null ? [null] : [.. records.Order(StringComparer.Ordinal).Chunk(SliceSize)];
        foreach (var field in fields)
        {
            if (!await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) continue;
            var column = Quote(field.PhysicalColumnName);
            var missing = hasStore
                ? $"NOT EXISTS (SELECT 1 FROM __nendo_media_content c WHERE c.sha256 = substr(t.{column}, {NendoMedia.EmbeddedScheme.Length + 1}))"
                : "1";
            foreach (var slice in slices)
            {
                var names = slice?.Select((_, index) => $"@id{index.ToString(CultureInfo.InvariantCulture)}").ToArray() ?? [];
                var filter = slice is null ? string.Empty : $" AND t.__nendo_record_id IN ({string.Join(", ", names)})";
                await using var query = Command($"""
                    SELECT t.__nendo_record_id FROM {Quote(entity.PhysicalTableName)} t
                    WHERE t.{column} LIKE '{NendoMedia.EmbeddedScheme}%' AND {missing}{filter}
                    ORDER BY t.__nendo_record_id LIMIT 1;
                    """, transaction);
                for (var index = 0; index < names.Length; index++) query.Parameters.AddWithValue(names[index], slice![index]);
                if (await query.ExecuteScalarAsync(ct) is string recordId)
                    throw new NendoPreconditionException("media-missing",
                        $"{entity.DisplayName} {recordId} names a picture in {field.DisplayName} that the file does not hold. " +
                        "Embed the picture in the same change, or name one the file already holds.");
            }
        }
    }
}
