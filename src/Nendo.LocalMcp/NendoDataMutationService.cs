using System.Text.Json;
using System.Text;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoDataMutationService(
    NendoApplicationService application,
    NendoAgentAuthority authority,
    NendoHostAuthority host,
    NendoUnattendedAuthority unattended,
    NendoImportService imports)
{
    private static readonly int MaximumValueMapEntries = NendoAuthoringLimits.Current.ValuesPerRecord;
    private const int MaximumValueMapBytes = 64 * 1024;
    private const int MaximumValueBytes = 32 * 1024;

    internal async Task<NendoDataOutcome> GetReceiptAsync(string receiptContext, string idempotencyKey,
        CancellationToken cancellationToken)
    {
        host.RequireActive();
        var identity = NendoReceiptContext.Read(receiptContext, idempotencyKey, host);
        var receipt = await application.GetMutationReceiptAsync(identity, cancellationToken);
        return receipt is not null
            ? new("committed", receipt, "This exact operation committed. Do not submit it with a new key.")
            : new("unresolved", null, "No receipt is recorded in this file state. A delayed request may still arrive. Retry the exact original request only while its original edit lease is valid; do not infer that a new key is safe.");
    }

    internal Task<NendoDataApplyResult> CreateRecordAsync(
        string sessionId,
        string leaseId,
        string entityId,
        string recordId,
        NendoObjectInput values,
        string idempotencyKey,
        CancellationToken cancellationToken,
        IReadOnlyDictionary<string, long>? expectedTargetVersions = null) => AdmitAsync(
            leaseId,
            sessionId,
            async _ => Touched(
                await application.CreateRecordAsync(
                    new NendoCreateRecordRequest(
                        entityId,
                        recordId,
                        ReadValueMap(values.Element),
                        Context(sessionId, idempotencyKey), expectedTargetVersions),
                    cancellationToken),
                [recordId],
                CreatedVersion),
            cancellationToken);

    internal Task<NendoDataApplyResult> CreateRecordsAsync(
        string sessionId,
        string leaseId,
        string entityId,
        IReadOnlyList<NendoRecordInput> records,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            sessionId,
            async _ =>
            {
                ArgumentNullException.ThrowIfNull(records);
                var entries = records.Select(record =>
                {
                    ArgumentNullException.ThrowIfNull(record);
                    RequireText(record.RecordId, "record ID", 200);
                    return new NendoCreateRecordEntry(
                        record.RecordId,
                        ReadValueMap(record.Values.Element),
                        record.ExpectedTargetVersions);
                }).ToArray();
                return Touched(
                    await application.CreateRecordsAsync(
                        new NendoCreateRecordsRequest(entityId, entries, Context(sessionId, idempotencyKey)),
                        cancellationToken),
                    entries.Select(entry => entry.RecordId).ToArray(),
                    CreatedVersion);
            },
            cancellationToken);

    internal Task<NendoDataApplyResult> SetFieldAsync(
        string sessionId,
        string leaseId,
        string entityId,
        string recordId,
        string fieldId,
        long expectedRecordVersion,
        NendoScalarInput value,
        string idempotencyKey,
        CancellationToken cancellationToken,
        long? expectedTargetRecordVersion = null) => AdmitAsync(
            leaseId,
            sessionId,
            async _ => Touched(
                await application.SetFieldAsync(
                    new NendoSetFieldRequest(
                        entityId,
                        recordId,
                        fieldId,
                        expectedRecordVersion,
                        ReadValue(value.Element),
                        Context(sessionId, idempotencyKey), expectedTargetRecordVersion),
                    cancellationToken),
                [recordId],
                expectedRecordVersion + 1),
            cancellationToken);

    internal Task<NendoDataApplyResult> ExecuteCommandAsync(
        string sessionId,
        string leaseId,
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            sessionId,
            // A contract version 3 command may set several fields, and the steps
            // live in the stored definition, so only the host can state the
            // resulting version. It does: one step advances the record by one.
            async _ =>
            {
                var result = await application.ExecuteCommandAsync(
                    new NendoExecuteCommandRequest(
                        commandId,
                        recordId,
                        expectedRecordVersion,
                        Context(sessionId, idempotencyKey)),
                    cancellationToken);
                return Touched(result, [recordId], result.RecordVersion);
            },
            cancellationToken);

    private NendoRequestContext Context(string sessionId, string idempotencyKey)
    {
        RequireText(idempotencyKey, "idempotency key", 200);
        var owner = NendoTransportIdentity.Pseudonym(sessionId);
        return new NendoRequestContext(
            $"mcp.data.{host.HostRunId}.{owner}",
            idempotencyKey.Trim(),
            owner);
    }

    internal Task<NendoDataApplyResult> DeleteRecordAsync(string sessionId, string leaseId, string entityId, string recordId,
        long expectedRecordVersion, string idempotencyKey, CancellationToken cancellationToken) =>
        AdmitAsync(leaseId, sessionId,
            async _ => Touched(
                await application.DeleteRecordAsync(new(entityId, recordId, expectedRecordVersion,
                    Context(sessionId, idempotencyKey)), cancellationToken),
                [recordId],
                null),
            cancellationToken);

    /// <summary>
    /// Bulk import, at the same access level and through the same admission as every other
    /// data write: it creates records and nothing else, which Edit data already permits one
    /// call at a time (ADR-0009, 2026-09-22 amendment).
    /// </summary>
    internal Task<NendoImportResult> ImportAsync(
        string sessionId,
        string leaseId,
        string entityId,
        string format,
        string? csv,
        IReadOnlyList<NendoCsvColumnMapping>? columnMappings,
        string? csvProfile,
        bool emptyIsNull,
        IReadOnlyList<NendoRecordInput>? records,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            sessionId,
            _ =>
            {
                RequireText(idempotencyKey, "idempotency key", 200);
                // Named rather than guessed from which argument arrived. A caller that
                // sends csv text and a records array has made a mistake, and picking one
                // for them would import half of what they meant.
                return format switch
                {
                    "csv" => imports.ImportCsvAsync(
                        entityId,
                        csv ?? throw new NendoValidationException("A csv import needs csv text."),
                        columnMappings ?? throw new NendoValidationException("A csv import needs columnMappings."),
                        ReadCsvProfile(csvProfile),
                        emptyIsNull,
                        idempotencyKey,
                        cancellationToken),
                    "json" => imports.ImportRecordsAsync(
                        entityId,
                        records ?? throw new NendoValidationException("A json import needs records."),
                        values => ReadValueMap(values.Element),
                        idempotencyKey,
                        cancellationToken),
                    _ => throw new NendoValidationException("format must be \"csv\" or \"json\"."),
                };
            },
            cancellationToken);

    private static bool ReadCsvProfile(string? profile) => profile switch
    {
        null or "external" => false,
        "nendo" => true,
        _ => throw new NendoValidationException("csvProfile must be \"nendo\" or \"external\"."),
    };

    /// <summary>
    /// Every data write goes through here. The access level and the consent retry are
    /// attached once rather than five times, because the version of this that repeated
    /// them at each call site is the version where the sixth write forgets one.
    /// </summary>
    private Task<T> AdmitAsync<T>(
        string leaseId,
        string sessionId,
        Func<NendoLeaseGrant, Task<T>> action,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.DataMutation,
            grant => WithConsentAsync(() => action(grant), cancellationToken),
            cancellationToken);

    /// <summary>
    /// At Unattended, a write refused because nobody has approved the file's automatic
    /// actions records that consent and tries once more
    /// (ADR-0009, 2026-09-22 amendment).
    /// <para>
    /// Exactly once, and only on that one code. The refusal happens before anything
    /// commits, so no receipt exists and the retry carries the same idempotency key as a
    /// first attempt rather than as a replay. At every other level, and for every other
    /// refusal, the exception passes through untouched -- including this one, whose
    /// message names the person and what they need to do.
    /// </para>
    /// </summary>
    private async Task<T> WithConsentAsync<T>(Func<Task<T>> write, CancellationToken cancellationToken)
    {
        try
        {
            return await write();
        }
        catch (NendoPreconditionException exception)
            when (exception.Code == "behaviour-not-approved" && unattended.IsAvailable)
        {
            if (!await unattended.GrantAsync(cancellationToken)) throw;
            return await write();
        }
    }

    /// <summary>Every newly created record starts at version 1.</summary>
    private const long CreatedVersion = 1;

    // A replay returns the original revision, and the record may have been edited
    // since. Reporting the version it held then would be a stale number presented
    // as current, so the field is simply absent on that path.
    private static NendoDataApplyResult Touched(
        NendoApplyResult result,
        IReadOnlyList<string> recordIds,
        long? recordVersion)
    {
        // An automatic action can write back to the caller's own record inside the same
        // revision, leaving it past the arithmetic guess this adapter would otherwise
        // report — one record named at two different versions in one response. The store
        // states the committed version in GeneratedChanges, so each named record takes
        // that over the computed one. One recordVersion describes every record named, so
        // it is stated only when they all agree: a batch in which an action moved some
        // records past the others reports null, and alsoChanged carries each moved
        // record's own version. Taking the highest across the batch named untouched
        // records at a version they do not hold, and their next optimistic write refused.
        long? reported = result.IsIdempotentReplay ? null : recordVersion;
        if (reported is not null)
        {
            var committed = result.GeneratedChanges
                .Where(change => change.RecordVersion is not null)
                .GroupBy(change => change.RecordId, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.Max(change => change.RecordVersion!.Value), StringComparer.Ordinal);
            var versions = recordIds
                .Select(recordId => committed.TryGetValue(recordId, out var version) ? version : reported.Value)
                .Distinct()
                .ToArray();
            reported = versions.Length == 1 ? versions[0] : null;
        }
        return new(
            result.RevisionId,
            result.OperationDigest,
            result.DefinitionRevision,
            result.DataRevision,
            result.ChangeSequence,
            result.IsIdempotentReplay,
            recordIds)
        {
            RecordVersion = reported,
            AlsoChanged = result.GeneratedChanges,
        };
    }

    private static IReadOnlyDictionary<string, object?> ReadValueMap(JsonElement values)
    {
        if (values.ValueKind != JsonValueKind.Object ||
            Encoding.UTF8.GetByteCount(values.GetRawText()) > MaximumValueMapBytes)
        {
            throw new NendoValidationException(
                "Record values must be a bounded JSON object.");
        }

        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in values.EnumerateObject())
        {
            if (result.Count == MaximumValueMapEntries)
            {
                throw new NendoValidationException(
                    $"A record may contain at most {MaximumValueMapEntries} submitted values.");
            }
            RequireText(property.Name, "field ID", 200);
            result.Add(property.Name, ReadValue(property.Value));
        }
        return result;
    }

    private static JsonElement ReadValue(JsonElement value)
    {
        if (Encoding.UTF8.GetByteCount(value.GetRawText()) > MaximumValueBytes)
        {
            throw new NendoValidationException("A submitted value is too large.");
        }
        if (value.ValueKind == JsonValueKind.Object) value = NendoNumericEnvelope.Decode(value);
        if (value.ValueKind is JsonValueKind.Object or JsonValueKind.Array or JsonValueKind.Undefined)
        {
            throw new NendoValidationException(
                "Field values must be scalar JSON values.");
        }
        return value.Clone();
    }

    private static void RequireText(string value, string name, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new NendoValidationException(
                $"The {name} must contain 1-{maximumLength} characters.");
        }
    }
}
