using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    internal const string SessionGetSnapshot = "session.getSnapshot";
    internal const string SessionCreateFile = "session.createFile";
    internal const string SessionOpenFile = "session.openFile";
    internal const string DataCreateRecord = "data.createRecord";
    internal const string DataDeleteRecord = "data.deleteRecord";
    internal const string DataSetField = "data.setField";
    internal const string DataSetFields = "data.setFields";
    internal const string DataExecuteCommand = "data.executeCommand";
    internal const string DataGetReceipt = "data.getReceipt";
    internal const string CompensationGetReceipt = "history.getCompensationReceipt";
    internal const string ProposalGetReceipt = "proposal.getReceipt";
    internal const string SemanticCompile = "semantic.compile";
    internal const string ProposalPrepareChangeSet = "proposal.prepareChangeSet";
    internal const string ProposalGet = "proposal.get";
    internal const string ProposalPromote = "proposal.promote";
    internal const string ProposalReject = "proposal.reject";
    internal const string HistoryGet = "history.get";
    internal const string HistoryQuery = "history.query";
    internal const string HistoryOperations = "history.operations";
    internal const string DataQueryRecords = "data.queryRecords";
    internal const string DataCountRecords = "data.countRecords";
    internal const string DataAggregateRecords = "data.aggregateRecords";
    internal const string DataGroupAggregateRecords = "data.groupAggregateRecords";
    internal const string DataBucketAggregateRecords = "data.bucketAggregateRecords";
    internal const string DataCellAggregateRecords = "data.cellAggregateRecords";
    internal const string HealthVerify = "health.verify";
    internal const string HistoryCompensate = "history.compensate";
    internal const string AppearanceSet = "appearance.set";
    internal const string AppearanceGet = "appearance.get";
    internal const string AgentGetStatus = "agent.getStatus";
    internal const string AgentSetMode = "agent.setMode";
    internal const string AgentRevokeEditing = "agent.revokeEditing";
    internal const string AgentGetProposal = "agent.getProposal";
    internal const string AgentSetSettings = "agent.setSettings";

    // Approving and withdrawing approval for a file's automatic actions. These reach
    // the device's own approval store, which is why they exist only here: an agent
    // speaks the MCP surface, which has no equivalent and must never gain one.
    internal const string BehaviourApprove = "behaviour.approve";
    internal const string BehaviourRevoke = "behaviour.revoke";
}

internal sealed record WorkbenchError(string Code, string Message);

internal sealed record WorkbenchResponse(
    int ProtocolVersion,
    string RequestId,
    bool Ok,
    object? Result,
    WorkbenchError? Error);

/// <summary>
/// A message the host sends without being asked.
/// <para>
/// The first of its kind on this bridge, and shaped so it cannot be mistaken for a
/// reply: it carries an <c>event</c> name where a response carries a
/// <c>requestId</c>, so a renderer that predates it matches nothing and drops it.
/// It is a nudge, not a channel — it carries a view name and no data, because
/// anything it carried would be state the renderer had not asked for and could not
/// place in its own ordering of reads.
/// </para>
/// </summary>
internal sealed record WorkbenchEvent(int ProtocolVersion, string Event, object? Payload);

/// <summary>The closed set of unsolicited event names.</summary>
internal static class WorkbenchEvents
{
    /// <summary>Show a Workbench view. Payload is one route name from the closed set.</summary>
    internal const string Navigate = "navigate";

    /// <summary>
    /// The open file moved. Payload is the change sequence it reached, and nothing else:
    /// not what changed, not who changed it, and no record contents. It is a nudge to
    /// look again, and the renderer decides when looking is safe.
    /// </summary>
    internal const string FileChanged = "fileChanged";

    /// <summary>
    /// An agent started or finished a call. Payload is whether work is running, the
    /// client's display name and the tool or resource it named -- no handle, no lease, no
    /// record. It is the one event here that exists for the person rather than for the
    /// renderer's own reads: while an agent holds the Engine gate the window cannot
    /// answer, and nothing on any screen said why.
    /// </summary>
    internal const string AgentActivity = "agentActivity";

    /// <summary>
    /// The renderer behind one or more custom views ended. Payload is the file session and the
    /// frame names (<c>nendo-view-…</c>) the browser reported; the Workbench says so in each
    /// view's own place and offers Reload. The Workbench itself is unaffected.
    /// </summary>
    internal const string ExtensionFramesFailed = "extensionFramesFailed";
}

