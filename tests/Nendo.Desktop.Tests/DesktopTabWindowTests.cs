using System.Text.Json;
using Nendo.Engine;
using Windows.Graphics;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A tab dragged out of the strip opens in a window of its own (ADR-0002), on
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
    public void AWindowThatFillsTheScreenHandsOnTheSizeItHadBefore()
    {
        // From a maximised window the new one does not cover the whole screen in turn.
        var area = new RectInt32(0, 0, 2560, 1392);
        var screen = new SizeInt32(2582, 1414);
        Assert.AreEqual(new SizeInt32(1600, 960), DesktopTabWindowRules.SizeToCarry(new SizeInt32(1600, 960), false, null, area));
        Assert.AreEqual(new SizeInt32(1600, 960), DesktopTabWindowRules.SizeToCarry(screen, true, new SizeInt32(1600, 960), area),
            "A maximised window handed on the screen's size rather than the size it was restored from.");
        // No smaller size known: three quarters of the screen, never all of it.
        Assert.AreEqual(new SizeInt32(1920, 1044), DesktopTabWindowRules.SizeToCarry(screen, true, null, area));
        Assert.AreEqual(new SizeInt32(1920, 1044), DesktopTabWindowRules.SizeToCarry(screen, true, new SizeInt32(2560, 1392), area));
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

    [TestMethod]
    public async Task AWindowsOnlyTabMovesOnlyWhereItIsLetGoAndTheOutcomeReachesThePage()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var fileSession = (await session.GetViewAsync()).FileSessionId!;
        var window = new RecordingTabWindow(isTabWindow: true);
        var handler = new WorkbenchProtocolHandler(session, _ => { }) { TabWindowHost = window };
        const string trail = """{"places":[{"view":"use"}],"cursor":0}""";

        var moved = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, new { trail, atPointer = true, last = true }, fileSession));
        Assert.IsTrue(moved.Ok, moved.Error?.Message);
        Assert.AreEqual(TabMoveOutcome.Moved, JsonSerializer.SerializeToElement(moved.Result).GetProperty("outcome").GetString(),
            "The page was not told what became of its only tab.");
        Assert.IsTrue(window.Last.Single(), "A window's only tab reached the host as one of several.");

        // An only tab has nowhere to go but where it was let go: the command never moves it.
        var beside = await handler.HandleAsync(Request(WorkbenchMethods.WindowDetachTab, new { trail, last = true }, fileSession));
        Assert.AreEqual("validation", beside.Error?.Code);
        Assert.HasCount(1, window.Detached);
    }

    [TestMethod]
    public async Task ADraggedTabsPictureIsAskedForWithinItsViewportAndTheDropIsKeptOnlyWhenLetGo()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var window = new RecordingTabWindow(isTabWindow: false);
        var handler = new WorkbenchProtocolHandler(session, _ => { }) { TabWindowHost = window };
        object Picture(double x = 120, double width = 236, double viewport = 1600, object? background = null) => new
        {
            box = new { x, y = 10, width, height = 38 }, grab = new { x = 40, y = 18 }, viewport = new { width = viewport, height = 900 },
            background = background ?? new[] { 255, 255, 255 }, border = new[] { 224, 224, 224 }, radius = 8,
        };

        // Asked before the page has a file session, as the drag ends whatever the file does meanwhile.
        var shown = await handler.HandleAsync(Request(WorkbenchMethods.WindowBeginTabDrag, Picture(), null));
        Assert.IsTrue(shown.Ok, shown.Error?.Message);
        Assert.AreEqual(new TabDragPicture(120, 10, 236, 38, 40, 18, 1600, 900, new(255, 255, 255), new(224, 224, 224), 8), window.Pictures.Single());

        foreach (var bad in new[] { Picture(width: 0), Picture(width: 2000), Picture(viewport: 0), Picture(background: new[] { 1, 2 }), (object)new { box = 3 } })
        {
            var refused = await handler.HandleAsync(Request(WorkbenchMethods.WindowBeginTabDrag, bad, null));
            Assert.AreEqual("validation", refused.Error?.Code, JsonSerializer.Serialize(bad));
        }
        Assert.HasCount(1, window.Pictures, "A picture was asked for a box outside its page.");

        Assert.IsTrue((await handler.HandleAsync(Request(WorkbenchMethods.WindowEndTabDrag, new { dropped = true }, null))).Ok);
        Assert.IsTrue((await handler.HandleAsync(Request(WorkbenchMethods.WindowEndTabDrag, new { }, null))).Ok);
        CollectionAssert.AreEqual(new[] { true, false }, window.Ended, "A tab brought back to the strip kept a drop point, or one let go did not.");
    }

    [TestMethod]
    public void ADraggedTabsPictureIsAWholeTabWithRoundedCornersOverWhatThePageDrew()
    {
        const int width = 20, height = 10;
        var tab = new byte[width * height * 4];
        // One opaque pixel of the tab's text, and one half-covered, premultiplied as the capture gives it.
        void Put(int x, int y, byte b, byte g, byte r, byte a) { var at = (y * width + x) * 4; tab[at] = b; tab[at + 1] = g; tab[at + 2] = r; tab[at + 3] = a; }
        Put(10, 5, 10, 20, 30, 255);
        Put(12, 5, 0, 0, 100, 128);
        var picture = DesktopTabWindowRules.ComposePicture(tab, width, height, new TabColour(200, 210, 220), new TabColour(1, 2, 3), 4);
        byte[] At(int x, int y) => picture.AsSpan((y * width + x) * 4, 4).ToArray();

        CollectionAssert.AreEqual(new byte[] { 0, 0, 0, 0 }, At(0, 0), "The corner was drawn square.");
        CollectionAssert.AreEqual(new byte[] { 220, 210, 200, 255 }, At(6, 5), "Where the page drew nothing, the picture is not a tab's background.");
        CollectionAssert.AreEqual(new byte[] { 3, 2, 1, 255 }, At(10, 0), "The tab has no border.");
        CollectionAssert.AreEqual(new byte[] { 10, 20, 30, 255 }, At(10, 5), "The tab's own pixel was changed.");
        // Half the page's red over the background: 100 + 200 × 127 / 255 = 199.
        CollectionAssert.AreEqual(new byte[] { 109, 104, 199, 255 }, At(12, 5));
        Assert.ThrowsExactly<ArgumentException>(() => DesktopTabWindowRules.ComposePicture(new byte[8], width, height, default, default, 0));

        // With the leaving tab's outline, 2 px wide: dashes and gaps of 6 along the edge, over the tab, inside its corners.
        var cobalt = new TabColour(30, 90, 200);
        var dashed = DesktopTabWindowRules.ComposePicture(tab, width, height, new TabColour(200, 210, 220), new TabColour(1, 2, 3), 4, cobalt, 2);
        byte[] Dash(int x, int y) => dashed.AsSpan((y * width + x) * 4, 4).ToArray();
        CollectionAssert.AreEqual(new byte[] { 200, 90, 30, 255 }, Dash(13, 0), "The outline has no dash where one falls.");
        CollectionAssert.AreEqual(new byte[] { 200, 90, 30, 255 }, Dash(13, 1), "The outline is not 2 px wide.");
        CollectionAssert.AreEqual(new byte[] { 3, 2, 1, 255 }, Dash(8, 0), "The outline has no gap where one falls.");
        CollectionAssert.AreEqual(new byte[] { 220, 210, 200, 255 }, Dash(13, 2), "The outline is wider than 2 px.");
        CollectionAssert.AreEqual(new byte[] { 0, 0, 0, 0 }, Dash(0, 0), "The outline was drawn outside the corner.");
        Assert.AreEqual(2, DesktopTabWindowRules.DashesAlongTop(dashed, width, cobalt), "The top edge carries the wrong number of dashes.");
        Assert.AreEqual(0, DesktopTabWindowRules.DashesAlongTop(picture, width, cobalt), "A picture without the outline counted dashes.");
    }

    [TestMethod]
    public void ATabsPictureIsCutAtItsBoxAndJoinsAWindowOnlyOverItsTitleBar()
    {
        var picture = new TabDragPicture(10, 5, 100, 36, 0, 0, 1600, 900, default, default, 0);
        Assert.AreEqual(new RectInt32(15, 7, 150, 55), DesktopTabWindowRules.PictureBounds(picture, 1.5, 2400, 1350), "The picture was cut off the tab at 150%.");
        Assert.AreEqual(new RectInt32(15, 7, 5, 55), DesktopTabWindowRules.PictureBounds(picture, 1.5, 20, 1350), "A box past the capture's edge was not cut to it.");
        Assert.IsNull(DesktopTabWindowRules.PictureBounds(picture with { X = 2000 }, 1.0, 1600, 900));
        Assert.IsNull(DesktopTabWindowRules.PictureBounds(picture, 0, 1600, 900));

        // The title bar short of Windows' buttons: where the window's tabs are.
        var client = new RectInt32(100, 50, 1600, 900);
        var band = DesktopTabWindowRules.JoinBand(client, 72, 216);
        Assert.AreEqual(new RectInt32(100, 50, 1384, 72), band);
        Assert.IsTrue(DesktopTabWindowRules.Contains(band, new PointInt32(700, 80)));
        Assert.IsFalse(DesktopTabWindowRules.Contains(band, new PointInt32(700, 122)), "A tab let go in the page joined the window.");
        Assert.IsFalse(DesktopTabWindowRules.Contains(band, new PointInt32(1600, 80)), "A tab let go on Windows' Close joined the window.");
        Assert.AreEqual(400.0, DesktopTabWindowRules.PageX(new PointInt32(700, 80), client, 1.5));
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

        public List<bool> Last { get; } = [];

        public List<TabDragPicture> Pictures { get; } = [];

        public List<bool> Ended { get; } = [];

        public string DetachTab(string trail, bool atPointer, bool last)
        {
            Detached.Add((trail, atPointer));
            Last.Add(last);
            return last ? TabMoveOutcome.Moved : TabMoveOutcome.Window;
        }

        public Task BeginTabDragAsync(TabDragPicture picture)
        {
            Pictures.Add(picture);
            return Task.CompletedTask;
        }

        public void EndTabDrag(bool dropped) => Ended.Add(dropped);

        public TabDragDiagnostics DiagnoseTabDrag(bool setPoint, (double X, double Y)? point) => new(false, null, null, false, null, null, null, null);

        public void CloseWindow() { }

        public void Exit() { }

        public TabWindowStart TakeTab()
        {
            var trail = Trail;
            Trail = null;
            return new(isTabWindow ? "tab" : "main", trail);
        }
    }
}
