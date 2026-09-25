using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    // Preparing a proposal: validating the change set against a clone, capturing the
    // behaviour plan it implies, and projecting what a reviewer will see. Nothing
    // here touches the active file, and a refusal is turned into a diagnostic that
    // names what to correct rather than a bare exception.
    internal async Task<NendoProposalPreview> BeginProposalAsync(
        string proposalId,
        string title,
        string origin,
        NendoChangeSet changeSet,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(proposalId);
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(origin);
        if (title.Length > 200 || origin.Length > 120)
        {
            throw new NendoValidationException("Proposal title or origin is too long.");
        }
        changeSet.Validate();

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
            {
                throw new NendoRecoveryRequiredException(
                    "The coordinator does not trust the active file enough to create a proposal.");
            }
            if (_proposals.ContainsKey(proposalId))
            {
                throw new NendoPreconditionException("proposal-exists", "The proposal already exists.");
            }
            if (await ReadProposalReceiptCoreAsync(store, proposalId, cancellationToken) is not null)
                throw new NendoIdempotencyConflictException("The proposal identity already names a committed application change.");

            var active = await store.GetSessionSnapshotAsync(FileName, Health, cancellationToken);
            var workspacePath = ProposalWorkspace.Create(_proposalRoot, proposalId);
            var context = new ProposalContext(
                proposalId,
                title,
                origin,
                workspacePath,
                changeSet,
                active.Manifest.ApplicationId,
                active.Manifest.InstanceId,
                active.Manifest.DefinitionRevision,
                CaptureTouchedRecords(changeSet, active),
                SemanticDiff.From(changeSet, active));
            _proposals.Add(proposalId, context);
            try
            {
                context.State = NendoProposalState.Validating;
                await ProposalWorkspace.PersistAsync(context, cancellationToken);
                var clonePath = Path.Combine(workspacePath, "proposal.nendo");
                await store.BackupToAsync(clonePath, cancellationToken);
                await using var clone = await SqliteNendoStore.OpenAsync(clonePath, cancellationToken);
                var cloneAuthority = await clone.GetAuthoritySnapshotAsync(cancellationToken);
                // The clone runs the actions so the review shows their effects, not
                // only the operations an author asked for. This is the host choosing to
                // simulate on a copy nobody edits; promoting the result is a separate
                // question that needs the owner's approval of the exact plan.
                clone.BehaviourAuthority = PreviewBehaviourAuthority.Instance;
                var expansion = new List<(int MutationIndex, BehaviourExecutionContext Context)>();
                await clone.ApplyChangeSetAsync(
                    changeSet,
                    cloneAuthority,
                    proposalId,
                    null,
                    cancellationToken,
                    expansion: expansion);
                context.BehaviourPlan = CaptureBehaviourPlan(
                    changeSet, expansion, active.Manifest.DataRevision, active.Manifest.DefinitionRevision) with
                {
                    // Read from the clone, so it describes the behaviour the file will
                    // hold once promoted — including definition changes this very
                    // proposal makes. Approving the behaviour as it stands today would
                    // not be approving what this proposal turns it into.
                    RequiredGrant = await clone.GetRequiredBehaviourGrantAsync(null, cancellationToken),
                };
                // The digest a reviewer is shown must cover what promotion will commit —
                // the authored operations plus the reviewed generated effects — so an
                // acceptance retry matches the committed receipt.
                context.ReviewedDigest = WithReviewedEffects(changeSet, context.BehaviourPlan).OperationDigest;
                var previewSnapshot = await clone.GetSessionSnapshotAsync(
                    "proposal.nendo",
                    NendoSessionHealth.Normal,
                    cancellationToken);
                var compilation = new NendoSemanticCompiler().Compile(previewSnapshot);
                context.Diagnostics = compilation.Diagnostics;
                context.PreviewRecordCounts = previewSnapshot.Records.GroupBy(record => record.EntityId, StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
                // One scope for the whole preview: every record type the validated
                // clone holds, counted from the clone. Reading entities off the
                // compiled plan described a schema-only change set as nothing at
                // all, and mixed a surface-scoped field count with a whole-file
                // record count in the same object.
                context.PreviewEntities = ProjectPreviewEntities(previewSnapshot, context.PreviewRecordCounts);
                context.MinimumHostVersionBefore = active.Manifest.MinimumHostVersion;
                context.MinimumHostVersionAfter = previewSnapshot.Manifest.MinimumHostVersion;
                context.PurposeBefore = active.Manifest.Purpose;
                context.PurposeAfter = previewSnapshot.Manifest.Purpose;
                context.PackageChanges = await ExtensionPackageDiff.ComputeAsync(store, clone, changeSet, cancellationToken);
                context.SemanticDiff = WithHostVersionRaise(
                    context.SemanticDiff,
                    active.Manifest.MinimumHostVersion,
                    previewSnapshot.Manifest.MinimumHostVersion);
                var boundedPreview = compilation.IsValid ? new NendoSemanticCompiler().Compile(previewSnapshot with {
                    Records = previewSnapshot.Records.GroupBy(record => record.EntityId, StringComparer.Ordinal)
                        .OrderBy(group => group.Key, StringComparer.Ordinal)
                        .SelectMany(group => group.OrderBy(record => record.RecordId, StringComparer.Ordinal).Take(50)).Take(200).ToArray(),
                }) : compilation;
                context.PreviewApplications = boundedPreview.Applications;
                context.PreviewOverview = boundedPreview.Overview;
                // The clone has validated all typed schema/data operations. A
                // custom surface is optional; if present it must compile fully.
                context.State = previewSnapshot.UiNodes.Count == 0 || compilation.IsValid
                    ? NendoProposalState.Previewable
                    : NendoProposalState.Invalid;
            }
            catch (NendoException exception)
            {
                context.Diagnostics = [ProposalDiagnostic(exception)];
                context.PreviewApplications = [];
                context.PreviewOverview = null;
                context.State = NendoProposalState.Invalid;
            }
            catch (Exception exception) when (exception is not NendoException)
            {
                // A failure that is not a Nendo validation error — a clone IO error, a
                // full volume, a cancelled preview — leaves nothing a reviewer could look
                // at, so the half-registered proposal must not linger. Left in place it
                // would block its own ID with "proposal-exists", refuse promotion as
                // never-previewable, count against a restore and never be cleaned up.
                // A workspace that cannot be removed right now — the failure may be the
                // very lock that holds it — is left for the abandoned-workspace sweep,
                // so the reason validation failed is what reaches the caller.
                _proposals.Remove(proposalId);
                ProposalWorkspace.TryDelete(context);
                throw;
            }
            await ProposalWorkspace.PersistAsync(context, cancellationToken);
            return context.ToPreview();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Freezes what the actions did on the clone, together with everything that made
    /// those effects correct.
    /// <para>
    /// The read set is the part that is easy to miss. A condition that counted records
    /// without changing any of them still depended on them, so a plan is only valid
    /// while those records say what they said. The data revision covers the other half:
    /// a record created after the review would change a count even though nothing the
    /// review looked at was touched.
    /// </para>
    /// </summary>
    private static PreparedBehaviourPlan CaptureBehaviourPlan(
        NendoChangeSet changeSet,
        IReadOnlyList<(int MutationIndex, BehaviourExecutionContext Context)> expansion,
        long activeDataRevision,
        long activeDefinitionRevision)
    {
        if (expansion.Count == 0) return PreparedBehaviourPlan.Empty;
        var generated = new List<PreparedBehaviourOperation>();
        var reads = new Dictionary<(string EntityId, string RecordId), long>();
        var behaviourDigest = string.Empty;
        var written = new HashSet<(string EntityId, string RecordId)>();
        foreach (var operation in changeSet.Mutations.SelectMany(mutation => mutation.Operations))
        {
            if (WrittenRecord(operation) is { } touched) written.Add(touched);
        }
        foreach (var (index, chain) in expansion)
        {
            behaviourDigest = chain.BehaviourDigest;
            foreach (var (operation, attribution, _) in chain.Generated)
            {
                generated.Add(new PreparedBehaviourOperation(index, operation.CanonicalJson(), attribution));
                if (WrittenRecord(operation) is { } touched) written.Add(touched);
            }
            foreach (var (key, version) in chain.ReadSet) reads[(key.EntityId, key.RecordId)] = version;
        }
        // Only records this plan does not itself write. The versions were observed on
        // the clone after the change set had been staged, so a record the plan changes
        // carries a version the active file has not reached yet — and its version is
        // already guarded, by the ordinary record precondition on the operation that
        // writes it. What is left is the interesting part: records a condition or a
        // total merely counted, which nothing in the plan touches and which no other
        // check would notice moving.
        foreach (var key in written) reads.Remove(key);
        // The revisions recorded are the ACTIVE file's at the moment of review, not the
        // clone's after it applied the change set. Promotion compares against the file
        // as it stands before the change set is applied, so recording the clone's
        // post-apply counters would make every promotion look stale.
        //
        // Versions are the clone's, but the clone began as a byte copy, so an untouched
        // record carries the version the active file still has.
        return new PreparedBehaviourPlan(
            generated,
            reads.Select(pair => new NendoTouchedRecordVersion(pair.Key.EntityId, pair.Key.RecordId, pair.Value))
                .OrderBy(read => read.EntityId, StringComparer.Ordinal)
                .ThenBy(read => read.RecordId, StringComparer.Ordinal)
                .ToArray(),
            activeDataRevision,
            activeDefinitionRevision,
            behaviourDigest,
            NendoBehaviourContract.Version);
    }

    private static IReadOnlyList<NendoProposalEntitySummary> ProjectPreviewEntities(
        NendoSessionSnapshot previewSnapshot,
        IReadOnlyDictionary<string, int> recordCounts) => previewSnapshot.Entities
        .OrderBy(entity => entity.EntityId, StringComparer.Ordinal)
        .Select(entity => new NendoProposalEntitySummary(
            entity.EntityId,
            entity.DisplayName,
            entity.Fields.Count(field => !field.Retired),
            recordCounts.TryGetValue(entity.EntityId, out var count) ? count : 0,
            entity.Retired))
        .ToArray();

    /// <summary>
    /// A raise in the minimum host version is a durable compatibility change: the
    /// file stops opening in an older Nendo. Nothing in the operations says so —
    /// it is a consequence of which storage extensions they touch — so the clone
    /// is where it becomes visible, and it is stated as its own reviewable line
    /// rather than left for someone to notice in the manifest afterwards.
    /// </summary>
    private static IReadOnlyList<NendoSemanticDiffEntry> WithHostVersionRaise(
        IReadOnlyList<NendoSemanticDiffEntry> diff,
        string before,
        string after)
    {
        if (string.Equals(before, after, StringComparison.Ordinal)) return diff;
        return
        [
            .. diff,
            new NendoSemanticDiffEntry(
                "raiseMinimumHostVersion",
                $"Raise the minimum Nendo version this file needs from {before} to {after}. " +
                "After this is accepted the file no longer opens in an older Nendo, and that cannot be undone.",
                [],
                NendoReversibilityClass.IrreversibleDeclared),
        ];
    }

    /// <summary>
    /// One diagnostic for a clone validation that refused. Every refusal used to
    /// collapse into NPROP001 with a generic hint, so a field-identity collision, a
    /// definition-revision mismatch and a UI node collision were indistinguishable
    /// and a caller could not branch on the code. A typed precondition carries its
    /// own code and its own remedy; only an unclassified failure stays NPROP001.
    /// </summary>
    private static NendoCompilerDiagnostic ProposalDiagnostic(NendoException exception) => exception switch
    {
        NendoPreconditionException precondition => new NendoCompilerDiagnostic(
            ProposalDiagnosticCode(precondition.Code),
            NendoDiagnosticSeverity.Error,
            precondition.Message,
            null,
            null,
            ProposalDiagnosticHint(precondition.Code)),
        NendoIdempotencyConflictException => new NendoCompilerDiagnostic(
            "NPROP009",
            NendoDiagnosticSeverity.Error,
            exception.Message,
            null,
            null,
            "Use a fresh idempotency key for a request that is not an exact retry."),
        NendoValidationException => new NendoCompilerDiagnostic(
            "NPROP002",
            NendoDiagnosticSeverity.Error,
            exception.Message,
            null,
            null,
            "Correct the named operation and validate the change set again."),
        _ => new NendoCompilerDiagnostic(
            "NPROP001",
            NendoDiagnosticSeverity.Error,
            exception.Message,
            null,
            null,
            "Correct the semantic change and validate the change set again."),
    };

    private static string ProposalDiagnosticCode(string preconditionCode) => preconditionCode switch
    {
        "definition-version-conflict" => "NPROP003",
        "required-field-needs-migration" => "NPROP004",
        "required-backfill-needed" => "NPROP005",
        "entity-not-found" => "NPROP006",
        "field-not-found" => "NPROP007",
        "record-version-conflict" => "NPROP008",
        _ => "NPROP010",
    };

    private static string ProposalDiagnosticHint(string preconditionCode) => preconditionCode switch
    {
        "definition-version-conflict" =>
            "Use the revision the message names, or omit expectedDefinitionRevision and let the host supply it.",
        "required-field-needs-migration" =>
            "Co-locate the field with its schema.createEntity, or add it optional and require it in a later mutation.",
        "required-backfill-needed" =>
            "Give every existing record a value for the field in an earlier mutation of this change set.",
        _ => "Correct the named operation and validate the change set again.",
    };
}