internal sealed record ExtensionFramesFailedPayload(string FileSessionId, IReadOnlyList<string> Frames);

/// <summary>What the renderer draws while an agent is working. Bounded by the adapter.</summary>
internal sealed record AgentActivityPayload(bool Busy, string Client, string Activity);

internal sealed record CreateRecordPayload(
    string EntityId,
    string RecordId,
    IReadOnlyDictionary<string, JsonElement> Values,
    string IdempotencyKey,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null);

internal sealed record DeleteRecordPayload(string EntityId, string RecordId, long ExpectedRecordVersion, string IdempotencyKey);

internal sealed record SetFieldPayload(
    string EntityId,
    string RecordId,
    string FieldId,
    long ExpectedRecordVersion,
    JsonElement Value,
    string IdempotencyKey,
    long? ExpectedTargetRecordVersion = null);

internal sealed record ExecuteCommandPayload(
    string CommandId,
    string RecordId,
    long ExpectedRecordVersion,
    string IdempotencyKey);

internal sealed record SetFieldsPayload(
    string EntityId,
    string RecordId,
    long ExpectedRecordVersion,
    IReadOnlyDictionary<string, JsonElement> Values,
    string IdempotencyKey,
    IReadOnlyDictionary<string, long>? ExpectedTargetVersions = null);

internal sealed record CanonicalMutationPayload(
    string IdempotencyKey,
    string Description,
    IReadOnlyList<NendoCanonicalOperationRequest> Operations);

internal sealed record PrepareChangeSetPayload(
    string ProposalId,
    string Title,
    IReadOnlyList<CanonicalMutationPayload> Mutations);

internal sealed record ProposalIdPayload(string ProposalId);
internal sealed record ProposalAcceptancePayload(string ProposalId, string? ExpectedOperationDigest);

internal sealed record CompensationPayload(string RevisionId, string IdempotencyKey);

internal sealed record AppearancePayload(string Preference, string Effective);

internal sealed record AgentModePayload(string Mode);

internal sealed record AgentSettingsPayload(
    bool LeaseExpiry,
    int LeaseExpirySeconds,
    bool FixedPort,
    int Port);

