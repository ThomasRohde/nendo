using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-216: the window's rules around the Workbench's browser, the taskbar, Windows ending the
/// session and the way out, each held without a window, a browser or a taskbar. What Windows
/// and WebView2 then do with them is the journey's.
/// </summary>
[TestClass]
public sealed class DesktopWindowChromeTests
{
    /// <summary>
    /// DSH-02: a cancelled or superseded navigation reported a failure, and recovery replaced a
    /// healthy view. They carry another navigation's ID; the Workbench's own latest navigation
    /// failing, cancelled included, still goes to recovery rather than leaving a blank view.
    /// </summary>
    [TestMethod]
    public void OnlyTheWorkbenchsOwnNavigationFailingIsTheViewFailing()
    {
        Assert.IsFalse(DesktopWorkbenchNavigation.IsFatal(9, 7, false),
            "A navigation the host cancelled (a dropped link), or one the Workbench's superseded, tore down the view.");
        Assert.IsFalse(DesktopWorkbenchNavigation.IsFatal(7, 7, true));
        Assert.IsTrue(DesktopWorkbenchNavigation.IsFatal(7, 7, false),
            "The Workbench's own navigation failing, cancelled or not, left the window on a blank view.");
        Assert.IsTrue(DesktopWorkbenchNavigation.IsFatal(7, null, false),
            "A failure before the Workbench's navigation was seen is still the view's.");
    }

    /// <summary>DSH-03: a response posted to a browser that had gone threw out of the async handler and ended the process.</summary>
    [TestMethod]
    public void APostToABrowserThatHasGoneIsCaught()
    {
        Assert.IsFalse(DesktopShellSafety.TryPost(() => throw new System.Runtime.InteropServices.COMException("The browser process exited.", unchecked((int)0x8007139F))));
        Assert.IsFalse(DesktopShellSafety.TryPost(() => throw new InvalidOperationException("CoreWebView2 members cannot be accessed after the WebView2 control is disposed.")));
        var posted = false;
        Assert.IsTrue(DesktopShellSafety.TryPost(() => posted = true));
        Assert.IsTrue(posted);
    }

    /// <summary>DSH-05: at standard scales the bar measures the same in page pixels, so a move between screens raised nothing.</summary>
    [TestMethod]
    public void ANewDisplayScaleIsAChangeEvenWhenTheBarMeasuresTheSame()
    {
        var bar = new TitleBarView(48, 0, 144);
        Assert.IsTrue(DesktopTitleBarRegions.Changed(bar, 1.0, bar, 2.0), "A move from 100% to 200% left the controls where 100% put them.");
        Assert.IsTrue(DesktopTitleBarRegions.Changed(bar, 1.5, bar, 1.0));
        Assert.IsTrue(DesktopTitleBarRegions.Changed(null, 0, bar, 1.0), "The first description was not sent.");
        Assert.IsTrue(DesktopTitleBarRegions.Changed(bar, 1.0, bar with { Right = 138 }, 1.0));
        Assert.IsFalse(DesktopTitleBarRegions.Changed(bar, 1.5, new TitleBarView(48, 0, 144), 1.5));
    }

    /// <summary>DSH-07: a shutdown or sign-out closes no window, so the session was never ended.</summary>
    [TestMethod]
    public void WindowsEndingTheSessionEndsItWithinItsBound()
    {
        var ended = 0;
        Assert.IsTrue(DesktopSessionEnd.Handles(DesktopSessionEnd.QueryEndSession));
        Assert.IsTrue(DesktopSessionEnd.Handles(DesktopSessionEnd.EndSession));
        Assert.IsFalse(DesktopSessionEnd.Handles(0x0010), "WM_CLOSE is the window's, not the session's.");
        Assert.AreEqual(1, DesktopSessionEnd.Answer(DesktopSessionEnd.QueryEndSession, 0, () => ended++), "Nendo held up the end of the session.");
        Assert.AreEqual(0, ended, "Asking whether the session may end is not the session ending.");
        Assert.AreEqual(0, DesktopSessionEnd.Answer(DesktopSessionEnd.EndSession, 0, () => ended++));
        Assert.AreEqual(0, ended, "A session end that was called off ended the session.");
        Assert.AreEqual(0, DesktopSessionEnd.Answer(DesktopSessionEnd.EndSession, 1, () => ended++));
        Assert.AreEqual(1, ended, "Windows ending the session did not end Nendo's.");
        Assert.AreEqual(0, DesktopSessionEnd.Answer(DesktopSessionEnd.EndSession, 1, () => throw new IOException("cleanup")),
            "A failing end crossed the window procedure.");

        var drained = false;
        Assert.IsTrue(DesktopSessionEnd.Drain(async () => { await Task.Delay(50); drained = true; }, TimeSpan.FromSeconds(5)));
        Assert.IsTrue(drained, "The session's end was not waited for.");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Assert.IsFalse(DesktopSessionEnd.Drain(() => new TaskCompletionSource().Task, TimeSpan.FromMilliseconds(200)));
        Assert.IsLessThan(3000, clock.ElapsedMilliseconds, "An end that never finished held the window procedure past its bound.");
        Assert.IsFalse(DesktopSessionEnd.Drain(() => throw new IOException("cleanup"), TimeSpan.FromSeconds(1)));
    }

