using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

[McpServerToolType]
internal sealed class NendoAuthoringTools(
    NendoAgentAuthoringService authoring,
    NendoActivityLog activity)
{
    [McpServerTool(
        Name = "nendo.change_set.begin",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Begin a bounded application change-set draft at the current definition revision.")]
    public Task<NendoChangeSetBeginResult> BeginAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Human-readable title shown to the person reviewing the proposal.")] string title,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.begin",
            () => authoring.BeginAsync(
                applicationHandle,
                leaseId,
                title,
                idempotencyKey,
                cancellationToken));

    [McpServerTool(
        Name = "nendo.change_set.add_operations",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Append bounded canonical semantic operations to an owned draft. Each mutation has description and operations;
        each operation has operationType and payload. The host supplies operation IDs. Use stable semantic IDs, never SQL or physical names.
        Families: schema.* (record types, fields, references, choices), ui.* (screens), behaviour.setDefinition/removeDefinition
        (calculations, functions, actions, triggers), data.* (records). A payload the host cannot bind is
        refused here, naming the mutation, operation and key; nothing enters the draft.
        The contract lives in two resources, not in this description: nendo://application/vocabulary carries every canonical
        operation with the payload fields it requires and accepts, every node kind with its properties, permitted children
        and root cardinality, the closed operator, value, ordering and aggregate sets, and the authoring limits;
        nendo://application/examples carries complete change sets you can send as they stand.
        Four rules that are easy to violate and expensive to discover:
        Identifiers are global to the file. entityId, fieldId, recordId and nodeId are each unique across the whole file, not
        scoped to a parent, so prefix them with their owner: task, taskTitle.
        A mutation is the materialization boundary for the definition lane: a required field must sit in the same mutation as
        its schema.createEntity, or be added optional and made required later. UI nodes are exempt.
        expectedDefinitionRevision may be omitted wherever the vocabulary lists it, and the host fills in the value for that
        operation's position; send it and it is honoured exactly.
        ui.addNode takes an inline properties map, so a node and its configuration cost one operation rather than one per
        property. Each property still expands to one canonical ui.setProperty, counted against the canonicalOperationLimit
        the response echoes beside the submitted count.
        Contract version 3 declares definitionVersion=3 on every root; mixing versions across roots fails closed.
        A failed validate leaves the draft open: correct it with nendo.change_set.amend rather than starting again.
        Active data remains unchanged until the person accepts the validated proposal in Nendo.
        """)]
    public Task<NendoChangeSetAddResult> AddOperationsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin.")] string changeSetId,
        [Description("One to eight mutations containing at most sixteen operations in this call. Numeric scalar values in payloads may use {\"$nendoNumber\":\"numeric lexeme\"} for exact integers/decimals; these are decoded before canonical validation.")]
        IReadOnlyList<NendoAgentMutationInput> mutations,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.add_operations",
            () => authoring.AddOperationsAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                mutations,
                idempotencyKey,
                cancellationToken));

    [McpServerTool(
        Name = "nendo.change_set.amend",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Replace the tail of an owned draft that has not been accepted. Drops every mutation from dropFromMutationOrdinal
        onwards and appends the supplied ones, under the same per-call bounds as add_operations. Use it after a failed
        validate: the draft stays open, so correcting one bad operation costs one call rather than a rebuilt change set.
        dropFromMutationOrdinal equal to the current mutationCount appends without dropping anything.
        An exact retry of the same idempotencyKey replays the first result and never truncates twice.
        """)]
    public Task<NendoChangeSetAddResult> AmendAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin.")] string changeSetId,
        [Description("Zero-based ordinal of the first mutation to drop. Use the mutationCount from the last add_operations response to append instead.")] int dropFromMutationOrdinal,
        [Description("Replacement mutations, in the same shape and under the same bounds as nendo.change_set.add_operations.")]
        IReadOnlyList<NendoAgentMutationInput> mutations,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.amend",
            () => authoring.AmendAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                dropFromMutationOrdinal,
                mutations,
                idempotencyKey,
                cancellationToken));

    [McpServerTool(
        Name = "nendo.change_set.validate",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Validate an owned draft on a private clone without changing the active file. A valid draft freezes and becomes a proposal for the person to review. An invalid draft is not consumed: its clone is discarded, the draft stays open, and the returned diagnostics say what to correct with nendo.change_set.amend before validating again.")]
    public Task<NendoAgentProposalPreview> ValidateAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin.")] string changeSetId,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.validate",
            () => authoring.ValidateAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                idempotencyKey,
                cancellationToken),
            result => result.ProposalId);

    [McpServerTool(
        Name = "nendo.change_set.preview",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true)]
    [Description("Read the sanitized validation preview for this handle's frozen change set.")]
    public Task<NendoAgentProposalPreview> PreviewAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin.")] string changeSetId,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.preview",
            () => authoring.PreviewAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                cancellationToken),
            result => result.ProposalId);

    [McpServerTool(
        Name = "nendo.change_set.reject",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Reject this handle's draft or preview without changing the active file.")]
    public Task<NendoChangeSetRejectResult> RejectAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin.")] string changeSetId,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.reject",
            () => authoring.RejectAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                idempotencyKey,
                cancellationToken),
            result => result.ProposalId);

    private async Task<T> ExecuteAsync<T>(
        RequestContext<CallToolRequestParams> context,
        string name,
        Func<Task<T>> action,
        Func<T, string?>? proposalId = null)
    {
        try
        {
            var result = await action();
            activity.Record(
                "authoring",
                name,
                context.Server,
                "completed",
                proposalId: proposalId?.Invoke(result));
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw NendoToolErrors.Translate(exception);
        }
    }
}
