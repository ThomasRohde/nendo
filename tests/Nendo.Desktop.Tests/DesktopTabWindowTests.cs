using System.Text.Json;
using Nendo.Engine;
using Windows.Graphics;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-277 (ADR-0002, 2026-10-16). A tab dragged out of the strip opens in a window of its own, on
/// the same file session. This class holds the bridge's half and the arithmetic of where the new
/// window lands; the journey measures the second window in a real host.
/// </summary>
[TestClass]
public sealed class DesktopTabWindowTests
{
    [TestMethod]
    public async Task ATabsTrailReachesTheWindowAsItWasSentAndOnlyWhileTheFileIsOpen()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var fileSession = (await session.GetViewAsync()).FileSessionId!;
        var window = new RecordingTabWindow(isTabWindow: false);
        var handler = new WorkbenchProtocolHandler(session, _ => { }) { TabWindowHost = window };

        // The host never reads a trail: it is handed on exactly, deep or not.
        var trail = JsonSerializer.Serialize(new { places = new[] { new { view = "use", drill = new { a = new { b = new { c = new { d = new[] { 1 } } } } } } }, cursor = 0 });
        var moved = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, new { trail, atPointer = true }, fileSession));
        Assert.IsTrue(moved.Ok, moved.Error?.Message);
        Assert.AreEqual((trail, true), window.Detached.Single());

        var beside = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, new { trail }, fileSession));
        Assert.IsTrue(beside.Ok, beside.Error?.Message);
        Assert.IsFalse(window.Detached[1].AtPointer, "A move without a drop point opens beside the window.");

        // A trail is for the file the page drew, like any request about it.
        var stale = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, new { trail }, "file-session-another"));
        Assert.IsFalse(stale.Ok, "A tab of another file session opened a window.");
        Assert.HasCount(2, window.Detached);

        foreach (var bad in new object[] { new { }, new { trail = 3 }, new { trail = "" }, new { trail = new string('x', DesktopTabWindowRules.MaximumTrailCharacters + 1) } })
        {
            var refused = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, bad, fileSession));
            Assert.AreEqual("validation", refused.Error?.Code, JsonSerializer.Serialize(bad).Length.ToString());
        }
        Assert.HasCount(2, window.Detached, "A refused trail opened a window.");
    }

    [TestMethod]
    public async Task AWindowLearnsItsRoleAndATabWindowItsTrailOnceWithoutAFileSession()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var tab = new RecordingTabWindow(isTabWindow: true) { Trail = """{"places":[{"view":"use"}],"cursor":0}""" };
        var handler = new WorkbenchProtocolHandler(session, _ => { }) { TabWindowHost = tab };

        // Asked before the page has a file session of its own, so it is not bound to one.
        var first = await handler.HandleAsync(Request(WorkbenchMethods.WindowTakeTab, new { }, null));
        Assert.IsTrue(first.Ok, first.Error?.Message);
        Assert.AreEqual(new TabWindowStart("tab", """{"places":[{"view":"use"}],"cursor":0}"""), first.Result);
        Assert.AreEqual(new TabWindowStart("tab", null), (await handler.HandleAsync(Request(WorkbenchMethods.WindowTakeTab, new { }, null))).Result,
            "A reloaded page took its tab's trail a second time.");

        var main = new WorkbenchProtocolHandler(session, _ => { }) { TabWindowHost = new RecordingTabWindow(isTabWindow: false) };
        Assert.AreEqual(new TabWindowStart("main", null), (await main.HandleAsync(Request(WorkbenchMethods.WindowTakeTab, new { }, null))).Result);
        Assert.AreEqual("window-unavailable", (await new WorkbenchProtocolHandler(session, _ => { }).HandleAsync(Request(WorkbenchMethods.WindowTakeTab, new { }, null))).Error?.Code);
    }

    [TestMethod]
    public async Task ATabWindowRefusesTheFileActionsThatSwitchTheFileAndRunsTheRest()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var fileSession = (await session.GetViewAsync()).FileSessionId!;
        var asked = new List<WorkbenchFileAction>();
        Task<DesktopFileActionView> Run(WorkbenchFileActionRequest request)
        {
            asked.Add(request.Action);
            return Task.FromResult(new DesktopFileActionView(null, "ran"));
        }
        var tab = new WorkbenchProtocolHandler(session, _ => { }, Run) { TabWindowHost = new RecordingTabWindow(isTabWindow: true) };
        var main = new WorkbenchProtocolHandler(session, _ => { }, Run) { TabWindowHost = new RecordingTabWindow(isTabWindow: false) };

        foreach (var method in DesktopTabWindowRules.MainWindowOnly)
        {
            var refused = await tab.HandleAsync(Request(method, new { recentId = "recent-1" }, fileSession));
            Assert.AreEqual("main-window-only", refused.Error?.Code, method);
        }
        Assert.IsEmpty(asked, "A tab window ran a file action that switches the file: " + string.Join(", ", asked));

        // A copy, an export or a check leaves the file where it is, so a tab window runs it.
        Assert.IsTrue((await tab.HandleAsync(Request(WorkbenchMethods.FileBackup, new { }, fileSession))).Ok);
        Assert.AreEqual(WorkbenchFileAction.Backup, asked.Single());
        // And the main window still opens and closes files.
        Assert.IsTrue((await main.HandleAsync(Request(WorkbenchMethods.FileClose, new { }, fileSession))).Ok);
        Assert.AreEqual(WorkbenchFileAction.Close, asked[1]);
    }

    [TestMethod]
    public void ATabLetGoAtThePointerOpensUnderItAtTheSizeItShowedAndStaysOnTheScreen()
    {
        var area = new RectInt32(0, 0, 1920, 1040);
        // 1200 × 800 physical at 100%, let go at (500, 200): the pointer lands over the new window's tab.
        Assert.AreEqual(new RectInt32(500 - DesktopTabWindowRules.GrabX, 200 - DesktopTabWindowRules.GrabY, 1200, 800),
            DesktopTabWindowRules.AtPointer(new SizeInt32(1200, 800), 1.0, new PointInt32(500, 200), area, 1.0));

        // From a 150% laptop to a 100% monitor on its right: 2400 × 1440 physical there is 1600 × 960 here.
        var monitor = new RectInt32(2880, 0, 2560, 1400);
        var placed = DesktopTabWindowRules.AtPointer(new SizeInt32(2400, 1440), 1.5, new PointInt32(3500, 400), monitor, 1.0);
        Assert.AreEqual((1600, 960), (placed.Width, placed.Height), "A window moved across screens kept the other screen's physical size.");
        Assert.AreEqual((3500 - DesktopTabWindowRules.GrabX, 400 - DesktopTabWindowRules.GrabY), (placed.X, placed.Y));

        // Let go near the screen's corner, the window is kept whole on it.
        var corner = DesktopTabWindowRules.AtPointer(new SizeInt32(1600, 960), 1.0, new PointInt32(1910, 1030), area, 1.0);
        Assert.AreEqual(new RectInt32(320, 80, 1600, 960), corner);
        // At 200% the grab is twice as far in physical pixels.
        var doubled = DesktopTabWindowRules.AtPointer(new SizeInt32(2048, 1440), 2.0, new PointInt32(1000, 500), new RectInt32(0, 0, 3840, 2100), 2.0);
        Assert.AreEqual((1000 - 2 * DesktopTabWindowRules.GrabX, 500 - 2 * DesktopTabWindowRules.GrabY), (doubled.X, doubled.Y));
    }

    [TestMethod]
    public void ATabMovedByTheCommandOpensOneStepFromItsWindow()
    {
        var area = new RectInt32(0, 0, 1920, 1040);
        Assert.AreEqual(new RectInt32(132, 82, 1600, 900), DesktopTabWindowRules.Cascaded(new RectInt32(100, 50, 1600, 900), area, 1.0));
        // At 200% the step is twice as far in physical pixels.
        Assert.AreEqual(new RectInt32(164, 114, 2400, 1500), DesktopTabWindowRules.Cascaded(new RectInt32(100, 50, 2400, 1500), new RectInt32(0, 0, 3840, 2100), 2.0));
        // A window filling the screen gives one that fills it too, rather than one hanging off its edge.
        Assert.AreEqual(area, DesktopTabWindowRules.Cascaded(area, area, 1.0));
    }

    private static string Request(string method, object payload, string? fileSessionId) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion, requestId = Guid.NewGuid().ToString("N"), method, fileSessionId, payload,
    });

    private sealed class RecordingTabWindow(bool isTabWindow) : IWorkbenchTabWindowHost
    {
        public List<(string Trail, bool AtPointer)> Detached { get; } = [];

        public string? Trail { get; set; }

        public bool IsTabWindow => isTabWindow;

        public void DetachTab(string trail, bool atPointer) => Detached.Add((trail, atPointer));

        public void CloseWindow() { }

        public TabWindowStart TakeTab()
        {
            var trail = Trail;
            Trail = null;
            return new(isTabWindow ? "tab" : "main", trail);
        }
    }
}
