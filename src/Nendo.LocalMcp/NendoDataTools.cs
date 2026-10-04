using System.ComponentModel;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Nendo.Engine;

namespace Nendo.LocalMcp;

[McpServerToolType]
internal sealed class NendoDataTools(
    NendoDataMutationService mutations,
    NendoActivityLog activity,
    NendoAgentProposalStore proposals,
    NendoHostAuthority host)
{
    [McpServerTool(Name = "nendo.data.get_receipt", Title = "Read a write's receipt", Destructive = false, Idempotent = true,
        OpenWorld = false, ReadOnly = true, UseStructuredContent = true)]
    [Description("Read a prior write's receipt using the locator saved from its lease grant: a data operation by its idempotencyKey, an import by the key it was sent under (every committed batch answers, in order), or an accepted proposal by proposalId. Works after reconnect and grants no edit access. Missing evidence remains unresolved.")]
    public async Task<NendoDataOutcome> GetReceiptAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Unprivileged receiptContext saved from the original lease grant.")] string receiptContext,
        [Description("The exact original idempotency key of the write or import. Omit it only with proposalId.")] string? idempotencyKey = null,
        [Description("The proposal whose acceptance to read, as nendo://application/proposals or the accept result names it. Answers with every revision the acceptance committed.")] string? proposalId = null,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var result = await mutations.GetReceiptAsync(receiptContext, idempotencyKey, proposalId, cancellationToken);
            activity.Record(context, "receipt", "nendo.data.get_receipt", result.State, result.Receipt?.RevisionId);
            return result;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception) { throw NendoToolErrors.Translate(exception); }
    }

    [McpServerTool(
        Name = "nendo.data.create_record",
        Title = "Create a record",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Create one record through the open application's semantic entity schema. Returns the record ID and its new version, so a record that will be referenced needs no follow-up read. Use nendo.data.create_records for several records in one revision.")]
    public Task<NendoDataApplyResult> CreateRecordAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.EntityId)] string entityId,
        [Description("Stable caller-selected record ID.")] string recordId,
        [Description("Bounded scalar value map keyed by stable field ID. Send exact integers/decimals as {\"$nendoNumber\":\"numeric lexeme\"}; use numericLexemes from nendo://application/entity/{entityId}/records, never a rounded JavaScript number. A text or singleChoice value is the JSON string itself (Bean), never a string with quote characters inside it; a choice must be one of the field's options exactly. A calculated field (derivedFields in the schema read) cannot be written.")] NendoObjectInput values,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        [Description("For each non-null reference field, the current version of its selected target, keyed by field ID.")] IReadOnlyDictionary<string, long>? expectedTargetVersions = null,
        [Description("Optional. true keeps the record in a new file of this application, false leaves it out; omit to follow its record type's keptInNewFiles. Set in the same revision as the create.")] bool? keptInNewFiles = null,
        [Description("Reference targets named by record ID or by a unique field's value, keyed by field ID; the host writes the ID and current version.")] IReadOnlyDictionary<string, NendoReferenceInput>? references = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.create_record",
            () => mutations.CreateRecordAsync(
                applicationHandle,
                leaseId,
                entityId,
                recordId,
                values,
                idempotencyKey,
                expectedTargetVersions,
                keptInNewFiles,
                references,
                cancellationToken),
            entityId);

    [McpServerTool(
        Name = "nendo.data.create_records",
        Title = "Create up to fifty records",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Create up to fifty records of one entity as a single revision under one idempotency key. All or nothing: if any record is refused, none are written. Returns every record ID it created. recordVersion is the version they all hold, 1 unless an automatic action wrote back to them; when an action moved only some of them it is null, and alsoChanged names each moved record with its own version.")]
    public Task<NendoDataApplyResult> CreateRecordsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.EntityId)] string entityId,
        [Description("One to fifty records with distinct stable record IDs. The per-call and per-record bounds are published in nendo://application/vocabulary.")]
        IReadOnlyList<NendoRecordInput> records,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.create_records",
            () => mutations.CreateRecordsAsync(
                applicationHandle,
                leaseId,
                entityId,
                records,
                idempotencyKey,
                cancellationToken),
            entityId);

    [McpServerTool(
        Name = "nendo.data.import_records",
        Title = "Import records from CSV or JSON",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Create many records of one record type from CSV text or typed JSON: the way a new application is given its
        data, where nendo.data.create_records takes fifty at a time.
        format is "csv" or "json". For csv, send the text itself in csv, never a path, and map its columns with
        columnMappings, each {column, fieldId}, column being the zero-based position in the header row. csvProfile
        "nendo" reads text from nendo://application/entity/{entityId}/export or the person's own Export, where a
        backslash followed by N means null and a value starting with a backslash carries one extra; the default,
        "external", reads every cell literally, and emptyIsNull (off by default) makes its empty cells null.
        Record IDs are derived for you and are stable across an exact retry.
        For json, send records as [{recordId, values}], the shape nendo.data.create_records takes, with exact
        numbers as {"$nendoNumber":"lexeme"} and reference targets in expectedTargetVersions.
        Bounds: 500 rows per call, echoed as maximumRowsPerCall, and the 256 KiB request body, which you will meet
        first. It commits in batches of fifty, each one revision and all or nothing, each with a key derived from
        yours, so a refused batch stops the run and leaves the batches before it committed. On success, committed
        and remaining state the counts. If a later batch is refused, NENDO_IMPORT_PARTIAL names the number
        committed, the number remaining, the first uncommitted data row, the committed revision IDs and the cause.
        Retry the identical call with the same idempotencyKey: earlier batches replay without duplicates. Bad
        mappings and mixed CSV/JSON payloads are refused before any write; the call as a whole is not atomic.
        Create the record type first: a write into one an unaccepted proposal would create names that proposal.
        """)]
    public Task<NendoImportResult> ImportRecordsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.EntityId)] string entityId,
        [Description("\"csv\" to send CSV text, or \"json\" to send typed records.")] string format,
        [Description("Stable key used to make exact retries safe. Record IDs for a CSV import are derived from it.")] string idempotencyKey,
        [Description("csv only: the CSV text itself, header row included. Never a path.")] string? csv = null,
        [Description("csv only: one {column, fieldId} per column to import, column being its zero-based position in the header row. Unmapped columns are ignored; every required field must be mapped. A reference column may add matchFieldId, a unique field of its target, when its cells hold codes rather than record IDs; a tree whose parent column holds codes is then written parents first.")] IReadOnlyList<NendoCsvColumnMapping>? columnMappings = null,
        [Description("csv only: \"nendo\" for the faithful profile with its backslash-N null marker and backslash escaping, or \"external\" (the default) for literal text.")] string? csvProfile = null,
        [Description("csv only, external profile only: treat an empty cell as null rather than as empty text. Off by default.")] bool emptyIsNull = false,
        [Description("json only: one to five hundred records with distinct stable record IDs, the same shape nendo.data.create_records takes.")] IReadOnlyList<NendoRecordInput>? records = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.import_records",
            () => mutations.ImportAsync(
                applicationHandle,
                leaseId,
                entityId,
                format,
                csv,
                columnMappings,
                csvProfile,
                emptyIsNull,
                records,
                idempotencyKey,
                cancellationToken),
            entityId);

    [McpServerTool(
        Name = "nendo.data.set_field",
        Title = "Set a field",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Set one field on one record using an exact expected record version.")]
    public Task<NendoDataApplyResult> SetFieldAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.EntityId)] string entityId,
        [Description("Stable record ID from nendo://application/entity/{entityId}/records.")] string recordId,
        [Description("Stable field ID from nendo://application/entity/{entityId}/schema, one of its fields. A derivedFields entry is calculated and cannot be written.")] string fieldId,
        [Description("Current record version required for this edit.")] long expectedRecordVersion,
        [Description("Scalar value valid for the field. Exact integers/decimals may use {\"$nendoNumber\":\"numeric lexeme\"}; numericLexemes at nendo://application/entity/{entityId}/records preserves every digit. A text or singleChoice value is the JSON string itself (Bean), never a string with quote characters inside it; a choice must be one of the field's options exactly.")] NendoScalarInput value,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        [Description("Required for a non-null reference assignment: the current version of its selected target record.")] long? expectedTargetRecordVersion = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.set_field",
            () => mutations.SetFieldAsync(
                applicationHandle,
                leaseId,
                entityId,
                recordId,
                fieldId,
                expectedRecordVersion,
                value,
                idempotencyKey,
                expectedTargetRecordVersion,
                cancellationToken),
            entityId, fieldId);

    [McpServerTool(
        Name = "nendo.data.update_record",
        Title = "Update several fields of a record",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Set several fields of one record as one revision at an exact expected record version: the form save the Workbench makes, 1 to 64 fields, instead of one nendo.data.set_field per field. The record advances one version per field written, in stable field order, and recordVersion reports where it stands. Values follow nendo.data.set_field's rules. A reference may be given as a value with its target's version in expectedTargetVersions, or named in references by record ID or by a unique field's value and resolved by the host.")]
    public Task<NendoDataApplyResult> UpdateRecordAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.EntityId)] string entityId,
        [Description("Stable record ID from nendo://application/entity/{entityId}/records.")] string recordId,
        [Description("Current record version required for this edit.")] long expectedRecordVersion,
        [Description("The fields to write, keyed by stable field ID, each a scalar valid for its field; exact numbers as {\"$nendoNumber\":\"numeric lexeme\"}. A calculated field cannot be written.")] NendoObjectInput values,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        [Description("For each non-null reference value, the current version of its target, keyed by field ID.")] IReadOnlyDictionary<string, long>? expectedTargetVersions = null,
        [Description("Reference targets named by record ID or by a unique field's value, keyed by field ID; the host writes the ID and version.")] IReadOnlyDictionary<string, NendoReferenceInput>? references = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.update_record",
            () => mutations.UpdateRecordAsync(
                applicationHandle,
                leaseId,
                entityId,
                recordId,
                expectedRecordVersion,
                values,
                idempotencyKey,
                expectedTargetVersions,
                references,
                cancellationToken),
            entityId);

    [McpServerTool(
        Name = "nendo.data.apply_writes",
        Title = "Write several records as one revision",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Create, update and delete records across record types as one revision, all or nothing: the batch the Workbench's forms commit. Up to limits.recordWritesPerCall writes, each a create (values), an update (expectedRecordVersion and 1 to 64 values) or a delete (expectedRecordVersion), one write per record. A write may point at a record an earlier write in the batch created; the host supplies that target's version. The result names every record with the version it holds now; label is what History calls the revision.")]
    public Task<NendoDataWritesResult> ApplyWritesAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("The writes, in order, each naming its kind, record type and record.")] IReadOnlyList<NendoRecordWriteInput> writes,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        [Description("Optional. What History calls this revision, 1 to 80 characters; omitted, it is described by what it does.")] string? label = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.apply_writes",
            () => mutations.ApplyWritesAsync(applicationHandle, leaseId, writes, idempotencyKey, label, cancellationToken),
            writes is null ? [] : writes.Select(write => write?.EntityId).ToArray());

    [McpServerTool(
        Name = "nendo.data.move_record",
        Title = "Move a record in its hierarchy",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Move a record in its record type's declared hierarchy (schema.declareHierarchy): under another parent, or to the top level with parentRecordId null, and, when the hierarchy declares an order field, before a named sibling or last. One revision of data.setField operations: the parent, the order, and only when no gap is left the siblings renumbered. The host refuses a move under the record's own descendants or deeper than the hierarchy allows. recordIds names every record written; recordVersion is stated when only the moved record was written — otherwise read the records back.")]
    public Task<NendoDataApplyResult> MoveRecordAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("Stable entity ID of a record type that declares a hierarchy.")] string entityId,
        [Description("The record to move.")] string recordId,
        [Description("The record's current version.")] long expectedRecordVersion,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        [Description("The new parent's record ID, or null for the top level.")] string? parentRecordId = null,
        [Description("The new parent's current version; required with a parentRecordId.")] long? expectedParentVersion = null,
        [Description("A sibling under the new parent to place the record before; omit to place it last. Needs an order field.")] string? beforeRecordId = null,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.move_record",
            () => mutations.MoveRecordAsync(
                applicationHandle,
                leaseId,
                entityId,
                recordId,
                expectedRecordVersion,
                parentRecordId,
                expectedParentVersion,
                beforeRecordId,
                idempotencyKey,
                cancellationToken),
            entityId);

    [McpServerTool(
        Name = "nendo.data.execute_command",
        Title = "Run a record command",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Execute one declarative command from the application's compiled semantic surface. A command sets one field per commandStep against consecutive record versions, so it advances the record by one version per step; the returned recordVersion is the version the record now holds, and is null only on an idempotent replay. Read the record back at nendo://application/entity/{entityId}/records to confirm the values.")]
    public Task<NendoDataApplyResult> ExecuteCommandAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("Stable command ID from the application surfaces resource. For a contract version 3 file this is the commandId on a recordCommand root under applications[].surfaces, which is that root's node ID.")] string commandId,
        [Description("Stable target record ID.")] string recordId,
        [Description("Current record version required for this command.")] long expectedRecordVersion,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.data.execute_command",
            () => mutations.ExecuteCommandAsync(
                applicationHandle,
                leaseId,
                commandId,
                recordId,
                expectedRecordVersion,
                idempotencyKey,
                cancellationToken),
            commandId);

    /// <summary>
    /// <paramref name="names"/> are the semantic IDs this call refers to. They are
    /// used only on the failing path, to say whether an outstanding proposal is
    /// what this write is waiting for.
    /// </summary>
    private async Task<T> ExecuteAsync<T>(
        RequestContext<CallToolRequestParams> context,
        string name,
        Func<Task<T>> action,
        params string?[] names)
    {
        try
        {
            var result = await action();
            // An import commits several revisions, so it has no single revision ID to
            // record. Saying it committed without naming one is the true statement; the
            // revisions themselves are in History either way.
            activity.Record(
                context,
                "mutation",
                name,
                "committed",
                (result as INendoRevisionResult)?.RevisionId);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw NendoToolErrors.Translate(
                exception,
                () => proposals.PendingCause(host.Mode >= AgentAccessMode.Unattended, names));
        }
    }

    [McpServerTool(Name = "nendo.data.set_kept_in_new_files", Title = "Keep a record in new files, or leave it out", Destructive = true,
        Idempotent = true, OpenWorld = false, ReadOnly = false, UseStructuredContent = true)]
    [Description("Say whether a new file of this application keeps one record (ADR-0022): kept true, left out false, or null to follow its record type's keptInNewFiles, which schema.setKeptInNewFiles sets in a change set. Keep what the application ships with, such as a lookup's entries or its top-level folders; leave the person's work out. A kept record may point only at kept records, or the person cannot make a new file: nendo://application/describe lists any under newFile.conflicts. The mark is a fact about the record, not a value: no field or record version changes and no automatic action runs. One Data revision, undone from History.")]
    public Task<NendoDataApplyResult> SetKeptInNewFilesAsync(RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("Stable entity ID.")] string entityId,
        [Description("Stable record ID.")] string recordId,
        [Description("true to keep the record in a new file, false to leave it out, null to follow its record type.")] bool? kept,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(context, "nendo.data.set_kept_in_new_files",
            () => mutations.SetKeptInNewFilesAsync(applicationHandle, leaseId, entityId, recordId, kept, idempotencyKey, cancellationToken),
            entityId);

    [McpServerTool(Name = "nendo.data.delete_record", Title = "Delete a record", Destructive = true, Idempotent = true,
        OpenWorld = false, ReadOnly = false, UseStructuredContent = true)]
    [Description("Delete one record at its exact current version. Incoming references block deletion. Values and the reserved ID are retained for guarded restoration through host History. recordVersion is null in the result because a deleted record holds no current version; the version it was deleted at is the expectedRecordVersion you sent.")]
    public Task<NendoDataApplyResult> DeleteRecordAsync(RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description("Opaque edit lease ID.")] string leaseId,
        [Description("Stable entity ID.")] string entityId,
        [Description("Stable record ID.")] string recordId,
        [Description("Exact current record version.")] long expectedRecordVersion,
        [Description("Stable key for exact retries.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(context, "nendo.data.delete_record",
            () => mutations.DeleteRecordAsync(applicationHandle, leaseId,
                entityId, recordId, expectedRecordVersion, idempotencyKey, cancellationToken),
            entityId);
}
