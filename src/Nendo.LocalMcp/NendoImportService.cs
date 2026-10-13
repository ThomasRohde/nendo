using System.ComponentModel;
using System.Security.Cryptography;
using System.Text;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>One CSV column bound to one stable field ID.</summary>
/// <param name="Column">
/// Zero-based index into the header row. An index, not a header name: two columns may
/// carry the same display name, and a mapping that resolved by name would silently take
/// whichever came first.
/// </param>
public sealed record NendoCsvColumnMapping(int Column, string FieldId)
{
    /// <summary>
    /// For a reference column: the unique field of the target record type whose values the
    /// cells hold, such as a code (W-075). Null means the cells hold record IDs.
    /// </summary>
    [Description("For a reference column only: the ID of a unique field of the target record type whose values the cells hold, such as a code. A cell then names a row of this same import or a record the file holds; one that names nothing, or two things, is refused with its row. Omit it and the cells are record IDs.")]
    public string? MatchFieldId { get; init; }
}

/// <summary>
/// What an import committed, and what is left.
/// </summary>
/// <param name="Committed">
/// How many records reached the file. Exact, and never rounded up to the number sent: an
/// import is a run of all-or-nothing revisions rather than one atomic act, so a call that
/// stops partway has really written this many.
/// </param>
/// <param name="Remaining">
/// How many rows of this call's own payload were not attempted. Zero on success.
/// </param>
/// <param name="RecordIds">Every record ID created, in the order the rows arrived.</param>
/// <param name="RevisionCount">
/// How many revisions it took. Each is one all-or-nothing batch with its own idempotency
/// key derived from the caller's, so an exact retry of this call replays the batches that
/// committed and attempts only the ones that did not.
/// </param>
public sealed record NendoImportResult(
    [property: Description("The record type imported into.")]
    string EntityId,
    [property: Description("How many records reached the file, exactly.")]
    int Committed,
    [property: Description("How many rows of this call were not attempted. Zero on success.")]
    int Remaining,
    [property: Description("Every record ID created, in the order the rows arrived.")]
    IReadOnlyList<string> RecordIds,
    [property: Description("How many revisions the import took, one per batch of fifty, each with a key derived from yours.")]
    int RevisionCount,
    [property: Description("The file's data revision after the last committed batch.")]
    long DataRevision,
    [property: Description("The most rows one call may carry.")]
    int MaximumRowsPerCall,
    [property: Description("True when every batch was an earlier import under this key, replayed: nothing was written now, and the records named may have changed or been deleted since.")]
    bool IsIdempotentReplay,
    [property: Description("How many of the revisions were replays of batches an earlier call under this key committed.")]
    int ReplayedRevisions);

internal sealed class NendoImportPartialException(
    int committed,
    int remaining,
    IReadOnlyList<string> revisionIds,
    Exception cause) : Exception("A later import batch was refused.", cause)
{
    internal int Committed { get; } = committed;
    internal int Remaining { get; } = remaining;
    internal int FirstUncommittedRow { get; } = committed + 1;
    internal IReadOnlyList<string> RevisionIds { get; } = revisionIds;
    internal Exception Cause { get; } = cause;
}

/// <summary>
/// Bulk record import for an agent: faithful CSV or typed JSON in, ordinary canonical
/// record operations out.
/// <para>
/// Both formats converge the moment their rows are decoded, and neither is a second
/// persistence or validation route: every batch is the same
/// <c>NendoApplicationService.CreateRecordsAsync</c> that <c>nendo.data.create_records</c>
/// calls, with the same per-record validation, the same all-or-nothing revision and the
/// same receipt.
/// </para>
/// <para>
/// Deliberately not the native importer's proposal-per-batch path. That exists so a
/// person can review a hundred rows before they land, and it clones the file to do it.
/// Nobody is reviewing here, and paying for a physical clone per hundred records to
/// produce operations the data tools already permit would be a cost with no reader.
/// </para>
/// </summary>
internal sealed class NendoImportService(NendoApplicationService application)
{
    /// <summary>
    /// The most rows one call may carry.
    /// <para>
    /// The binding limit is the transport, not the CSV profile's ten thousand: a request
    /// body is capped at 256 KiB, so a call much larger than this is refused by the
    /// perimeter with a message about bytes rather than about rows. Stating a row count
    /// the caller can plan against is the more useful refusal, and the response echoes it
    /// so a loop can be written from one reply.
    /// </para>
    /// </summary>
    internal static readonly int MaximumRowsPerCall = NendoAuthoringLimits.Current.Import!.RowsPerCall;

