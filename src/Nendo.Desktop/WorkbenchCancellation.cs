using System.Collections.Concurrent;
using System.Text.Json;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Stop one request that is still running, named by its own request ID.
    /// <para>
    /// It answers only after the work has actually stopped. A cancel that returns
    /// while the worker is still running is a button that lies: the window looks
    /// free, the file is still being written, and the next action races the one
    /// that was supposedly abandoned.
    /// </para>
    /// </summary>
    internal const string RequestCancel = "request.cancel";

    /// <summary>
    /// The methods the host may run away from the UI thread.
    /// <para>
    /// It is an allowlist rather than a denylist because the cost of the two
    /// mistakes is not the same. A method missing from here runs on the UI thread
    /// and is merely slower; one wrongly added would touch a native picker or a
    /// XAML element from a worker and fail at the moment a person is using it.
    /// </para>
    /// <para>
    /// Bounded calculations are the reason this exists. They are real CPU work
    /// inside an ordinary read, and <c>async</c> alone does not move CPU work: an
    /// awaited call started on the UI thread finishes its arithmetic there.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlySet<string> OffUiThread = new HashSet<string>(StringComparer.Ordinal)
    {
        RequestCancel,
        SessionGetSnapshot,
        SessionGetRecentFiles,
        DataCreateRecord,
        DataDeleteRecord,
        DataSetKeptInNewFiles,
        DataSetField,
        DataSetFields,
        DataMoveRecord,
        DataExecuteCommand,
        DataGetReceipt,
        DataQueryRecords,
        DataQueryRecordWindow,
        DataCountRecords,
        DataAggregateRecords,
        DataGroupAggregateRecords,
        DataBucketAggregateRecords,
        DataCellAggregateRecords,
        DataTreeRecords,
        // A batch write with its calculations and automatic actions, its undo, a search, a
        // rebuild of the search index and a fold of history (a backup and a VACUUM) are the
        // heaviest work the Workbench asks for. On the UI thread each froze the window for as
        // long as it ran.
        DataWriteRecords,
        DataUndoRecordWrites,
        DataSearchRecords,
        DataBuildSearchIndex,
        HistoryFoldPreview,
        HistoryFold,
        AgentGetStatus,
        AgentSetMode,
        AgentRevokeEditing,
        AgentGetProposal,
        AgentSetSettings,
        ExtensionStateRead,
        ExtensionStateSet,
        CompensationGetReceipt,
        ProposalGetReceipt,
        ProposalPrepareChangeSet,
        ProposalGet,
        ProposalReadPackageFile,
        HelpReadPages,
        ProposalPromote,
        ProposalReject,
        SemanticCompile,
        HistoryGet,
        HistoryQuery,
        HistoryOperations,
        HistoryCompensate,
        HealthVerify,
        BehaviourApprove,
        BehaviourRevoke,
        ExtensionSettingsSet,
        ExtensionRemove,
        AgentSessionList,
        AgentSessionSetCommand,
        AgentSessionSetHidden,
        AgentSessionLaunch,
        AgentSessionRead,
        AgentSessionPrompt,
        AgentSessionAnswer,
        AgentSessionCancel,
        AgentSessionAuthenticate,
        AgentSessionEnd,
        AgentSessionSetOption,
        AgentSessionSetViewAccess,
        AgentSessionTurn,
        // Pictures (ADR-0031): a copy of a link, a view's reads and puts, and showing a file in
        // its folder touch no window.
        MediaEmbedCopy,
        MediaReveal,
        MediaDescribe,
        MediaReadWindow,
        MediaStage,
        MediaCommit,
        MediaUsage,
        MediaRemoveUnused,
        // The file's own icon: the page sends the drawn PNG, so no picker is involved.
        LookEmbedIcon,
        // A view's runtime event: kept in memory, and no window is involved.
        ExtensionEventsReport,
    };

    /// <summary>
    /// The methods that stay on the UI thread, each for a reason: a native picker or dialog (the
    /// file actions, a package's import, export and development folder), the window or its
    /// browser (appearance, the title bar, a download, the diagnostics), or a development link
    /// whose watcher belongs with the window. Every method is in exactly one of the two sets, and
    /// a test holds that, so a new method is placed by somebody deciding where it runs rather
    /// than landing on the UI thread by default.
    /// </summary>
    internal static readonly IReadOnlySet<string> OnUiThread = new HashSet<string>(StringComparer.Ordinal)
    {
        // A tab window: opening a window, reading the page's own window, closing one.
        WindowDetachTab,
        WindowTakeTab,
        DiagnosticsCloseWindow,
        DiagnosticsExit,
        SessionCreateFile,
        SessionOpenFile,
        // A picture picked, pasted or dropped, a file linked, or a copy saved: a picker or the clipboard.
        MediaEmbed,
        MediaLink,
        MediaSaveCopy,
        FileOpenRecent,
        FileOpenDropped,
        FileClose,
        FileBackup,
        FileDuplicate,
        FileFork,
        FileNewFile,
        FileRestore,
        FileUpgrade,
        FileInspect,
        FileDiagnostics,
        FileExport,
        FileResolveRecovery,
        "file.importCsv",
        "file.exportCsv",
        "file.embedLinkedPictures",
        AppearanceSet,
        AppearanceGet,
        WindowSetTitleBarControls,
        DiagnosticsTitleBar,
        DiagnosticsResizeWindow,
        DiagnosticsFrameProcesses,
        DownloadsShow,
        ExtensionImport,
        ExtensionExport,
        ExtensionDevelopLink,
        ExtensionDevelopStop,
        ExtensionDevelopSave,
    };
}