    /// <summary>DSH-13: a window shown from the tray got its badge back but not its progress.</summary>
    [TestMethod]
    public void ANewTaskbarButtonGetsTheProgressOfWorkStillRunning()
    {
        var button = new RecordingButton();
        var activity = new DesktopTaskbarActivity(button);
        activity.Set(agent: true);
        activity.Set(fileAction: true);
        activity.Set(fileAction: false);
        Assert.AreEqual("busy:True", button.Calls[^1], "A file action finishing cleared the agent's progress.");
        button.Calls.Clear();
        activity.ButtonRecreated();
        CollectionAssert.AreEqual(new[] { "forget", "busy:True" }, button.Calls,
            "A button made again while an agent works came back without its progress.");
        activity.Set(agent: false);
        button.Calls.Clear();
        activity.ButtonRecreated();
        CollectionAssert.AreEqual(new[] { "forget", "busy:False" }, button.Calls);
        new DesktopTaskbarActivity(null).ButtonRecreated();
    }

    /// <summary>DSH-14: the sizes were handed to Windows as physical pixels, half-size at 200%.</summary>
    [TestMethod]
    public void TheWindowsSizesAreThePagesPixelsAtTheDisplaysScale()
    {
        var workArea = new Windows.Graphics.RectInt32(0, 0, 3_840, 2_100);
        Assert.AreEqual(new Windows.Graphics.RectInt32(320, 90, 3_200, 1_920), DesktopWindowPolicy.FitTo(workArea, 2.0),
            "The first window on a 200% screen opened at half its size.");
        Assert.AreEqual(new Windows.Graphics.SizeInt32(2_048, 1_440), DesktopWindowPolicy.MinimumFor(workArea, 2.0),
            "The window could be shrunk below the layout's minimum at 200%.");
        // Clamped to the work area, as at 100%.
        Assert.AreEqual(new Windows.Graphics.RectInt32(0, 0, 3_840, 2_100), DesktopWindowPolicy.FitTo(workArea, 2.5));
        Assert.AreEqual(new Windows.Graphics.SizeInt32(2_560, 1_800), DesktopWindowPolicy.MinimumFor(workArea, 2.5));
        Assert.AreEqual(new Windows.Graphics.RectInt32(1_000, 500, 2_048, 1_440),
            DesktopWindowPolicy.FitSavedTo(new DesktopWindowState(1_000, 500, 1_200, 800, false), workArea, 2.0),
            "A saved window smaller than the scaled minimum was kept below it.");
        // A scale Windows could not give is 100%.
        Assert.AreEqual(DesktopWindowPolicy.FitTo(workArea), DesktopWindowPolicy.FitTo(workArea, double.NaN));
    }

    /// <summary>DSH-19: a cleanup failure on the way out escaped an async void handler after Exit.</summary>
    [TestMethod]
    public async Task ACleanupFailureOnTheWayOutIsReturnedNotThrown()
    {
        var failure = await DesktopShellSafety.ShutdownAsync(() => throw new IOException("The discovery entry is held open."));
        Assert.IsInstanceOfType<IOException>(failure);
        Assert.IsInstanceOfType<NendoPreconditionException>(await DesktopShellSafety.ShutdownAsync(async () =>
        {
            await Task.Yield();
            throw new NendoPreconditionException("cleanup", "Proposal cleanup failed.");
        }));
        Assert.IsNull(await DesktopShellSafety.ShutdownAsync(() => Task.CompletedTask));
    }

