using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DesktopExtensionLifetimeTests
{
    private const string Ready = "chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){chrome.webview.postMessage({version:1,session:m.session,generation:m.generation,method:'ready'});chrome.webview.postMessage({version:1,session:m.session,generation:m.generation,method:'selectRecord',recordId:'one'});}});";
    private static string Root
    {
        get
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) directory = directory.Parent;
            return directory?.FullName ?? throw new InvalidOperationException("Run from repository output.");
        }
    }
    private static string Helper => Path.Combine(Root, "artifacts", "bin", "Nendo.ExtensionHost",
#if DEBUG
        "debug");
#else
        "release");
#endif
    private static Task<DesktopExtensionRunningView> Start(DesktopSessionController session) =>
        session.StartExtensionAsync("graph", Helper, Path.Combine(Root, "artifacts", "extension-runtime"), "light", "en");

    private static async Task Prepare(DesktopTestWorkspace workspace, DesktopSessionController session, bool ready = true)
    {
        var bytes = await DesktopExtensionConsentTests.SeedAsync(workspace, DesktopExtensionDeviceTests.Archive(script: ready ? Ready : null));
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        await session.ApproveExtensionAsync((await session.PrepareExtensionConsentAsync("graph")).ReviewId);
    }

    private const string Pressure = "chrome.webview.addEventListener('message',e=>{const m=e.data;if(m.method==='initialize'){const b={version:1,session:m.session,generation:m.generation};chrome.webview.postMessage({...b,method:'ready'});chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'});setTimeout(()=>{window.pressure=[];for(let i=0;i<40;i++){const block=new Uint8Array(16*1024*1024);block.fill(7);window.pressure.push(block)}chrome.webview.postMessage({...b,method:'selectRecord',recordId:'one'});},1000);}});";

    [TestMethod]
    [TestCategory("ExtensionRuntime")]
    public async Task MemoryPressureStopsTheRunningViewAndStudioStillSavesThroughTheSameSession()
    {
        // The file-owned running view, not only the bare process: pressure must surface as a closed view with
        // its reason while the same file session keeps writing records, which is what Studio does.
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var bytes = await DesktopExtensionConsentTests.SeedAsync(workspace, DesktopExtensionDeviceTests.Archive(script: Pressure));
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        await session.ApproveExtensionAsync((await session.PrepareExtensionConsentAsync("graph")).ReviewId);
        await using var run = await Start(session);
        using var process = Process.GetProcessById(run.Renderer.ProcessId);
        Assert.AreEqual("selected", (await run.Renderer.ReceiveAsync()).Code, "The workload did not begin with a normal selection.");
        Assert.AreEqual(("nodes", "one"), await session.GetExtensionSelectionAsync(run));
        try
        {
            var survived = await run.Renderer.ReceiveAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Fail("The view completed 640 MiB of retained allocations under its 512 MiB Job: " + survived.Code);
        }
        catch (Exception error) when (error is EndOfStreamException or IOException or ObjectDisposedException) { }
        Assert.AreEqual("memory-pressure", run.Renderer.ResourceStopReason, "The running view did not record memory pressure as its stop reason.");
        Assert.IsTrue(run.IsClosed, "The running view stayed open after memory pressure.");
        Assert.IsTrue(process.WaitForExit(5000), "The helper survived memory pressure.");
        // The file session is still open; Studio writes through it, and the view being dead does not stop that.
        Assert.AreEqual("stale-file-session", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.GetExtensionSelectionAsync(run))).Code);
        var one = (await session.GetViewAsync()).Records.Single(r => r.RecordId == "one");
        var saved = await session.SetFieldAsync("nodes", "one", "label", one.RecordVersion, "Saved after memory pressure", "pressure-studio-write");
        Assert.IsFalse(saved.Mutation.IsIdempotentReplay, "The Studio write after memory pressure did not commit a new revision.");
        var after = saved.Session!.Records.Single(r => r.RecordId == "one");
        Assert.AreEqual("Saved after memory pressure", after.Values["label"].GetString(), "Studio could not write after the view stopped.");
    }

    [TestMethod]
    public async Task ClosingFileKillsRendererAndInvalidatesSelectionBeforeReopen()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session);
        await using var run = await Start(session);
        Assert.AreEqual("selected", (await run.Renderer.ReceiveAsync()).Code);
        Assert.AreEqual(("nodes", "one"), await session.GetExtensionSelectionAsync(run));
        Assert.ThrowsExactly<IOException>(() => session.ExtensionPackages.Remove(run.Grant.PackageDigest));
        using var process = Process.GetProcessById(run.Renderer.ProcessId);
        await session.CloseAsync();
        Assert.IsTrue(process.WaitForExit(2000), "Closing the file left its extension process running.");
        Assert.IsTrue(run.IsClosed);
        await session.OpenAsync(workspace.FilePath);
        Assert.AreEqual("stale-file-session", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.GetExtensionSelectionAsync(run))).Code);
    }

    [TestMethod]
    public async Task FileCanCloseDuringSilentRendererStartup()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session, ready: false);
        var starting = Start(session);
        var watch = Stopwatch.StartNew();
        await session.CloseAsync();
        Assert.IsLessThan(2000d, watch.Elapsed.TotalMilliseconds, "Renderer startup held the file gate and delayed close.");
        await Assert.ThrowsAsync<Exception>(async () => { await using var run = await starting; });
        Assert.IsLessThan(4000d, watch.Elapsed.TotalMilliseconds, "Closing the file did not cancel pending renderer startup.");
    }

    [TestMethod]
    public async Task RevocationStopsRunningViewAndPackageInstallationAloneCannotStartIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session);
        await using var run = await Start(session);
        using var process = Process.GetProcessById(run.Renderer.ProcessId);
        await session.DisableExtensionAsync("graph");
        Assert.IsTrue(process.WaitForExit(2000), "Device revocation left the controller's renderer running.");
        Assert.AreEqual("extension-not-approved", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => Start(session))).Code);
    }

    [TestMethod]
    public async Task DataChangeReplacesProjectionAndClearsOldSelection()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session);
        await using var run = await Start(session);
        Assert.AreEqual("selected", (await run.Renderer.ReceiveAsync()).Code);
        await session.SetFieldAsync("nodes", "one", "label", 1, "Changed", "extension-data-refresh");
        Assert.IsNull(await session.GetExtensionSelectionAsync(run), "A selection from an older revision remained navigable.");
        var until = Stopwatch.StartNew();
        while (run.Renderer.Session.Generation == 1 && until.Elapsed < TimeSpan.FromSeconds(4)) await Task.Delay(50);
        Assert.IsGreaterThan(1L, run.Renderer.Session.Generation, "The running graph did not receive a new projection generation.");
        Assert.IsNull(await session.GetExtensionSelectionAsync(run), "Replacing the projection retained the old selection.");
    }

    [TestMethod]
    public async Task ChangedBindingsStopAnAlreadyRunningView()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session);
        await using var run = await Start(session);
        using var process = Process.GetProcessById(run.Renderer.ProcessId);
        var proposal = await session.PrepareProposalAsync(new("proposal-" + Guid.NewGuid().ToString("N"), "swap", "test", new([
            new("test", "swap-running", "test", "Reverse running graph", [
                new("source", "ui.setProperty", JsonSerializer.SerializeToElement(new { surfaceId = "graph", nodeId = "graph", propertyName = "sourceFieldId", value = "to" })),
                new("target", "ui.setProperty", JsonSerializer.SerializeToElement(new { surfaceId = "graph", nodeId = "graph", propertyName = "targetFieldId", value = "from" })),
            ]),
        ])));
        Assert.IsTrue((await session.PromoteProposalAsync(proposal.ProposalId)).Promotion.Applied);
        Assert.IsTrue(process.WaitForExit(3000), "The old package kept running after its approved bindings changed.");
        Assert.IsFalse((await session.ReadExtensionStatusAsync("graph")).IsApproved);
    }

    [TestMethod]
    public async Task ContainedWindowComposesBelowHostToolbarWithoutChangingItsProcess()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await Prepare(workspace, session);
        await using var run = await Start(session);
        var dpi = SetThreadDpiAwarenessContext(-4);
        var parent = CreateWindowEx(0, "STATIC", "Nendo task-owned composition test", 0x10CF0000, 60, 60, 900, 700, 0, 0, 0, 0);
        try
        {
            Assert.AreNotEqual((nint)0, parent);
            DesktopExtensionComposition.Attach(run.Renderer, parent);
            DesktopExtensionComposition.Place(run.Renderer, 0, 96, 850, 560);
            Assert.AreEqual(parent, DesktopExtensionComposition.GetParent(run.Renderer.WindowHandle), "The renderer is not a child of the host window.");
            Assert.IsTrue(IsWindowVisible(run.Renderer.WindowHandle), "The composed renderer stayed invisible.");
            Assert.IsTrue(GetWindowRect(run.Renderer.WindowHandle, out var bounds));
            var origin = new Point();
            Assert.IsTrue(ClientToScreen(parent, ref origin));
            Assert.AreEqual(origin.Y + 96, bounds.Top, "The renderer covers the native toolbar.");
            Assert.AreEqual(850, bounds.Right - bounds.Left);
            Assert.AreEqual(560, bounds.Bottom - bounds.Top);
            Assert.IsTrue(GetLayeredWindowAttributes(run.Renderer.WindowHandle, out _, out var alpha, out _));
            Assert.AreEqual((byte)255, alpha, "The composed renderer is transparent.");
            using var process = Process.GetProcessById(run.Renderer.ProcessId);
            Assert.IsTrue(ExtensionNative.IsAppContainer(process.Handle), "Composition removed AppContainer containment.");
        }
        finally { if (parent != 0) DestroyWindow(parent); SetThreadDpiAwarenessContext(dpi); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { internal int X, Y; }
    [DllImport("user32.dll")] private static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateWindowEx(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(nint window, ref Point point);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern bool GetLayeredWindowAttributes(nint window, out uint key, out byte alpha, out uint flags);
}