    /// <summary>Rows per revision, matching what the data tools already commit at once.</summary>
    private static readonly int BatchSize = NendoAuthoringLimits.Current.Import!.RowsPerBatch;

    // Internal fault boundary for deterministic partial-failure tests; never a tool or host setting.
    internal Action<int>? BeforeBatch { get; set; }

    private const int MaximumCsvCharacters = 1024 * 1024;

    internal async Task<NendoImportResult> ImportCsvAsync(
        string entityId,
        string csv,
        IReadOnlyList<NendoCsvColumnMapping> columnMappings,
        bool nendoProfile,
        bool emptyIsNull,
        string idempotencyKey,
        string origin,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(csv);
        ArgumentNullException.ThrowIfNull(columnMappings);
        if (csv.Length > MaximumCsvCharacters)
        {
            throw new NendoValidationException(
                $"The CSV text is longer than {MaximumCsvCharacters} characters. Send it in parts.");
        }
        if (columnMappings.Count == 0)
        {
            throw new NendoValidationException("Map at least one CSV column to a field ID.");
        }
        var document = NendoCsvProfile.Parse(Encoding.UTF8.GetBytes(csv), cancellationToken);
        RequireRowCount(document.Rows.Count);
        var mappings = columnMappings
            .Select(mapping => new NendoCsvMapping(mapping.Column, mapping.FieldId) { MatchFieldId = mapping.MatchFieldId })
            .ToArray();
        await RequireTargetAsync(entityId, mappings, cancellationToken);
        // A tree whose parent column holds codes is written parents first (W-075). The order
        // is a pure function of the text, so an exact retry derives the same record IDs.
        var options = new NendoCsvOptions(nendoProfile, emptyIsNull);
        document = await application.OrderCsvParentsFirstAsync(document, entityId, mappings, cancellationToken, options);
        var seed = Seed(idempotencyKey);

        // A CSV row carries no reference target versions; decoding reads the current ones.
        // For a batch this key already committed, the current ones are the wrong evidence:
        // the receipt replays only the payload it was written with, and a target edited
        // since would turn an exact retry into a "different payload" (R-006). So the
        // committed batches are found first, by their receipts, and their rows carry the
        // versions their own revision recorded. Only rows that may still be written are
        // resolved against the file as it is now, and validated as before.
        var committedVersions = await ReadCommittedTargetVersionsAsync(
            idempotencyKey, document.Rows.Count, cancellationToken);
        var decoded = await application.DecodeCsvRowsAsync(
            document,
            entityId,
            mappings,
            options,
            0,
            document.Rows.Count,
            cancellationToken,
            row => committedVersions[row / BatchSize] is null,
            row => $"import.{seed}.{row}");

        // A CSV row carries no record ID, so one is derived from the caller's key and the
        // row's position. Stable, which is what makes an exact retry ask for the same
        // records rather than a second copy of them, and distinct from another import
        // in the same record type. Record identity includes the record type.
        RequireValueBounds(decoded);
        var records = decoded
            .Select((row, index) =>
            {
                var recordId = $"import.{seed}.{index}";
                var versions = row.ExpectedTargetVersions;
                if (committedVersions[index / BatchSize] is { } committed)
                {
                    // A row the committed batch does not hold, or whose reference it did not
                    // carry, makes a different payload, which the receipt refuses as one.
                    versions = committed.TryGetValue(recordId, out var recorded)
                        ? recorded.Where(pair => row.Values.ContainsKey(pair.Key))
                            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
                        : versions;
                }
                return new NendoCreateRecordEntry(recordId, row.Values, versions);
            })
            .ToArray();
        // Every row is decoded and checked above, before anything is written. A batch after the
        // first is decoded again just before it commits: a batch before it may have moved a
        // record its rows point at, its automatic actions included, and the versions read at the
        // start would refuse it as target-version-conflict (MTD-01). A batch an earlier call
        // committed keeps the versions its receipt recorded.
        return await CommitAsync(entityId, records.Length, async (ordinal, offset, count) =>
        {
            if (ordinal == 0 || committedVersions[ordinal] is not null) return records[offset..(offset + count)];
            var fresh = await application.DecodeCsvRowsAsync(
                document, entityId, mappings, options, offset, count, cancellationToken,
                recordIdOfRow: row => $"import.{seed}.{row}");
            return fresh.Select((row, index) => new NendoCreateRecordEntry($"import.{seed}.{offset + index}", row.Values, row.ExpectedTargetVersions)).ToArray();
        }, idempotencyKey, origin, cancellationToken);
    }

