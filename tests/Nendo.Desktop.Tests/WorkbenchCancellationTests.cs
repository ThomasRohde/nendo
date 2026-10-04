using System.Text.Json;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Stage S7 of ADR-0008: work off the UI thread, and a stop that actually stops.
/// <para>
/// A bounded calculation is real arithmetic inside an ordinary read. Awaiting it
/// does not move it: a call started on the UI thread finishes its arithmetic there
/// and the window stops responding for as long as it takes. And a cancel that
/// returns while the worker is still running is worse than none — it reports an idle
/// file that is still being written.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class WorkbenchCancellationTests
{
    [TestMethod]
    public void EveryMethodThatCanTouchNativeUiStaysOnTheUiThread()
    {
        // The reads and writes that carry calculations are the point of the list.
        foreach (var method in new[]
                 {
                     WorkbenchMethods.SessionGetSnapshot, WorkbenchMethods.DataQueryRecords,
                     WorkbenchMethods.DataSetField, WorkbenchMethods.DataSetFields,
                     WorkbenchMethods.DataMoveRecord, WorkbenchMethods.SemanticCompile, WorkbenchMethods.ProposalPromote,
                     WorkbenchMethods.RequestCancel,
                 })
        {
            Assert.IsTrue(WorkbenchProtocolHandler.RunsOffUiThread(Message(method)), method);
        }

        // A native picker, a file action and the appearance bridge each reach XAML,
        // which belongs to the one thread that owns the window.
        foreach (var method in new[]
                 {
                     WorkbenchMethods.SessionCreateFile, WorkbenchMethods.SessionOpenFile,
                     WorkbenchMethods.FileBackup, WorkbenchMethods.FileRestore,
                     WorkbenchMethods.FileDiagnostics, WorkbenchMethods.AppearanceSet,
                     "file.importCsv", "file.exportCsv",
                 })
        {
            Assert.IsFalse(WorkbenchProtocolHandler.RunsOffUiThread(Message(method)), method);
        }

        // Anything unreadable stays where the real parse produces the real refusal.
        Assert.IsFalse(WorkbenchProtocolHandler.RunsOffUiThread("{"));
        Assert.IsFalse(WorkbenchProtocolHandler.RunsOffUiThread("[]"));
        Assert.IsFalse(WorkbenchProtocolHandler.RunsOffUiThread("{\"method\":7}"));
        Assert.IsFalse(WorkbenchProtocolHandler.RunsOffUiThread("{\"method\":\"nendo.invent\"}"));
    }

    [TestMethod]
    public async Task StoppingSomethingThatHasAlreadyFinishedIsNotAnError()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        var handler = Handler(session, new HeldPackagePicker());

        var answer = await handler.HandleAsync(Request("stop", WorkbenchMethods.RequestCancel,
            new { requestId = "a-request-that-already-returned" }));

        Assert.IsTrue(answer.Ok, "A stop that arrives a moment too late is a race nobody can avoid, not a failure.");
        var view = (WorkbenchProtocolHandler.CancelledRequestView)answer.Result!;
        Assert.IsFalse(view.Found);
        Assert.IsTrue(view.Stopped);
    }

    [TestMethod]
    public async Task AStopAnswersOnlyAfterTheWorkHasActuallyStopped()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        var opened = await session.CreateAsync(workspace.FilePath);
        // A native picker is the one wait this host can hold open on demand, so it
        // stands in for a long calculation: the request is genuinely in flight, and
        // the test decides when it finishes. Import's picker is the one that reads its
        // package under the request's own token once the person has chosen.
        var picker = new HeldPackagePicker();
        var handler = Handler(session, picker);

        var work = Task.Run(() => handler.HandleAsync(Request("slow-import", WorkbenchMethods.ExtensionImport,
            fileSessionId: opened.FileSessionId)));
        await picker.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(20));

        var stop = Task.Run(() => handler.HandleAsync(Request("stop", WorkbenchMethods.RequestCancel,
            new { requestId = "slow-import" })));
        await Task.Delay(200);
        Assert.IsFalse(stop.IsCompleted,
            "The stop answered while the work was still running, which reports an idle file that is still being written.");

        // A package that does not exist: read, it would fail as a missing file, not as a stop.
        picker.Chosen.TrySetResult(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "never-read.nendoview"));
        var answer = await stop.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.IsTrue(answer.Ok);
        var view = (WorkbenchProtocolHandler.CancelledRequestView)answer.Result!;
        Assert.IsTrue(view.Found);
        Assert.IsTrue(view.Stopped, "The worker did not stop within the join window.");

        // The cancellation reached the work itself, not only the message loop that
        // started it: the chosen package was never read.
        var outcome = await work.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.IsFalse(outcome.Ok);
        Assert.AreEqual("cancelled", outcome.Error!.Code, outcome.Error.Message);
    }

    [TestMethod]
    public async Task TwoRequestsAreStoppedIndependentlyByName()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        var opened = await session.CreateAsync(workspace.FilePath);
        var picker = new HeldPackagePicker();
        var handler = Handler(session, picker);

        var work = Task.Run(() => handler.HandleAsync(Request("slow-import", WorkbenchMethods.ExtensionImport,
            fileSessionId: opened.FileSessionId)));
        await picker.Waiting.Task.WaitAsync(TimeSpan.FromSeconds(20));

        // Naming another request must not touch this one.
        var other = await handler.HandleAsync(Request("stop-other", WorkbenchMethods.RequestCancel,
            new { requestId = "some-other-request" }));
        Assert.IsFalse(((WorkbenchProtocolHandler.CancelledRequestView)other.Result!).Found);
        Assert.IsFalse(work.IsCompleted, "Stopping one request stopped a different one.");

        picker.Chosen.TrySetResult(null);
        var outcome = await work.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.IsTrue(outcome.Ok, "A request nobody stopped must finish normally.");
    }

    private static DesktopSessionController Session(DesktopTestWorkspace workspace) =>
        new(new NendoLocalMcpHostOptions(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "cancel-discovery")),
            workspace.FileHistoryRoot);

    private static WorkbenchProtocolHandler Handler(DesktopSessionController session, IWorkbenchExtensionHost extensionHost) =>
        new(session, _ => { }, extensionHost: extensionHost);

    private static string Message(string method) =>
        JsonSerializer.Serialize(new { protocolVersion = DesktopShellContract.BridgeProtocolVersion, requestId = "peek", method });

    private static string Request(string requestId, string method, object? payload = null, string? fileSessionId = null) =>
        JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId,
            method,
            fileSessionId,
            payload = payload ?? new { },
        });

    /// <summary>A package picker that waits until the test says what the person chose.</summary>
    private sealed class HeldPackagePicker : IWorkbenchExtensionHost
    {
        internal TaskCompletionSource Waiting { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource<string?> Chosen { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<string?> PickPackageSourceAsync()
        {
            Waiting.TrySetResult();
            return Chosen.Task;
        }

        public Task<string?> PickExportFolderAsync() => Task.FromResult<string?>(null);
        public Task<string?> PickDevelopmentFolderAsync() => Task.FromResult<string?>(null);
        public Task<IReadOnlyList<ExtensionFrameProcess>> ReadFrameProcessesAsync() => Task.FromResult<IReadOnlyList<ExtensionFrameProcess>>([]);
    }
}