internal sealed partial class WorkbenchProtocolHandler
{
    /// <summary>
    /// Whether this message may be handled away from the UI thread.
    /// <para>
    /// A routing peek, not the authoritative parse: <see cref="HandleAsync"/> still
    /// validates the whole envelope. Anything unreadable answers false and stays on
    /// the UI thread, where the real parse produces the real refusal.
    /// </para>
    /// </summary>
    internal static bool RunsOffUiThread(string messageJson)
    {
        try
        {
            using var document = JsonDocument.Parse(messageJson, new JsonDocumentOptions { MaxDepth = 16 });
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("method", out var method) &&
                method.ValueKind == JsonValueKind.String &&
                WorkbenchMethods.OffUiThread.Contains(method.GetString()!);
        }
        catch (JsonException) { return false; }
    }

    /// <summary>How long a cancel waits for the worker before reporting that it did not stop.</summary>
    private static readonly TimeSpan JoinTimeout = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, InFlightRequest> _inFlight = new(StringComparer.Ordinal);

    private sealed record InFlightRequest(CancellationTokenSource Cancellation, TaskCompletionSource Finished);

    /// <summary>What a cancel did, so the caller never has to infer it from silence.</summary>
    internal sealed record CancelledRequestView(bool Found, bool Stopped);

    private IDisposable TrackRequest(string requestId, CancellationTokenSource cancellation)
    {
        var entry = new InFlightRequest(cancellation, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
        return _inFlight.TryAdd(requestId, entry) ? new RequestScope(this, requestId, entry) : NullScope.Instance;
    }

    private sealed class RequestScope(WorkbenchProtocolHandler owner, string requestId, InFlightRequest entry) : IDisposable
    {
        public void Dispose()
        {
            owner._inFlight.TryRemove(requestId, out _);
            // Completed last, so anyone waiting on the join cannot observe a
            // request that has left the registry but is still unwinding.
            entry.Finished.TrySetResult();
        }
    }

    private sealed class NullScope : IDisposable
    {
        internal static readonly NullScope Instance = new();
        public void Dispose() { }
    }

    /// <summary>
    /// Cancel one in-flight request and wait for it to stop.
    /// <para>
    /// An unknown request ID is not an error: the work may simply have finished
    /// between asking for the stop and the message arriving. The answer says
    /// which of the two happened rather than reporting a failure for a race the
    /// caller cannot avoid.
    /// </para>
    /// </summary>
    private async Task<CancelledRequestView> CancelRequestAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var target = RequiredString(payload, "requestId", 120);
        if (!_inFlight.TryGetValue(target, out var request)) return new CancelledRequestView(false, true);
        await request.Cancellation.CancelAsync();
        try
        {
            await request.Finished.Task.WaitAsync(JoinTimeout, cancellationToken);
            return new CancelledRequestView(true, true);
        }
        catch (TimeoutException)
        {
            // The worker ignored its token. Say so rather than reporting a stop
            // that did not happen; the caller must not start the next action yet.
            return new CancelledRequestView(true, false);
        }
    }
}