    /// <summary>
    /// Refuses an import into a record type the file does not hold, or through a field it does
    /// not hold, as the precondition a JSON import and every other write meets, so the refusal
    /// names an unaccepted proposal that would create it (MTD-07). The CSV path met the native
    /// importer's dialog sentence first: "Choose an active record type."
    /// </summary>
    private async Task RequireTargetAsync(string entityId, IReadOnlyList<NendoCsvMapping> mappings, CancellationToken cancellationToken)
    {
        var definition = await application.GetDefinitionSnapshotAsync(cancellationToken);
        var entity = definition.Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", $"Record type {NendoText.Bounded(entityId, 200)} does not exist in this file.");
        if (entity.Retired)
            throw new NendoPreconditionException("entity-retired", $"{entity.DisplayName} is retired. Reactivate it before importing into it.");
        foreach (var mapping in mappings)
        {
            if (string.IsNullOrWhiteSpace(mapping.FieldId)) continue;
            if (entity.DerivedFields.FirstOrDefault(field => field.FieldId == mapping.FieldId) is { } derived)
                throw new NendoPreconditionException("field-calculated",
                    $"CSV column {mapping.Column} maps {mapping.FieldId} ({derived.DisplayName}), which {entity.DisplayName} calculates; an import writes stored fields only.");
            var field = entity.Fields.FirstOrDefault(candidate => candidate.FieldId == mapping.FieldId)
                ?? throw new NendoPreconditionException("field-not-found", $"{NendoText.Bounded(mapping.FieldId, 200)} is not a field of {entityId}.");
            if (field.Retired)
                throw new NendoPreconditionException("field-retired", $"{field.DisplayName} of {entity.DisplayName} is retired. Reactivate it before importing into it.");
        }
    }

    /// <summary>
    /// The value bounds every other agent write keeps, applied to each decoded CSV row before the
    /// first batch, naming the row and the field (MTD-12): a cell up to the CSV profile's own
    /// bound was written unchecked, where the same value as JSON was refused.
    /// </summary>
    private static void RequireValueBounds(IReadOnlyList<NendoCsvRow> rows)
    {
        foreach (var row in rows)
        {
            var where = $" in CSV row {row.SourceRow}";
            var total = 0L;
            foreach (var (fieldId, value) in row.Values)
            {
                var size = NendoDataMutationService.StoredBytes(value);
                NendoDataMutationService.RequireValueSize(fieldId, size, where);
                total += size;
                NendoDataMutationService.RequireValuesSize(total, fieldId, where);
            }
        }
    }

