using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-093. Nendo's top bar is the window's title bar: the page hands the host the boxes of its
/// controls there, and the host hands Windows the same boxes in the screen's own pixels. What
/// Windows then does with a press is measured in the real window by the extension-view journey
/// (G32); this class holds the bridge and the arithmetic.
/// </summary>
[TestClass]
public sealed class DesktopTitleBarTests
{
    [TestMethod]
    public void TheControlsAreReadAsFiniteBoxesAndABadListIsRefused()
    {
        var controls = DesktopTitleBarRegions.ReadControls(Payload(new { controls = new[] { new { x = 551.5, y = 10, width = 32, height = 32 } } }));
        Assert.HasCount(1, controls);
        Assert.AreEqual(new TitleBarRect(551.5, 10, 32, 32), controls[0]);
        Assert.IsEmpty(DesktopTitleBarRegions.ReadControls(Payload(new { controls = Array.Empty<object>() })));

        foreach (var bad in new object[]
        {
            new { },
            new { controls = "all of them" },
            new { controls = new[] { "box" } },
            new { controls = new[] { new { x = 1, y = 2, width = 3 } } },
            new { controls = new[] { new { x = 1, y = 2, width = -3, height = 4 } } },
            new { controls = new[] { new { x = 1e9, y = 2, width = 3, height = 4 } } },
            new { controls = Enumerable.Range(0, DesktopTitleBarRegions.MaximumControls + 1).Select(i => new { x = i, y = 0, width = 1, height = 1 }).ToArray() },
        })
        {
            Assert.ThrowsExactly<NendoValidationException>(() => DesktopTitleBarRegions.ReadControls(Payload(bad)), JsonSerializer.Serialize(bad));
        }
        // A number the page cannot have meant is refused rather than read as one.
        Assert.ThrowsExactly<NendoValidationException>(() => DesktopTitleBarRegions.ReadControls(
            JsonDocument.Parse("""{ "controls": [ { "x": "1", "y": 2, "width": 3, "height": 4 } ] }""").RootElement));
    }

    [TestMethod]
    public void BoxesBecomeWholeScreenPixelsGrownOutwardsAndClippedToTheWindow()
    {
        var pixels = DesktopTitleBarRegions.ToPixels([
            new TitleBarRect(161.33, 8.67, 30, 30),
            new TitleBarRect(1040, 8, 30, 30),
            new TitleBarRect(10, 60, 0, 30),
            new TitleBarRect(-40, -40, 20, 20),
        ], 1.5, 0, 0, 1578, 949);
        CollectionAssert.AreEqual(new[]
        {
            // 161.33 × 1.5 = 241.995 down to 241, and (161.33 + 30) × 1.5 = 286.995 up to 287.
            new TitleBarPixels(241, 13, 46, 46),
            // 1070 × 1.5 = 1605 runs past the window's 1578 and is cut there.
            new TitleBarPixels(1560, 12, 18, 45),
        }, pixels.ToArray());
        // Where the page starts in the window moves every box by as much.
        Assert.AreEqual(new TitleBarPixels(20, 40, 20, 20), DesktopTitleBarRegions.ToPixels([new TitleBarRect(0, 0, 10, 10)], 2, 10, 20, 800, 600)[0]);
        Assert.AreEqual(new TitleBarRect(-10, -20, 10, 10), DesktopTitleBarRegions.ToPage(new TitleBarPixels(0, 0, 20, 20), 2, 10, 20));
    }

    [TestMethod]
    public async Task ThePageHandsTheWindowItsControlsWithoutAFileAndOlderRenderersCannot()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var window = new RecordingWindow();
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { },
            windowHost: window);

        var answer = await handler.HandleAsync(Request(7, WorkbenchMethods.WindowSetTitleBarControls,
            new { controls = new[] { new { x = 10, y = 8, width = 30, height = 30 }, new { x = 100, y = 10, width = 32, height = 32 } } }));
        Assert.IsTrue(answer.Ok, answer.Error?.Message);
        Assert.IsFalse(session.HasFile, "The title bar is the window's, so it needs no file.");
        Assert.AreEqual(new TitleBarView(48, 0, 144), answer.Result);
        CollectionAssert.AreEqual(new[] { new TitleBarRect(10, 8, 30, 30), new TitleBarRect(100, 10, 32, 32) }, window.Controls.ToArray());

        var refused = await handler.HandleAsync(Request(7, WorkbenchMethods.WindowSetTitleBarControls, new { controls = "all" }));
        Assert.AreEqual("validation", refused.Error?.Code);
        foreach (var version in new[] { 2, 3, 4, 5, 6 })
            Assert.AreEqual("unknown-method", (await handler.HandleAsync(Request(version, WorkbenchMethods.WindowSetTitleBarControls, new { controls = Array.Empty<object>() }))).Error?.Code);

        var noWindow = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
        Assert.AreEqual("window-unavailable", (await noWindow.HandleAsync(Request(7, WorkbenchMethods.WindowSetTitleBarControls, new { controls = Array.Empty<object>() }))).Error?.Code);
    }

    [TestMethod]
    public async Task TheTitleBarDiagnosticsAnswerOnlyUnderNativeDiagnostics()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { },
            windowHost: new RecordingWindow());
        // A process started with native diagnostics on answers them, and only such a process.
        var expected = DesktopRuntimeConfiguration.NativeDiagnostics ? null : "unknown-method";
        Assert.AreEqual(expected, (await handler.HandleAsync(Request(7, WorkbenchMethods.DiagnosticsTitleBar, new { points = Array.Empty<object>() }))).Error?.Code);
        Assert.AreEqual(expected, (await handler.HandleAsync(Request(7, WorkbenchMethods.DiagnosticsResizeWindow, new { width = 800, height = 600 }))).Error?.Code);
    }

    [TestMethod]
    public void TheTitleBarEventIsInTheClosedSetAndCarriesTheBarAsTheAnswerDoes()
    {
        var json = WorkbenchProtocolHandler.SerializeEvent(new WorkbenchEvent(DesktopShellContract.EventBridgeProtocolVersion,
            WorkbenchEvents.TitleBarChanged, new TitleBarView(48, 0, 144)));
        using var document = JsonDocument.Parse(json);
        Assert.AreEqual("titleBarChanged", document.RootElement.GetProperty("event").GetString());
        var payload = document.RootElement.GetProperty("payload");
        Assert.AreEqual(48, payload.GetProperty("height").GetDouble());
        Assert.AreEqual(0, payload.GetProperty("left").GetDouble());
        Assert.AreEqual(144, payload.GetProperty("right").GetDouble());
    }

    private static JsonElement Payload(object value) => JsonSerializer.SerializeToElement(value);

    private static string Request(int version, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = version, requestId = Guid.NewGuid().ToString("N"), method, payload,
    });

    /// <summary>A window whose title bar is the tall one at 100 percent, and which keeps what it was handed.</summary>
    private sealed class RecordingWindow : IWorkbenchWindowHost
    {
        public List<TitleBarRect> Controls { get; } = [];

        public TitleBarView SetTitleBarControls(IReadOnlyList<TitleBarRect> controls)
        {
            Controls.Clear();
            Controls.AddRange(controls);
            return new TitleBarView(48, 0, 144);
        }

        public TitleBarDiagnosticsView DiagnoseTitleBar(IReadOnlyList<TitleBarRect> points) =>
            new(1, 0, 0, 800, 600, new TitleBarView(48, 0, 144), [], [], []);

        public TitleBarDiagnosticsView ResizeWindow(double width, double height) => DiagnoseTitleBar([]);
    }
}
