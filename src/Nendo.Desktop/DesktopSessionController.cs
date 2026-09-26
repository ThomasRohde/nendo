using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// What the shell needs to say about a file's automatic actions: whether consent is
/// needed, whether it is held, and what exactly is being asked for.
/// <para>
/// The capability summary is what an owner is actually consenting to, so it travels
/// in the terms they see rather than as an opaque digest. The digest travels too,
/// short, because "this is not the behaviour you approved" is only meaningful if two
/// different behaviours look different.
/// </para>
/// </summary>
internal sealed record DesktopBehaviourTrustView(
    bool RequiresApproval,
    bool IsApproved,
    bool CreatesRecords,
    bool UpdatesRecords,
    bool DeletesRecords,
    string? BehaviourDigest,
    string? Notice);

internal sealed record DesktopSessionView(
    bool HasFile,
    string? FileName,
    string Health,
    NendoManifestSnapshot? Manifest,
    IReadOnlyList<NendoEntitySnapshot> Entities,
    IReadOnlyList<NendoRecordSnapshot> Records,
    IReadOnlyList<NendoUiNodeSnapshot> UiNodes,
    NendoStorageHealthSnapshot? Storage)
{
    public NendoFileCapabilities Capabilities { get; init; } = new(false, false, false, false, false, false, false);
    public IReadOnlyList<NendoOpenFinding> Findings { get; init; } = [];
    public string? FileSessionId { get; init; }
    public string? AgentCleanupNotice { get; init; }
    public NendoReplacementRecovery? ReplacementRecovery { get; init; }

    /// <summary>
    /// Whether this file's automatic actions need approval on this device, and whether
    /// they have it. Null when no file is open.
    /// </summary>
    public DesktopBehaviourTrustView? BehaviourTrust { get; init; }
    public DesktopLocationWarning? LocationWarning { get; init; }

    /// <summary>
    /// The file's custom-view packages and whether their views may run on this device now.
    /// Null when no file is open or the file is in recovery.
    /// </summary>
    public DesktopExtensionRuntimeView? Extensions { get; init; }

    /// <summary>
    /// Which build this is. Present on every view, including the empty one: a
    /// version that disappears when no file is open cannot answer the question it
    /// exists for.
    /// </summary>
    public string HostVersion { get; init; } = NendoProduct.Version;

    internal static DesktopSessionView Empty { get; } = new(
        false,
        null,
        "noFile",
        null,
        [],
        [],
        [],
        null);
}

internal sealed record DesktopMutationView(
    NendoApplyResult Mutation,
    DesktopSessionView? Session,
    string? RefreshNotice = null);

internal sealed record DesktopPromotionView(
    NendoPromotionOutcome Promotion,
    DesktopSessionView? Session,
    string? RefreshNotice = null);

