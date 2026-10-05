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
    private static readonly int MaximumValueMapBytes = NendoAuthoringLimits.Current.RecordValuesBytes;
    private static readonly int MaximumValueBytes = NendoAuthoringLimits.Current.RecordValueBytes;

    internal async Task<NendoDataOutcome> GetReceiptAsync(string receiptContext, string? idempotencyKey, string? proposalId,
        CancellationToken cancellationToken)
    {
        host.RequireActive();
        if (proposalId is not null)
        {
            // An acceptance is keyed by the proposal, not by the accept call's key: the
            // Engine records the committed revisions under the proposal ID (W-144).
            NendoReceiptContext.ReadScope(receiptContext, host);
            NendoText.RequireText(proposalId, "proposal ID", 200);
            var accepted = await application.GetProposalReceiptAsync(proposalId, cancellationToken);
            return accepted is { Revisions.Count: > 0 }
                ? new("committed", accepted.Revisions[^1],
                    $"Proposal {proposalId} was accepted and committed {accepted.Revisions.Count} revision(s); the file is at definition revision {accepted.DefinitionRevision}.")
                { Revisions = accepted.Revisions.Select(NendoReceiptRevision.From).ToArray() }
                : new("unresolved", null, "No acceptance of this proposal is recorded in this file state. nendo://application/proposals says whether it is still waiting.");
        }
        if (string.IsNullOrWhiteSpace(idempotencyKey))
            throw new NendoValidationException("A bounded receipt locator and idempotency key are required, or a proposalId.");
        var identity = NendoReceiptContext.Read(receiptContext, idempotencyKey, host);
        var receipt = await application.GetMutationReceiptAsync(identity, cancellationToken);
        if (receipt is not null)
            return new("committed", receipt, "This exact operation committed. Do not submit it with a new key.") { Revisions = [NendoReceiptRevision.From(receipt)] };
        // An import commits one batch per revision, each under a key derived from the
        // caller's, in the scope every lease shares (W-144). The batches answer in order.
        var batches = new List<NendoApplyResult>();
        for (var ordinal = 0; ordinal < NendoImportService.MaximumBatchesPerCall; ordinal++)
        {
            var batch = await application.GetMutationReceiptAsync(
                new NendoOperationIdentity(NendoImportService.IdempotencyScope, NendoImportService.BatchKey(identity.IdempotencyKey, ordinal)),
                cancellationToken);
            if (batch is null) break;
            batches.Add(batch);
        }
        return batches.Count > 0
            ? new("committed", batches[^1],
                $"An import under this key committed {batches.Count} batch(es). Retry the identical import with the same key to replay them and finish any remaining rows; do not submit it with a new key.")
            { Revisions = batches.Select(NendoReceiptRevision.From).ToArray() }
            : new("unresolved", null, "No receipt is recorded in this file state. A delayed request may still arrive. Retry the exact original request only while its original edit lease is valid; do not infer that a new key is safe.");
    }

    internal Task<NendoDataApplyResult> CreateRecordAsync(
        string applicationHandle,
        string leaseId,
        string entityId,
        string recordId,
        NendoObjectInput values,
        string idempotencyKey,
        IReadOnlyDictionary<string, long>? expectedTargetVersions,
        bool? keptInNewFiles,
        IReadOnlyDictionary<string, NendoReferenceInput>? references,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ =>
            {
                var context = Context(applicationHandle, idempotencyKey);
                var entry = await ToEntryAsync(entityId, new NendoRecordInput(recordId, values)
                {
                    ExpectedTargetVersions = expectedTargetVersions,
                    KeptInNewFiles = keptInNewFiles,
                    References = references,
                }, cancellationToken);
                var committed = await CommittedTargetVersionsAsync(context, references is { Count: > 0 }, cancellationToken);
                return Touched(
                    await application.CreateRecordAsync(
                        new NendoCreateRecordRequest(
                            entityId,
                            recordId,
                            entry.Values,
                            context, Recorded(committed, recordId, entry.ExpectedTargetVersions, references), entry.KeptInNewFiles),
                        cancellationToken),
                    entityId, [recordId],
                    CreatedVersion);
            },
            cancellationToken);

    internal Task<NendoDataApplyResult> CreateRecordsAsync(
        string applicationHandle,
        string leaseId,
        string entityId,
        IReadOnlyList<NendoRecordInput> records,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ =>
            {
                ArgumentNullException.ThrowIfNull(records);
                var context = Context(applicationHandle, idempotencyKey);
                var committed = await CommittedTargetVersionsAsync(
                    context, records.Any(record => record?.References is { Count: > 0 }), cancellationToken);
                var entries = new List<NendoCreateRecordEntry>(records.Count);
                foreach (var record in records)
                {
                    var entry = await ToEntryAsync(entityId, record, cancellationToken);
                    entries.Add(entry with { ExpectedTargetVersions = Recorded(committed, entry.RecordId, entry.ExpectedTargetVersions, record.References) });
                }
                return Touched(
                    await application.CreateRecordsAsync(
                        new NendoCreateRecordsRequest(entityId, entries, context),
                        cancellationToken),
                    entityId, entries.Select(entry => entry.RecordId).ToArray(),
                    CreatedVersion);
            },
            cancellationToken);

    /// <summary>
    /// The one place a record input becomes an Engine entry (W-147, W-159): the same ID
    /// bound, the same value reading and the same reference resolution for a single
    /// create, a batch create and a JSON import. The import mapped it a second time with a
    /// different ID check and a null-versus-empty difference for target versions.
    /// </summary>
    internal async Task<NendoCreateRecordEntry> ToEntryAsync(string entityId, NendoRecordInput record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        NendoText.RequireText(record.RecordId, "record ID", 200);
        var values = ReadValueMap(record.Values.Element);
        var targets = await ResolveReferencesAsync(entityId, values, record.ExpectedTargetVersions, record.References, cancellationToken);
        return new NendoCreateRecordEntry(record.RecordId, values, targets, record.KeptInNewFiles);
    }

    /// <summary>
    /// Puts each named reference target into the values with its current version (W-147).
    /// A target named by record ID is read for its version; one named by a unique field's
    /// value is found through the same filtered query the screens use. The rule CSV import
    /// follows for matchFieldId, so both formats carry one rule.
    /// <para>
    /// In a batch, a target an earlier write of the same batch creates or updates is found
    /// among those writes first (W-166): the committed store does not hold it yet, and the
    /// Engine supplies the version that earlier write leaves, as it does for a plain value.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyDictionary<string, long>?> ResolveReferencesAsync(
        string entityId,
        Dictionary<string, object?> values,
        IReadOnlyDictionary<string, long>? expectedTargetVersions,
        IReadOnlyDictionary<string, NendoReferenceInput>? references,
        CancellationToken cancellationToken,
        IReadOnlyList<BatchWritten>? earlier = null)
    {
        if (references is null || references.Count == 0) return expectedTargetVersions;
        var targets = new Dictionary<string, long>(expectedTargetVersions ?? new Dictionary<string, long>(), StringComparer.Ordinal);
        var snapshot = await application.GetDefinitionSnapshotAsync(cancellationToken);
        var entity = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        foreach (var (fieldId, reference) in references)
        {
            ArgumentNullException.ThrowIfNull(reference);
            var field = entity.Fields.SingleOrDefault(candidate => candidate.FieldId == fieldId && !candidate.Retired)
                ?? throw new NendoPreconditionException("field-not-found", $"{fieldId} is not a field of {entityId}.");
            if (field.StorageKind != NendoStorageKind.Reference || field.Reference is null)
                throw new NendoValidationException($"references names {fieldId}, which is not a reference field of {entityId}.");
            var target = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == field.Reference.TargetEntityId && !candidate.Retired)
                ?? throw new NendoPreconditionException("entity-not-found", $"The target record type of {fieldId} does not exist.");
            NendoRecordSnapshot found;
            var inBatch = (earlier ?? []).Where(written => written.EntityId == target.EntityId && written.Values is not null).ToArray();
            if (reference.RecordId is not null)
            {
                if (reference.MatchFieldId is not null || reference.Value is not null)
                    throw new NendoValidationException($"references.{fieldId} names a recordId or a matchFieldId with value, not both.");
                NendoText.RequireText(reference.RecordId, "record ID", 200);
                if (inBatch.Any(written => written.RecordId == reference.RecordId))
                {
                    values[fieldId] = JsonSerializer.SerializeToElement(reference.RecordId);
                    targets.Remove(fieldId);
                    continue;
                }
                found = (await application.QueryRecordsAsync(new NendoRecordQuery(target.EntityId, 1) { RecordId = reference.RecordId }, cancellationToken))
                    .Items.SingleOrDefault()
                    ?? throw new NendoPreconditionException("target-not-found", $"{target.DisplayName} has no record {reference.RecordId}.");
            }
            else
            {
                if (string.IsNullOrWhiteSpace(reference.MatchFieldId) || reference.Value is null)
                    throw new NendoValidationException($"references.{fieldId} names a recordId, or a matchFieldId with value.");
                var match = target.Fields.SingleOrDefault(candidate => candidate.FieldId == reference.MatchFieldId && !candidate.Retired);
                if (match is null || !match.Unique)
                    throw new NendoValidationException(
                        $"{field.DisplayName} can be matched only by a unique field of {target.DisplayName}; {reference.MatchFieldId} is not one.");
                var matched = inBatch.Where(written => written.Values!.TryGetValue(match.FieldId, out var held) && Holds(held, reference.Value)).ToArray();
                if (matched.Length > 1)
                    throw new NendoPreconditionException("target-not-found", $"More than one {target.DisplayName} record in this batch holds {reference.Value} in {match.FieldId}.");
                if (matched.Length == 1)
                {
                    values[fieldId] = JsonSerializer.SerializeToElement(matched[0].RecordId);
                    targets.Remove(fieldId);
                    continue;
                }
                var page = await application.QueryRecordsAsync(new NendoRecordQuery(target.EntityId, 2)
                {
                    Filters = [new NendoRecordFilter(match.FieldId, "eq", JsonSerializer.SerializeToElement(reference.Value))],
                }, cancellationToken);
                found = page.Items.Count == 1
                    ? page.Items[0]
                    : throw new NendoPreconditionException("target-not-found", $"No {target.DisplayName} record holds {reference.Value} in {match.FieldId}.");
            }
            values[fieldId] = JsonSerializer.SerializeToElement(found.RecordId);
            targets[fieldId] = found.RecordVersion;
        }
        return targets;
    }

    /// <summary>A record an earlier write of the same batch left in place, with the values it wrote; Values is null for a delete.</summary>
    private sealed record BatchWritten(string EntityId, string RecordId, IReadOnlyDictionary<string, object?>? Values);

    /// <summary>Whether a written value is the text a matchFieldId reference names, as the screens' eq filter would compare it.</summary>
    private static bool Holds(object? held, string wanted) => held is JsonElement element && element.ValueKind switch
    {
        JsonValueKind.String => string.Equals(element.GetString(), wanted, StringComparison.Ordinal),
        JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => string.Equals(element.GetRawText(), wanted, StringComparison.Ordinal),
        _ => false,
    };

    /// <summary>
    /// The reference target versions the revision this key already committed recorded, by
    /// record ID, or null when no write names a reference or the key has no receipt (F-258).
    /// <para>
    /// A reference named by record ID or by a unique field's value is resolved to its
    /// target's current version before the Engine sees the write, and the Engine replays a
    /// key only for the payload it committed. A retry after a lost response therefore
    /// carries the versions of the attempt that committed, as the import's retry does;
    /// resolved afresh, the one case the receipt exists for, a target edited in between,
    /// answered NENDO_IDEMPOTENCY_CONFLICT for the same request.
    /// </para>
    /// </summary>
    private async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>?> CommittedTargetVersionsAsync(
        NendoRequestContext context, bool namesReferences, CancellationToken cancellationToken)
    {
        if (!namesReferences) return null;
        var receipt = await application.GetMutationReceiptAsync(
            new NendoOperationIdentity(context.IdempotencyScope, context.IdempotencyKey), cancellationToken);
        return receipt is null ? null : await application.ReadRecordedTargetVersionsAsync(receipt.RevisionId, cancellationToken);
    }

    /// <summary>
    /// For the fields a write named in <paramref name="references"/>, the versions the
    /// committed revision recorded in place of the ones resolved now. A field the revision
    /// did not record, or a record it did not write, keeps what was resolved: a different
    /// payload under a used key is still a conflict.
    /// </summary>
    private static IReadOnlyDictionary<string, long>? Recorded(
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, long>>? committed,
        string recordId,
        IReadOnlyDictionary<string, long>? resolved,
        IReadOnlyDictionary<string, NendoReferenceInput>? references)
    {
        if (committed is null || resolved is null || references is not { Count: > 0 } ||
            !committed.TryGetValue(recordId, out var recorded)) return resolved;
        var versions = new Dictionary<string, long>(resolved, StringComparer.Ordinal);
        foreach (var fieldId in references.Keys)
            if (recorded.TryGetValue(fieldId, out var version)) versions[fieldId] = version;
        return versions;
    }

    /// <summary>Several fields of one record as one revision (W-147): N set_field calls used to be N revisions and N hand-carried versions.</summary>
    internal Task<NendoDataApplyResult> UpdateRecordAsync(
        string applicationHandle,
        string leaseId,
        string entityId,
        string recordId,
        long expectedRecordVersion,
        NendoObjectInput values,
        string idempotencyKey,
        IReadOnlyDictionary<string, long>? expectedTargetVersions,
        IReadOnlyDictionary<string, NendoReferenceInput>? references,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ =>
            {
                var context = Context(applicationHandle, idempotencyKey);
                var map = ReadValueMap(values.Element);
                var targets = await ResolveReferencesAsync(entityId, map, expectedTargetVersions, references, cancellationToken);
                var committed = await CommittedTargetVersionsAsync(context, references is { Count: > 0 }, cancellationToken);
                return Touched(
                    await application.SetFieldsAsync(
                        new NendoSetFieldsRequest(entityId, recordId, expectedRecordVersion, map,
                            context, Recorded(committed, recordId, targets, references)),
                        cancellationToken),
                    entityId, [recordId],
                    expectedRecordVersion + map.Count);
            },
            cancellationToken);

    /// <summary>Creates, updates and deletes across record types as one revision, all or nothing (W-147).</summary>
    internal Task<NendoDataWritesResult> ApplyWritesAsync(
        string applicationHandle,
        string leaseId,
        IReadOnlyList<NendoRecordWriteInput> writes,
        string idempotencyKey,
        string? label,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ =>
            {
                ArgumentNullException.ThrowIfNull(writes);
                if (writes.Count is < 1 or > NendoApplicationService.MaximumRecordWrites)
                    throw new NendoValidationException(
                        $"A batch carries 1-{NendoApplicationService.MaximumRecordWrites} record writes; this one carries {writes.Count}.");
                var context = Context(applicationHandle, idempotencyKey);
                var committed = await CommittedTargetVersionsAsync(
                    context, writes.Any(write => write?.References is { Count: > 0 }), cancellationToken);
                var mapped = new List<NendoRecordWrite>(writes.Count);
                var earlier = new List<BatchWritten>(writes.Count);
                for (var index = 0; index < writes.Count; index++)
                {
                    var write = writes[index] ?? throw new NendoValidationException($"Write {index} is missing.");
                    var kind = write.Kind switch
                    {
                        "create" => NendoRecordWriteKind.Create,
                        "update" => NendoRecordWriteKind.Update,
                        "delete" => NendoRecordWriteKind.Delete,
                        _ => throw new NendoValidationException($"Write {index}: kind is create, update or delete; '{write.Kind}' is not."),
                    };
                    NendoText.RequireText(write.EntityId, "entity ID", 200);
                    NendoText.RequireText(write.RecordId, "record ID", 200);
                    Dictionary<string, object?>? map = null;
                    IReadOnlyDictionary<string, long>? targets = write.ExpectedTargetVersions;
                    if (write.Values.Element.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
                    {
                        map = ReadValueMap(write.Values.Element);
                        targets = await ResolveReferencesAsync(write.EntityId, map, write.ExpectedTargetVersions, write.References, cancellationToken, earlier);
                        targets = Recorded(committed, write.RecordId, targets, write.References);
                    }
                    else if (write.References is { Count: > 0 })
                    {
                        throw new NendoValidationException($"Write {index} names references and no values; put the reference fields in values or omit both.");
                    }
                    mapped.Add(new NendoRecordWrite(kind, write.EntityId, write.RecordId, map, write.ExpectedRecordVersion, targets));
                    earlier.Add(new BatchWritten(write.EntityId, write.RecordId, kind == NendoRecordWriteKind.Delete ? null : map));
                }
                var result = await application.ApplyRecordWritesAsync(
                    new NendoRecordWritesRequest(mapped, context, string.IsNullOrWhiteSpace(label) ? null : label),
                    cancellationToken);
                var applied = result.Applied;
                return new NendoDataWritesResult(
                    applied.RevisionId,
                    applied.OperationDigest,
                    applied.DefinitionRevision,
                    applied.DataRevision,
                    applied.ChangeSequence,
                    applied.IsIdempotentReplay,
                    result.Records.Select(record => new NendoDataWrittenRecord(record.EntityId, record.RecordId, record.RecordVersion)).ToArray())
                {
                    AlsoChanged = applied.GeneratedChanges,
                    Assigned = applied.AssignedValues,
                };
            },
            cancellationToken);

    /// <summary>
    /// Compensates a record revision this session committed (W-153, ADR-0006 and ADR-0009
    /// amendments): the same linked revision History and a view make. The context's origin is
    /// the lease's pseudonym, which is what the Engine compares with the revision's, so a
    /// revision another origin committed is refused by the Engine as revision-not-yours.
    /// </summary>
    internal Task<NendoDataWritesResult> UndoRevisionAsync(
        string applicationHandle,
        string leaseId,
        string revisionId,
        string idempotencyKey,
        string? label,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ =>
            {
                NendoText.RequireText(revisionId, "revision ID", 200);
                var result = await application.UndoRecordWritesAsync(
                    new NendoUndoRecordWritesRequest(revisionId, Context(applicationHandle, idempotencyKey), Redo: false,
                        string.IsNullOrWhiteSpace(label) ? null : label),
                    cancellationToken);
                var applied = result.Applied;
                return new NendoDataWritesResult(
                    applied.RevisionId,
                    applied.OperationDigest,
                    applied.DefinitionRevision,
                    applied.DataRevision,
                    applied.ChangeSequence,
                    applied.IsIdempotentReplay,
                    result.Records.Select(record => new NendoDataWrittenRecord(record.EntityId, record.RecordId, record.RecordVersion)).ToArray())
                {
                    AlsoChanged = applied.GeneratedChanges,
                    Assigned = applied.AssignedValues,
                };
            },
            cancellationToken);

    internal Task<NendoDataApplyResult> SetFieldAsync(
        string applicationHandle,
        string leaseId,
        string entityId,
        string recordId,
        string fieldId,
        long expectedRecordVersion,
        NendoScalarInput value,
        string idempotencyKey,
        long? expectedTargetRecordVersion,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            async _ => Touched(
                await application.SetFieldAsync(
                    new NendoSetFieldRequest(
                        entityId,
                        recordId,
                        fieldId,
                        expectedRecordVersion,
                        ReadValue(value.Element, fieldId),
                        Context(applicationHandle, idempotencyKey), expectedTargetRecordVersion),
                    cancellationToken),
                entityId, [recordId],
                expectedRecordVersion + 1),
            cancellationToken);

    internal Task<NendoDataApplyResult> MoveRecordAsync(
        string applicationHandle,
        string leaseId,
        string entityId,
        string recordId,
        long expectedRecordVersion,
        string? parentRecordId,
        long? expectedParentVersion,
        string? beforeRecordId,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            // A move may renumber siblings, so the host states which records it wrote and the
            // moved record's version rather than this adapter guessing from the request.
            async _ =>
            {
                var moved = await application.MoveRecordAsync(
                    new NendoMoveRecordRequest(entityId, recordId, expectedRecordVersion, parentRecordId, expectedParentVersion,
                        beforeRecordId, Context(applicationHandle, idempotencyKey)),
                    cancellationToken);
                return Touched(moved.Applied, entityId, moved.TouchedRecordIds, moved.TouchedRecordIds.Count == 1 ? moved.RecordVersion : null);
            },
            cancellationToken);

    internal Task<NendoDataApplyResult> ExecuteCommandAsync(
        string applicationHandle,
        string leaseId,
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken) => AdmitAsync(
            leaseId,
            applicationHandle,
            // A contract version 3 command may set several fields, and the steps
            // live in the stored definition, so only the host can state the
            // resulting version, including what its automatic actions wrote.
            async _ =>
            {
                var result = await application.ExecuteCommandAsync(
                    new NendoExecuteCommandRequest(
                        commandId,
                        recordId,
                        expectedRecordVersion,
                        Context(applicationHandle, idempotencyKey)),
                    cancellationToken);
                // The typed command service resolves the owning type and final version.
                return Touched(result, null, [recordId], result.RecordVersion);
            },
            cancellationToken);

    private NendoRequestContext Context(string applicationHandle, string idempotencyKey)
    {
        NendoText.RequireText(idempotencyKey, "idempotency key", NendoAuthoringLimits.Current.IdempotencyKeyCharacters);
        var owner = NendoTransportIdentity.Pseudonym(applicationHandle);
        return new NendoRequestContext(
            $"mcp.data.{host.HostRunId}.{owner}",
            idempotencyKey.Trim(),
            owner);
    }

    /// <summary>A record's own mark for a new file of the application (ADR-0022); its version does not move.</summary>
    internal Task<NendoDataApplyResult> SetKeptInNewFilesAsync(string applicationHandle, string leaseId, string entityId, string recordId,
        bool? kept, string idempotencyKey, CancellationToken cancellationToken) =>
        AdmitAsync(leaseId, applicationHandle,
            async _ => Touched(
                await application.SetRecordKeptInNewFilesAsync(entityId, recordId, kept, Context(applicationHandle, idempotencyKey), cancellationToken),
                entityId, [recordId],
                null),
            cancellationToken);

    internal Task<NendoDataApplyResult> DeleteRecordAsync(string applicationHandle, string leaseId, string entityId, string recordId,
        long expectedRecordVersion, string idempotencyKey, CancellationToken cancellationToken) =>
        AdmitAsync(leaseId, applicationHandle,
            async _ => Touched(
                await application.DeleteRecordAsync(new(entityId, recordId, expectedRecordVersion,
                    Context(applicationHandle, idempotencyKey)), cancellationToken),
                entityId, [recordId],
                null),
            cancellationToken);

    /// <summary>
    /// Bulk import, at the same access level and through the same admission as every other
    /// data write: it creates records and nothing else, which Edit data already permits one
    /// call at a time (ADR-0009, 2026-09-22 amendment).
    /// </summary>
    internal Task<NendoImportResult> ImportAsync(
        string applicationHandle,
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
            applicationHandle,
            _ =>
            {
                NendoText.RequireText(idempotencyKey, "idempotency key", NendoAuthoringLimits.Current.IdempotencyKeyCharacters);
                // Named rather than guessed from which argument arrived. A caller that
                // sends csv text and a records array has made a mistake, and picking one
                // for them would import half of what they meant.
                if (format == "csv" && records is not null)
                    throw new NendoValidationException("A csv import cannot also contain json records.");
                if (format == "json" &&
                    (csv is not null || columnMappings is not null || csvProfile is not null || emptyIsNull))
                    throw new NendoValidationException("A json import cannot also contain csv options or text.");
                return format switch
                {
                    "csv" => imports.ImportCsvAsync(
                        entityId,
                        csv ?? throw new NendoValidationException("A csv import needs csv text."),
                        columnMappings ?? throw new NendoValidationException("A csv import needs columnMappings."),
                        ReadCsvProfile(csvProfile),
                        emptyIsNull,
                        idempotencyKey,
                        NendoTransportIdentity.Pseudonym(applicationHandle),
                        cancellationToken),
                    "json" => imports.ImportRecordsAsync(
                        entityId,
                        records ?? throw new NendoValidationException("A json import needs records."),
                        record => ToEntryAsync(entityId, record, cancellationToken),
                        idempotencyKey,
                        NendoTransportIdentity.Pseudonym(applicationHandle),
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
        string applicationHandle,
        Func<NendoLeaseGrant, Task<T>> action,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            applicationHandle,
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
        string? entityId,
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
        if (reported is not null && entityId is not null)
        {
            var committed = result.GeneratedChanges
                .GroupBy(change => (change.EntityId, change.RecordId))
                .ToDictionary(group => group.Key, group => group.Last().RecordVersion);
            var versions = recordIds
                .Select(recordId => committed.TryGetValue((entityId, recordId), out var version) ? version : reported.Value)
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
            Assigned = result.AssignedValues,
        };
    }

    private static Dictionary<string, object?> ReadValueMap(JsonElement values)
    {
        if (values.ValueKind != JsonValueKind.Object)
        {
            throw new NendoValidationException(
                "Record values must be a JSON object keyed by field ID.");
        }

        // Counted as stored, not as received: a tool's arguments arrive with every non-ASCII
        // character escaped (six bytes for one ø), so counting the raw text refused non-ASCII
        // text at a third of the size (W-165).
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        var total = 0L;
        foreach (var property in values.EnumerateObject())
        {
            if (result.Count == MaximumValueMapEntries)
            {
                throw new NendoValidationException(
                    $"A record may contain at most {MaximumValueMapEntries} submitted values.");
            }
            NendoText.RequireText(property.Name, "field ID", 200);
            var value = ReadValue(property.Value, property.Name);
            total += StoredBytes(property.Value);
            if (total > MaximumValueMapBytes)
            {
                throw new NendoPreconditionException("values-too-large",
                    $"The values of this write hold more than {MaximumValueMapBytes} bytes together, the most one write may " +
                    $"hold (limits.recordValuesBytes); {total} bytes were counted by {property.Name}. Split the fields over more writes.");
            }
            result.Add(property.Name, value);
        }
        return result;
    }

    /// <summary>The UTF-8 bytes a value holds as stored: a string's own text, anything else its JSON text.</summary>
    private static long StoredBytes(JsonElement value) => value.ValueKind == JsonValueKind.String
        ? Encoding.UTF8.GetByteCount(value.GetString()!)
        : Encoding.UTF8.GetByteCount(value.GetRawText());

    private static JsonElement ReadValue(JsonElement value, string fieldId)
    {
        if (StoredBytes(value) is var size && size > MaximumValueBytes)
        {
            throw new NendoPreconditionException("value-too-large",
                $"The value of {fieldId} is {size} bytes, and a value may hold at most {MaximumValueBytes} " +
                "(limits.recordValueBytes, UTF-8 bytes of the text as stored). Shorten it or keep the full text outside the file.");
        }
        if (value.ValueKind == JsonValueKind.Object) value = NendoNumericEnvelope.Decode(value);
        if (value.ValueKind is JsonValueKind.Object or JsonValueKind.Array or JsonValueKind.Undefined)
        {
            throw new NendoValidationException(
                "Field values must be scalar JSON values.");
        }
        return value.Clone();
    }
}
