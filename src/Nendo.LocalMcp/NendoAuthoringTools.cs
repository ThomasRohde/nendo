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
        Title = "Begin a change set",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Begin a private change-set draft for this handle at the file's current definition revision and return its changeSetId, which add_operations, amend, validate, preview and reject take. title is what the person sees on the proposal. A session holds at most limits.draftsPerSession open drafts (nendo://application/vocabulary); one more is refused as NENDO_DRAFT_LIMIT. outstandingProposals and advisory report other change sets open against the file: accepting any one advances the definition revision and leaves the rest stale. A draft never validated is discarded when the lease ends; a validated proposal stays. An exact retry under the same idempotencyKey returns the same draft.")]
    public Task<NendoChangeSetBeginResult> BeginAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("Human-readable title shown to the person reviewing the proposal.")] string title,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
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
        Title = "Add operations to a change set",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Append bounded canonical semantic operations to an owned draft. Each mutation has description and operations;
        each operation has operationType and payload. The host supplies operation IDs. Use stable semantic IDs, never SQL or physical names.
        Families: schema.* (record types, fields, references, choices, hierarchies), ui.* (screens),
        behaviour.setDefinition/removeDefinition (calculations, functions, actions, triggers), extension.* (custom-view
        packages), application.setPurpose and setLook, and data.* (records).
        A payload the host cannot bind is refused here, naming the mutation, operation and key; nothing enters the draft.
        The contract lives in nendo://application/vocabulary, not in this description: operations carries every canonical
        operation with the payload fields it requires and accepts, authoringRules the rules that are easy to break and
        expensive to discover (definition IDs are global; record IDs are scoped to their type; a required field sits in the same mutation as its
        schema.createEntity), and limits the bounds. nendo://application/examples carries complete change sets you can
        send as they stand.
        A failed validate leaves the draft open: correct it with nendo.change_set.amend rather than starting again.
        Nothing in the draft touches the active file until its validated proposal is accepted: by the person in Nendo or, at Unattended only, by nendo.change_set.accept.
        """)]
    public Task<NendoChangeSetAddResult> AddOperationsAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.ChangeSetId)] string changeSetId,
        [Description("The mutations for this call, within the per-call bounds nendo://application/vocabulary publishes under limits (mutationsPerCall, operationsPerCall); the result echoes the change set's ceilings. Numeric scalar values in payloads may use {\"$nendoNumber\":\"numeric lexeme\"} for exact integers/decimals; these are decoded before canonical validation.")]
        IReadOnlyList<NendoAgentMutationInput> mutations,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
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
        Title = "Amend a change set",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Replace the tail of an owned draft that has not been validated. Drops every mutation from dropFromMutationOrdinal
        onwards and appends the supplied ones, under the same per-call bounds as add_operations. Use it after a failed
        validate: the draft stays open, so correcting one bad operation costs one call rather than a rebuilt change set.
        dropFromMutationOrdinal equal to the current mutationCount appends without dropping anything.
        An exact retry of the same idempotencyKey replays the first result and never truncates twice.
        """)]
    public Task<NendoChangeSetAddResult> AmendAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.ChangeSetId)] string changeSetId,
        [Description("Zero-based ordinal of the first mutation to drop. Use the mutationCount from the last add_operations response to append instead.")] int dropFromMutationOrdinal,
        [Description("Replacement mutations, in the same shape and under the same bounds as nendo.change_set.add_operations.")]
        IReadOnlyList<NendoAgentMutationInput> mutations,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
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
        Title = "Validate a change set into a proposal",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Validate an owned draft on a private clone without changing the active file. A valid draft freezes and becomes a proposal: the person reviews it in Nendo, or at Unattended nendo.change_set.accept applies it. An invalid draft is not consumed: its clone is discarded, the draft stays open, and the returned diagnostics say what to correct with nendo.change_set.amend before validating again.")]
    public Task<NendoAgentProposalPreview> ValidateAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.ChangeSetId)] string changeSetId,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
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
        Name = "nendo.change_set.revalidate",
        Title = "Validate a proposal again at the current revision",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Validate this handle's proposal again, at the file's current definition revision, with the same operations: the proposal it replaces is rejected and a new one takes its place under the same changeSetId, previewable for the person or, at Unattended, for nendo.change_set.accept. Use it after an accept answered stale, or when nendo://application/proposals says the file moved under it, instead of rejecting and resending every operation. A draft that no longer validates at the new revision stays open to amend. Still a draft: NENDO_CHANGE_SET_NOT_VALIDATED.")]
    public Task<NendoAgentProposalPreview> RevalidateAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description("Server-minted change-set ID of a validated proposal this handle owns.")] string changeSetId,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
        CancellationToken cancellationToken = default) => ExecuteAsync(
            context,
            "nendo.change_set.revalidate",
            () => authoring.RevalidateAsync(applicationHandle, leaseId, changeSetId, idempotencyKey, cancellationToken),
            result => result.ProposalId);

    [McpServerTool(
        Name = "nendo.change_set.preview",
        Title = "Preview a proposal",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true)]
    [Description("Read the sanitized validation preview for this handle's frozen change set. The same preview, for any proposal and without a lease, is nendo://application/proposal/{proposalId}.")]
    public Task<NendoAgentProposalPreview> PreviewAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.ChangeSetId)] string changeSetId,
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
        Title = "Reject a change set",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("Reject this handle's draft or validated proposal without changing the active file. A proposal leaves nendo://application/proposals and its private clone is discarded; a draft is dropped with its operations. An exact retry under the same idempotencyKey replays the first result. For a proposal that went stale, nendo.change_set.revalidate keeps the operations instead.")]
    public Task<NendoChangeSetRejectResult> RejectAsync(
        RequestContext<CallToolRequestParams> context,
        [Description(NendoParameterDescriptions.ApplicationHandle)] string applicationHandle,
        [Description(NendoParameterDescriptions.LeaseId)] string leaseId,
        [Description(NendoParameterDescriptions.ChangeSetId)] string changeSetId,
        [Description(NendoParameterDescriptions.IdempotencyKey)] string idempotencyKey,
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

    private Task<T> ExecuteAsync<T>(
        RequestContext<CallToolRequestParams> context,
        string name,
        Func<Task<T>> action,
        Func<T, string?>? proposalId = null) => NendoToolCall.RunAsync(
            context, activity, "authoring", name, action, _ => "completed", proposalId: proposalId);
}
