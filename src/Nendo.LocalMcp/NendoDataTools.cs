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
    NendoAgentProposalStore proposals)
{
    [McpServerTool(Name = "nendo.data.get_receipt", Destructive = false, Idempotent = true,
        OpenWorld = false, ReadOnly = true, UseStructuredContent = true)]
    [Description("Read a prior data-operation receipt using the locator saved from its lease grant. Works after reconnect and grants no edit access. Missing evidence remains unresolved.")]
    public async Task<NendoDataOutcome> GetReceiptAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Unprivileged receiptContext saved from the original lease grant.")] string receiptContext,
        [Description("The exact original mutation idempotency key.")] string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var result = await mutations.GetReceiptAsync(receiptContext, idempotencyKey, cancellationToken);
            activity.Record("receipt", "nendo.data.get_receipt", context.Server, result.State, result.Receipt?.RevisionId);
            return result;
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception) { throw NendoToolErrors.Translate(exception); }
    }

    [McpServerTool(
        Name = "nendo.data.create_record",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Create one record through the open application's semantic entity schema. Returns the record ID and its new version, so a record that will be referenced needs no follow-up read. Use nendo.data.create_records for several records in one revision.")]
    public Task<NendoDataApplyResult> CreateRecordAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Stable entity ID from nendo://application/entities or nendo://application/describe.")] string entityId,
        [Description("Stable caller-selected record ID.")] string recordId,
        [Description("Bounded scalar value map keyed by stable field ID. Send exact integers/decimals as {\"$nendoNumber\":\"numeric lexeme\"}; use numericLexemes from nendo://application/entity/{entityId}/records, never a rounded JavaScript number. A text or singleChoice value is the JSON string itself (Bean), never a string with quote characters inside it; a choice must be one of the field's options exactly. A calculated field (derivedFields in the schema read) cannot be written.")] NendoObjectInput values,
        [Description("Stable key used to make exact retries safe.")] string idempotencyKey,
        [Description("For each non-null reference field, the current version of its selected target, keyed by field ID.")] IReadOnlyDictionary<string, long>? expectedTargetVersions = null,
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
                cancellationToken, expectedTargetVersions),
            entityId);

    [McpServerTool(
        Name = "nendo.data.create_records",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Create up to fifty records of one entity as a single revision under one idempotency key. All or nothing: if any record is refused, none are written. Returns every record ID it created. recordVersion is the version they all hold, 1 unless an automatic action wrote back to them; when an action moved only some of them it is null, and alsoChanged names each moved record with its own version.")]
    public Task<NendoDataApplyResult> CreateRecordsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Stable entity ID from nendo://application/entities or nendo://application/describe.")] string entityId,
        [Description("One to fifty records with distinct stable record IDs. The per-call and per-record bounds are published in nendo://application/vocabulary.")]
        IReadOnlyList<NendoRecordInput> records,
        [Description("Stable key used to make exact retries safe.")] string idempotencyKey,
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
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Create many records of one record type from faithful CSV text or typed JSON, without a file picker.
        This is how a new application is given its data: nendo.data.create_records takes fifty at a time and a
        demonstration dataset is twenty round trips of it.
        format is "csv" or "json". For csv, send the text itself in csv -- never a path, which this host does not
        accept anywhere -- and map its columns with columnMappings, each {column, fieldId}, column being the
        zero-based position in the header row. Set csvProfile to "nendo" for text that came out of
        nendo://application/entity/{entityId}/export or the person's own Export, where a backslash followed by N means null and a
        non-null value starting with a backslash carries one extra; leave it "external" for ordinary CSV, where
        every cell is literal. emptyIsNull applies to external CSV only and is off by default, so empty text stays
        empty text. Record IDs are derived for you and are stable across an exact retry.
        For json, send records as [{recordId, values}], the same shape nendo.data.create_records takes, with
        exact numbers as {"$nendoNumber":"lexeme"} and reference targets in expectedTargetVersions.
        Bounds: 500 rows per call, echoed back as maximumRowsPerCall, and the usual 256 KiB request body, which is
        the limit you will meet first. It commits in batches of fifty, each one revision, each all or nothing, each
        with its own key derived from yours -- so a batch that is refused stops the run and leaves the batches
        before it committed. committed says exactly how many landed and remaining how many did not; nothing here
        claims the whole call is atomic. Retry the same call with the same idempotencyKey to finish it.
        Create the record type first: a write into one an unaccepted proposal would create names that proposal.
        """)]
    public Task<NendoImportResult> ImportRecordsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Stable entity ID from nendo://application/entities or nendo://application/describe.")] string entityId,
        [Description("\"csv\" to send CSV text, or \"json\" to send typed records.")] string format,
        [Description("Stable key used to make exact retries safe. Record IDs for a CSV import are derived from it.")] string idempotencyKey,
        [Description("csv only: the CSV text itself, header row included. Never a path.")] string? csv = null,
        [Description("csv only: one {column, fieldId} per column to import, column being its zero-based position in the header row. Unmapped columns are ignored; every required field must be mapped.")] IReadOnlyList<NendoCsvColumnMapping>? columnMappings = null,
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
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Set one field on one record using an exact expected record version.")]
    public Task<NendoDataApplyResult> SetFieldAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Stable entity ID from nendo://application/entities or nendo://application/describe.")] string entityId,
        [Description("Stable record ID from nendo://application/entity/{entityId}/records.")] string recordId,
        [Description("Stable field ID from nendo://application/entity/{entityId}/schema, one of its fields. A derivedFields entry is calculated and cannot be written.")] string fieldId,
        [Description("Current record version required for this edit.")] long expectedRecordVersion,
        [Description("Scalar value valid for the field. Exact integers/decimals may use {\"$nendoNumber\":\"numeric lexeme\"}; numericLexemes at nendo://application/entity/{entityId}/records preserves every digit. A text or singleChoice value is the JSON string itself (Bean), never a string with quote characters inside it; a choice must be one of the field's options exactly.")] NendoScalarInput value,
        [Description("Stable key used to make exact retries safe.")] string idempotencyKey,
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
                cancellationToken, expectedTargetRecordVersion),
            entityId, fieldId);

    [McpServerTool(
        Name = "nendo.data.execute_command",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Execute one declarative command from the application's compiled semantic surface. A command sets one field per commandStep against consecutive record versions, so it advances the record by one version per step; the returned recordVersion is the version the record now holds, and is null only on an idempotent replay. Read the record back at nendo://application/entity/{entityId}/records to confirm the values.")]
    public Task<NendoDataApplyResult> ExecuteCommandAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Stable command ID from the application surfaces resource. For a contract version 3 file this is the commandId on a recordCommand root under applications[].surfaces, which is that root's node ID.")] string commandId,
        [Description("Stable target record ID.")] string recordId,
        [Description("Current record version required for this command.")] long expectedRecordVersion,
        [Description("Stable key used to make exact retries safe.")] string idempotencyKey,
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
                "mutation",
                name,
                context.Server,
                "committed",
                (result as NendoDataApplyResult)?.RevisionId);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw NendoToolErrors.Translate(exception, () => proposals.PendingCause(names));
        }
    }

    [McpServerTool(Name = "nendo.data.delete_record", Destructive = true, Idempotent = true,
        OpenWorld = false, ReadOnly = false, UseStructuredContent = true)]
    [Description("Delete one record at its exact current version. Incoming references block deletion. Values and the reserved ID are retained for guarded restoration through host History. recordVersion is null in the result because a deleted record holds no current version; the version it was deleted at is the expectedRecordVersion you sent.")]
    public Task<NendoDataApplyResult> DeleteRecordAsync(RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
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