internal sealed partial class WorkbenchProtocolHandler
{
    internal const int MaximumMessageCharacters = 262_144;
    private static readonly JsonSerializerOptions LegacyJsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new WorkbenchScalarJsonConverter() },
    };
    private static readonly IReadOnlySet<string> CurrentOnlyMethods = new HashSet<string>(
        [
            WorkbenchMethods.DataCreateRecord,
            WorkbenchMethods.DataSetField,
            WorkbenchMethods.DataExecuteCommand,
            WorkbenchMethods.ProposalPrepareChangeSet,
        ],
        StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> AgentMethods = new HashSet<string>(
        [
            WorkbenchMethods.AgentGetStatus,
            WorkbenchMethods.AgentSetMode,
            WorkbenchMethods.AgentRevokeEditing,
            WorkbenchMethods.AgentGetProposal,
            WorkbenchMethods.AgentSetSettings,
        ],
        StringComparer.Ordinal);
    private readonly DesktopSessionController _session;
    private readonly Func<Task<string?>> _pickCreatePath;
    private readonly Func<Task<string?>> _pickOpenPath;
    private readonly Action<AppearancePayload> _applyAppearance;
    private readonly Func<DesktopAppearanceView>? _getAppearance;
    private readonly Func<WorkbenchFileActionRequest, Task<DesktopFileActionView>>? _fileActions;
    private readonly IWorkbenchExtensionHost? _extensionHost;
    private string? _legacyFileSessionId;

    internal WorkbenchProtocolHandler(
        DesktopSessionController session,
        Func<Task<string?>> pickCreatePath,
        Func<Task<string?>> pickOpenPath,
        Action<AppearancePayload> applyAppearance,
        Func<WorkbenchFileActionRequest, Task<DesktopFileActionView>>? fileActions = null,
        Func<DesktopAppearanceView>? getAppearance = null,
        IWorkbenchExtensionHost? extensionHost = null)
    {
        _extensionHost = extensionHost;
        _session = session;
        _pickCreatePath = pickCreatePath;
        _pickOpenPath = pickOpenPath;
        _applyAppearance = applyAppearance;
        _getAppearance = getAppearance;
        _fileActions = fileActions;
    }

    /// <param name="droppedPath">
    /// The file Windows says arrived with this message, when one did. Supplied by the
    /// host from the shell's own file object rather than read out of the payload, so
    /// that "open this dropped file" cannot become "open any path I name".
    /// </param>
    internal async Task<WorkbenchResponse> HandleAsync(
        string messageJson,
        string? droppedPath = null,
        CancellationToken cancellationToken = default)
    {
        string requestId = "invalid-request";
        var responseProtocolVersion = DesktopShellContract.BridgeProtocolVersion;
        try
        {
            if (messageJson.Length > MaximumMessageCharacters)
            {
                return Failure(
                    requestId,
                    "request-too-large",
                    "The Workbench request is larger than the supported limit.");
            }
            using var document = JsonDocument.Parse(messageJson, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16,
            });
            var root = document.RootElement;
            var protocolVersion = RequiredInt32(root, "protocolVersion");
            requestId = RequiredString(root, "requestId", 120);
            var method = RequiredString(root, "method", 120);
            var payload = root.TryGetProperty("payload", out var value)
                ? value
                : JsonSerializer.SerializeToElement(new { });
            if (!DesktopShellContract.IsSupportedBridgeProtocol(protocolVersion))
            {
                return Failure(requestId, "unsupported-protocol", "The Workbench protocol version is not supported.");
            }
            responseProtocolVersion = protocolVersion;

            // Stopping a request is bookkeeping about requests, so it is answered
            // here rather than travelling through the file-session binding and the
            // service gate that the request it is stopping already holds.
            if (method == WorkbenchMethods.RequestCancel)
            {
                return new WorkbenchResponse(responseProtocolVersion, requestId, true,
                    await CancelRequestAsync(payload, cancellationToken), null);
            }

            // Everything below runs under this request's own cancellation, so a
            // later request.cancel naming it reaches the work itself rather than
            // only the message loop that started it.
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            using var inFlight = TrackRequest(requestId, cancellation);
            cancellationToken = cancellation.Token;

            if (!IsMethodAvailable(protocolVersion, method))
            {
                throw new NendoPreconditionException(
                    "unknown-method",
                    $"Workbench method {method} is not part of protocol version {protocolVersion}.");
            }

            // V5 sends the opaque file generation it actually rendered. Older
            // renderers are pinned once and cannot silently follow a native file
            // switch. The controller checks this under its gate, including after
            // every interactive picker/confirmation wait.
            var independent = method is WorkbenchMethods.SessionGetSnapshot or WorkbenchMethods.AppearanceSet or WorkbenchMethods.AppearanceGet or WorkbenchMethods.SessionGetRecentFiles;
            string? expectedSession = null;
            if (protocolVersion < DesktopShellContract.OutcomeBridgeProtocolVersion)
            {
                var snapshot = await _session.GetViewAsync(cancellationToken);
                Interlocked.CompareExchange(ref _legacyFileSessionId, snapshot.FileSessionId, null);
                expectedSession = _legacyFileSessionId;
            }
            else if (!independent)
            {
                expectedSession = RequiredString(root, "fileSessionId", 120);
            }
            using var projection = _session.BindReadProjection(root.TryGetProperty("boundedRead", out var boundedRead) &&
                boundedRead.ValueKind == JsonValueKind.True);
            using var binding = independent ? null : _session.BindFileRequest(expectedSession!);
            if (binding is not null) await _session.ValidateFileRequestAsync(cancellationToken);

            object? result;
            if (FileMethods.TryGetValue(method, out var fileAction))
            {
                if (fileAction == WorkbenchFileAction.OpenDropped && droppedPath is null)
                {
                    throw new NendoValidationException("No file arrived with that request.");
                }
                result = await RunFileActionAsync(fileAction,
                    fileAction == WorkbenchFileAction.OpenRecent ? RequiredString(payload, "recentId", 120) : null,
                    fileAction == WorkbenchFileAction.OpenDropped ? droppedPath : null);
            }
            else if (protocolVersion == DesktopShellContract.LegacyBridgeProtocolVersion &&
                LegacyWorkbenchProtocol.IsMethod(method))
            {
                result = await LegacyWorkbenchProtocol.HandleAsync(
                    _session,
                    method,
                    payload,
                    cancellationToken);
            }
            else
            {
                result = method switch
                {
                    WorkbenchMethods.SessionGetSnapshot => await _session.GetViewAsync(cancellationToken),
                    WorkbenchMethods.ExtensionSettingsSet => await _session.SetExtensionSettingAsync(
                        RequiredString(payload, "scope", 16), RequiredBoolean(payload, "enabled"), cancellationToken),
                    WorkbenchMethods.ExtensionImport => await ImportExtensionAsync(cancellationToken),
                    WorkbenchMethods.ExtensionExport => await ExportExtensionAsync(RequiredString(payload, "packageId", 80), cancellationToken),
                    WorkbenchMethods.ExtensionRemove => await _session.PrepareExtensionRemovalAsync(RequiredString(payload, "packageId", 80), cancellationToken),
                    WorkbenchMethods.DiagnosticsFrameProcesses when DesktopRuntimeConfiguration.NativeDiagnostics =>
                        await ExtensionHost().ReadFrameProcessesAsync(),
                    WorkbenchMethods.SessionGetRecentFiles => await _session.GetRecentFilesAsync(cancellationToken),
                    WorkbenchMethods.SessionCreateFile => protocolVersion == DesktopShellContract.BridgeProtocolVersion
                        ? await RunSessionFileActionAsync(WorkbenchFileAction.Create)
                        : await CreateFileAsync(cancellationToken),
                    WorkbenchMethods.SessionOpenFile => protocolVersion == DesktopShellContract.BridgeProtocolVersion
                        ? await RunSessionFileActionAsync(WorkbenchFileAction.Open)
                        : await OpenFileAsync(cancellationToken),
                    WorkbenchMethods.DataCreateRecord => await CreateGenericRecordAsync(payload, cancellationToken),
                    WorkbenchMethods.DataDeleteRecord => await DeleteGenericRecordAsync(payload, cancellationToken),
                    WorkbenchMethods.DataSetField => await SetGenericFieldAsync(payload, cancellationToken),
                    WorkbenchMethods.DataSetFields => await SetGenericFieldsAsync(payload, cancellationToken),
                    WorkbenchMethods.DataExecuteCommand => await ExecuteGenericCommandAsync(payload, cancellationToken),
                    WorkbenchMethods.DataGetReceipt => await _session.GetMutationReceiptAsync(RequiredString(payload, "idempotencyKey", 200), false, cancellationToken),
                    WorkbenchMethods.CompensationGetReceipt => await _session.GetMutationReceiptAsync(RequiredString(payload, "idempotencyKey", 200), true, cancellationToken),
                    WorkbenchMethods.ProposalGetReceipt => await _session.GetProposalReceiptAsync(RequiredString(payload, "proposalId", 80), cancellationToken),
                    WorkbenchMethods.SemanticCompile => await _session.CompileSemanticUiAsync(cancellationToken),
                    WorkbenchMethods.ProposalPrepareChangeSet => await PrepareChangeSetAsync(payload, cancellationToken),
                    WorkbenchMethods.ProposalGet => await GetProposalAsync(payload, cancellationToken),
                    WorkbenchMethods.ProposalPromote => await PromoteProposalAsync(payload, cancellationToken),
                    WorkbenchMethods.ProposalReject => await RejectProposalAsync(payload, cancellationToken),
                    WorkbenchMethods.HistoryGet => await _session.GetHistoryAsync(cancellationToken),
                    WorkbenchMethods.HistoryQuery => await _session.QueryHistoryAsync(Deserialize<NendoHistoryQuery>(payload), cancellationToken),
                    WorkbenchMethods.HistoryOperations => await _session.QueryRevisionOperationsAsync(Deserialize<NendoRevisionOperationsQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataQueryRecords => await _session.QueryRecordsAsync(Deserialize<NendoRecordQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataCountRecords => await _session.CountRecordsAsync(Deserialize<NendoRecordCountQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataAggregateRecords => await _session.AggregateRecordsAsync(Deserialize<NendoRecordAggregateQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataGroupAggregateRecords => await _session.GroupAggregateRecordsAsync(Deserialize<NendoRecordGroupedAggregateQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataBucketAggregateRecords => await _session.BucketAggregateRecordsAsync(Deserialize<NendoRecordDateBucketQuery>(payload), cancellationToken),
                    WorkbenchMethods.DataCellAggregateRecords => await _session.CellAggregateRecordsAsync(Deserialize<NendoRecordCellAggregateQuery>(payload), cancellationToken),
                    WorkbenchMethods.HealthVerify => await _session.VerifyIntegrityAsync(cancellationToken),
                    WorkbenchMethods.HistoryCompensate => await CompensateRevisionAsync(payload, cancellationToken),
                    WorkbenchMethods.AppearanceSet => ApplyAppearance(payload),
                    WorkbenchMethods.AppearanceGet => _getAppearance?.Invoke() ?? new DesktopAppearanceView("system", "light", false, "Native appearance is unavailable."),
                    WorkbenchMethods.AgentGetStatus => await _session.GetAgentStatusAsync(cancellationToken),
                    WorkbenchMethods.AgentSetMode => await SetAgentModeAsync(payload, cancellationToken),
                    WorkbenchMethods.AgentRevokeEditing => await _session.RevokeAgentEditingAsync(cancellationToken),
                    WorkbenchMethods.AgentGetProposal => await GetAgentProposalAsync(payload, cancellationToken),
                    WorkbenchMethods.AgentSetSettings => await SetAgentSettingsAsync(payload, cancellationToken),
                    WorkbenchMethods.BehaviourApprove => await _session.ApproveBehaviourAsync(cancellationToken),
                    WorkbenchMethods.BehaviourRevoke => await _session.RevokeBehaviourAsync(cancellationToken),
                    _ => throw new NendoPreconditionException(
                        "unknown-method",
                        $"Workbench method {method} is not part of protocol version {protocolVersion}."),
                };
            }
            if (protocolVersion < DesktopShellContract.BridgeProtocolVersion && binding is not null)
                _legacyFileSessionId = binding.FileSessionId;
            return new WorkbenchResponse(
                responseProtocolVersion,
                requestId,
                true,
                result,
                null);
        }
        catch (JsonException)
        {
            return Failure(requestId, "invalid-request", "The Workbench request is not valid JSON.", responseProtocolVersion);
        }
        catch (NendoPreconditionException exception)
        {
            return Failure(requestId, exception.Code, exception.Message, responseProtocolVersion);
        }
        catch (NendoCalculationException exception)
        {
            // An automatic action that could not run refused the save; the code says
            // why and the message names the action.
            return Failure(requestId, exception.Code, exception.Message, responseProtocolVersion);
        }
        catch (NendoFileOpenException exception)
        {
            return Failure(requestId, "file-inspection", exception.Inspection.Findings.FirstOrDefault()?.Message
                ?? "The selected file could not be safely opened.", responseProtocolVersion);
        }
        catch (NendoReplacementInterruptedException exception)
        {
            return Failure(requestId, "replacement-interrupted", exception.Message, responseProtocolVersion);
        }
        catch (NendoIdempotencyConflictException exception)
        {
            return Failure(requestId, "idempotency-conflict", exception.Message, responseProtocolVersion);
        }
        catch (NendoRecoveryRequiredException exception)
        {
            return Failure(requestId, "recovery-required", exception.Message, responseProtocolVersion);
        }
        catch (NendoWriteOwnershipException exception)
        {
            return Failure(requestId, "write-owned", exception.Message, responseProtocolVersion);
        }
        catch (NendoValidationException exception)
        {
            return Failure(requestId, "validation", exception.Message, responseProtocolVersion);
        }
        catch (NendoCompensationNotSupportedException exception)
        {
            return Failure(requestId, "compensation-not-supported", exception.Message, responseProtocolVersion);
        }
        catch (OperationCanceledException)
        {
            return Failure(requestId, "cancelled", "The action was cancelled. Refresh the file status before trying again.", responseProtocolVersion);
        }
        catch (IOException)
        {
            return Failure(requestId, "file-io", "The file action could not be confirmed. Inspect the file status and selected destination before retrying; a result may already exist.", responseProtocolVersion);
        }
        catch (UnauthorizedAccessException)
        {
            return Failure(requestId, "file-access", "Access was denied. Choose an accessible file or folder, or open the file read-only.", responseProtocolVersion);
        }
        catch (Exception)
        {
            return Failure(requestId, "internal", "The host could not complete the Workbench request.", responseProtocolVersion);
        }
    }

    internal static string Serialize(WorkbenchResponse response) =>
        JsonSerializer.Serialize(response, response.ProtocolVersion >= 6 ? JsonOptions : LegacyJsonOptions);

    internal static string SerializeEvent(WorkbenchEvent hostEvent) =>
        JsonSerializer.Serialize(hostEvent, JsonOptions);

    private async Task<DesktopSessionView> CreateFileAsync(CancellationToken cancellationToken)
    {
        var path = await _pickCreatePath();
        return path is null
            ? await _session.GetViewAsync(cancellationToken)
            : await _session.CreateFromSavePickerAsync(path, cancellationToken);
    }

    private async Task<DesktopSessionView> OpenFileAsync(CancellationToken cancellationToken)
    {
        var path = await _pickOpenPath();
        return path is null
            ? await _session.GetViewAsync(cancellationToken)
            : await _session.OpenAsync(path, cancellationToken);
    }

    private async Task<DesktopMutationView> CreateGenericRecordAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<CreateRecordPayload>(payload);
        return await _session.CreateRecordAsync(
            request.EntityId,
            request.RecordId,
            request.Values.ToDictionary(
                pair => pair.Key,
                pair => (object?)pair.Value.Clone(),
                StringComparer.Ordinal),
            request.IdempotencyKey,
            cancellationToken, request.ExpectedTargetVersions);
    }

    private async Task<DesktopMutationView> DeleteGenericRecordAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var request = Deserialize<DeleteRecordPayload>(payload);
        return await _session.DeleteRecordAsync(request.EntityId, request.RecordId, request.ExpectedRecordVersion,
            request.IdempotencyKey, cancellationToken);
    }

    private async Task<DesktopMutationView> SetGenericFieldAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<SetFieldPayload>(payload);
        return await _session.SetFieldAsync(
            request.EntityId,
            request.RecordId,
            request.FieldId,
            request.ExpectedRecordVersion,
            request.Value,
            request.IdempotencyKey,
            cancellationToken, request.ExpectedTargetRecordVersion);
    }

    private async Task<DesktopMutationView> SetGenericFieldsAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<SetFieldsPayload>(payload);
        if (request.Values is null) throw new NendoValidationException("The form values are required.");
        return await _session.SetFieldsAsync(request.EntityId, request.RecordId, request.ExpectedRecordVersion,
            request.Values.ToDictionary(pair => pair.Key, pair => (object?)pair.Value.Clone(), StringComparer.Ordinal),
            request.IdempotencyKey, cancellationToken, request.ExpectedTargetVersions);
    }

    private async Task<DesktopMutationView> ExecuteGenericCommandAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ExecuteCommandPayload>(payload);
        return await _session.ExecuteCommandAsync(
            request.CommandId,
            request.RecordId,
            request.ExpectedRecordVersion,
            request.IdempotencyKey,
            cancellationToken);
    }

    private async Task<NendoProposalPreview> PrepareChangeSetAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<PrepareChangeSetPayload>(payload);
        var changeSet = new NendoCanonicalChangeSetRequest(request.Mutations.Select(mutation =>
            new NendoCanonicalMutationRequest(
                "desktop.p2.5",
                mutation.IdempotencyKey,
                "workbench",
                mutation.Description,
                mutation.Operations)).ToArray());
        return await _session.PrepareProposalAsync(
            new NendoCanonicalProposalRequest(
                request.ProposalId,
                request.Title,
                "workbench",
                changeSet),
            cancellationToken);
    }

    private async Task<NendoProposalPreview> GetProposalAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ProposalIdPayload>(payload);
        return await _session.GetProposalAsync(request.ProposalId, cancellationToken);
    }

    private async Task<DesktopPromotionView> PromoteProposalAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ProposalAcceptancePayload>(payload);
        return await _session.PromoteProposalAsync(request.ProposalId, cancellationToken, request.ExpectedOperationDigest);
    }

    private async Task<DesktopPromotionView> RejectProposalAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ProposalIdPayload>(payload);
        return await _session.RejectProposalAsync(request.ProposalId, cancellationToken);
    }

    private async Task<DesktopMutationView> CompensateRevisionAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<CompensationPayload>(payload);
        return await _session.CompensateRevisionAsync(
            request.RevisionId,
            request.IdempotencyKey,
            cancellationToken);
    }

    private object ApplyAppearance(JsonElement payload)
    {
        var request = Deserialize<AppearancePayload>(payload);
        if (request.Preference is not ("system" or "light" or "dark") ||
            request.Effective is not ("light" or "dark"))
        {
            throw new NendoValidationException("Appearance must contain a valid preference and effective theme.");
        }
        _applyAppearance(request);
        return _getAppearance?.Invoke() ?? (object)new { request.Preference, request.Effective };
    }

    private async Task<DesktopAgentStatus> SetAgentModeAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<AgentModePayload>(payload);
        return await _session.SetAgentModeAsync(request.Mode, cancellationToken);
    }

    private async Task<DesktopAgentStatus> SetAgentSettingsAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<AgentSettingsPayload>(payload);
        // Re-validated in the store; the renderer is never the authority on a bounded value.
        return await _session.SetAgentSettingsAsync(
            request.LeaseExpiry,
            request.LeaseExpirySeconds,
            request.FixedPort,
            request.Port,
            cancellationToken);
    }

    private async Task<Nendo.LocalMcp.NendoAgentProposalPreview> GetAgentProposalAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ProposalIdPayload>(payload);
        return await _session.GetAgentProposalAsync(request.ProposalId, cancellationToken);
    }

    private static T Deserialize<T>(JsonElement payload) where T : class =>
        payload.Deserialize<T>(JsonOptions)
        ?? throw new NendoValidationException("The Workbench request payload is missing or invalid.");

    private static WorkbenchResponse Failure(
        string requestId,
        string code,
        string message,
        int protocolVersion = DesktopShellContract.BridgeProtocolVersion) => new(
        protocolVersion,
        requestId,
        false,
        null,
        new WorkbenchError(code, message));

    private static bool IsMethodAvailable(int protocolVersion, string method) =>
        (protocolVersion >= DesktopShellContract.SnapshotBridgeProtocolVersion || method != WorkbenchMethods.DataDeleteRecord) &&
        (protocolVersion >= DesktopShellContract.OutcomeBridgeProtocolVersion || method is not
            (WorkbenchMethods.DataGetReceipt or WorkbenchMethods.CompensationGetReceipt or WorkbenchMethods.ProposalGetReceipt or WorkbenchMethods.DataSetFields or
             WorkbenchMethods.DataQueryRecords or WorkbenchMethods.DataCountRecords or
             WorkbenchMethods.DataAggregateRecords or
             WorkbenchMethods.HistoryQuery or WorkbenchMethods.HistoryOperations or WorkbenchMethods.HealthVerify)) &&
        (protocolVersion >= DesktopShellContract.OutcomeBridgeProtocolVersion ||
            (!FileMethods.ContainsKey(method) && method is not (WorkbenchMethods.SessionGetRecentFiles or WorkbenchMethods.AppearanceGet))) &&
        protocolVersion switch
        {
            DesktopShellContract.LegacyBridgeProtocolVersion => !CurrentOnlyMethods.Contains(method),
            DesktopShellContract.PreviousBridgeProtocolVersion =>
                !LegacyWorkbenchProtocol.IsMethod(method) && !AgentMethods.Contains(method),
            DesktopShellContract.AgentBridgeProtocolVersion => !LegacyWorkbenchProtocol.IsMethod(method),
            DesktopShellContract.OutcomeBridgeProtocolVersion => !LegacyWorkbenchProtocol.IsMethod(method),
            DesktopShellContract.SnapshotBridgeProtocolVersion => !LegacyWorkbenchProtocol.IsMethod(method),
            DesktopShellContract.BridgeProtocolVersion => !LegacyWorkbenchProtocol.IsMethod(method),
            _ => false,
        };

    private static string RequiredString(JsonElement root, string name, int maximumLength)
    {
        if (!root.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new NendoValidationException($"Request property {name} is required.");
        }
        var result = value.GetString();
        if (string.IsNullOrWhiteSpace(result) || result.Length > maximumLength)
        {
            throw new NendoValidationException($"Request property {name} has an invalid length.");
        }
        return result;
    }

    private static bool RequiredBoolean(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : throw new NendoValidationException($"Request property {name} must be true or false.");

    private static int RequiredInt32(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result))
        {
            throw new NendoValidationException($"Request property {name} is required.");
        }
        return result;
    }
}