internal sealed partial class DesktopSessionController : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private NendoWriteCoordinator? _coordinator;
    private NendoApplicationService? _service;
    private bool _disposed;

    internal bool HasFile => _coordinator is not null;

    internal async Task<DesktopSessionView> CreateAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        return await CreateCoreAsync(path, acceptEmptyPickerPlaceholder: false, cancellationToken);
    }

    internal async Task<DesktopSessionView> CreateFromSavePickerAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        return await CreateCoreAsync(path, acceptEmptyPickerPlaceholder: true, cancellationToken);
    }

    private async Task<DesktopSessionView> CreateCoreAsync(
        string path,
        bool acceptEmptyPickerPlaceholder,
        CancellationToken cancellationToken)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            RequireWritableLocation(Path.GetFullPath(path));
            _coordinator = acceptEmptyPickerPlaceholder
                ? await NendoWriteCoordinator.CreateOrInitializeEmptyAsync(
                    path,
                    $"desktop-{Environment.ProcessId}",
                    cancellationToken)
                : await NendoWriteCoordinator.CreateAsync(
                    path,
                    $"desktop-{Environment.ProcessId}",
                    cancellationToken);
            _service = new NendoApplicationService(_coordinator);
            BeginAgentFileSession();
            return await FinishOpenAsync(path, writable: true, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<DesktopSessionView> OpenAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            EnsureAvailableForOpen();
            var candidate = await PrepareOpenCoreAsync(path, cancellationToken);
            return await OpenCandidateCoreAsync(candidate, readOnly: false, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private DesktopBehaviourGrantStore? _behaviourGrants;

    /// <summary>
    /// This device's record of which files may run their automatic actions. Created on
    /// first use so a session that never opens a file with behaviour never touches it.
    /// </summary>
    internal DesktopBehaviourGrantStore BehaviourGrants =>
        _behaviourGrants ??= new DesktopBehaviourGrantStore(_deviceStateRoot);

    /// <summary>
    /// Records that the owner has agreed to let the open file run its actions, for exactly
    /// the behaviour it currently holds.
    /// </summary>
    internal async Task<DesktopSessionView> ApproveBehaviourAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var trust = _coordinator?.BehaviourTrust
                ?? throw new NendoValidationException("No file is open.");
            if (trust.Required is not { } required)
                throw new NendoValidationException("This file has no automatic actions to approve.");
            BehaviourGrants.Approve(required);
            return await ReadViewAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Withdraws every approval for the open file.</summary>
    internal async Task<DesktopSessionView> RevokeBehaviourAsync(CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var trust = _coordinator?.BehaviourTrust
                ?? throw new NendoValidationException("No file is open.");
            if (trust.Required is { } required) BehaviourGrants.Revoke(required.ApplicationId, required.InstanceId);
            return await ReadViewAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<DesktopSessionView> GetViewAsync(
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await ReadViewAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal Task<NendoProposalPreview> PrepareProposalAsync(
        NendoCanonicalProposalRequest request,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.PrepareProposalAsync(request, cancellationToken), cancellationToken);

    internal async Task<DesktopMutationView> CreateRecordAsync(
        string entityId,
        string recordId,
        IReadOnlyDictionary<string, object?> values,
        string idempotencyKey,
        CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, long>? expectedTargetVersions = null,
        string? origin = null) =>
        await MutateAsync(
            service => service.CreateRecordAsync(
                new NendoCreateRecordRequest(
                    entityId,
                    recordId,
                    values,
                    new NendoRequestContext("desktop.p2.5", idempotencyKey, origin ?? "surface"), expectedTargetVersions),
                cancellationToken),
            cancellationToken, origin);

    internal Task<DesktopMutationView> DeleteRecordAsync(string entityId, string recordId, long expectedRecordVersion,
        string idempotencyKey, CancellationToken cancellationToken = default, string? origin = null) =>
        MutateAsync(service => service.DeleteRecordAsync(new(entityId, recordId, expectedRecordVersion,
            new NendoRequestContext("desktop.p2.5", idempotencyKey, origin ?? "studio")), cancellationToken), cancellationToken, origin);

    internal async Task<DesktopMutationView> SetFieldAsync(
        string entityId,
        string recordId,
        string fieldId,
        long expectedRecordVersion,
        object? value,
        string idempotencyKey,
        CancellationToken cancellationToken = default,
        long? expectedTargetRecordVersion = null) =>
        await MutateAsync(
            service => service.SetFieldAsync(
                new NendoSetFieldRequest(
                    entityId,
                    recordId,
                    fieldId,
                    expectedRecordVersion,
                    value,
                    new NendoRequestContext("desktop.p2.5", idempotencyKey, "surface"), expectedTargetRecordVersion),
                cancellationToken),
            cancellationToken);

    internal Task<DesktopMutationView> SetFieldsAsync(
        string entityId,
        string recordId,
        long expectedRecordVersion,
        IReadOnlyDictionary<string, object?> values,
        string idempotencyKey,
        CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, long>? expectedTargetVersions = null,
        string? origin = null) =>
        MutateAsync(service => service.SetFieldsAsync(new NendoSetFieldsRequest(
            entityId, recordId, expectedRecordVersion, values,
            new NendoRequestContext("desktop.p2.5", idempotencyKey, origin ?? "surface"), expectedTargetVersions), cancellationToken), cancellationToken, origin);

    internal async Task<DesktopMutationView> ExecuteCommandAsync(
        string commandId,
        string recordId,
        long expectedRecordVersion,
        string idempotencyKey,
        CancellationToken cancellationToken = default,
        string? origin = null) =>
        await MutateAsync(
            service => service.ExecuteCommandAsync(
                new NendoExecuteCommandRequest(
                    commandId,
                    recordId,
                    expectedRecordVersion,
                    new NendoRequestContext("desktop.p2.5", idempotencyKey, origin ?? "surface")),
                cancellationToken),
            cancellationToken, origin);

    internal async Task<DesktopMutationView> CompensateRevisionAsync(
        string revisionId,
        string idempotencyKey,
        CancellationToken cancellationToken = default) =>
        await MutateAsync(
            service => service.CompensateRevisionAsync(revisionId, idempotencyKey, cancellationToken),
            cancellationToken);

    internal Task<NendoCompileResult> CompileSemanticUiAsync(
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => _boundedReadProjection.Value
            ? service.CompileSemanticDefinitionAsync(cancellationToken)
            : service.CompileSemanticUiAsync(cancellationToken), cancellationToken);

    internal Task<NendoPage<NendoRecordSnapshot>> QueryRecordsAsync(NendoRecordQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.QueryRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoRecordCount> CountRecordsAsync(NendoRecordCountQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.CountRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoRecordAggregate> AggregateRecordsAsync(NendoRecordAggregateQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.AggregateRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoRecordGroupedAggregate> GroupAggregateRecordsAsync(NendoRecordGroupedAggregateQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.GroupAggregateRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoRecordDateBucketAggregate> BucketAggregateRecordsAsync(NendoRecordDateBucketQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.BucketAggregateRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoRecordCellAggregate> CellAggregateRecordsAsync(NendoRecordCellAggregateQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.CellAggregateRecordsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoPage<NendoRevisionSummary>> QueryHistoryAsync(NendoHistoryQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.QueryHistoryAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoPage<NendoStoredOperationSnapshot>> QueryRevisionOperationsAsync(NendoRevisionOperationsQuery query, CancellationToken cancellationToken) =>
        QueryAsync(service => service.QueryRevisionOperationsAsync(query, cancellationToken), cancellationToken);

    internal Task<NendoStorageHealthSnapshot> VerifyIntegrityAsync(CancellationToken cancellationToken) =>
        QueryAsync(service => service.VerifyIntegrityAsync(cancellationToken), cancellationToken);

    internal Task<IReadOnlyList<NendoRevisionSnapshot>> GetHistoryAsync(
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.GetHistoryAsync(cancellationToken), cancellationToken);

    internal Task<NendoProposalPreview> GetProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.GetProposalAsync(proposalId, cancellationToken), cancellationToken);

    internal async Task<DesktopPromotionView> PromoteProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default,
        string? expectedOperationDigest = null) =>
        await ChangeProposalAsync(
            service => _agentProposals?.Snapshot().Any(value => value.ProposalId == proposalId) is true
                ? _agentProposals.PromoteAsync(service, proposalId, cancellationToken, expectedOperationDigest)
                : service.PromoteProposalAsync(proposalId, cancellationToken, expectedOperationDigest),
            cancellationToken);

    internal async Task<DesktopPromotionView> RejectProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default) =>
        await ChangeProposalAsync(
            service => _agentProposals?.Snapshot().Any(value => value.ProposalId == proposalId) is true
                ? _agentProposals.RejectAsync(service, proposalId, cancellationToken)
                : service.RejectProposalAsync(proposalId, cancellationToken),
            cancellationToken);

    internal async Task CloseAsync()
    {
        await EnterRequestGateAsync();
        try
        {
            await CloseFileCoreAsync();
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
            await CloseFileCoreAsync();
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task CloseFileCoreAsync()
    {
        try
        {
            await CloseAgentFileSessionCoreAsync();
        }
        finally
        {
            var coordinator = _coordinator;
            if (coordinator is not null && _authorityLostHandler is not null)
                coordinator.WriteAuthorityLost -= _authorityLostHandler;
            _authorityLostHandler = null;
            if (coordinator is not null && _committedHandler is not null)
                coordinator.Committed -= _committedHandler;
            _committedHandler = null;
            RotateFileSession();
            _coordinator = null;
            _service = null;
            _currentPath = null;
            _currentWritableLocationAcknowledged = false;
            _currentObservation = null;
            _detachedRecovery = null;
            _recoveryPath = null;
            _openCandidates.Clear();
            _replacementReviews.Clear();
            if (coordinator is not null)
            {
                await coordinator.DisposeAsync();
            }
        }
    }

    private async Task<DesktopMutationView> MutateAsync(
        Func<NendoApplicationService, Task<NendoApplyResult>> action,
        CancellationToken cancellationToken,
        string? origin = null)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var service = _service ?? throw new NendoPreconditionException(
                "no-file-open",
                "Open or create a Nendo file before changing Studio data.");
            await AdmitExtensionWriterAsync(service, origin, cancellationToken);
            var result = await action(service);
            var refresh = await RefreshAfterOutcomeAsync(cancellationToken);
            return new DesktopMutationView(result, refresh.Session, refresh.Notice);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// What the shell should say about this file's automatic actions.
    /// <para>
    /// The capabilities are named rather than digested, because the owner is being
    /// asked to agree to what the file will do, and "it may delete records" is the
    /// part of that they can actually weigh. The digest is carried short, only so two
    /// different behaviours look different from each other.
    /// </para>
    /// </summary>
    private DesktopBehaviourTrustView? DescribeBehaviourTrust()
    {
        if (_coordinator is null) return null;
        var trust = _coordinator.BehaviourTrust;
        var capabilities = trust.Required?.Capabilities ?? NendoBehaviourCapabilities.None;
        return new DesktopBehaviourTrustView(
            trust.RequiresApproval,
            trust.IsApproved,
            capabilities.HasFlag(NendoBehaviourCapabilities.CreateRecords),
            capabilities.HasFlag(NendoBehaviourCapabilities.UpdateRecords),
            capabilities.HasFlag(NendoBehaviourCapabilities.DeleteRecords),
            trust.Required is { } required ? required.BehaviourDigest[..12] : null,
            _behaviourGrants?.Notice);
    }

    private async Task<T> QueryAsync<T>(
        Func<NendoApplicationService, Task<T>> action,
        CancellationToken cancellationToken,
        string? origin = null)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var service = RequireService();
            await AdmitExtensionWriterAsync(service, origin, cancellationToken);
            return await action(service);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<DesktopPromotionView> ChangeProposalAsync(
        Func<NendoApplicationService, Task<NendoPromotionOutcome>> action,
        CancellationToken cancellationToken)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var result = await action(RequireService());
            var refresh = await RefreshAfterOutcomeAsync(cancellationToken);
            return new DesktopPromotionView(result, refresh.Session, refresh.Notice);
        }
        finally
        {
            _gate.Release();
        }
    }

    private NendoApplicationService RequireService() =>
        _service ?? throw new NendoPreconditionException(
            "no-file-open",
            "Open or create a Nendo file before using Studio.");

    private async Task<DesktopSessionView> ReadViewAsync(CancellationToken cancellationToken)
    {
        if (_service is null)
        {
            StopExtensionsForFile();
            return (_detachedRecovery ?? DesktopSessionView.Empty) with { FileSessionId = _fileSessionId };
        }

        await StopUnhealthyAgentAccessCoreAsync();
        if (!_service.Capabilities.ReadData) return RecoveryView();
        NendoSessionSnapshot snapshot;
        try { snapshot = _boundedReadProjection.Value
            ? await _service.GetDefinitionSnapshotAsync(cancellationToken)
            : await _service.GetSnapshotAsync(cancellationToken); }
        catch (NendoRecoveryRequiredException) when (!_service.Capabilities.ReadData)
        {
            await StopUnhealthyAgentAccessCoreAsync();
            return RecoveryView();
        }
        if (!_service.Capabilities.ReadData) return RecoveryView();
        var health = snapshot.Health switch
        {
            NendoSessionHealth.Normal => "normal",
            NendoSessionHealth.ReadOnly => "readOnly",
            NendoSessionHealth.RecoveryRequired => "recoveryRequired",
            NendoSessionHealth.Closed => "closed",
            _ => "unknown",
        };
        return new DesktopSessionView(
            true,
            snapshot.FileName,
            health,
            snapshot.Manifest,
            snapshot.Entities,
            snapshot.Records,
            snapshot.UiNodes,
            snapshot.Storage)
        {
            Capabilities = _service.Capabilities,
            Findings = _service.Inspection?.Findings ?? [],
            FileSessionId = _fileSessionId,
            AgentCleanupNotice = _agentCleanupNotice,
            LocationWarning = _currentPath is null ? null : _locationPolicy.Inspect(_currentPath),
            BehaviourTrust = DescribeBehaviourTrust(),
            Extensions = DescribeExtensions(snapshot, health),
        };
    }

    private DesktopSessionView RecoveryView()
    {
        StopExtensionsForFile();
        return RecoveryViewCore();
    }

    private DesktopSessionView RecoveryViewCore() => new(true, _coordinator!.FileName,
        "recoveryRequired", null, [], [], [], null)
    {
        Capabilities = _service!.Capabilities,
        Findings = _service.Inspection?.Findings ?? [],
        FileSessionId = _fileSessionId,
        AgentCleanupNotice = _agentCleanupNotice,
        LocationWarning = _currentPath is null ? null : _locationPolicy.Inspect(_currentPath),
    };

    private void EnsureAvailableForOpen()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_coordinator is not null)
        {
            throw new NendoPreconditionException(
                "file-already-open",
                "Close the current Nendo file before opening another one.");
        }
    }
}
