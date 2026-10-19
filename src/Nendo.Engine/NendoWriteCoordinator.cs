using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator : IAsyncDisposable
{
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _proposalRoot;
    private readonly Dictionary<string, ProposalContext> _proposals = new(StringComparer.Ordinal);
    private INendoBehaviourAuthority _behaviourAuthority = DeniedBehaviourAuthority.Instance;
    private NendoBehaviourGrant? _behaviourRequirement;
    private bool _proposalCleanupPending;
    private WriteOwnershipLease? _ownership;
    private InstanceOwnershipLease? _instanceOwnership;
    private FileStream? _pathPin;
    private SqliteNendoStore? _store;
    private NendoAuthoritySnapshot? _authority;
    private volatile bool _recoveryRequired;
    private volatile bool _disposed;
    private bool _authorityLossNotified;
    private DateTimeOffset? _authorityLostAt;
    private readonly NendoSessionSnapshot? _readOnlySnapshot;
    private readonly IReadOnlyList<NendoRevisionSnapshot>? _readOnlyHistory;
    private readonly string? _readOnlyContentDigest;
    private NendoFileInspection? _inspection;

    internal Action? BeforeProposalCommit { get; set; }
    internal Action? BeforeCommitAuthorityRead { get; set; }
    internal Action? AfterCommit { get; set; }

    /// <summary>Test seam: right after the store committed a write, before anything derivative runs.</summary>
    internal Action? AfterStoreCommit { get; set; }

    internal string ProposalRoot => _proposalRoot;

    private NendoWriteCoordinator(
        string path,
        WriteOwnershipLease ownership,
        InstanceOwnershipLease instanceOwnership,
        FileStream pathPin,
        SqliteNendoStore store,
        NendoAuthoritySnapshot authority)
    {
        _path = path;
        _ownership = ownership;
        _instanceOwnership = instanceOwnership;
        _pathPin = pathPin;
        _store = store;
        _authority = authority;
        _proposalRoot = ProposalWorkspace.RootFor(authority);
        _proposalCleanupPending = !ProposalWorkspace.CleanupAbandoned(_proposalRoot);
    }

    public string FileName => Path.GetFileName(_path);
    public bool ProposalCleanupPending => _proposalCleanupPending;

    /// <summary>
    /// One-way notification for trusted host adapters. Called synchronously while
    /// the coordinator is gated: handlers must only close admission or queue work,
    /// never wait for a coordinator operation or dispose an integration here.
    /// </summary>
    public event Action? WriteAuthorityLost;

    /// <summary>
    /// The open file committed a change, carrying the change sequence it reached.
    /// <para>
    /// Raised for every writer the coordinator serves, which is the point of it: a
    /// surface on screen cannot otherwise know that an agent wrote through MCP, because
    /// nothing in the renderer's own world moved. It is not raised for an idempotent
    /// replay, which commits nothing.
    /// </para>
    /// <para>
    /// Same one-way contract and same threading rules as <see cref="WriteAuthorityLost"/>:
    /// called synchronously while the coordinator is gated, so a handler must only
    /// marshal or queue and must never wait on a coordinator operation.
    /// </para>
    /// </summary>
    public event Action<long>? Committed;

    /// <summary>
    /// The same commit, with what it changed: every record a write or an automatic action
    /// touched, and whether the definition moved. Raised right after
    /// <see cref="Committed"/>, under the same threading rules.
    /// </summary>
    public event Action<NendoCommitSummary>? CommittedChanges;

    /// <summary>Raises the commit events for revisions that were not all idempotent replays.</summary>
    private void RaiseCommitted(long changeSequence, IReadOnlyList<NendoApplyResult> results, IEnumerable<NendoMutation> mutations)
    {
        AfterCommit?.Invoke();
        NotifyCommitted(changeSequence);
        if (CommittedChanges is null) return;
        var operations = mutations.SelectMany(mutation => mutation.Operations).ToArray();
        var fresh = results.Where(result => !result.IsIdempotentReplay).ToArray();
        var records = operations.Select(ChangedRecord).OfType<NendoChangedRecord>()
            .Concat(fresh.SelectMany(result => result.GeneratedChanges.Select(change => new NendoChangedRecord(change.EntityId, change.RecordId))))
            .Distinct()
            .ToArray();
        var summary = new NendoCommitSummary(
            changeSequence,
            [.. fresh.Select(result => result.RevisionId)],
            records,
            operations.Any(operation => operation.Lane == NendoRevisionLane.Definition));
        foreach (var handler in CommittedChanges?.GetInvocationList() ?? [])
        {
            // Told after the commit: a faulty observer can neither report the write as failed nor
            // keep the others from hearing of it, as with WriteAuthorityLost.
            try { ((Action<NendoCommitSummary>)handler)(summary); }
            catch (Exception exception) { ReportObserverFailure(exception); }
        }
    }

    /// <summary>
    /// Told the type of an exception an observer of this coordinator threw and the coordinator
    /// swallowed, so a host that keeps a failure record can keep it. Never the message, which may
    /// carry data. Called under the gate: it must only queue.
    /// </summary>
    public Action<Type>? ObserverFailed { get; set; }

    private void ReportObserverFailure(Exception exception)
    {
        try { ObserverFailed?.Invoke(exception.GetType()); }
        catch (Exception) { }
    }

    /// <summary>Raises <see cref="Committed"/>, each handler on its own, after a commit that already stands.</summary>
    private void NotifyCommitted(long changeSequence)
    {
        foreach (var handler in Committed?.GetInvocationList() ?? [])
        {
            try { ((Action<long>)handler)(changeSequence); }
            catch (Exception exception) { ReportObserverFailure(exception); }
        }
    }

    /// <summary>The record an operation changes, its metadata included, or null when it changes no single record.</summary>
    private static NendoChangedRecord? ChangedRecord(NendoOperation operation) =>
        WrittenRecord(operation) is { } written
            ? new NendoChangedRecord(written.EntityId, written.RecordId)
            : operation is SetRecordKeptInNewFilesOperation kept ? new NendoChangedRecord(kept.EntityId, kept.RecordId) : null;

    public NendoFileCapabilities Capabilities => _disposed || _replacementRetired || _recoveryRequired && _readOnlySnapshot is null
        ? NendoFileCapabilities.None
        : _readOnlySnapshot is not null
            ? _inspection!.Capabilities
            // A file whose automatic actions have not been approved on this device
            // stays fully readable and keeps its bounded calculations; only editing
            // is withheld, because editing is what would run the actions. Refusing
            // the write rather than quietly disabling the trigger is the difference
            // between a file the owner can still trust and one that has silently
            // stopped doing what it says it does.
            : BehaviourTrust is { RequiresApproval: true, IsApproved: false }
                ? NendoFileCapabilities.Writable with { Mutate = false }
                : NendoFileCapabilities.Writable;

    /// <summary>
    /// Who answers for this file's automatic actions. Set by the host that opened the
    /// file; the Engine never discovers it, and a file can never supply its own.
    /// </summary>
    public INendoBehaviourAuthority BehaviourAuthority
    {
        get => _behaviourAuthority;
        set
        {
            _behaviourAuthority = value ?? throw new ArgumentNullException(nameof(value));
            if (_store is not null) _store.BehaviourAuthority = _behaviourAuthority;
        }
    }

    /// <summary>
    /// What consent the open file needs and whether the host holds it right now.
    /// <para>
    /// The two halves are deliberately cached differently. What a file <em>requires</em>
    /// follows from its stored definitions, so it is read once and refreshed whenever
    /// those change. Whether consent is <em>held</em> is asked of the authority on every
    /// read, because remembering that answer is how a revoked grant keeps working.
    /// </para>
    /// </summary>
    public NendoBehaviourTrust BehaviourTrust => _behaviourRequirement is { } required
        ? new NendoBehaviourTrust(true, _behaviourAuthority.IsGranted(required), required)
        : NendoBehaviourTrust.None;

    /// <summary>
    /// Re-reads what the file's definitions require. Called when the file is opened and
    /// after any definition change, which is exactly when previously given consent
    /// stops applying.
    /// </summary>
    internal async Task RefreshBehaviourRequirementAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed || _recoveryRequired || _store is null)
        {
            _behaviourRequirement = null;
            return;
        }
        _behaviourRequirement = (await _store.GetBehaviourTrustAsync(null, cancellationToken)).Required;
    }

    public NendoFileInspection? Inspection => _recoveryRequired && _readOnlySnapshot is null
        ? new(NendoOpenClassification.RecoveryRequired, Capabilities,
            [new("authority-lost", "The open file changed outside its trusted session. Reopen for recovery inspection.")],
            null, null, false, _authorityLostAt ?? DateTimeOffset.UtcNow)
        : _inspection;

    public NendoSessionHealth Health => _disposed || _replacementRetired
        ? NendoSessionHealth.Closed
        : _recoveryRequired
            ? NendoSessionHealth.RecoveryRequired
            : _readOnlySnapshot is not null ? NendoSessionHealth.ReadOnly : NendoSessionHealth.Normal;

    private NendoWriteCoordinator(string path, FileStream pathPin, InspectedNendoFile observed)
    {
        _path = path;
        _pathPin = pathPin;
        _proposalRoot = string.Empty;
        _inspection = observed.Inspection;
        _readOnlySnapshot = observed.Snapshot!;
        _readOnlyHistory = observed.History;
        _readOnlyContentDigest = observed.ContentDigest;
        _recoveryRequired = observed.Inspection.Classification == NendoOpenClassification.RecoveryRequired;
    }

    public async Task<NendoSessionSnapshot> GetSnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                return _readOnlySnapshot;
            }
            var store = GetStore();
            return await store.GetSessionSnapshotAsync(FileName, Health, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyList<NendoRevisionSnapshot>> GetHistoryAsync(
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadHistory)
                {
                    throw new NendoPreconditionException("history-unavailable", "History cannot be safely interpreted for this file.");
                }
                return _readOnlyHistory!;
            }
            return await GetStore().GetRevisionsAsync(cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Host-owned calculation ceilings for the open file. Tests lower these to reach a
    /// boundary without building a fixture the size of the ceiling; production leaves
    /// the shipped values in place.
    /// </summary>
    internal NendoBehaviourLimits BehaviourLimits
    {
        get => GetStore().BehaviourLimits;
        set => GetStore().BehaviourLimits = value;
    }

    /// <summary>Host-owned seam for proving that an interrupted chain leaves nothing behind.</summary>
    internal Action<int>? GeneratedOperationCheckpoint
    {
        get => GetStore().GeneratedOperationCheckpoint;
        set => GetStore().GeneratedOperationCheckpoint = value;
    }

    public async Task<NendoApplyResult> ApplyAsync(
        NendoMutation mutation,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
            {
                throw new NendoRecoveryRequiredException(
                    "The coordinator no longer trusts the open file; recovery is required before another mutation.");
            }

            try
            {
                var (result, trusted) = await store.ApplyAsync(mutation, _authority, cancellationToken,
                    beforeAuthorityRead: BeforeCommitAuthorityRead);
                // A replay returns an immutable historical receipt. Storage has
                // checked the current authority before resolving that receipt;
                // the complete authority must remain unchanged across a replay.
                // Fresh commits still have to match their new revision counters.
                if (!MatchesMutationAuthority(result, trusted))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        "The committed result did not match the coordinator authority snapshot.");
                }
                _authority = trusted;
                AfterStoreCommit?.Invoke();
                // A definition change is precisely when previously given consent stops
                // applying, so what the file requires is read again rather than carried
                // over from before the change. The write has committed, so the caller's
                // token no longer decides anything: a cancel here reported a committed
                // write as failed and skipped the commit events.
                if (mutation.Operations[0].Lane == NendoRevisionLane.Definition)
                    await RefreshBehaviourRequirementAsync(CancellationToken.None);
                if (!result.IsIdempotentReplay) RaiseCommitted(result.ChangeSequence, [result], [mutation]);
                return result;
            }
            catch (NendoRecoveryRequiredException)
            {
                EnterRecovery();
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private bool MatchesMutationAuthority(NendoApplyResult result, NendoAuthoritySnapshot trusted) =>
        result.IsIdempotentReplay
            ? trusted == _authority
            : trusted.ApplicationId == _authority!.ApplicationId &&
              trusted.InstanceId == _authority.InstanceId &&
              trusted.DefinitionRevision == result.DefinitionRevision &&
              trusted.DataRevision == result.DataRevision &&
              trusted.ChangeSequence == result.ChangeSequence;

    internal async Task<NendoChangeSetApplyResult> ApplyChangeSetAsync(
        NendoChangeSet changeSet,
        string proposalId,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var store = GetStore();
            if (_recoveryRequired || _authority is null)
            {
                throw new NendoRecoveryRequiredException(
                    "The coordinator no longer trusts the open file; recovery is required before proposal promotion.");
            }
            try
            {
                var (result, trusted) = await store.ApplyChangeSetAsync(
                    changeSet,
                    _authority,
                    proposalId,
                    BeforeProposalCommit,
                    cancellationToken,
                    BeforeCommitAuthorityRead);
                if (!MatchesChangeSetAuthority(result, trusted))
                {
                    EnterRecovery();
                    throw new NendoRecoveryRequiredException(
                        "The promoted result did not match the coordinator authority snapshot.");
                }
                _authority = trusted;
                if (!result.Revisions.All(revision => revision.IsIdempotentReplay))
                    RaiseCommitted(result.ChangeSequence, result.Revisions, changeSet.Mutations);
                return result;
            }
            catch (NendoRecoveryRequiredException)
            {
                EnterRecovery();
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task BackupToAsync(
        string destinationPath,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await GetStore().BackupToAsync(destinationPath, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            NotifyAuthorityLost();
            try
            {
                if (_store is not null) await _store.DisposeAsync();
            }
            finally
            {
                _store = null;
                _pathPin?.Dispose();
                _pathPin = null;
                _ownership?.Dispose();
                _ownership = null;
                try
                {
                    _authority = null;
                    _backups.Clear();
                    _identityCopies.Clear();
                    _restores.Clear();
                    _upgrades.Clear();
                    _proposals.Clear();
                    if (_readOnlySnapshot is null) _proposalCleanupPending = !ProposalWorkspace.CleanupAbandoned(_proposalRoot);
                }
                finally
                {
                    _instanceOwnership?.Dispose();
                    _instanceOwnership = null;
                }
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private SqliteNendoStore GetStore()
    {
        ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
        if (_readOnlySnapshot is not null)
        {
            throw new NendoPreconditionException("read-only", "This file is open for inspection only. Editing and application changes are disabled.");
        }
        RequireTrustedSession();
        return _store ?? throw new ObjectDisposedException(nameof(NendoWriteCoordinator));
    }

    private ProposalContext GetProposal(string proposalId)
    {
        ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
        RequireTrustedSession();
        return _proposals.TryGetValue(proposalId, out var context)
            ? context
            : throw new NendoPreconditionException(
                "proposal-not-found",
                "The proposal is not available in this session.");
    }

    private void RequireTrustedSession()
    {
        if (_recoveryRequired && _readOnlySnapshot is null)
            throw new NendoRecoveryRequiredException(
                "The open file is no longer trusted. Close and explicitly inspect it before reading data or history again.");
    }

    private void EnterRecovery()
    {
        _authorityLostAt ??= DateTimeOffset.UtcNow;
        _recoveryRequired = true;
        NotifyAuthorityLost();
    }

    private void NotifyAuthorityLost()
    {
        if (_authorityLossNotified) return;
        _authorityLossNotified = true;
        foreach (var handler in WriteAuthorityLost?.GetInvocationList() ?? [])
        {
            // A faulty observer cannot prevent another adapter from closing its
            // admission or replace the original typed recovery failure.
            try { ((Action)handler)(); }
            catch (Exception exception) { ReportObserverFailure(exception); }
        }
    }

    /// <summary>
    /// Folds the reviewed generated writes into the change set, in the mutation they
    /// belong to and after the operations that caused them.
    /// <para>
    /// This is what makes promotion a replay. The operations are the ones the clone
    /// produced and the owner saw, carrying the record versions they were computed
    /// against — so if anything has moved since, the ordinary version checks refuse
    /// rather than writing something recalculated behind the owner's back.
    /// </para>
    /// </summary>
    private static NendoChangeSet WithReviewedEffects(NendoChangeSet changeSet, PreparedBehaviourPlan plan)
    {
        if (plan.Generated.Count == 0) return changeSet;
        var mutations = new List<NendoMutation>(changeSet.Mutations.Count);
        for (var index = 0; index < changeSet.Mutations.Count; index++)
        {
            var mutation = changeSet.Mutations[index];
            var generated = plan.Generated.Where(operation => operation.MutationIndex == index).ToArray();
            mutations.Add(generated.Length == 0
                ? mutation
                : mutation with
                {
                    Operations = mutation.Operations
                        .Concat(generated.Select(operation => NendoOperationCodec.Read(operation.CanonicalJson)))
                        .ToArray(),
                });
        }
        return new NendoChangeSet(mutations);
    }

    /// <summary>The record an operation writes to, or null when it writes to no single record.</summary>
    private static (string EntityId, string RecordId)? WrittenRecord(NendoOperation operation) => operation switch
    {
        CreateRecordOperation create => (create.EntityId, create.RecordId),
        SetFieldOperation set => (set.EntityId, set.RecordId),
        DeleteRecordOperation delete => (delete.EntityId, delete.RecordId),
        RestoreDeletedRecordOperation restore => (restore.EntityId, restore.RecordId),
        // A backfill writes a record too, bumping its version. Omitting it left the
        // clone's post-backfill version in the plan's read set, so the promotion compared
        // it against the active file's pre-backfill version and was refused as stale every
        // time — a proposal that could never be accepted.
        BackfillRetiredFieldOperation backfill => (backfill.Edit.EntityId, backfill.Edit.RecordId),
        _ => null,
    };

    private static IReadOnlyList<NendoTouchedRecordVersion> CaptureTouchedRecords(
        NendoChangeSet changeSet,
        NendoSessionSnapshot snapshot)
    {
        // A record introduced by this proposal has no active-file version to
        // protect. The clone still replays operations in order, so an edit that
        // precedes its create is refused by the normal record precondition.
        var activeRecords = snapshot.Records
            .Select(record => (record.EntityId, record.RecordId))
            .ToHashSet();
        var created = changeSet.Mutations
            .SelectMany(mutation => mutation.Operations)
            .OfType<CreateRecordOperation>()
            .Select(operation => (operation.EntityId, operation.RecordId))
            .Where(record => !activeRecords.Contains(record))
            .ToHashSet();
        var references = changeSet.Mutations
            .SelectMany(mutation => mutation.Operations)
            .OfType<SetFieldOperation>()
            .Select(operation => (operation.EntityId, operation.RecordId))
            .Concat(changeSet.Mutations.SelectMany(mutation => mutation.Operations).OfType<BackfillRetiredFieldOperation>()
                .Select(operation => (operation.Edit.EntityId, operation.Edit.RecordId)))
            .Concat(changeSet.Mutations.SelectMany(mutation => mutation.Operations).OfType<ConvertLegacyReferenceOperation>()
                .SelectMany(operation => operation.Records.Select(row => (EntityId: operation.EntityId, RecordId: row.RecordId))
                    .Concat(operation.Records.Where(row => row.TargetRecordId is not null)
                        .Select(row => (EntityId: operation.TargetEntityId, RecordId: row.TargetRecordId!)))))
            .Concat(changeSet.Mutations.SelectMany(mutation => mutation.Operations).OfType<ConfigureReferenceOperation>()
                .Where(operation => operation.ReviewedRecords is not null)
                .SelectMany(operation => operation.ReviewedRecords!.Select(row => (EntityId: operation.EntityId, RecordId: row.RecordId))
                    .Concat(operation.ReviewedRecords!.Where(row => row.TargetRecordId is not null)
                        .Select(row => (EntityId: operation.TargetEntityId, RecordId: row.TargetRecordId!)))))
            .Where(reference => !created.Contains(reference))
            // A record the proposal deletes, and one a reference it writes points at, carry the
            // version the review saw too. Edited after the review, they made the replay refuse
            // and the proposal read Failed, with a form's words, where Stale was the truth.
            // Only records the file holds: one that is missing is the clone's refusal to name.
            .Concat(GuardedTargets(changeSet, snapshot).Where(target => !created.Contains(target) && activeRecords.Contains(target)))
            .Distinct()
            .OrderBy(value => value.EntityId, StringComparer.Ordinal)
            .ThenBy(value => value.RecordId, StringComparer.Ordinal);
        var touched = new List<NendoTouchedRecordVersion>();
        var versions = RecordVersions(snapshot);
        foreach (var reference in references)
        {
            if (!versions.TryGetValue(reference, out var version))
                throw new NendoPreconditionException(
                    "record-not-found",
                    $"Touched record {reference.RecordId} does not exist.");
            touched.Add(new NendoTouchedRecordVersion(
                reference.EntityId,
                reference.RecordId,
                version));
        }
        return touched.AsReadOnly();
    }

    /// <summary>The records a change set deletes, and those its reference writes point at.</summary>
    private static IEnumerable<(string EntityId, string RecordId)> GuardedTargets(NendoChangeSet changeSet, NendoSessionSnapshot snapshot)
    {
        IEnumerable<(string EntityId, string RecordId)> Target(string entityId, string fieldId, JsonElement value)
        {
            var reference = snapshot.Entities.SingleOrDefault(entity => entity.EntityId == entityId)?
                .Fields.SingleOrDefault(field => field.FieldId == fieldId)?.Reference;
            if (reference is not null && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } recordId)
                yield return (reference.TargetEntityId, recordId);
        }
        foreach (var operation in changeSet.Mutations.SelectMany(mutation => mutation.Operations))
        {
            switch (operation)
            {
                case DeleteRecordOperation delete:
                    yield return (delete.EntityId, delete.RecordId);
                    break;
                case SetFieldOperation { ExpectedTargetRecordVersion: not null } set:
                    foreach (var target in Target(set.EntityId, set.FieldId, set.Value)) yield return target;
                    break;
                case CreateRecordOperation create:
                    foreach (var fieldId in create.ExpectedTargetVersions.Keys)
                        if (create.Values.TryGetValue(fieldId, out var value))
                            foreach (var target in Target(create.EntityId, fieldId, value)) yield return target;
                    break;
            }
        }
    }

    private static bool TouchedRecordChanged(
        IReadOnlyList<NendoTouchedRecordVersion> captured,
        NendoSessionSnapshot current)
    {
        var versions = RecordVersions(current);
        foreach (var touched in captured)
        {
            if (!versions.TryGetValue((touched.EntityId, touched.RecordId), out var version) || version != touched.Version)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Each record's version by its type and ID, read once. Each touched record searched the whole
    /// snapshot, so a proposal of thousands of edits made millions of comparisons.
    /// </summary>
    private static Dictionary<(string EntityId, string RecordId), long> RecordVersions(NendoSessionSnapshot snapshot)
    {
        var versions = new Dictionary<(string EntityId, string RecordId), long>(snapshot.Records.Count);
        foreach (var record in snapshot.Records) versions[(record.EntityId, record.RecordId)] = record.RecordVersion;
        return versions;
    }

    private static string ValidatePath(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var fullPath = Path.GetFullPath(path);
        if (!string.Equals(
                Path.GetExtension(fullPath),
                NendoFormat.FileExtension,
                StringComparison.OrdinalIgnoreCase))
        {
            throw new NendoValidationException($"Nendo files must use the {NendoFormat.FileExtension} extension.");
        }
        return fullPath;
    }

    private static FileStream OpenPathPin(string path, FileMode mode, FileAccess access = FileAccess.ReadWrite) => new(path, new FileStreamOptions
    {
        Access = access,
        Mode = mode,
        Share = FileShare.ReadWrite,
        Options = FileOptions.RandomAccess,
    });

    private static void DeletePartialCreation(string fullPath)
    {
        foreach (var path in new[] { fullPath, $"{fullPath}-journal", $"{fullPath}-wal", $"{fullPath}-shm" })
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
