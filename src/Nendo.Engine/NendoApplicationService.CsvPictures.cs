namespace Nendo.Engine;

/// <summary>
/// CSV with pictures (ADR-0031 point 14, W-272). A CSV holds a media field's address like any
/// text. Export with pictures writes each embedded picture into a folder beside the CSV and names
/// it there by a relative address, so the CSV and its folder carry the pictures to another file;
/// embedding a record type's linked pictures brings them into that file.
/// </summary>
public sealed partial class NendoApplicationService
{
    /// <summary>The folder an export with pictures writes beside its CSV.</summary>
    public const string CsvPictureFolder = "Media";

    /// <summary>
    /// Writes every embedded picture a record type's media fields name into
    /// <c>{csvFolder}\Media</c>, once each, and answers the address each is named by in the
    /// CSV, keyed by its SHA-256: <c>.\Media\{file}</c>, which a file opened beside that folder
    /// reads as a linked picture. A file name comes from the picture's name, and a different
    /// picture already there under that name is never overwritten.
    /// </summary>
    public async Task<IReadOnlyDictionary<string, string>> ExportCsvPicturesAsync(string entityId, string csvFolder,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(csvFolder);
        var entity = await RequireCsvEntityAsync(entityId, cancellationToken);
        var mediaFields = MediaFieldsOf(entity);
        var addresses = new Dictionary<string, string>(StringComparer.Ordinal);
        if (mediaFields.Length == 0) return addresses;
        var folder = Path.Combine(csvFolder, CsvPictureFolder);
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? cursor = null;
        do
        {
            var page = await QueryRecordsAsync(new(entityId, 50, cursor), cancellationToken);
            foreach (var record in page.Items)
            foreach (var field in mediaFields)
            {
                if (!record.Values.TryGetValue(field.FieldId, out var value) || value.ValueKind != System.Text.Json.JsonValueKind.String ||
                    !NendoMediaAddress.TryParse(value.GetString(), out var address) || address!.Sha256 is not { } sha ||
                    addresses.ContainsKey(sha)) continue;
                if (await ReadMediaAsync(sha, cancellationToken) is not { } item ||
                    await ReadMediaContentAsync(sha, cancellationToken) is not { } content) continue;
                Directory.CreateDirectory(folder);
                addresses[sha] = @".\" + CsvPictureFolder + @"\" + await PlacePictureAsync(folder, item, content, taken, cancellationToken);
            }
            cursor = page.NextCursor;
        } while (cursor is not null);
        return addresses;
    }