    /// <summary>DSH-23: the constructor's icon was unguarded, so a missing icon ended the launch.</summary>
    [TestMethod]
    public void AMissingIconLeavesTheWindowWithoutOne()
    {
        var missing = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "AppIcon.ico");
        Assert.IsFalse(DesktopShellSafety.TrySetIcon(path => throw new FileNotFoundException("The icon is missing.", path), missing));
        Assert.IsFalse(DesktopShellSafety.TrySetIcon(_ => throw new System.Runtime.InteropServices.COMException("Unreadable icon."), missing));
        string? given = null;
        Assert.IsTrue(DesktopShellSafety.TrySetIcon(path => given = path, missing));
        Assert.AreEqual(missing, given);
    }

    /// <summary>
    /// DSH-15: F5 and Ctrl+R reloaded the Workbench and dropped an open form's typing. WebView2
    /// handles those keys before the page can stop them, and WinUI's WebView2 has no controller to
    /// filter them one by one, so the setting is what there is to hold: off in a shipped build, on
    /// in a Debug build for F12. Whether a real F5 then reloads is a journey's to measure, and no
    /// lane does.
    /// </summary>
    [TestMethod]
    public void TheWorkbenchsBrowserKeysAreOffInAShippedBuild()
    {
        var setup = Between(Source("MainPage.xaml.cs"), "private async Task StartWorkbenchAsync", "core.Navigate(");
        StringAssert.Contains(setup, "core.Settings.AreBrowserAcceleratorKeysEnabled = DesktopWorkbenchNavigation.BrowserAcceleratorKeys;",
            "The Workbench's document does not take its browser keys from the rule.");
        var rule = Between(Source("DesktopWindowChrome.cs"), "internal static bool BrowserAcceleratorKeys =>", "#endif");
        StringAssert.Matches(rule, new System.Text.RegularExpressions.Regex(@"#if DEBUG\s+true;\s+#else\s+false;"),
            "A shipped build keeps the browser's reload, print and find keys on the Workbench.");
#if DEBUG
        Assert.IsTrue(DesktopWorkbenchNavigation.BrowserAcceleratorKeys, "A Debug build lost F12 on the Workbench.");
#endif
    }

    /// <summary>
    /// The call sites of DSH-03, DSH-19 and DSH-23, which the window owns and no lane drives: each
    /// goes through the guarded helper the tests above hold.
    /// </summary>
    [TestMethod]
    public void TheWindowCallsTheGuardedHelpers()
    {
        var deliver = Between(Source("MainPage.xaml.cs"), "void DeliverResponse()", "App.CurrentWindow?.ApplyFileName");
        StringAssert.Contains(deliver, "DesktopShellSafety.TryPost(", "A response is posted to the browser unguarded (DSH-03).");
        Assert.DoesNotContain("_webView.CoreWebView2?.PostWebMessageAsJson", deliver, "A response is posted to the browser unguarded (DSH-03).");

        var window = Source("MainWindow.xaml.cs");
        var closing = Between(window, "private async void AppWindow_Closing", "finally");
        StringAssert.Contains(closing, "await DesktopShellSafety.ShutdownAsync(page.ShutdownAsync)",
            "The close handler awaits the session's shutdown where a failure escapes (DSH-19).");
        Assert.DoesNotContain("await page.ShutdownAsync()", closing, "The close handler awaits the session's shutdown where a failure escapes (DSH-19).");

        var constructor = Between(window, "internal MainWindow(DesktopStartupRequest? startupRequest)", "_placementFile = startupRequest?.Path;");
        StringAssert.Contains(constructor, "DesktopShellSafety.TrySetIcon(AppWindow.SetIcon,", "The constructor sets the icon unguarded (DSH-23).");
        Assert.DoesNotContain("AppWindow.SetIcon(Path", constructor, "The constructor sets the icon unguarded (DSH-23).");
    }

    /// <summary>
    /// DSH-14, after review: the minimum is physical pixels, which Windows does not rescale when the
    /// window moves to a screen of another scale (microsoft/microsoft-ui-xaml#10452), so a minimum
    /// set on a 200% laptop kept the window from shrinking on a 100% monitor. It is set again for
    /// each new scale.
    /// </summary>
    [TestMethod]
    public void TheMinimumFollowsTheScaleTheWindowMovesTo()
    {
        var workArea = new Windows.Graphics.RectInt32(0, 0, 1_920, 1_040);
        Assert.AreEqual(new Windows.Graphics.SizeInt32(1_024, 720), DesktopWindowPolicy.MinimumAfterScaleChange(workArea, 2.0, 1.0),
            "A window moved from a 200% screen to a 100% one kept the 200% minimum.");
        Assert.AreEqual(new Windows.Graphics.SizeInt32(1_536, 1_040), DesktopWindowPolicy.MinimumAfterScaleChange(workArea, 1.0, 1.5));
        Assert.IsNull(DesktopWindowPolicy.MinimumAfterScaleChange(workArea, 1.5, 1.5), "The same scale set the minimum again.");
        var refresh = Between(Source("MainWindow.TitleBar.cs"), "private void RefreshTitleBar()", "TitleBarChanged?.Invoke(bar);");
        StringAssert.Contains(refresh, "DesktopWindowPolicy.ApplyMinimum(AppWindow, _titleBarScale, scale);",
            "A new display scale leaves the minimum at the old screen's scale.");
    }

    /// <summary>
    /// R2SMA-09: the native recovery panel's outcome InfoBar sat inside a 96-pixel scroll area under
    /// the reason and the session lines, so a backup's or an export's result opened below its fold.
    /// No lane drives the native panel with an action, so the markup is what there is to hold.
    /// </summary>
    [TestMethod]
    public void TheRecoveryPanelsOutcomeIsNotInsideAClippingScrollArea()
    {
        var page = System.Xml.Linq.XDocument.Parse(Source("MainPage.xaml"));
        System.Xml.Linq.XNamespace x = "http://schemas.microsoft.com/winfx/2006/xaml";
        var activity = page.Descendants().Single(element => (string?)element.Attribute(x + "Name") == "RecoveryActivity");
        Assert.AreEqual("InfoBar", activity.Name.LocalName);
        var clipping = activity.Ancestors().FirstOrDefault(element => element.Name.LocalName == "ScrollViewer");
        Assert.IsNull(clipping, $"RecoveryActivity is inside a ScrollViewer (MaxHeight {(string?)clipping?.Attribute("MaxHeight") ?? "none"}).");
    }

    /// <summary>
    /// R2SMA-14: a native dialog took the page's theme once, as it was made, so a dialog open across
    /// a Windows theme switch under System kept the old one. No lane flips the theme under an open
    /// dialog, so the helper's source is what there is to hold.
    /// </summary>
    [TestMethod]
    public void ANativeDialogFollowsThePagesThemeWhileItIsOpen()
    {
        var helper = Between(Source("MainPage.FileActions.cs"), "private ContentDialog NativeDialog(", "return dialog;");
        StringAssert.Contains(helper, "ActualThemeChanged += FollowTheme;", "An open dialog does not follow the page's theme.");
        StringAssert.Contains(helper, "ActualThemeChanged -= FollowTheme;", "A closed dialog keeps listening to the page's theme.");
    }

    private static string Source(string name) =>
        File.ReadAllText(Path.Combine(TestRepository.Root(), "src", "Nendo.Desktop", name));

    private static string Between(string text, string start, string end)
    {
        var from = text.IndexOf(start, StringComparison.Ordinal);
        Assert.IsGreaterThanOrEqualTo(0, from, $"'{start}' is not in the source any more.");
        var to = text.IndexOf(end, from + start.Length, StringComparison.Ordinal);
        Assert.IsGreaterThan(from, to, $"'{end}' does not follow '{start}' in the source.");
        return text[from..to];
    }

    private sealed class RecordingButton : IDesktopTaskbarButton
    {
        public List<string> Calls { get; } = [];
        public void Forget() => Calls.Add("forget");
        public void SetBusy(bool busy) => Calls.Add($"busy:{busy}");
    }
}
