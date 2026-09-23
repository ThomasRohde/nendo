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
public sealed record NendoCsvColumnMapping(int Column, string FieldId);

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
    string EntityId,
    int Committed,
    int Remaining,
    IReadOnlyList<string> RecordIds,
    int RevisionCount,
    long DataRevision,
    int MaximumRowsPerCall);

internal sealed class NendoImportPartialException(
    int committed,
    int remaining,
    IReadOnlyList<string> revisionIds,
    NendoException cause) : Exception("A later import batch was refused.", cause)
{
    internal int Committed { get; } = committed;
    internal int Remaining { get; } = remaining;
    internal int FirstUncommittedRow { get; } = committed + 1;
    internal IReadOnlyList<string> RevisionIds { get; } = revisionIds;
    internal NendoException Cause { get; } = cause;
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
    internal const int MaximumRowsPerCall = 500;

    /// <summary>Rows per revision, matching what the data tools already commit at once.</summary>
    private const int BatchSize = 50;

    private const int MaximumCsvCharacters = 1024 * 1024;

    internal async Task<NendoImportResult> ImportCsvAsync(
        string entityId,
        string csv,
        IReadOnlyList<NendoCsvColumnMapping> columnMappings,
        bool nendoProfile,
        bool emptyIsNull,
        string idempotencyKey,
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
            .Select(mapping => new NendoCsvMapping(mapping.Column, mapping.FieldId))
            .ToArray();
        var decoded = await application.DecodeCsvRowsAsync(
            document,
            entityId,
            mappings,
            new NendoCsvOptions(nendoProfile, emptyIsNull),
            0,
            document.Rows.Count,
            cancellationToken);

        // A CSV row carries no record ID, so one is derived from the caller's key and the
        // row's position. Stable, which is what makes an exact retry ask for the same
        // records rather than a second copy of them, and unique to this import, because
        // record IDs are global to the file rather than scoped to a record type.
        var seed = Seed(idempotencyKey);
        var records = decoded
            .Select((row, index) => new NendoCreateRecordEntry(
                $"import.{seed}.{index}",
                row.Values,
                row.ExpectedTargetVersions))
            .ToArray();
        return await CommitAsync(entityId, records, idempotencyKey, cancellationToken);
    }

    internal async Task<NendoImportResult> ImportRecordsAsync(
        string entityId,
        IReadOnlyList<NendoRecordInput> records,
        Func<NendoObjectInput, IReadOnlyDictionary<string, object?>> readValues,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(records);
        RequireRowCount(records.Count);
        if (records.Count == 0)
        {
            throw new NendoValidationException("Send at least one record.");
        }
        var entries = records
            .Select(record =>
            {
                ArgumentNullException.ThrowIfNull(record);
                if (string.IsNullOrWhiteSpace(record.RecordId) || record.RecordId.Length > 200)
                {
                    throw new NendoValidationException("Each record needs a stable record ID of 1 to 200 characters.");
                }
                return new NendoCreateRecordEntry(
                    record.RecordId,
                    readValues(record.Values),
                    record.ExpectedTargetVersions ?? new Dictionary<string, long>(StringComparer.Ordinal));
            })
            .ToArray();
        return await CommitAsync(entityId, entries, idempotencyKey, cancellationToken);
    }

    /// <summary>
    /// Commits the decoded rows in all-or-nothing batches, and reports exactly what landed.
    /// <para>
    /// A batch that fails stops the run and takes its own rows with it; every batch before
    /// it stays committed, because they are separate revisions with separate receipts and
    /// pretending otherwise would be the one thing an import must not say. A refusal
    /// after an acknowledged batch carries its exact row count and revision IDs. The
    /// caller can retry the identical request and key; committed batches replay.
    /// </para>
    /// </summary>
    private async Task<NendoImportResult> CommitAsync(
        string entityId,
        IReadOnlyList<NendoCreateRecordEntry> entries,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var committed = 0;
        var revisions = 0;
        var dataRevision = 0L;
        var ids = new List<string>(entries.Count);
        var revisionIds = new List<string>((entries.Count + BatchSize - 1) / BatchSize);
        while (committed < entries.Count)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var batch = entries.Skip(committed).Take(BatchSize).ToArray();
            NendoApplyResult result;
            try
            {
                result = await application.CreateRecordsAsync(
                    new NendoCreateRecordsRequest(entityId, batch, new NendoRequestContext(
                        "agent.import", $"{idempotencyKey}#{revisions}", "agent")),
                    cancellationToken);
            }
            catch (NendoException exception) when (committed > 0)
            {
                throw new NendoImportPartialException(
                    committed, entries.Count - committed, revisionIds.ToArray(), exception);
            }
            dataRevision = result.DataRevision;
            revisionIds.Add(result.RevisionId);
            committed += batch.Length;
            revisions++;
            ids.AddRange(batch.Select(entry => entry.RecordId));
        }
        return new NendoImportResult(
            entityId,
            committed,
            entries.Count - committed,
            ids,
            revisions,
            dataRevision,
            MaximumRowsPerCall);
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
