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
        DataSetField,
        DataSetFields,
        DataExecuteCommand,
        DataGetReceipt,
        DataQueryRecords,
        DataCountRecords,
        DataAggregateRecords,
        DataGroupAggregateRecords,
        DataBucketAggregateRecords,
        DataCellAggregateRecords,
        CompensationGetReceipt,
        ProposalGetReceipt,
        ProposalPrepareChangeSet,
        ProposalGet,
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
