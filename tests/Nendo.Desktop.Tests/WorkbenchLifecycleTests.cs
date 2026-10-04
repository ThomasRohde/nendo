using System.Security.Cryptography;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchLifecycleTests
{
    [TestMethod]
    public async Task TheBridgeRequiresTheRenderedSessionAndRejectsItAfterCloseReopen()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var original = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("record", "Original", "record");
        var handler = Handler(session);
        var payload = new { entityId = NendoApplicationService.IdeaEntityId, recordId = "record",
            fieldId = NendoApplicationService.IdeaTitleFieldId, expectedRecordVersion = 1, value = "Changed", idempotencyKey = "edit" };
        var missing = await handler.HandleAsync(Request(WorkbenchMethods.DataSetField, null, payload));
        Assert.AreEqual("validation", missing.Error!.Code);
        var edited = await handler.HandleAsync(Request(WorkbenchMethods.DataSetField, original.FileSessionId, payload));
        Assert.IsTrue(edited.Ok, edited.Error?.Message);
        await session.CloseAsync();
        var reopened = await session.OpenAsync(workspace.FilePath);
        var bytes = await HashAsync(workspace.FilePath);
        Assert.AreNotEqual(original.FileSessionId, reopened.FileSessionId);
        foreach (var method in new[] { WorkbenchMethods.DataSetField, WorkbenchMethods.HistoryGet,
            WorkbenchMethods.AgentSetMode, WorkbenchMethods.FileClose, WorkbenchMethods.FileBackup })
        {
            var stale = await handler.HandleAsync(Request(method, original.FileSessionId, payload));
            Assert.AreEqual("stale-file-session", stale.Error!.Code, method);
        }
        CollectionAssert.AreEqual(bytes, await HashAsync(workspace.FilePath));
        Assert.AreEqual(reopened.FileSessionId, ((DesktopSessionView)(await handler.HandleAsync(
            Request(WorkbenchMethods.SessionGetSnapshot))).Result!).FileSessionId);
    }

    [TestMethod]
    public async Task AwaitedConfirmationCannotCloseAFileOpenedWhileItWasWaiting()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var original = await session.CreateAsync(workspace.FilePath);
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var confirmed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = Handler(session, async request =>
        {
            Assert.AreEqual(WorkbenchFileAction.Close, request.Action);
            waiting.SetResult();
            await confirmed.Task;
            await session.CloseAsync();
            return new(await session.GetViewAsync(), null);
        });
        var pending = handler.HandleAsync(Request(WorkbenchMethods.FileClose, original.FileSessionId));
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await session.CloseAsync();
        var reopened = await session.OpenAsync(workspace.FilePath);
        confirmed.SetResult();
        var denied = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.AreEqual("stale-file-session", denied.Error!.Code);
        Assert.AreEqual(reopened.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        Assert.IsTrue(session.HasFile);
    }

    [TestMethod]
    public async Task EmptySessionAlsoRotatesAndOnlyTheAdmittedLifecycleRequestFollowsItsChanges()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var empty = await session.GetViewAsync();
        using (var scope = session.BindFileRequest(empty.FileSessionId!))
        {
            var created = await session.CreateAsync(workspace.FilePath);
            Assert.AreEqual(created.FileSessionId, scope.FileSessionId);
            await session.CloseAsync();
            Assert.AreEqual((await session.GetViewAsync()).FileSessionId, scope.FileSessionId);
        }
        using (session.BindFileRequest(empty.FileSessionId!))
        {
            var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.GetViewAsync());
            Assert.AreEqual("stale-file-session", stale.Code);
        }
        Assert.IsFalse((await session.GetViewAsync()).HasFile);
    }

    [TestMethod]
    public async Task AnOlderRendererReachesNoFileLifecycleAtAll()
    {
        // Before W-135 a renderer at 2 to 4 was pinned to the first file it saw and kept its
        // reads, and only the lifecycle methods were fenced off. Now it reaches nothing.
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var opened = await session.CreateAsync(workspace.FilePath);
        var actions = 0;
        var handler = Handler(session, _ =>
        {
            actions++;
            return Task.FromResult(new DesktopFileActionView(null, null));
        });
        foreach (var version in new[] { 2, 3, 4, 5, 6 })
        {
            foreach (var method in new[] { WorkbenchMethods.SessionGetSnapshot, WorkbenchMethods.HistoryGet,
                WorkbenchMethods.FileBackup, WorkbenchMethods.FileRestore, WorkbenchMethods.FileDuplicate, WorkbenchMethods.FileFork,
                WorkbenchMethods.FileUpgrade, WorkbenchMethods.FileClose, WorkbenchMethods.FileOpenRecent, WorkbenchMethods.FileExport,
                WorkbenchMethods.FileResolveRecovery, WorkbenchMethods.SessionGetRecentFiles })
            {
                var denied = await handler.HandleAsync(Request(method, opened.FileSessionId, version: version));
                Assert.AreEqual("unsupported-protocol", denied.Error?.Code, $"{method} answered a version {version} renderer.");
            }
        }
        Assert.AreEqual(0, actions, "An older renderer started a file action.");
        Assert.AreEqual(opened.FileSessionId, (await session.GetViewAsync()).FileSessionId);
    }

    [TestMethod]
    public async Task ClosedFileActionsUseHostDestinationsAndReturnNoPathsOrPhysicalObservations()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var original = await session.CreateAsync(workspace.FilePath);
        var directory = Path.GetDirectoryName(workspace.FilePath)!;
        var backupPath = Path.Combine(directory, "backup.nendo");
        var sourceHash = await HashAsync(workspace.FilePath);
        var handler = Handler(session, async request =>
        {
            if (request.Action == WorkbenchFileAction.Backup)
            {
                var plan = await session.PrepareBackupAsync(backupPath, "bridge-backup");
                await session.CreateBackupAsync(plan.PlanId);
            }
            else if (request.Action == WorkbenchFileAction.Restore)
            {
                var plan = await session.PrepareRestoreAsync(backupPath, "bridge-restore");
                await session.RestoreAsync(plan.PlanId, true);
            }
            else
            {
                var kind = request.Action == WorkbenchFileAction.Duplicate ? NendoIdentityCopyKind.Duplicate : NendoIdentityCopyKind.Fork;
                var plan = await session.PrepareIdentityCopyAsync(kind, Path.Combine(directory, $"{kind}.nendo"), $"bridge-{kind}");
                await session.CreateIdentityCopyAsync(plan.PlanId);
            }
            return new(await session.GetViewAsync(), "Completed");
        });
        foreach (var method in new[] { WorkbenchMethods.FileBackup, WorkbenchMethods.FileDuplicate, WorkbenchMethods.FileFork })
        {
            // Renderer-supplied destinations have no authority; only the native
            // callback can supply paths to typed application services.
            var response = await handler.HandleAsync(Request(method, original.FileSessionId, new { path = "forbidden.nendo" }));
            Assert.IsTrue(response.Ok, response.Error?.Message);
            Assert.DoesNotContain(directory.Replace("\\", "\\\\"), WorkbenchProtocolHandler.Serialize(response));
        }
        CollectionAssert.AreEqual(sourceHash, await HashAsync(workspace.FilePath));
        var restored = await handler.HandleAsync(Request(WorkbenchMethods.FileRestore, original.FileSessionId));
        Assert.IsTrue(restored.Ok, restored.Error?.Message);
        var view = (DesktopFileActionView)restored.Result!;
        Assert.IsNotNull(view.Session);
        Assert.AreNotEqual(original.FileSessionId, view.Session.FileSessionId);
        Assert.DoesNotContain("physicalFileKey", WorkbenchProtocolHandler.Serialize(restored));
        Assert.DoesNotContain("contentDigest", WorkbenchProtocolHandler.Serialize(restored));
        Assert.DoesNotContain("openObservation", WorkbenchProtocolHandler.Serialize(restored));
        var recent = await handler.HandleAsync(Request(WorkbenchMethods.SessionGetRecentFiles));
        Assert.IsTrue(recent.Ok);
        Assert.DoesNotContain(directory.Replace("\\", "\\\\"), WorkbenchProtocolHandler.Serialize(recent));
    }

    private static WorkbenchProtocolHandler Handler(DesktopSessionController session,
        Func<WorkbenchFileActionRequest, Task<DesktopFileActionView>>? actions = null) =>
        new(session, _ => { }, actions);

    private static async Task<byte[]> HashAsync(string path)
    {
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return await SHA256.HashDataAsync(input);
    }

    private static string Request(string method, string? fileSessionId = null, object? payload = null,
        int version = DesktopShellContract.BridgeProtocolVersion) =>
        JsonSerializer.Serialize(new { protocolVersion = version, requestId = Guid.NewGuid().ToString("N"), method, fileSessionId, payload = payload ?? new { } });
}
