using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoAgentAuthoringService(
    NendoApplicationService application,
    NendoAgentAuthority authority,
    NendoHostAuthority host,
    NendoAgentProposalStore proposals,
    NendoUnattendedAuthority unattended)
{
    // The published limits are the enforced limits: nendo://application/vocabulary
    // serializes this same record, so an agent plans batches against what refuses.
    private static readonly NendoAuthoringLimits Limits = NendoAuthoringLimits.Current;
    private static readonly int MaximumDraftsPerSession = Limits.DraftsPerSession;
    private static readonly int MaximumMutationsPerAdd = Limits.MutationsPerCall;
    private static readonly int MaximumOperationsPerAdd = Limits.OperationsPerCall;
    private static readonly int MaximumMutationsPerChangeSet = Limits.MutationsPerChangeSet;
    private static readonly int MaximumOperationsPerChangeSet = Limits.OperationsPerChangeSet;
    private static readonly int MaximumCanonicalOperationsPerChangeSet = Limits.CanonicalOperationsPerChangeSet;
    private static readonly int MaximumPropertiesPerNodeOperation = Limits.PropertiesPerNodeOperation;
    private const int MaximumPayloadBytes = 32 * 1024;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, Draft> _drafts = new(StringComparer.Ordinal);
    private readonly Dictionary<(string SessionId, string Key), Replay<NendoChangeSetBeginResult>>
        _beginReplays = new();
    private readonly Dictionary<(string SessionId, string ChangeSetId, string Key), Replay<NendoAgentProposalPreview>>
        _validateReplays = new();
    private readonly Dictionary<(string SessionId, string ChangeSetId, string Key), Replay<NendoChangeSetRejectResult>>
        _rejectReplays = new();
    private readonly Dictionary<(string SessionId, string ChangeSetId, string Key), Replay<NendoChangeSetAcceptResult>>
        _acceptReplays = new();

    internal Task<NendoChangeSetBeginResult> BeginAsync(
        string sessionId,
        string leaseId,
        string title,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                RequireText(title, "title", 200);
                RequireKey(idempotencyKey);
                var digest = Digest(new { title });
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    var replayKey = (sessionId, idempotencyKey);
                    if (_beginReplays.TryGetValue(replayKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    if (_drafts.Values.Count(value => value.SessionId == sessionId) >= MaximumDraftsPerSession)
                    {
                        throw new NendoAgentAuthoringException(
                            "DRAFT_LIMIT",
                            "The agent session has too many live change-set drafts.");
                    }
                    var snapshot = await application.GetSnapshotAsync(cancellationToken);
                    RequireHostIdentity(snapshot);
                    var changeSetId = $"change-set-{RandomHex(16)}";
                    // Two proposals can capture the same revision, and accepting
                    // either invalidates the other. Say so here rather than let a
                    // person discover it at the approval dialog, after reviewing.
                    var outstanding = _drafts.Count + proposals.Snapshot().Count;
                    var result = new NendoChangeSetBeginResult(
                        changeSetId,
                        title.Trim(),
                        snapshot.Manifest.DefinitionRevision,
                        "draft")
                    {
                        OutstandingProposals = outstanding,
                        Advisory = outstanding == 0
                            ? null
                            : $"{outstanding} other change {(outstanding == 1 ? "set is" : "sets are")} open against definition revision " +
                              $"{snapshot.Manifest.DefinitionRevision}. Accepting any one of them advances the revision and invalidates the rest; " +
                              "finish or reject the others before building this one.",
                    };
                    _drafts.Add(changeSetId, new Draft(
                        changeSetId,
                        result.Title,
                        sessionId,
                        leaseId,
                        host.HostRunId,
                        snapshot.Manifest.ApplicationId,
                        snapshot.Manifest.InstanceId,
                        snapshot.Manifest.DefinitionRevision));
                    _beginReplays.Add(replayKey, new Replay<NendoChangeSetBeginResult>(digest, result));
                    return result;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    internal Task<NendoChangeSetAddResult> AddOperationsAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        IReadOnlyList<NendoAgentMutationInput> mutations,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                RequireKey(idempotencyKey);
                var validated = ValidateMutations(mutations);
                var digest = Digest(validated);
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    var draft = RequireDraft(changeSetId, sessionId, leaseId);
                    if (draft.Frozen)
                    {
                        throw new NendoAgentAuthoringException(
                            "CHANGE_SET_FROZEN",
                            "The change set is already frozen for validation.");
                    }
                    if (draft.AddReplays.TryGetValue(idempotencyKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    var operationCount = validated.Sum(value => value.Operations.Count);
                    var canonicalCount = CanonicalCount(validated);
                    RequireChangeSetCapacity(
                        draft.Mutations.Count,
                        draft.OperationCount,
                        draft.CanonicalOperationCount,
                        validated.Count,
                        operationCount,
                        canonicalCount);
                    RequireCompilable(validated, draft, draft.Mutations.Count);
                    draft.Mutations.AddRange(validated);
                    draft.OperationCount += operationCount;
                    draft.CanonicalOperationCount += canonicalCount;
                    var result = Progress(draft);
                    draft.AddReplays.Add(
                        idempotencyKey,
                        new Replay<NendoChangeSetAddResult>(digest, result));
                    return result;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    /// <summary>
    /// Replace the tail of an unvalidated draft. A failed validation typically
    /// names one bad operation out of fifty; without this the only way to correct
    /// it is to rebuild the whole change set in a new draft.
    /// </summary>
    internal Task<NendoChangeSetAddResult> AmendAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        int dropFromMutationOrdinal,
        IReadOnlyList<NendoAgentMutationInput> mutations,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                RequireKey(idempotencyKey);
                var validated = ValidateMutations(mutations);
                var digest = Digest(new { dropFromMutationOrdinal, validated });
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    var draft = RequireDraft(changeSetId, sessionId, leaseId);
                    if (draft.Frozen)
                    {
                        throw new NendoAgentAuthoringException(
                            "CHANGE_SET_FROZEN",
                            "The change set is already frozen for validation.");
                    }
                    // An exact retry replays rather than truncating twice.
                    if (draft.AddReplays.TryGetValue(idempotencyKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    if (dropFromMutationOrdinal < 0 || dropFromMutationOrdinal > draft.Mutations.Count)
                    {
                        throw new NendoAgentAuthoringException(
                            "CHANGE_SET_ORDINAL",
                            $"Drop from mutation ordinal 0-{draft.Mutations.Count}; the change set holds {draft.Mutations.Count} mutations.");
                    }
                    var kept = draft.Mutations.Take(dropFromMutationOrdinal).ToArray();
                    var keptOperations = kept.Sum(value => value.Operations.Count);
                    var keptCanonical = CanonicalCount(kept);
                    var operationCount = validated.Sum(value => value.Operations.Count);
                    var canonicalCount = CanonicalCount(validated);
                    RequireChangeSetCapacity(
                        kept.Length,
                        keptOperations,
                        keptCanonical,
                        validated.Count,
                        operationCount,
                        canonicalCount);
                    RequireCompilable(validated, draft, dropFromMutationOrdinal);
                    draft.Mutations.Clear();
                    draft.Mutations.AddRange(kept);
                    draft.Mutations.AddRange(validated);
                    draft.OperationCount = keptOperations + operationCount;
                    draft.CanonicalOperationCount = keptCanonical + canonicalCount;
                    // The draft no longer holds what a previous validation saw, so
                    // an exact retry of that validate must not replay its verdict.
                    foreach (var key in _validateReplays.Keys.Where(value => value.ChangeSetId == changeSetId).ToArray())
                    {
                        _validateReplays.Remove(key);
                    }
                    var result = Progress(draft);
                    draft.AddReplays.Add(
                        idempotencyKey,
                        new Replay<NendoChangeSetAddResult>(digest, result));
                    return result;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    internal Task<NendoAgentProposalPreview> ValidateAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                RequireKey(idempotencyKey);
                var replayKey = (sessionId, changeSetId, idempotencyKey);
                var digest = Digest(new { changeSetId });
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    if (_validateReplays.TryGetValue(replayKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    var draft = RequireDraft(changeSetId, sessionId, leaseId);
                    if (draft.Mutations.Count == 0)
                    {
                        throw new NendoAgentAuthoringException(
                            "CHANGE_SET_EMPTY",
                            "The change set has no operations to validate.");
                    }
                    var snapshot = await application.GetSnapshotAsync(cancellationToken);
                    RequireCapturedAuthority(draft, snapshot);
                    draft.Frozen = true;
                    var proposalId = $"proposal-{RandomHex(16)}";
                    var origin = NendoTransportIdentity.Pseudonym(sessionId);
                    NendoProposalPreview preview;
                    try
                    {
                        preview = await application.PrepareProposalAsync(
                            new NendoCanonicalProposalRequest(
                                proposalId,
                                draft.Title,
                                origin,
                                Compile(draft, origin)),
                            cancellationToken);
                        if (preview.CapturedDefinitionRevision != draft.CapturedDefinitionRevision ||
                            preview.SourceApplicationId != draft.ApplicationId ||
                            preview.SourceInstanceId != draft.InstanceId)
                        {
                            await application.RejectProposalAsync(preview.ProposalId, cancellationToken);
                            throw new NendoAgentAuthoringException(
                                "CHANGE_SET_STALE",
                                "The application authority changed while the change set was validating.");
                        }
                    }
                    catch
                    {
                        // A validate that ends without a verdict — a body the compiler
                        // refused, authority that moved, a cancelled call — is not a
                        // verdict on the draft. It reopens, so the documented remedy is
                        // not itself refused as frozen and ninety operations are not lost
                        // to one exception.
                        draft.Frozen = false;
                        draft.Preview = null;
                        throw;
                    }
                    var projected = NendoAgentProposalStore.ProjectPreview(preview);
                    _validateReplays.Add(replayKey, new Replay<NendoAgentProposalPreview>(digest, projected));
                    if (preview.State == NendoProposalState.Previewable)
                    {
                        draft.Preview = preview;
                        proposals.Add(changeSetId, host.HostRunId, sessionId, preview);
                        _drafts.Remove(changeSetId);
                        return projected;
                    }
                    // A failed validation is a dry run, not the end of the draft.
                    // Discard the private clone and reopen the draft so one bad
                    // operation costs one amend rather than a whole rebuild.
                    await application.RejectProposalAsync(preview.ProposalId, cancellationToken);
                    draft.Preview = null;
                    draft.Frozen = false;
                    return projected;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    internal Task<NendoAgentProposalPreview> PreviewAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    if (_drafts.TryGetValue(changeSetId, out var draft))
                    {
                        RequireDraftOwnership(draft, sessionId, leaseId);
                        return draft.Preview is null
                            ? throw new NendoAgentAuthoringException(
                                "CHANGE_SET_NOT_VALIDATED",
                                "The change set has not been validated.")
                            : NendoAgentProposalStore.ProjectPreview(draft.Preview);
                    }
                    return proposals.GetOwned(changeSetId, host.HostRunId, sessionId);
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    internal Task<NendoChangeSetRejectResult> RejectAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.ApplicationAuthoring,
            async _ =>
            {
                RequireKey(idempotencyKey);
                var replayKey = (sessionId, changeSetId, idempotencyKey);
                var digest = Digest(new { changeSetId });
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    if (_rejectReplays.TryGetValue(replayKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    NendoProposalPreview? preview;
                    if (_drafts.TryGetValue(changeSetId, out var draft))
                    {
                        RequireDraftOwnership(draft, sessionId, leaseId);
                        preview = draft.Preview;
                        _drafts.Remove(changeSetId);
                    }
                    else
                    {
                        preview = proposals.RemoveOwned(changeSetId, host.HostRunId, sessionId);
                    }
                    if (preview is not null)
                    {
                        await application.RejectProposalAsync(preview.ProposalId, cancellationToken);
                    }
                    var result = new NendoChangeSetRejectResult(
                        changeSetId,
                        preview?.ProposalId,
                        "rejected");
                    _rejectReplays.Add(replayKey, new Replay<NendoChangeSetRejectResult>(digest, result));
                    return result;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    /// <summary>
    /// Accepts a proposal this session validated, at <see cref="AgentAccessMode.Unattended"/>
    /// and nowhere else (ADR-0009, 2026-09-22 amendment).
    /// <para>
    /// It promotes through the same store method the person's own Accept button calls, and
    /// passes the reviewed operation digest rather than omitting it: the digest is optional
    /// for callers that predate it, and an agent accepting its own work without pinning it
    /// would be the one caller in the product with nothing checked.
    /// </para>
    /// <para>
    /// A promotion that does not apply is not this call failing. The file moved, or the
    /// file's automatic actions are still waiting for somebody -- the outcome says which,
    /// and the proposal stays where it is so the next step is visible.
    /// </para>
    /// </summary>
    internal Task<NendoChangeSetAcceptResult> AcceptAsync(
        string sessionId,
        string leaseId,
        string changeSetId,
        string idempotencyKey,
        CancellationToken cancellationToken) => authority.AdmitMutationAsync(
            leaseId,
            sessionId,
            AgentAccessMode.Unattended,
            async _ =>
            {
                RequireKey(idempotencyKey);
                var replayKey = (sessionId, changeSetId, idempotencyKey);
                var digest = Digest(new { changeSetId });
                await _gate.WaitAsync(cancellationToken);
                try
                {
                    if (_acceptReplays.TryGetValue(replayKey, out var replay))
                    {
                        return ExactReplay(replay, digest);
                    }
                    if (_drafts.TryGetValue(changeSetId, out var draft))
                    {
                        RequireDraftOwnership(draft, sessionId, leaseId);
                        throw new NendoAgentAuthoringException(
                            "CHANGE_SET_NOT_VALIDATED",
                            "The change set has not been validated. Validate it before accepting it.");
                    }
                    var owned = proposals.GetOwned(changeSetId, host.HostRunId, sessionId);
                    var outcome = await proposals.PromoteAsync(
                        application, owned.ProposalId, cancellationToken, owned.OperationDigest);

                    // Consent second, and only when the file now needs it. Asking before the
                    // commit would grant for a behaviour the file does not hold yet, and the
                    // grant is scoped to a digest, so it would be a grant for nothing.
                    var approved = false;
                    if (outcome.Applied && unattended.IsAvailable)
                    {
                        if (application.BehaviourTrust is { RequiresApproval: true, IsApproved: false })
                        {
                            approved = await unattended.GrantAsync(cancellationToken);
                        }
                    }
                    var result = new NendoChangeSetAcceptResult(
                        changeSetId,
                        owned.ProposalId,
                        outcome.Applied,
                        StateName(outcome.State),
                        outcome.Message,
                        outcome.Result?.DefinitionRevision,
                        approved);
                    _acceptReplays.Add(replayKey, new Replay<NendoChangeSetAcceptResult>(digest, result));
                    return result;
                }
                finally
                {
                    _gate.Release();
                }
            },
            cancellationToken);

    private static string StateName(NendoProposalState state) => state switch
    {
        NendoProposalState.Active => "active",
        NendoProposalState.Stale => "stale",
        NendoProposalState.Failed => "failed",
        NendoProposalState.Previewable => "previewable",
        NendoProposalState.Rejected => "rejected",
        NendoProposalState.Applying => "applying",
        NendoProposalState.Validating => "validating",
        NendoProposalState.Invalid => "invalid",
        _ => "draft",
    };

    internal async Task DiscardSessionAsync(string sessionId)
    {
        NendoProposalPreview[] privatePreviews;
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            var drafts = _drafts.Values.Where(value => value.SessionId == sessionId).ToArray();
            privatePreviews = drafts.Select(value => value.Preview).OfType<NendoProposalPreview>().ToArray();
            foreach (var draft in drafts)
            {
                _drafts.Remove(draft.ChangeSetId);
            }
            foreach (var key in _beginReplays.Keys.Where(value => value.SessionId == sessionId).ToArray())
            {
                _beginReplays.Remove(key);
            }
            foreach (var key in _acceptReplays.Keys.Where(value => value.SessionId == sessionId).ToArray())
            {
                _acceptReplays.Remove(key);
            }
            foreach (var key in _validateReplays.Keys.Where(value => value.SessionId == sessionId).ToArray())
            {
                _validateReplays.Remove(key);
            }
            foreach (var key in _rejectReplays.Keys.Where(value => value.SessionId == sessionId).ToArray())
            {
                _rejectReplays.Remove(key);
            }
        }
        finally
        {
            _gate.Release();
        }
        await RejectDiscardedAsync(privatePreviews);
    }

    internal async Task DiscardAllDraftsAsync()
    {
        NendoProposalPreview[] privatePreviews;
        await _gate.WaitAsync(CancellationToken.None);
        try
        {
            privatePreviews = _drafts.Values.Select(value => value.Preview).OfType<NendoProposalPreview>().ToArray();
            _drafts.Clear();
            _beginReplays.Clear();
            _validateReplays.Clear();
            _rejectReplays.Clear();
        }
        finally
        {
            _gate.Release();
        }
        await RejectDiscardedAsync(privatePreviews);
    }

    private async Task RejectDiscardedAsync(IEnumerable<NendoProposalPreview> previews)
    {
        foreach (var preview in previews)
        {
            try
            {
                await application.RejectProposalAsync(preview.ProposalId, CancellationToken.None);
            }
            catch (Exception)
            {
                // Engine reopen cleanup removes a private clone if the file is already closing.
            }
        }
    }

    private void RequireHostIdentity(NendoSessionSnapshot snapshot)
    {
        if (snapshot.Manifest.ApplicationId != host.ApplicationId ||
            snapshot.Manifest.InstanceId != host.InstanceId)
        {
            throw new NendoAgentAuthoringException(
                "AUTHORITY_CHANGED",
                "The open application authority changed.");
        }
    }

    private void RequireCapturedAuthority(Draft draft, NendoSessionSnapshot snapshot)
    {
        RequireHostIdentity(snapshot);
        if (draft.ApplicationId != snapshot.Manifest.ApplicationId ||
            draft.InstanceId != snapshot.Manifest.InstanceId ||
            draft.HostRunId != host.HostRunId ||
            draft.CapturedDefinitionRevision != snapshot.Manifest.DefinitionRevision)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_STALE",
                "The application definition changed after the draft began.");
        }
    }

    private Draft RequireDraft(string changeSetId, string sessionId, string leaseId)
    {
        if (string.IsNullOrWhiteSpace(changeSetId) || !_drafts.TryGetValue(changeSetId, out var draft))
        {
            // A change set that validated is no longer a draft: it is a proposal
            // waiting for a person. Saying it did not exist sent a reviewer looking for
            // a typo in an ID they had just used successfully.
            if (!string.IsNullOrWhiteSpace(changeSetId) &&
                proposals.TryGetOwned(changeSetId, host.HostRunId, sessionId) is { } validated)
            {
                throw new NendoAgentAuthoringException(
                    "CHANGE_SET_FROZEN",
                    $"Change set {changeSetId} validated as proposal {validated.ProposalId} and is waiting for a person " +
                    "to accept it in Nendo; it takes no more operations. To change it, reject it with " +
                    "nendo.change_set.reject and begin a new change set. To keep it, ask the person to accept it; " +
                    "there is no promotion tool.");
            }
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_NOT_FOUND",
                "The change set does not exist.");
        }
        RequireDraftOwnership(draft, sessionId, leaseId);
        return draft;
    }

    private void RequireDraftOwnership(Draft draft, string sessionId, string leaseId)
    {
        if (draft.SessionId != sessionId ||
            draft.LeaseId != leaseId ||
            draft.HostRunId != host.HostRunId ||
            draft.ApplicationId != host.ApplicationId ||
            draft.InstanceId != host.InstanceId)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_NOT_FOUND",
                "The change set is not owned by this agent session.");
        }
    }

    private NendoCanonicalChangeSetRequest Compile(Draft draft, string origin)
    {
        var operationOrdinal = 0;
        // The definition revision advances once per preceding definition-lane
        // mutation. The host already knows that number, so a caller that omits
        // expectedDefinitionRevision has it filled in here; the stored canonical
        // operation still carries an exact integer, so optimistic concurrency at
        // promotion is unchanged. An explicit value is passed through untouched
        // and still conflicts loudly if it is wrong.
        var revision = draft.CapturedDefinitionRevision;
        var mutations = new List<NendoCanonicalMutationRequest>(draft.Mutations.Count);
        for (var mutationOrdinal = 0; mutationOrdinal < draft.Mutations.Count; mutationOrdinal++)
        {
            var mutation = draft.Mutations[mutationOrdinal];
            mutations.Add(new NendoCanonicalMutationRequest(
                $"mcp.change-set.{host.HostRunId}.{draft.ChangeSetId}",
                $"mutation-{mutationOrdinal:D3}",
                origin,
                mutation.Description,
                mutation.Operations
                    .SelectMany(Expand)
                    .Select(operation => new NendoCanonicalOperationRequest(
                        $"operation.agent.{draft.ChangeSetId}.{operationOrdinal++:D3}",
                        operation.OperationType,
                        ResolveRevision(operation, revision))).ToArray()));
            if (mutation.Operations.Count > 0 && IsDefinitionLane(mutation.Operations[0].OperationType))
            {
                revision++;
            }
        }
        return new NendoCanonicalChangeSetRequest(mutations);
    }

    /// <summary>
    /// An inline <c>properties</c> map on <c>ui.addNode</c> becomes the canonical
    /// <c>ui.addNode</c> followed by one <c>ui.setProperty</c> per property, in
    /// stable property-name order.
    /// <para>
    /// The convenience is at the boundary and nowhere behind it: the stored
    /// operations, the semantic diff, history and promotion all see the same typed
    /// operations they saw before. What changes is what a build costs. A node used
    /// to cost one operation plus one per property, so a five-column list view was
    /// sixteen operations and a complete application's screens ran to several
    /// hundred — past the change-set ceiling, which forced the build into several
    /// proposals and a human approval between each.
    /// </para>
    /// </summary>
    private static IEnumerable<NendoAgentOperationInput> Expand(NendoAgentOperationInput operation)
    {
        if (operation.OperationType != "ui.addNode" ||
            !operation.Payload.Element.TryGetProperty("properties", out var properties) ||
            properties.ValueKind != JsonValueKind.Object)
        {
            yield return operation;
            yield break;
        }
        yield return new NendoAgentOperationInput(operation.OperationType, Without(operation.Payload.Element, "properties"));
        var surfaceId = operation.Payload.Element.GetProperty("surfaceId");
        var nodeId = operation.Payload.Element.GetProperty("nodeId");
        foreach (var property in properties.EnumerateObject()
                     .OrderBy(value => value.Name, StringComparer.Ordinal))
        {
            yield return new NendoAgentOperationInput("ui.setProperty", Object(writer =>
            {
                writer.WritePropertyName("surfaceId");
                surfaceId.WriteTo(writer);
                writer.WritePropertyName("nodeId");
                nodeId.WriteTo(writer);
                writer.WriteString("propertyName", property.Name);
                writer.WritePropertyName("value");
                property.Value.WriteTo(writer);
            }));
        }
    }

    /// <summary>
    /// Every operation is built into the typed form a proposal compiles through,
    /// here, where it is sent, so a payload the compiler would refuse costs one
    /// refused call that names the operation rather than a draft. The revision
    /// filled in for the check is the draft's captured one; validate resolves the
    /// real one per position, and the shape check does not depend on its value.
    /// </summary>
    private static void RequireCompilable(IReadOnlyList<NendoAgentMutationInput> mutations, Draft draft, int firstMutationOrdinal)
    {
        for (var mutationIndex = 0; mutationIndex < mutations.Count; mutationIndex++)
        {
            var operations = mutations[mutationIndex].Operations;
            for (var operationIndex = 0; operationIndex < operations.Count; operationIndex++)
            {
                foreach (var expanded in Expand(operations[operationIndex]))
                {
                    try
                    {
                        NendoCanonicalOperations.Check(
                            expanded.OperationType,
                            ResolveRevision(expanded, draft.CapturedDefinitionRevision));
                    }
                    catch (Exception exception) when (exception is NendoValidationException or ArgumentException)
                    {
                        throw new NendoValidationException(
                            $"Mutation {firstMutationOrdinal + mutationIndex}, operation {operationIndex} " +
                            $"({Describe(operations[operationIndex])}): {exception.Message}");
                    }
                }
            }
        }
    }

    /// <summary>The operation as a refusal names it: its type, and the ID it is about.</summary>
    private static string Describe(NendoAgentOperationInput operation)
    {
        foreach (var key in new[] { "definitionId", "nodeId", "fieldId", "entityId", "recordId" })
        {
            if (operation.Payload.Element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String)
            {
                return $"{operation.OperationType} '{value.GetString()}'";
            }
        }
        return operation.OperationType;
    }

    /// <summary>How many canonical operations these mutations expand to.</summary>
    private static int CanonicalCount(IReadOnlyList<NendoAgentMutationInput> mutations) =>
        mutations.Sum(mutation => mutation.Operations.Sum(CanonicalCount));

    private static int CanonicalCount(NendoAgentOperationInput operation) =>
        operation.OperationType == "ui.addNode" &&
        operation.Payload.Element.TryGetProperty("properties", out var properties) &&
        properties.ValueKind == JsonValueKind.Object
            ? 1 + properties.EnumerateObject().Count()
            : 1;

    private static JsonElement Without(JsonElement payload, string name) => Object(writer =>
    {
        foreach (var property in payload.EnumerateObject().Where(property => property.Name != name))
        {
            property.WriteTo(writer);
        }
    });

    private static JsonElement Object(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            write(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static JsonElement ResolveRevision(NendoAgentOperationInput operation, long revision)
    {
        if (!RevisionScopedOperations.Contains(operation.OperationType) ||
            (operation.Payload.Element.TryGetProperty("expectedDefinitionRevision", out var declared) &&
             declared.ValueKind != JsonValueKind.Null))
        {
            return operation.Payload.Element.Clone();
        }
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in operation.Payload.Element.EnumerateObject()
                         .Where(property => property.Name != "expectedDefinitionRevision"))
            {
                property.WriteTo(writer);
            }
            writer.WriteNumber("expectedDefinitionRevision", revision);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }

    private static bool IsDefinitionLane(string operationType) =>
        operationType.StartsWith("schema.", StringComparison.Ordinal) ||
        operationType.StartsWith("ui.", StringComparison.Ordinal) ||
        operationType.StartsWith("behaviour.", StringComparison.Ordinal) ||
        operationType.StartsWith("application.", StringComparison.Ordinal);

    /// <summary>
    /// The operations whose payload carries <c>expectedDefinitionRevision</c>. A
    /// data-lane conversion is included because it is validated against the same
    /// counter even though it does not advance it.
    /// </summary>
    private static IReadOnlySet<string> RevisionScopedOperations { get; } = new HashSet<string>(
        NendoAuthoringOperations.All
            .Where(operation => operation.OptionalPayload.Contains("expectedDefinitionRevision"))
            .Select(operation => operation.OperationType),
        StringComparer.Ordinal);

    // Echoing the limit beside the usage makes the ceiling self-documenting, so it
    // is not discovered by crashing into it two-thirds of the way through a build.
    private static NendoChangeSetAddResult Progress(Draft draft) => new(
        draft.ChangeSetId,
        draft.Mutations.Count,
        draft.OperationCount,
        "draft")
    {
        MutationLimit = MaximumMutationsPerChangeSet,
        OperationLimit = MaximumOperationsPerChangeSet,
        CanonicalOperationCount = draft.CanonicalOperationCount,
        CanonicalOperationLimit = MaximumCanonicalOperationsPerChangeSet,
    };

    private static void RequireChangeSetCapacity(
        int heldMutations,
        int heldOperations,
        int heldCanonical,
        int addedMutations,
        int addedOperations,
        int addedCanonical)
    {
        if (heldMutations + addedMutations > MaximumMutationsPerChangeSet)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_LIMIT",
                $"A change set holds at most {MaximumMutationsPerChangeSet} mutations; this one holds {heldMutations} " +
                $"and the call adds {addedMutations}.");
        }
        if (heldOperations + addedOperations > MaximumOperationsPerChangeSet)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_LIMIT",
                $"A change set holds at most {MaximumOperationsPerChangeSet} submitted operations; this one holds {heldOperations} " +
                $"and the call adds {addedOperations}.");
        }
        if (heldCanonical + addedCanonical > MaximumCanonicalOperationsPerChangeSet)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_LIMIT",
                $"A change set expands to at most {MaximumCanonicalOperationsPerChangeSet} canonical operations; this one " +
                $"expands to {heldCanonical} and the call adds {addedCanonical}. Inline properties on ui.addNode each " +
                "expand to one ui.setProperty.");
        }
    }

    private static IReadOnlyList<NendoAgentMutationInput> ValidateMutations(
        IReadOnlyList<NendoAgentMutationInput> mutations)
    {
        ArgumentNullException.ThrowIfNull(mutations);
        if (mutations.Count < 1 || mutations.Count > MaximumMutationsPerAdd)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_LIMIT",
                $"One call carries 1-{MaximumMutationsPerAdd} mutations; this one carries {mutations.Count}.");
        }
        if (mutations.Any(value => value is null || value.Operations is null))
        {
            throw new NendoValidationException("Every mutation requires a description and its operations.");
        }
        var submitted = mutations.Sum(value => value.Operations.Count);
        if (submitted < 1 || submitted > MaximumOperationsPerAdd)
        {
            throw new NendoAgentAuthoringException(
                "CHANGE_SET_LIMIT",
                $"One call carries 1-{MaximumOperationsPerAdd} operations in total; this one carries {submitted}.");
        }
        return mutations.Select(mutation =>
        {
            RequireText(mutation.Description, "description", 500);
            return new NendoAgentMutationInput(
                mutation.Description.Trim(),
                mutation.Operations.Select(ValidateOperation).ToArray());
        }).ToArray();
    }

    private static NendoAgentOperationInput ValidateOperation(NendoAgentOperationInput operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        RequireText(operation.OperationType, "operation type", 100);
        // Three different mistakes used to share one sentence. An operation type this
        // host does not implement is its own refusal — it is the answer to "is there
        // an escape hatch" — and a payload problem names the operation and the key.
        if (!AllowedPayloads.TryGetValue(operation.OperationType, out var allowed))
        {
            throw new NendoAgentAuthoringException(
                "UNKNOWN_OPERATION",
                $"Operation type '{operation.OperationType}' is not one this host implements; " +
                $"nendo://application/vocabulary lists the {AllowedPayloads.Count} it accepts under operations.");
        }
        if (operation.Payload.Element.ValueKind != JsonValueKind.Object)
        {
            throw new NendoValidationException(
                $"The payload of {operation.OperationType} must be a JSON object.");
        }
        if (Encoding.UTF8.GetByteCount(operation.Payload.Element.GetRawText()) > MaximumPayloadBytes)
        {
            throw new NendoValidationException(
                $"The payload of {operation.OperationType} is larger than the {MaximumPayloadBytes / 1024} KiB one operation may carry.");
        }
        var unknown = operation.Payload.Element.EnumerateObject()
            .Select(property => property.Name)
            .Where(name => !allowed.Contains(name))
            .ToArray();
        if (unknown.Length > 0)
        {
            var published = NendoAuthoringOperations.All.Single(candidate => candidate.OperationType == operation.OperationType);
            throw new NendoValidationException(
                $"{operation.OperationType} does not take {string.Join(", ", unknown)}; it takes " +
                $"{string.Join(", ", published.RequiredPayload.Concat(published.OptionalPayload))}.");
        }
        // Decode first: an exact decimal arrives as a {"$nendoNumber": "..."} object,
        // and an inline property value carrying one is a number, not an object.
        var decoded = new NendoAgentOperationInput(operation.OperationType, NendoNumericEnvelope.Decode(operation.Payload.Element));
        RequireInlineProperties(decoded);
        return decoded;
    }

    /// <summary>
    /// An inline property map is a bounded object of scalar property values,
    /// addressed to a node this same operation creates. A node kind's whole
    /// property set is small — the largest in the vocabulary is six — so the
    /// ceiling is generous and still bounds the expansion.
    /// </summary>
    private static void RequireInlineProperties(NendoAgentOperationInput operation)
    {
        if (!operation.Payload.Element.TryGetProperty("properties", out var properties)) return;
        if (properties.ValueKind != JsonValueKind.Object)
        {
            throw new NendoValidationException("Inline node properties must be a JSON object keyed by property name.");
        }
        // The expansion addresses each property to this node, so both parts of the
        // address must be here before it can be expanded rather than after.
        foreach (var name in new[] { "surfaceId", "nodeId" })
        {
            if (!operation.Payload.Element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            {
                throw new NendoValidationException($"Inline node properties require {name} on the same ui.addNode.");
            }
        }
        var count = 0;
        foreach (var property in properties.EnumerateObject())
        {
            if (++count > MaximumPropertiesPerNodeOperation)
            {
                throw new NendoValidationException(
                    $"One ui.addNode carries at most {MaximumPropertiesPerNodeOperation} inline properties.");
            }
            RequireText(property.Name, "property name", 100);
            if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array or JsonValueKind.Undefined)
            {
                throw new NendoValidationException("An inline node property value must be a scalar JSON value.");
            }
        }
    }

    private static T ExactReplay<T>(Replay<T> replay, string digest)
    {
        if (replay.Digest != digest)
        {
            throw new NendoAgentAuthoringException(
                "IDEMPOTENCY_CONFLICT",
                "The idempotency key was already used for a different request.");
        }
        return replay.Result;
    }

    private static void RequireKey(string value) => RequireText(value, "idempotency key", 200);

    private static void RequireText(string value, string name, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new NendoValidationException(
                $"The {name} must contain 1-{maximumLength} characters.");
        }
    }

    private static string Digest<T>(T value) => Convert.ToHexString(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, NendoMcpJson.Options)))
        .ToLowerInvariant();

    private static string RandomHex(int byteCount) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(byteCount)).ToLowerInvariant();

    /// <summary>
    /// The accepted operation types and payload fields, taken from the table
    /// <c>nendo://application/vocabulary</c> publishes. One table, so a payload
    /// field cannot be documented and refused, or accepted and undocumented.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlySet<string>> AllowedPayloads { get; } =
        NendoAuthoringOperations.AllowedPayloads;

    private sealed class Draft(
        string changeSetId,
        string title,
        string sessionId,
        string leaseId,
        string hostRunId,
        string applicationId,
        string instanceId,
        long capturedDefinitionRevision)
    {
        internal string ChangeSetId { get; } = changeSetId;
        internal string Title { get; } = title;
        internal string SessionId { get; } = sessionId;
        internal string LeaseId { get; } = leaseId;
        internal string HostRunId { get; } = hostRunId;
        internal string ApplicationId { get; } = applicationId;
        internal string InstanceId { get; } = instanceId;
        internal long CapturedDefinitionRevision { get; } = capturedDefinitionRevision;
        internal List<NendoAgentMutationInput> Mutations { get; } = [];
        internal Dictionary<string, Replay<NendoChangeSetAddResult>> AddReplays { get; } =
            new(StringComparer.Ordinal);
        internal int OperationCount { get; set; }

        /// <summary>What <see cref="OperationCount"/> expands to once inline properties are unfolded.</summary>
        internal int CanonicalOperationCount { get; set; }
        internal bool Frozen { get; set; }
        internal NendoProposalPreview? Preview { get; set; }
    }

    private sealed record Replay<T>(string Digest, T Result);
}