    /// <summary>
    /// Copies every linked picture file a record type's media fields name into the file, one
    /// revision each, and sets the field to the embedded address. A relative address is read
    /// against <paramref name="fileFolder"/>, the folder holding the open file. Web pictures stay
    /// links, and a file that is not there or is not a picture is listed and left as it is.
    /// </summary>
    public async Task<NendoEmbedLinkedResult> EmbedLinkedPicturesAsync(string entityId, string? fileFolder, NendoRequestContext context,
        CancellationToken cancellationToken = default)
    {
        RequireContext(context);
        var entity = await RequireCsvEntityAsync(entityId, cancellationToken);
        var mediaFields = MediaFieldsOf(entity);
        // The links first, then the writes: a write moves the file on, and a page cursor with it.
        var links = new List<(string RecordId, NendoFieldSnapshot Field, NendoMediaAddress Address)>();
        string? cursor = null;
        do
        {
            var page = await QueryRecordsAsync(new(entityId, 50, cursor), cancellationToken);
            foreach (var record in page.Items)
            foreach (var field in mediaFields)
                if (record.Values.TryGetValue(field.FieldId, out var value) && value.ValueKind == System.Text.Json.JsonValueKind.String &&
                    NendoMediaAddress.TryParse(value.GetString(), out var address) &&
                    address!.Source is NendoMediaSource.LocalAbsolute or NendoMediaSource.LocalRelative)
                    links.Add((record.RecordId, field, address));
            cursor = page.NextCursor;
        } while (cursor is not null);

        var embedded = 0;
        var left = new List<NendoLinkedPictureLeft>();
        for (var index = 0; index < links.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var (recordId, field, address) = links[index];
            var path = address.Source == NendoMediaSource.LocalAbsolute ? address.Value
                : fileFolder is null ? null : Path.GetFullPath(Path.Combine(fileFolder, address.Value));
            var info = path is null ? null : new FileInfo(path);
            if (info is not { Exists: true }) { left.Add(new(recordId, field.FieldId, address.Value, "The file is not there.")); continue; }
            if (info.Length > NendoMedia.MaximumItemBytes)
            {
                left.Add(new(recordId, field.FieldId, address.Value, $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB."));
                continue;
            }
            var record = (await QueryRecordsAsync(new(entityId, 1) { RecordId = recordId }, cancellationToken)).Items.SingleOrDefault();
            if (record is null || !record.Values.TryGetValue(field.FieldId, out var now) || now.ValueKind != System.Text.Json.JsonValueKind.String ||
                now.GetString() != address.Value) continue;
            try
            {
                var content = await File.ReadAllBytesAsync(info.FullName, cancellationToken);
                await PutMediaAsync(new(content, null, Truncate(info.Name, NendoMedia.MaximumNameCharacters),
                    context with { IdempotencyKey = $"{context.IdempotencyKey}#{index}" },
                    new(entityId, recordId, field.FieldId, record.RecordVersion)), cancellationToken);
                embedded++;
            }
            catch (NendoException exception)
            {
                left.Add(new(recordId, field.FieldId, address.Value, exception.Message));
            }
        }
        return new(embedded, left);
    }

    private async Task<NendoEntitySnapshot> RequireCsvEntityAsync(string entityId, CancellationToken cancellationToken) =>
        (await GetDefinitionSnapshotAsync(cancellationToken)).Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");

    private static NendoFieldSnapshot[] MediaFieldsOf(NendoEntitySnapshot entity) =>
        [.. entity.Fields.Where(field => !field.Retired && field.Presentation == NendoMedia.Presentation)];

    /// <summary>A media field's value as an export with pictures writes it: an embedded picture's address in the folder.</summary>
    private static System.Text.Json.JsonElement PictureAddressFor(NendoFieldSnapshot field, System.Text.Json.JsonElement value,
        IReadOnlyDictionary<string, string>? pictureAddresses) =>
        pictureAddresses is not null && field.Presentation == NendoMedia.Presentation &&
        value.ValueKind == System.Text.Json.JsonValueKind.String &&
        NendoMediaAddress.TryParse(value.GetString(), out var address) && address!.Sha256 is { } sha &&
        pictureAddresses.TryGetValue(sha, out var written)
            ? System.Text.Json.JsonSerializer.SerializeToElement(written)
            : value;

    /// <summary>
    /// The file a picture is written to in the folder: its own name, then its name with the start
    /// of its hash, then its hash. A file already there with the same bytes is the same picture.
    /// </summary>
    private static async Task<string> PlacePictureAsync(string folder, NendoMediaItem item, byte[] content, HashSet<string> taken,
        CancellationToken cancellationToken)
    {
        var extension = NendoMedia.PictureTypes[item.MediaType][0];
        var stem = SafeStem(item.Name) ?? item.Sha256[..12];
        foreach (var candidate in new[] { stem + extension, $"{stem}-{item.Sha256[..8]}{extension}", item.Sha256 + extension })
        {
            if (taken.Contains(candidate)) continue;
            var path = Path.Combine(folder, candidate);
            if (File.Exists(path))
            {
                if (!(await File.ReadAllBytesAsync(path, cancellationToken)).AsSpan().SequenceEqual(content)) continue;
            }
            else
            {
                await using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true);
                await file.WriteAsync(content, cancellationToken);
            }
            taken.Add(candidate);
            return candidate;
        }
        throw new NendoValidationException($"{folder} already holds other files under the names {stem}{extension} and {item.Sha256}{extension}.");
    }

    /// <summary>A picture's name as a file name without its extension, or null when nothing of it is usable.</summary>
    private static string? SafeStem(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var stem = Path.GetFileNameWithoutExtension(name.Replace('/', '_').Replace('\\', '_'));
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string([.. stem.Select(character => invalid.Contains(character) || char.IsControl(character) ? '_' : character)]);
        safe = Truncate(safe, 80).Trim().TrimEnd('.').Trim();
        return safe.Length == 0 || safe is "." or ".." ? null : safe;
    }

    private static string Truncate(string text, int length) => text.Length > length ? text[..length] : text;
}

/// <summary>What embedding a record type's linked pictures did: how many it embedded, and each link it left.</summary>
public sealed record NendoEmbedLinkedResult(int Embedded, IReadOnlyList<NendoLinkedPictureLeft> Left);

/// <summary>A linked picture left as a link, and why.</summary>
public sealed record NendoLinkedPictureLeft(string RecordId, string FieldId, string Address, string Reason);
