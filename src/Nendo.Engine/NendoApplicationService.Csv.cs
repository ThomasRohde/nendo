namespace Nendo.Engine;

public sealed partial class NendoApplicationService
{
    public async Task<NendoCsvBatchPreview> PrepareCsvBatchAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, string batchId,
        CancellationToken cancellationToken = default, long? expectedDefinitionRevision = null)
    {
        ArgumentNullException.ThrowIfNull(document); ArgumentNullException.ThrowIfNull(mappings);
        if (document.Headers.Count is 0 or > NendoCsvProfile.MaximumColumns ||
            document.Headers.Any(string.IsNullOrWhiteSpace) ||
            document.Headers.Distinct(StringComparer.Ordinal).Count() != document.Headers.Count ||
            document.Rows.Any(row => row.Count != document.Headers.Count) ||
            document.Headers.Concat(document.Rows.SelectMany(row => row)).Any(cell => cell is null || cell.Length > NendoCsvProfile.MaximumCellCharacters))
            throw new NendoValidationException("CSV columns, headers or cell lengths are invalid.");
        if (offset < 0 || offset >= document.Rows.Count || document.Rows.Count > NendoCsvProfile.MaximumRows)
            throw new NendoValidationException("CSV batch offset is outside the document.");
        RequireIdentity(batchId, "CSV batch ID");
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        if (expectedDefinitionRevision is { } expected && expected != definition.Manifest.DefinitionRevision)
            throw new NendoPreconditionException("stale-csv-schema", "The record definition changed. Review CSV mapping again.");
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        if (mappings.Count == 0 || mappings.Select(mapping => mapping.FieldId).Distinct(StringComparer.Ordinal).Count() != mappings.Count ||
            mappings.Any(mapping => mapping.Column < 0 || mapping.Column >= document.Headers.Count || !fields.ContainsKey(mapping.FieldId)) ||
            fields.Values.Any(field => MustBeMapped(field) && !mappings.Any(mapping => mapping.FieldId == field.FieldId)))
            throw new NendoValidationException("Map each required field once to an existing CSV column.");
        var rows = await DecodeRowsAsync(document, entity, mappings, options, offset, NendoCsvProfile.BatchSize, cancellationToken,
            recordIdOfRow: row => row >= offset && row < offset + NendoCsvProfile.BatchSize
                ? NendoCanonical.DeterministicId("record", "csv.import", batchId, row)
                : null);
        var operations = new List<NendoOperation>();
        for (var index = 0; index < rows.Count; index++)
        {
            var ordinal = offset + index;
            operations.Add(new CreateRecordOperation(NendoCanonical.DeterministicId("operation", "csv.import", batchId, ordinal), entityId,
                NendoCanonical.DeterministicId("record", "csv.import", batchId, ordinal), rows[index].Values, rows[index].ExpectedTargetVersions));
        }
        var proposal = await PrepareProposalAsync(new NendoProposalRequest("proposal-" + batchId, $"Import {rows.Count} CSV records", "csv",
            new([new("csv.import", batchId, "csv", CsvBatchDescription(rows.Select(row => row.SourceRow).ToArray()), operations)])), cancellationToken);
        if (proposal.CapturedDefinitionRevision != definition.Manifest.DefinitionRevision)
        {
            await RejectProposalAsync(proposal.ProposalId, cancellationToken);
            throw new NendoPreconditionException("stale-csv-schema", "The record definition changed. Review CSV mapping again.");
        }
        return new(proposal, rows);
    }

    /// <summary>
    /// What History calls a batch: the rows of the file it holds, which after parents-first
    /// ordering need not be the batch's positions (ESQ-14). Runs of rows read as ranges, and a
    /// long list ends in an ellipsis.
    /// </summary>
    internal static string CsvBatchDescription(IReadOnlyList<int> sourceRows)
    {
        var runs = new List<string>();
        for (var index = 0; index < sourceRows.Count;)
        {
            var end = index;
            while (end + 1 < sourceRows.Count && sourceRows[end + 1] == sourceRows[end] + 1) end++;
            runs.Add(end == index ? $"{sourceRows[index]}" : $"{sourceRows[index]}–{sourceRows[end]}");
            index = end + 1;
        }
        return runs.Count switch
        {
            1 when sourceRows.Count == 1 => $"Import CSV row {runs[0]}",
            1 => $"Import CSV rows {runs[0]}",
            <= 6 => $"Import {sourceRows.Count} CSV rows: {string.Join(", ", runs)}",
            _ => $"Import {sourceRows.Count} CSV rows: {string.Join(", ", runs.Take(5))}, …",
        };
    }

    /// <summary>
    /// Turns a window of CSV rows into validated field values, with the current version of
    /// every reference target they name.
    /// <para>
    /// Extracted from the batch preview above so the native importer and the agent one
    /// decode identically. They diverge after this point on purpose -- the native path
    /// wraps the rows in a proposal because a person reviews each batch, the agent path
    /// commits them as ordinary record operations because nobody is reviewing -- but what
    /// a cell means must not be one of the things they can disagree about.
    /// </para>
    /// <para>
    /// <paramref name="resolveTargetVersions"/> names, by zero-based document row, the rows
    /// whose reference targets are looked up; the others come back with values only and an
    /// empty version map. An import retry passes it so rows a committed batch already holds
    /// are not re-resolved against targets edited since: those rows are replayed from their
    /// receipt with the versions they were committed at, never applied again. Every row that
    /// may still be written is resolved and validated as before. Null resolves every row.
    /// </para>
    /// </summary>
    public async Task<IReadOnlyList<NendoCsvRow>> DecodeCsvRowsAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, int count,
        CancellationToken cancellationToken = default, Func<int, bool>? resolveTargetVersions = null,
        Func<int, string?>? recordIdOfRow = null)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(mappings);
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        if (mappings.Count == 0) throw new NendoValidationException("Map at least one CSV column to a field ID.");
        var mappedFields = new HashSet<string>(StringComparer.Ordinal);
        foreach (var mapping in mappings)
        {
            if (mapping.Column < 0 || mapping.Column >= document.Headers.Count)
                throw new NendoValidationException($"CSV column {mapping.Column} is outside the header.");
            if (string.IsNullOrWhiteSpace(mapping.FieldId) || !fields.ContainsKey(mapping.FieldId))
                throw new NendoValidationException($"CSV mapping field {mapping.FieldId} does not exist or is retired.");
            if (!mappedFields.Add(mapping.FieldId))
                throw new NendoValidationException($"CSV mapping repeats field {mapping.FieldId}.");
        }
        if (fields.Values.Any(field => MustBeMapped(field) && !mappedFields.Contains(field.FieldId)))
            throw new NendoValidationException("Map each required field once to an existing CSV column.");
        return await DecodeRowsAsync(document, entity, mappings, options, offset, count, cancellationToken, resolveTargetVersions, recordIdOfRow);
    }

    /// <summary>
    /// A required field needs a column, except one with a sequence: the host fills it with
    /// the next code when the row is written, as it does for a create that leaves it out,
    /// so an import may leave it unmapped or its cells empty (ADR-0020; F-259).
    /// </summary>
    private static bool MustBeMapped(NendoFieldSnapshot field) => field.Required && field.Sequence is null;

    /// <summary>
    /// The document with a declared hierarchy's rows put parents first, when its parent
    /// column is matched by a code the same import carries (W-075). Both importers call it
    /// before they cut batches, so a parent is always written before the rows under it.
    /// </summary>
    public async Task<NendoCsvDocument> OrderCsvParentsFirstAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, CancellationToken cancellationToken = default, NendoCsvOptions? options = null)
    {
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        return NendoCsvReferenceCodes.OrderParentsFirst(document, entity, mappings, options);
    }

    /// <summary>
    /// The reference target versions each record written by <paramref name="revisionId"/> was
    /// checked against, by record ID and then by field, read from that revision's own stored
    /// operations: a create's <c>expectedTargetVersions</c> and a set-field's
    /// <c>expectedTargetRecordVersion</c>.
    /// <para>
    /// This is the original evidence a retry needs: a committed write's receipt replays only
    /// for the payload it was committed with, and that payload carries the target versions
    /// of the moment it was written, not of the retry. The import's batches have used it
    /// since R-006; since 2026-10-04 the record writes that resolve a reference do too (F-258).
    /// </para>
    /// </summary>
    public async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>> ReadRecordedTargetVersionsAsync(
        string revisionId, CancellationToken cancellationToken = default)
    {
        RequireIdentity(revisionId, "revision ID");
        var written = new Dictionary<string, Dictionary<string, long>>(StringComparer.Ordinal);
        string? cursor = null;
        do
        {
            var page = await QueryRevisionOperationsAsync(new(revisionId, 200, cursor), cancellationToken);
            foreach (var operation in page.Items)
            {
                if (operation.OperationType is not ("data.createRecord" or "data.setField")) continue;
                using var json = System.Text.Json.JsonDocument.Parse(operation.CanonicalJson);
                if (!json.RootElement.TryGetProperty("payload", out var payload) ||
                    !payload.TryGetProperty("recordId", out var recordId) ||
                    recordId.ValueKind != System.Text.Json.JsonValueKind.String) continue;
                if (!written.TryGetValue(recordId.GetString()!, out var versions))
                    written[recordId.GetString()!] = versions = new Dictionary<string, long>(StringComparer.Ordinal);
                if (operation.OperationType == "data.createRecord")
                {
                    if (payload.TryGetProperty("expectedTargetVersions", out var expected) &&
                        expected.ValueKind == System.Text.Json.JsonValueKind.Object)
                    {
                        foreach (var pair in expected.EnumerateObject())
                            if (pair.Value.TryGetInt64(out var version)) versions[pair.Name] = version;
                    }
                }
                else if (payload.TryGetProperty("fieldId", out var fieldId) && fieldId.ValueKind == System.Text.Json.JsonValueKind.String &&
                    payload.TryGetProperty("expectedTargetRecordVersion", out var target) && target.TryGetInt64(out var targetVersion))
                {
                    versions[fieldId.GetString()!] = targetVersion;
                }
            }
            cursor = page.NextCursor;
        } while (cursor is not null);
        return written.ToDictionary(pair => pair.Key, pair => (IReadOnlyDictionary<string, long>)pair.Value, StringComparer.Ordinal);
    }

    private async Task<IReadOnlyList<NendoCsvRow>> DecodeRowsAsync(NendoCsvDocument document, NendoEntitySnapshot entity,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, int count,
        CancellationToken cancellationToken, Func<int, bool>? resolveTargetVersions = null,
        Func<int, string?>? recordIdOfRow = null)
    {
        var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        var rows = new List<NendoCsvRow>();
        // A column matched by a code is looked up by its own resolver, built once for the call.
        var resolvers = new Dictionary<string, CsvCodeResolver>(StringComparer.Ordinal);
        if (mappings.Any(mapping => mapping.MatchFieldId is not null))
        {
            var definition = await GetDefinitionSnapshotAsync(cancellationToken);
            foreach (var mapping in mappings.Where(mapping => mapping.MatchFieldId is not null))
                resolvers[mapping.FieldId] = await CsvCodeResolver.CreateAsync(
                    this, definition.Entities, entity, fields[mapping.FieldId], mapping, mappings, document, options, cancellationToken);
        }
        // One lookup per distinct target rather than per row: a hundred rows pointing at
        // the same parent record used to be a hundred reads of it.
        var targets = new Dictionary<(string Entity, string Record), long>();
        for (var index = offset; index < Math.Min(document.Rows.Count, offset + count); index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var values = new Dictionary<string, object?>(); var versions = new Dictionary<string, long>();
            var resolve = resolveTargetVersions?.Invoke(index) ?? true;
            foreach (var mapping in mappings)
            {
                var field = fields[mapping.FieldId];
                try
                {
                    var value = NendoCsvProfile.Decode(document.Rows[index][mapping.Column], field, options);
                    if (value is string code && resolvers.TryGetValue(field.FieldId, out var resolver))
                    {
                        var (recordId, targetVersion) = resolver.Resolve(code, index, document, recordIdOfRow);
                        values.Add(field.FieldId, recordId);
                        if (resolve) versions.Add(field.FieldId, targetVersion);
                        continue;
                    }
                    if (field.Presentation == NendoMedia.Presentation && value is string text)
                        await RequireCsvPictureAsync(text, cancellationToken);
                    values.Add(field.FieldId, value);
                    if (resolve && value is string id && field.Reference is { } reference)
                    {
                        var key = (reference.TargetEntityId, id);
                        if (!targets.TryGetValue(key, out var version))
                        {
                            var page = await QueryRecordsAsync(new(reference.TargetEntityId, 1) { RecordId = id }, cancellationToken);
                            version = page.Items.SingleOrDefault()?.RecordVersion ?? throw new NendoValidationException("Reference target does not exist.");
                            targets.Add(key, version);
                        }
                        versions.Add(field.FieldId, version);
                    }
                }
                // The row number a person counts in their own file: one-based, past the header.
                catch (NendoException exception) { throw new NendoValidationException($"CSV row {document.SourceRowNumber(index)}, {field.DisplayName}: {exception.Message}"); }
            }
            rows.Add(new(document.SourceRowNumber(index), values, versions));
        }
        return rows;
    }

    /// <summary>
    /// A media field's cell names a picture: an address, and for an embedded one a picture this
    /// file holds (ADR-0031, W-272). Refused here, so the review names the row, rather than when
    /// the batch is applied.
    /// </summary>
    private async Task RequireCsvPictureAsync(string text, CancellationToken cancellationToken)
    {
        if (!NendoMediaAddress.TryParse(text, out var address))
            throw new NendoValidationException($"“{text}” is not a picture's address: media: and a SHA-256, an https: address, or a file path.");
        if (address!.Sha256 is { } sha && await ReadMediaAsync(sha, cancellationToken) is null)
            throw new NendoValidationException($"this file does not hold the picture {text}. Export with pictures, and import beside its Media folder.");
    }

    /// <summary>
    /// One page of a faithful CSV export, written into <paramref name="writer"/>.
    /// <para>
    /// The whole-file export below is this method in a loop, and so is the agent's paged
    /// export resource. <paramref name="cursor"/> is null for the first page, which is
    /// also the only page that writes the header row.
    /// </para>
    /// </summary>
    public async Task<NendoCsvExportPage> ExportCsvPageAsync(string entityId, TextWriter writer, string? cursor, int limit,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(writer);
        if (limit is < 1 or > 200) throw new NendoValidationException("A CSV export page holds 1 to 200 records.");
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        var fields = entity.Fields.Where(field => !field.Retired).ToArray();
        if (fields.Length == 0) throw new NendoValidationException("There are no active fields to export.");
        if (cursor is null)
        {
            await writer.WriteAsync((string.Join(',', fields.Select(field => NendoCsvProfile.Quote(field.DisplayName))) + "\r\n").AsMemory(), cancellationToken);
        }
        var page = await QueryRecordsAsync(new(entityId, limit, cursor), cancellationToken);
        foreach (var record in page.Items)
        {
            await writer.WriteAsync((string.Join(',', fields.Select(field => NendoCsvProfile.Encode(record.Values.GetValueOrDefault(field.FieldId)))) + "\r\n").AsMemory(), cancellationToken);
        }
        return new NendoCsvExportPage(
            page.Items.Count,
            page.NextCursor,
            page.ChangeSequence,
            fields.Select(field => field.FieldId).ToArray());
    }

    /// <summary>
    /// The native export's file: the whole export written to <paramref name="destination"/> in
    /// <see cref="NendoCsvProfile.FileEncoding"/>, so it starts with UTF-8's byte-order mark and a
    /// spreadsheet opened on it reads æ, ø and å (R2LAT-11). The stream stays open.
    /// </summary>
    /// <para>
    /// With <paramref name="pictureAddresses"/>, from <see cref="ExportCsvPicturesAsync"/>, a media
    /// field names each embedded picture by where that call wrote it (W-272).
    /// </para>
    public async Task<int> ExportCsvFileAsync(string entityId, Stream destination, CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? pictureAddresses = null)
    {
        ArgumentNullException.ThrowIfNull(destination);
        await using var writer = new StreamWriter(destination, NendoCsvProfile.FileEncoding, leaveOpen: true);
        var count = await ExportCsvAsync(entityId, writer, cancellationToken, pictureAddresses);
        await writer.FlushAsync(cancellationToken);
        return count;
    }

    public async Task<int> ExportCsvAsync(string entityId, TextWriter writer, CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? pictureAddresses = null)
    {
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        var fields = entity.Fields.Where(field => !field.Retired).ToArray();
        if (fields.Length == 0) throw new NendoValidationException("There are no active fields to export.");
        await writer.WriteAsync((string.Join(',', fields.Select(field => NendoCsvProfile.Quote(field.DisplayName))) + "\r\n").AsMemory(), cancellationToken);
        string? cursor = null; var count = 0;
        do
        {
            var page = await QueryRecordsAsync(new(entityId, 50, cursor), cancellationToken);
            if (page.ChangeSequence != definition.Manifest.ChangeSequence)
                throw new NendoPreconditionException("stale-csv-export", "The file changed during export. Retry from its current state.");
            foreach (var record in page.Items)
            {
                await writer.WriteAsync((string.Join(',', fields.Select(field =>
                    NendoCsvProfile.Encode(PictureAddressFor(field, record.Values.GetValueOrDefault(field.FieldId), pictureAddresses)))) + "\r\n").AsMemory(), cancellationToken);
                count++;
            }
            cursor = page.NextCursor;
        } while (cursor is not null);
        if ((await GetDefinitionSnapshotAsync(cancellationToken)).Manifest.ChangeSequence != definition.Manifest.ChangeSequence)
            throw new NendoPreconditionException("stale-csv-export", "The file changed during export. Retry from its current state.");
        return count;
    }
}