    /// <summary>
    /// For each batch of a CSV import of <paramref name="rowCount"/> rows, the target versions
    /// its committed revision recorded by record ID, or null for a batch with no receipt.
    /// </summary>
    private async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>?[]> ReadCommittedTargetVersionsAsync(
        string idempotencyKey, int rowCount, CancellationToken cancellationToken)
    {
        var batches = new IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>?[(rowCount + BatchSize - 1) / BatchSize];
        for (var ordinal = 0; ordinal < batches.Length; ordinal++)
        {
            var receipt = await application.GetMutationReceiptAsync(
                new NendoOperationIdentity(IdempotencyScope, BatchKey(idempotencyKey, ordinal)), cancellationToken);
            if (receipt is not null)
                batches[ordinal] = await application.ReadRecordedTargetVersionsAsync(receipt.RevisionId, cancellationToken);
        }
        return batches;
    }

    /// <param name="toEntries">
    /// Maps records as one batch create maps them (W-147, W-159): an earlier record of the same
    /// list may be a reference's target, and the versions are the given receipt's where it has them.
    /// </param>
    internal async Task<NendoImportResult> ImportRecordsAsync(
        string entityId,
        IReadOnlyList<NendoRecordInput> records,
        Func<IReadOnlyList<NendoRecordInput>, IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>?, Task<IReadOnlyList<NendoCreateRecordEntry>>> toEntries,
        string idempotencyKey,
        string origin,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(records);
        RequireRowCount(records.Count);
        if (records.Count == 0)
        {
            throw new NendoValidationException("Send at least one record.");
        }
        // A record ID twice in the payload is refused whole. A batch checks only its own fifty,
        // so copies in two batches committed the first and then stopped partway (MTD-08).
        var first = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < records.Count; index++)
        {
            if (records[index]?.RecordId is not { } recordId) continue;
            if (!first.TryAdd(recordId, index))
                throw new NendoValidationException(
                    $"records[{first[recordId]}] and records[{index}] carry the same record ID {NendoText.Bounded(recordId, 200)}; each record needs its own.");
        }
        // Every record is mapped and checked once before anything is written; a record may name
        // an earlier one of the import as a reference's target, as a CSV row may.
        await toEntries(records, null);
        // Then each batch is mapped again just before it commits (MTD-01): a batch before it may
        // have moved a target, and an earlier record is a record of the file by then. A batch this
        // key already committed carries the versions its revision recorded, so an exact retry
        // after a target was edited replays rather than conflicting (MTD-02).
        var committedVersions = await ReadCommittedTargetVersionsAsync(idempotencyKey, records.Count, cancellationToken);
        return await CommitAsync(entityId, records.Count,
            (ordinal, offset, count) => toEntries(records.Skip(offset).Take(count).ToArray(), committedVersions[ordinal]),
            idempotencyKey, origin, cancellationToken);
    }

    /// <summary>
    /// Commits the rows in all-or-nothing batches, each batch's entries made by
    /// <c>batchAt</c> just before it is sent, and reports exactly what landed and what replayed.
    /// <para>
    /// A batch that fails stops the run and takes its own rows with it; every batch before
    /// it stays committed, because they are separate revisions with separate receipts and
    /// pretending otherwise would be the one thing an import must not say. A refusal
    /// after an acknowledged batch carries its exact row count and revision IDs. The
    /// caller can retry the identical request and key; committed batches replay.
    /// </para>
    /// </summary>
    /// <param name="origin">
    /// The session pseudonym every other agent write carries, so History says which session
    /// imported. The batches were attributed to a bare "agent" until 2026-09-27 (F-180).
    /// The origin is part of what a replay must match, and the idempotency scope is shared on
    /// purpose, so a retry from a new lease -- after a restart, say -- can finish what an
    /// earlier one began: a batch that already committed is resubmitted under the origin its
    /// receipt records, and only a batch not yet written takes this one.
    /// </param>
    /// <param name="batchAt">The entries of one batch, by its ordinal, its first row and its row count.</param>
    private async Task<NendoImportResult> CommitAsync(
        string entityId,
        int total,
        Func<int, int, int, Task<IReadOnlyList<NendoCreateRecordEntry>>> batchAt,
        string idempotencyKey,
        string origin,
        CancellationToken cancellationToken)
    {
        var committed = 0;
        var revisions = 0;
        var replayed = 0;
        var dataRevision = 0L;
        var ids = new List<string>(total);
        var revisionIds = new List<string>((total + BatchSize - 1) / BatchSize);
        while (committed < total)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = BatchKey(idempotencyKey, revisions);
            IReadOnlyList<NendoCreateRecordEntry> batch;
            NendoApplyResult result;
            try
            {
                BeforeBatch?.Invoke(committed);
                batch = await batchAt(revisions, committed, Math.Min(BatchSize, total - committed));
                var receipt = await application.GetMutationReceiptAsync(
                    new NendoOperationIdentity(IdempotencyScope, key), cancellationToken);
                result = await application.CreateRecordsAsync(
                    new NendoCreateRecordsRequest(entityId, batch, new NendoRequestContext(
                        IdempotencyScope, key, receipt?.Origin ?? origin)),
                    cancellationToken);
            }
            // Any failure after an acknowledged batch, a cancellation and an IO failure
            // included: what committed is the one thing the caller must be told.
            catch (Exception exception) when (committed > 0 && exception is not OutOfMemoryException)
            {
                throw new NendoImportPartialException(
                    committed, total - committed, revisionIds.ToArray(), exception);
            }
            dataRevision = result.DataRevision;
            revisionIds.Add(result.RevisionId);
            committed += batch.Count;
            revisions++;
            if (result.IsIdempotentReplay) replayed++;
            ids.AddRange(batch.Select(entry => entry.RecordId));
        }
        return new NendoImportResult(
            entityId,
            committed,
            total - committed,
            ids,
            revisions,
            dataRevision,
            MaximumRowsPerCall,
            replayed == revisions,
            replayed);
    }

    /// <summary>
    /// A short stable token for one import, from the caller's own key.
    /// <para>
    /// The key itself is not used directly: it may be up to two hundred characters and it
    /// is the caller's to choose, so a record ID built from it could collide with the
    /// bound on record IDs or carry whatever the caller happened to put in it. This is a
    /// digest of it -- same key, same records, every time.
    /// </para>
    /// </summary>
    private static string Seed(string idempotencyKey) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(idempotencyKey)))[..16].ToLowerInvariant();

    internal const string IdempotencyScope = "agent.import";

    /// <summary>The most batches one call commits, and so the most receipts one key can answer for.</summary>
    internal static readonly int MaximumBatchesPerCall = (MaximumRowsPerCall + BatchSize - 1) / BatchSize;

    /// <summary>The Engine's bound on an idempotency key, which the caller's own key shares.</summary>
    private static readonly int MaximumKeyCharacters = NendoAuthoringLimits.Current.IdempotencyKeyCharacters;

    /// <summary>
    /// The idempotency key of one batch: the caller's key, <c>#</c> and the batch ordinal.
    /// <para>
    /// The caller may use all two hundred characters the Engine allows, and the suffix would
    /// then push the batch key past that bound, so no batch of such an import could ever be
    /// written (R-007). A key that does not fit is replaced by <c>import.sha256.</c> and the
    /// full SHA-256 of the caller's key: bounded, stable for a retry, and distinct for
    /// distinct keys. A key that fits keeps its plain form, so a receipt written before this
    /// rule still replays.
    /// </para>
    /// </summary>
    internal static string BatchKey(string idempotencyKey, int ordinal)
    {
        var suffix = "#" + ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return idempotencyKey.Length + suffix.Length <= MaximumKeyCharacters
            ? idempotencyKey + suffix
            : "import.sha256." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(idempotencyKey))).ToLowerInvariant() + suffix;
    }

    private static void RequireRowCount(int count)
    {
        if (count > MaximumRowsPerCall)
        {
            throw new NendoValidationException(
                $"One import carries at most {MaximumRowsPerCall} rows; this one has {count}. " +
                "Send the rest in further calls with their own idempotency keys.");
        }
    }
}
