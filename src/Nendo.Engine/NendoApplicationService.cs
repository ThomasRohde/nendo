using System.Globalization;
namespace Nendo.Engine;

public sealed partial class NendoApplicationService
{
    private readonly NendoWriteCoordinator _coordinator;
    private readonly NendoSemanticCompiler _semanticCompiler = new();
    private readonly object _definitionCacheGate = new();
    private (string Application, string Instance, long Revision)? _compiledDefinitionKey;
    private NendoCompileResult? _compiledDefinition;
    internal long DefinitionCompilationCount { get; private set; }

    public NendoApplicationService(NendoWriteCoordinator coordinator)
    {
        _coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator));
    }

    public NendoSessionHealth Health => _coordinator.Health;

    public NendoFileCapabilities Capabilities => _coordinator.Capabilities;

    /// <summary>
    /// Whether the open file carries automatic actions, and whether this host has been
    /// told it may run them. A read of the current position, not a way to change it:
    /// consent is given through the host's own authority and is asked for afresh before
    /// every commit, so nothing that reads this can turn a no into a yes.
    /// </summary>
    public NendoBehaviourTrust BehaviourTrust => _coordinator.BehaviourTrust;

    public NendoFileInspection? Inspection => _coordinator.Inspection;

    public event Action? WriteAuthorityLost
    {
        add => _coordinator.WriteAuthorityLost += value;
        remove => _coordinator.WriteAuthorityLost -= value;
    }

    // Native host lifecycle entry points. The selected path stays on the host;
    // Workbench and MCP receive neither it nor an arbitrary invocation route.
    public Task<NendoBackupPlan> PrepareBackupAsync(
        string destinationPath,
        string requestId,
        CancellationToken cancellationToken = default) =>
        _coordinator.PrepareBackupAsync(destinationPath, requestId, cancellationToken);

    public Task<NendoBackupResult> CreateBackupAsync(
        string planId,
        CancellationToken cancellationToken = default) =>
        _coordinator.CreateBackupAsync(planId, cancellationToken);

    public Task<NendoIdentityCopyPlan> PrepareIdentityCopyAsync(
        NendoIdentityCopyKind kind, string destinationPath, string requestId,
        CancellationToken cancellationToken = default) =>
        _coordinator.PrepareIdentityCopyAsync(kind, destinationPath, requestId, cancellationToken);

    public Task<NendoIdentityCopyResult> CreateIdentityCopyAsync(
        string planId, CancellationToken cancellationToken = default) =>
        _coordinator.CreateIdentityCopyAsync(planId, cancellationToken);

    public Task<NendoRestorePlan> PrepareRestoreAsync(
        string backupPath, string requestId, CancellationToken cancellationToken = default) =>
        _coordinator.PrepareRestoreAsync(backupPath, requestId, cancellationToken);

    public Task<NendoRestoreResult> RestoreAsync(
        string planId, bool confirmDiscardProposals, CancellationToken cancellationToken = default) =>
        _coordinator.RestoreAsync(planId, confirmDiscardProposals, cancellationToken);

    public Task<NendoUpgradePlan> PrepareUpgradeAsync(string requestId, CancellationToken cancellationToken = default) =>
        _coordinator.PrepareUpgradeAsync(requestId, cancellationToken);

    public Task<NendoUpgradeResult> UpgradeAsync(string planId, CancellationToken cancellationToken = default) =>
        _coordinator.UpgradeAsync(planId, cancellationToken);

    public Task<NendoSessionSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default) =>
        _coordinator.GetSnapshotAsync(cancellationToken);

    public Task<NendoSessionSnapshot> GetDefinitionSnapshotAsync(CancellationToken cancellationToken = default) =>
        _coordinator.GetDefinitionSnapshotAsync(cancellationToken);

    public Task<NendoStorageHealthSnapshot> VerifyIntegrityAsync(CancellationToken cancellationToken = default) =>
        _coordinator.VerifyIntegrityAsync(cancellationToken);

    public Task<NendoGraphProjection> ReadGraphProjectionAsync(NendoGraphBinding binding, CancellationToken cancellationToken = default) =>
        _coordinator.ReadGraphProjectionAsync(binding, cancellationToken);

    public Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, CancellationToken cancellationToken = default) =>
        _coordinator.ReadExtensionViewAsync(viewId, cancellationToken);

    /// <summary>A view on a record page, scoped to <paramref name="recordId"/>.</summary>
    public Task<NendoExtensionViewSnapshot> ReadExtensionViewAsync(string viewId, string? recordId, CancellationToken cancellationToken = default) =>
        _coordinator.ReadExtensionViewAsync(viewId, recordId, cancellationToken);

    public Task<NendoRecordCount> CountRecordsAsync(
        NendoRecordCountQuery query,
        CancellationToken cancellationToken = default) =>
        _coordinator.CountRecordsAsync(query, cancellationToken);

    public Task<NendoRecordAggregate> AggregateRecordsAsync(
        NendoRecordAggregateQuery query,
        CancellationToken cancellationToken = default) =>
        _coordinator.AggregateRecordsAsync(query, cancellationToken);

    public Task<NendoRecordGroupedAggregate> GroupAggregateRecordsAsync(
        NendoRecordGroupedAggregateQuery query,
        CancellationToken cancellationToken = default) =>
        _coordinator.GroupAggregateRecordsAsync(query, cancellationToken);

    public Task<NendoRecordDateBucketAggregate> BucketAggregateRecordsAsync(
        NendoRecordDateBucketQuery query,
        CancellationToken cancellationToken = default) =>
        _coordinator.BucketAggregateRecordsAsync(query, cancellationToken);

    public Task<NendoRecordCellAggregate> CellAggregateRecordsAsync(
        NendoRecordCellAggregateQuery query,
        CancellationToken cancellationToken = default) =>
        _coordinator.CellAggregateRecordsAsync(query, cancellationToken);

    public Task<NendoPage<NendoRecordSnapshot>> QueryRecordsAsync(
        NendoRecordQuery query, CancellationToken cancellationToken = default) =>
        _coordinator.QueryRecordsAsync(query, cancellationToken);

    public Task<NendoPage<NendoRevisionSummary>> QueryHistoryAsync(
        NendoHistoryQuery query, CancellationToken cancellationToken = default) =>
        _coordinator.QueryHistoryAsync(query, cancellationToken);

    public Task<NendoPage<NendoStoredOperationSnapshot>> QueryRevisionOperationsAsync(
        NendoRevisionOperationsQuery query, CancellationToken cancellationToken = default) =>
        _coordinator.QueryRevisionOperationsAsync(query, cancellationToken);

    public Task<NendoRecoveryExportPlan> PrepareRecoveryExportAsync(string entityId, string destinationPath,
        string requestId, CancellationToken cancellationToken = default) =>
        _coordinator.PrepareRecoveryExportAsync(entityId, destinationPath, requestId, cancellationToken);

    public Task<NendoRecoveryExportResult> CreateRecoveryExportAsync(string planId, bool confirmPartial,
        CancellationToken cancellationToken = default) =>
        _coordinator.CreateRecoveryExportAsync(planId, confirmPartial, cancellationToken);

    public Task<IReadOnlyList<NendoRevisionSnapshot>> GetHistoryAsync(
        CancellationToken cancellationToken = default) =>
        _coordinator.GetHistoryAsync(cancellationToken);

    public Task<NendoApplyResult?> GetMutationReceiptAsync(
        NendoOperationIdentity identity, CancellationToken cancellationToken = default) =>
        _coordinator.GetMutationReceiptAsync(identity, cancellationToken);

    public Task<NendoChangeSetApplyResult?> GetProposalReceiptAsync(
        string proposalId, CancellationToken cancellationToken = default) =>
        _coordinator.GetProposalReceiptAsync(proposalId, cancellationToken);

    public bool ProposalCleanupPending => _coordinator.ProposalCleanupPending;

    public Task<bool> RetryProposalCleanupAsync(CancellationToken cancellationToken = default) =>
        _coordinator.RetryProposalCleanupAsync(cancellationToken);

    public async Task<NendoCompileResult> CompileSemanticUiAsync(
        CancellationToken cancellationToken = default)
    {
        var snapshot = await _coordinator.GetSnapshotAsync(cancellationToken);
        return CompileVerifiedSnapshot(snapshot);
    }

    public async Task<NendoCompileResult> CompileSemanticDefinitionAsync(CancellationToken cancellationToken = default) =>
        CompileVerifiedSnapshot(await _coordinator.GetDefinitionSnapshotAsync(cancellationToken));

    private NendoCompileResult CompileVerifiedSnapshot(NendoSessionSnapshot snapshot)
    {
        if (snapshot.Health != NendoSessionHealth.Normal && !Capabilities.CustomSurfaces)
        {
            return new NendoCompileResult(false,
                [new("NFILE001", NendoDiagnosticSeverity.Error,
                    "Custom surfaces are disabled for this file's recovery state.", null, null,
                    "Use Studio to inspect readable data and Health to review recovery actions.")]);
        }
        NendoCompileResult definition;
        var key = (snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId, snapshot.Manifest.DefinitionRevision);
        lock (_definitionCacheGate)
        {
            if (_compiledDefinitionKey != key)
            {
                _compiledDefinition = _semanticCompiler.Compile(snapshot with { Records = [] });
                _compiledDefinitionKey = key;
                DefinitionCompilationCount++;
            }
            definition = _compiledDefinition!;
        }
        // Only definitions are cached. Values, versions, data revision and the
        // render digest always come from the current coherent projection.
        return _semanticCompiler.ProjectRecords(definition, snapshot) with { SourceChangeSequence = snapshot.Manifest.ChangeSequence };
    }

    public Task<NendoProposalPreview> PrepareProposalAsync(
        NendoProposalRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.ProposalId, "proposal ID");
        RequireText(request.Title, "proposal title", 200);
        RequireText(request.Origin, "proposal origin", 100);
        ArgumentNullException.ThrowIfNull(request.ChangeSet);
        return _coordinator.BeginProposalAsync(
            request.ProposalId,
            request.Title.Trim(),
            request.Origin.Trim(),
            request.ChangeSet.Validate(),
            cancellationToken);
    }

    public Task<NendoProposalPreview> PrepareProposalAsync(
        NendoCanonicalProposalRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return PrepareProposalAsync(
            new NendoProposalRequest(
                request.ProposalId,
                request.Title,
                request.Origin,
                CanonicalChangeSetRequestCompiler.Compile(request.ChangeSet)),
            cancellationToken);
    }

    public async Task<NendoApplyResult> CreateRecordAsync(
        NendoCreateRecordRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID");
        RequireIdentity(request.RecordId, "record ID");
        ArgumentNullException.ThrowIfNull(request.Values);
        RequireContext(request.Context);
        var entity = await RequireEntityAsync(request.EntityId, cancellationToken);
        return await _coordinator.ApplyAsync(
            new NendoMutation(
                request.Context.IdempotencyScope,
                request.Context.IdempotencyKey,
                request.Context.Origin,
                $"Create {entity.DisplayName}",
                [new CreateRecordOperation(
                    NendoCanonical.DeterministicId(
                        "operation",
                        request.Context.IdempotencyScope,
                        request.Context.IdempotencyKey,
                        0),
                    request.EntityId,
                    request.RecordId,
                    request.Values, request.ExpectedTargetVersions)]),
            cancellationToken);
    }

    /// <summary>
    /// One mutation holding one create operation per record, exactly as a form save
    /// expands to one operation per field. All or nothing: a refusal anywhere in the
    /// batch leaves the file untouched.
    /// </summary>
    public async Task<NendoApplyResult> CreateRecordsAsync(
        NendoCreateRecordsRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID");
        ArgumentNullException.ThrowIfNull(request.Records);
        RequireContext(request.Context);
        if (request.Records.Count is < 1 or > MaximumBatchRecords)
        {
            throw new NendoValidationException(
                $"A batch create carries 1-{MaximumBatchRecords} records; this one carries {request.Records.Count}.");
        }
        foreach (var record in request.Records)
        {
            ArgumentNullException.ThrowIfNull(record);
            RequireIdentity(record.RecordId, "record ID");
            ArgumentNullException.ThrowIfNull(record.Values);
        }
        if (request.Records.Select(record => record.RecordId).Distinct(StringComparer.Ordinal).Count()
            != request.Records.Count)
        {
            throw new NendoValidationException("A batch create requires distinct record IDs.");
        }
        var entity = await RequireEntityAsync(request.EntityId, cancellationToken);
        var operations = request.Records
            .Select((record, ordinal) => (NendoOperation)new CreateRecordOperation(
                NendoCanonical.DeterministicId(
                    "operation",
                    request.Context.IdempotencyScope,
                    request.Context.IdempotencyKey,
                    ordinal),
                request.EntityId,
                record.RecordId,
                record.Values,
                record.ExpectedTargetVersions))
            .ToArray();
        return await _coordinator.ApplyAsync(
            new NendoMutation(
                request.Context.IdempotencyScope,
                request.Context.IdempotencyKey,
                request.Context.Origin,
                $"Create {request.Records.Count} {entity.DisplayName}",
                operations),
            cancellationToken);
    }

    /// <summary>Bounded so one call cannot become an unbounded import.</summary>
    public const int MaximumBatchRecords = 50;

    public async Task<NendoApplyResult> DeleteRecordAsync(NendoDeleteRecordRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID"); RequireIdentity(request.RecordId, "record ID");
        RequireContext(request.Context);
        var entity = await RequireEntityAsync(request.EntityId, cancellationToken);
        return await _coordinator.ApplyAsync(new NendoMutation(request.Context.IdempotencyScope,
            request.Context.IdempotencyKey, request.Context.Origin, $"Delete {entity.DisplayName}",
            [new DeleteRecordOperation(NendoCanonical.DeterministicId("operation", request.Context.IdempotencyScope,
                request.Context.IdempotencyKey, 0), request.EntityId, request.RecordId, request.ExpectedRecordVersion)]), cancellationToken);
    }

    public async Task<NendoApplyResult> SetFieldAsync(
        NendoSetFieldRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID");
        RequireIdentity(request.RecordId, "record ID");
        RequireIdentity(request.FieldId, "field ID");
        RequireContext(request.Context);
        var entity = await RequireEntityAsync(request.EntityId, cancellationToken);
        var field = entity.Fields.SingleOrDefault(value => value.FieldId == request.FieldId)
            ?? throw (entity.DerivedFields.FirstOrDefault(value => value.FieldId == request.FieldId) is { } calculated
                ? NendoCalculatedFieldRefusal.For(request.EntityId, request.FieldId, calculated.CalculationId)
                : new NendoPreconditionException(
                    "field-not-found",
                    $"Field {request.FieldId} does not exist on entity {request.EntityId}."));
        return await _coordinator.ApplyAsync(
            new NendoMutation(
                request.Context.IdempotencyScope,
                request.Context.IdempotencyKey,
                request.Context.Origin,
                $"Edit {entity.DisplayName} {field.DisplayName}",
                [new SetFieldOperation(
                    NendoCanonical.DeterministicId(
                        "operation",
                        request.Context.IdempotencyScope,
                        request.Context.IdempotencyKey,
                        0),
                    request.EntityId,
                    request.RecordId,
                    request.FieldId,
                    request.ExpectedRecordVersion,
                    request.Value, request.ExpectedTargetRecordVersion)]),
            cancellationToken);
    }

    public Task<NendoApplyResult> SetFieldsAsync(
        NendoSetFieldsRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.EntityId, "entity ID");
        RequireIdentity(request.RecordId, "record ID");
        RequireContext(request.Context);
        ArgumentNullException.ThrowIfNull(request.Values);
        if (request.Values.Count is < 1 or > 64 || request.ExpectedRecordVersion < 1 ||
            request.ExpectedRecordVersion > long.MaxValue - request.Values.Count)
            throw new NendoValidationException("A form save requires 1-64 fields and a valid record version.");
        if (request.ExpectedTargetVersions?.Keys.Any(id => !request.Values.ContainsKey(id)) == true)
            throw new NendoValidationException("Target versions must identify submitted reference fields.");

        // Stable field order and semantic IDs keep exact retries independent of
        // dictionary insertion order or subsequent changes to display labels.
        var operations = request.Values.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select((pair, ordinal) => (NendoOperation)new SetFieldOperation(
                NendoCanonical.DeterministicId("operation", request.Context.IdempotencyScope,
                    request.Context.IdempotencyKey, ordinal),
                request.EntityId, request.RecordId, pair.Key,
                request.ExpectedRecordVersion + ordinal, pair.Value,
                request.ExpectedTargetVersions is not null && request.ExpectedTargetVersions.TryGetValue(pair.Key, out var targetVersion) ? targetVersion : null)).ToArray();
        return _coordinator.ApplyAsync(new NendoMutation(request.Context.IdempotencyScope,
            request.Context.IdempotencyKey, request.Context.Origin, "Edit record fields", operations), cancellationToken);
    }

    public async Task<NendoApplyResult> ExecuteCommandAsync(
        NendoExecuteCommandRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        RequireIdentity(request.CommandId, "command ID");
        RequireIdentity(request.RecordId, "record ID");
        RequireContext(request.Context);
        var compilation = await CompileSemanticUiAsync(cancellationToken);

        // Contract version 3 carries commands in the surface tree and a command
        // may set several fields. Every step lands in one mutation against one
        // expected record version, so a button either applies whole or not at all.
        if (FindComposableCommand(compilation, request.CommandId) is { } composable)
            return await ExecuteComposableCommandAsync(composable, request, cancellationToken);

        throw new NendoPreconditionException(
            "command-unavailable",
            "The requested command is not available from a healthy semantic definition.");
    }

    /// <summary>
    /// The version a command leaves behind: one step per field, each against the
    /// previous version. A replay reports nothing rather than the version the
    /// record held when the original committed, which may be stale by now.
    /// </summary>
    private static NendoApplyResult Advanced(NendoApplyResult result, long expectedRecordVersion, int steps) =>
        result.IsIdempotentReplay ? result : result with { RecordVersion = expectedRecordVersion + steps };

    private static (NendoApplicationPlan Plan, NendoSurfaceNodePlan Command)? FindComposableCommand(
        NendoCompileResult compilation,
        string commandId)
    {
        if (!compilation.IsValid) return null;
        foreach (var plan in compilation.Applications)
        {
            var command = FindNode(plan.Surfaces, node => node.Kind == "recordCommand" && node.SemanticId == commandId);
            if (command is not null) return (plan, command);
        }
        return null;
    }

    private static NendoSurfaceNodePlan? FindNode(
        IReadOnlyList<NendoSurfaceNodePlan> nodes,
        Func<NendoSurfaceNodePlan, bool> match) =>
        nodes.Select(node => match(node) ? node : FindNode(node.Children, match)).FirstOrDefault(node => node is not null);

    private async Task<NendoApplyResult> ExecuteComposableCommandAsync(
        (NendoApplicationPlan Plan, NendoSurfaceNodePlan Command) found,
        NendoExecuteCommandRequest request,
        CancellationToken cancellationToken)
    {
        var (plan, command) = found;
        var steps = command.Children.Where(child => child.Kind == "commandStep").ToArray();
        if (steps.Length == 0)
            throw new NendoPreconditionException("command-unavailable", "The requested command is not available from a healthy semantic definition.");

        var fields = plan.Entity.Fields.ToDictionary(field => field.SemanticId, StringComparer.Ordinal);
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var step in steps)
        {
            var fieldId = step.Properties["fieldId"].GetString()!;
            if (!fields.TryGetValue(fieldId, out var field))
                throw new NendoPreconditionException("command-unavailable", "The requested command is not available from a healthy semantic definition.");
            values[fieldId] = ResolveStepValue(step, field);
        }

        // One expected record version across the whole button, as a form save does.
        var operations = values.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select((pair, ordinal) => (NendoOperation)new SetFieldOperation(
                NendoCanonical.DeterministicId("operation", request.Context.IdempotencyScope, request.Context.IdempotencyKey, ordinal),
                plan.Entity.SemanticId, request.RecordId, pair.Key,
                request.ExpectedRecordVersion + ordinal, pair.Value)).ToArray();
        return Advanced(
            await _coordinator.ApplyAsync(
                new NendoMutation(request.Context.IdempotencyScope, request.Context.IdempotencyKey,
                    request.Context.Origin, command.Properties["label"].GetString() ?? "Command", operations),
                cancellationToken),
            request.ExpectedRecordVersion,
            operations.Length);
    }

    /// <summary>
    /// today and now resolve at execution, not at compilation, so the stored
    /// definition and its digest stay independent of the clock.
    /// </summary>
    private static object? ResolveStepValue(NendoSurfaceNodePlan step, NendoFieldPlan field)
    {
        var kind = step.Properties["valueKind"].GetString();
        var now = DateTimeOffset.UtcNow;
        return kind switch
        {
            "null" => null,
            "today" => field.StorageKind == NendoStorageKind.DateTime
                ? now.Date.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)
                : now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            "now" => now.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
            _ => step.Properties["value"],
        };
    }

    public Task<NendoProposalPreview> GetProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default) =>
        _coordinator.GetProposalAsync(proposalId, cancellationToken);

    public Task<NendoPromotionOutcome> RejectProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default) =>
        _coordinator.RejectProposalAsync(proposalId, cancellationToken);

    public Task<NendoPromotionOutcome> PromoteProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default,
        string? expectedOperationDigest = null) =>
        _coordinator.PromoteProposalAsync(proposalId, cancellationToken, expectedOperationDigest);

    public Task<NendoApplyResult> CompensateRevisionAsync(
        string revisionId,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        RequireKey(idempotencyKey);
        return _coordinator.CompensateRevisionAsync(revisionId, idempotencyKey, cancellationToken);
    }

    private static void RequireKey(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 200)
        {
            throw new NendoValidationException("An idempotency key must contain 1-200 characters.");
        }
    }

    private static void RequireContext(NendoRequestContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        RequireText(context.IdempotencyScope, "idempotency scope", 200);
        RequireText(context.IdempotencyKey, "idempotency key", 200);
        RequireText(context.Origin, "origin", 100);
    }

    private static void RequireIdentity(string value, string name) =>
        RequireText(value, name, 200);

    private static void RequireText(string value, string name, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new NendoValidationException(
                $"The {name} must contain 1-{maximumLength} characters.");
        }
    }

    private async Task<NendoEntitySnapshot> RequireEntityAsync(
        string entityId,
        CancellationToken cancellationToken)
    {
        var snapshot = await _coordinator.GetDefinitionSnapshotAsync(cancellationToken);
        return snapshot.Entities.SingleOrDefault(value => value.EntityId == entityId)
            ?? throw new NendoPreconditionException(
                "entity-not-found",
                $"Entity {entityId} does not exist.");
    }

}
