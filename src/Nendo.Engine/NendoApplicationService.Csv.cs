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
            fields.Values.Any(field => field.Required && !mappings.Any(mapping => mapping.FieldId == field.FieldId)))
            throw new NendoValidationException("Map each required field once to an existing CSV column.");
        var rows = await DecodeRowsAsync(document, entity, mappings, options, offset, NendoCsvProfile.BatchSize, cancellationToken);
        var operations = new List<NendoOperation>();
        for (var index = 0; index < rows.Count; index++)
        {
            var ordinal = offset + index;
            operations.Add(new CreateRecordOperation(NendoCanonical.DeterministicId("operation", "csv.import", batchId, ordinal), entityId,
                NendoCanonical.DeterministicId("record", "csv.import", batchId, ordinal), rows[index].Values, rows[index].ExpectedTargetVersions));
        }
        var proposal = await PrepareProposalAsync(new NendoProposalRequest("proposal-" + batchId, $"Import {rows.Count} CSV records", "csv",
            new([new("csv.import", batchId, "csv", $"Import CSV rows {offset + 2}–{offset + rows.Count + 1}", operations)])), cancellationToken);
        if (proposal.CapturedDefinitionRevision != definition.Manifest.DefinitionRevision)
        {
            await RejectProposalAsync(proposal.ProposalId, cancellationToken);
            throw new NendoPreconditionException("stale-csv-schema", "The record definition changed. Review CSV mapping again.");
        }
        return new(proposal, rows);
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
    /// </summary>
    public async Task<IReadOnlyList<NendoCsvRow>> DecodeCsvRowsAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, int count,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(document);
        var definition = await GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(entity => entity.EntityId == entityId && !entity.Retired)
            ?? throw new NendoValidationException("Choose an active record type.");
        return await DecodeRowsAsync(document, entity, mappings, options, offset, count, cancellationToken);
    }

    private async Task<IReadOnlyList<NendoCsvRow>> DecodeRowsAsync(NendoCsvDocument document, NendoEntitySnapshot entity,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, int count,
        CancellationToken cancellationToken)
    {
        var fields = entity.Fields.Where(field => !field.Retired).ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        var rows = new List<NendoCsvRow>();
        // One lookup per distinct target rather than per row: a hundred rows pointing at
        // the same parent record used to be a hundred reads of it.
        var targets = new Dictionary<(string Entity, string Record), long>();
        for (var index = offset; index < Math.Min(document.Rows.Count, offset + count); index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var values = new Dictionary<string, object?>(); var versions = new Dictionary<string, long>();
            foreach (var mapping in mappings)
            {
                var field = fields[mapping.FieldId];
                try
                {
                    var value = NendoCsvProfile.Decode(document.Rows[index][mapping.Column], field, options);
                    values.Add(field.FieldId, value);
                    if (value is string id && field.Reference is { } reference)
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
                catch (NendoException exception) { throw new NendoValidationException($"CSV row {index + 2}, {field.DisplayName}: {exception.Message}"); }
            }
            rows.Add(new(index + 2, values, versions));
        }
        return rows;
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

    public async Task<int> ExportCsvAsync(string entityId, TextWriter writer, CancellationToken cancellationToken = default)
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
                await writer.WriteAsync((string.Join(',', fields.Select(field => NendoCsvProfile.Encode(record.Values.GetValueOrDefault(field.FieldId)))) + "\r\n").AsMemory(), cancellationToken);
                count++;
            }
            cursor = page.NextCursor;
        } while (cursor is not null);
        if ((await GetDefinitionSnapshotAsync(cancellationToken)).Manifest.ChangeSequence != definition.Manifest.ChangeSequence)
            throw new NendoPreconditionException("stale-csv-export", "The file changed during export. Retry from its current state.");
        return count;
    }
}
