using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Windows.Storage.Pickers;
using Microsoft.Web.WebView2.Core;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainPage : Page
{
    private WebView2? _webView;
    private readonly DesktopSessionController _session = CreateSessionController();
    private readonly WorkbenchProtocolHandler _protocol;
    private DesktopStartupRequest? _startupRequest;
    private bool _startupConsumed;
    private bool _unloaded;
    private long _workbenchGeneration;

    /// <summary>The Workbench's own latest navigation, the only one whose failure is the view's.</summary>
    private ulong? _workbenchNavigationId;
    private ExtensionAssetServer? _extensionAssets;

    public MainPage()
    {
        DesktopStartupTiming.Mark("page.constructor");
        InitializeComponent();
        DesktopStartupTiming.Mark("page.initialized");
        if (DesktopRuntimeConfiguration.NativeCaptureRoot is not null)
            SizeChanged += (_, _) => { _ = CaptureNativeRecoveryForTestAsync(); };
        _protocol = new WorkbenchProtocolHandler(
            _session,
            ApplyAppearance,
            RunWorkbenchFileActionAsync,
            () => App.CurrentWindow?.GetAppearance() ?? new("system", "light", false, "The native window is unavailable."),
            this,
            this);
    }

    /// <summary>
    /// The session behind this page, for the window that owns the notification area.
    /// <para>
    /// The page owns the controller because the page owns the renderer that drives it;
    /// the window needs it only to read shell state and subscribe to signals, which is
    /// why this is a getter rather than a move of ownership.
    /// </para>
    /// </summary>
    internal DesktopSessionController Session => _session;

    /// <summary>
    /// The workspace failed, and nobody behind a hidden window would know. Carries what
    /// the host was told — the kind, and how long the view had been up — because those
    /// are the two things that are gone the moment the view is restarted.
    /// </summary>
    internal event Action<string, int>? RendererFailed;

    /// <summary>When the current view started, so a failure can say how long it lasted.</summary>
    private DateTimeOffset _viewStartedUtc = DateTimeOffset.UtcNow;

    /// <summary>The workspace is running again, so a later failure is a new one.</summary>
    internal event Action? RendererStarted;

    /// <summary>Routes a notification click to a Workbench view once the window is back.</summary>
    internal void RouteTo(string route) => PostWorkbenchEvent(WorkbenchEvents.Navigate, route);

    /// <summary>
    /// Tells the renderer the open file moved, so a surface on screen can look again.
    /// <para>
    /// Arrives on the writer's thread while the Engine gate is held; PostWorkbenchEvent
    /// marshals to the UI thread, which is the whole of what this method has to get
    /// right. It carries the change sequence and nothing else: the renderer decides what
    /// to re-read and, more importantly, when it is safe to redraw.
    /// </para>
    /// </summary>
    internal void FileChanged(long changeSequence) =>
        PostWorkbenchEvent(WorkbenchEvents.FileChanged, changeSequence);

    /// <summary>
    /// Tells the renderer an agent started or finished a call, so a person on any screen
    /// can see that the file is being written to rather than a window that has stopped
    /// answering. Same threading as above: raised on the agent's thread, marshalled here.
    /// The renderer owns the delay -- a fast read must not flash an indicator.
    /// </summary>
    internal void AgentWorking(Nendo.LocalMcp.NendoAgentWork work) =>
        PostWorkbenchEvent(
            WorkbenchEvents.AgentActivity,
            new AgentActivityPayload(work.Busy, work.Client, work.Activity));

    /// <summary>
    /// Tells the renderer the launched agent's conversation moved (ADR-0030), carrying its
    /// revision. Raised on the agent's thread; marshalled here like the two above.
    /// </summary>
    internal void LaunchedAgentChanged(long revision) =>
        PostWorkbenchEvent(WorkbenchEvents.AgentSessionChanged, revision);

    private static DesktopSessionController CreateSessionController()
    {
        // Isolated profiles use the same production services and permissions.
        if (DesktopRuntimeConfiguration.DeviceStateRoot is { } root)
        {
            return new DesktopSessionController(new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(root, "discovery")),
                Path.Combine(root, "file-history"),
                deviceStateRoot: root);
        }
        // The default profile keeps the standard discovery location and the per-device settings root.
        return new DesktopSessionController(deviceStateRoot: DesktopAppearanceStore.DefaultRoot);
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        _startupRequest = e.Parameter as DesktopStartupRequest;
    }

    private async void Page_Loaded(object sender, RoutedEventArgs e)
    {
        DesktopStartupTiming.Mark("page.loaded");
        _unloaded = false;
        // The browser starts while the file opens. Neither needs the other until the first
        // navigation, and each took about half a second one after the other.
        var browser = BeginWorkbenchBrowser();
        if (!await InitializeStartupSessionAsync())
        {
            DesktopStartupTiming.Mark("session.failed");
            DesktopStartupTiming.Write();
            // The recovery panel has already closed the browser, which can fail its start.
            browser?.Ready.ContinueWith(static start => _ = start.Exception,
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            return;
        }
        DesktopStartupTiming.Mark("session.ready");
        await StartWorkbenchAsync(browser);
    }

    /// <summary>A Workbench browser that has been asked to start, and its start.</summary>
    private sealed record WorkbenchBrowser(WebView2 View, Task Ready);

    private static string WorkbenchAssetRoot => Path.Combine(AppContext.BaseDirectory, "Workbench");

    /// <summary>
    /// Puts a new browser in the page and starts it, replacing any earlier one. Null when
    /// the Workbench is not installed, which <see cref="StartWorkbenchAsync"/> reports.
    /// </summary>
    private WorkbenchBrowser? BeginWorkbenchBrowser()
    {
        if (!File.Exists(Path.Combine(WorkbenchAssetRoot, DesktopShellContract.WorkbenchEntryPoint))) return null;
        RecoveryPanel.Visibility = Visibility.Collapsed;
        WebHost.Visibility = Visibility.Visible;
        DetachWorkbench();

        _webView = new WebView2
        {
            // Transparent, so the window's Mica shows wherever the page leaves its ground (G).
            DefaultBackgroundColor = Windows.UI.Color.FromArgb(0, 0, 0, 0),
            IsTabStop = true,
        };
        AutomationProperties.SetAutomationId(_webView, "workbench.webview");
        WebHost.Children.Add(_webView);

        DesktopStartupTiming.Mark("webview.ensure.begin");
        return new(_webView, EnsureBrowserAsync(_webView));
    }

    /// <summary>
    /// Starts the browser with its profile under the device-state folder rather than
    /// WebView2's default beside the executable (see <see cref="DesktopBrowserProfile"/>).
    /// </summary>
    private static async Task EnsureBrowserAsync(WebView2 view)
    {
        var environment = await DesktopBrowserProfile.CreateEnvironmentAsync();
        await view.EnsureCoreWebView2Async(environment);
    }

    private void Page_Unloaded(object sender, RoutedEventArgs e)
    {
        _unloaded = true;
        DetachWorkbench();
    }

    /// <param name="started">
    /// A browser started earlier for this view, at startup; null starts a new one.
    /// </param>
    private async Task StartWorkbenchAsync(WorkbenchBrowser? started = null)
    {
        DesktopStartupTiming.Mark("workbench.start");
        try
        {
            var assetRoot = WorkbenchAssetRoot;
            // Only the browser this page still shows: a recovery or a restart in between
            // closed the earlier one.
            var browser = started is not null && ReferenceEquals(started.View, _webView) ? started : BeginWorkbenchBrowser();
            if (browser is null)
            {
                throw new FileNotFoundException(
                    "The app view is missing. Reinstall Nendo and try again.",
                    Path.Combine(assetRoot, DesktopShellContract.WorkbenchEntryPoint));
            }

            await browser.Ready;
            DesktopStartupTiming.Mark("webview.ensure.end");
            // A restart while the browser was starting owns the page now.
            if (!ReferenceEquals(browser.View, _webView)) return;
            var core = browser.View.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.IsZoomControlEnabled = false;
            // F5 and Ctrl+R reloaded the Workbench and dropped an open form's typing without a
            // word; Ctrl+P and Ctrl+F opened the browser's print and find over the app (DSH-15).
            // Off in a shipped build, where the keys still reach the page, so its own shortcuts
            // and a view's declared keys keep working; on in a Debug build for F12 (see
            // BrowserAcceleratorKeys). DevTools stay enabled and open from Inspect on a view's menu.
            core.Settings.AreBrowserAcceleratorKeysEnabled = DesktopWorkbenchNavigation.BrowserAcceleratorKeys;
            core.SetVirtualHostNameToFolderMapping(
                DesktopShellContract.WorkbenchHostName,
                assetRoot,
                CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationCompleted += Workbench_NavigationCompleted;
            core.NavigationStarting += Workbench_NavigationStarting;
            core.ProcessFailed += Workbench_ProcessFailed;
            core.WebMessageReceived += Workbench_WebMessageReceived;
            // Custom views run as frames of this document, served from the open file. The
            // Workbench's own content security policy keeps its document local; nothing here
            // narrows what a view's frame may reach.
            ExtensionWebViewPolicy.Attach(core, DownloadSaved);
            _extensionAssets = ExtensionAssetServer.Attach(core, _session, assetRoot);
            DesktopStartupTiming.Mark("webview.navigate");
            core.Navigate(DesktopShellContract.WorkbenchUri.AbsoluteUri);
            _viewStartedUtc = DateTimeOffset.UtcNow;
            RendererStarted?.Invoke();
        }
        catch (Exception)
        {
            DesktopStartupTiming.Mark("workbench.failed");
            DesktopStartupTiming.Write();
            ShowRecovery("The app view could not start. Use the native file actions below, or restart the view.");
        }
    }

    private void Workbench_NavigationStarting(
        CoreWebView2 sender,
        CoreWebView2NavigationStartingEventArgs args)
    {
        if (!DesktopShellContract.IsAllowedWorkbenchUri(args.Uri))
        {
            args.Cancel = true;
            return;
        }
        _workbenchNavigationId = args.NavigationId;
    }

    private void Workbench_NavigationCompleted(
        CoreWebView2 sender,
        CoreWebView2NavigationCompletedEventArgs args)
    {
        // A navigation the host cancelled, or one another superseded, is not the view failing
        // (DSH-02): only the Workbench's own navigation failing is.
        if (!DesktopWorkbenchNavigation.IsFatal(args.NavigationId, _workbenchNavigationId, args.IsSuccess))
        {
            if (args.IsSuccess && args.NavigationId == _workbenchNavigationId)
            {
                DesktopStartupTiming.Mark("webview.navigation.completed");
                DesktopStartupTiming.Write();
            }
            return;
        }

        DesktopStartupTiming.Mark("webview.navigation.failed");
        DesktopStartupTiming.Write();
        ShowRecovery($"The app view could not load ({args.WebErrorStatus}).");
    }

    /// <summary>
    /// Only the Workbench's own processes going away is a reason for recovery. A view's
    /// renderer ending stops that view, which the Workbench says in the view's own place. The
    /// browser restarts a GPU or utility process by itself, and the page never notices.
    /// </summary>
    private void Workbench_ProcessFailed(
        CoreWebView2 sender,
        CoreWebView2ProcessFailedEventArgs args)
    {
        var kind = args.ProcessFailedKind;
        if (kind == CoreWebView2ProcessFailedKind.FrameRenderProcessExited)
        {
            var frames = (args.FrameInfosForFailedProcess ?? [])
                .Select(frame => frame.Name)
                .Where(name => name?.StartsWith("nendo-view-", StringComparison.Ordinal) == true)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            PostWorkbenchEvent(WorkbenchEvents.ExtensionFramesFailed,
                new ExtensionFramesFailedPayload(_session.CurrentFileSessionId, frames));
            return;
        }
        if (kind is not (CoreWebView2ProcessFailedKind.BrowserProcessExited or
            CoreWebView2ProcessFailedKind.RenderProcessExited or
            CoreWebView2ProcessFailedKind.RenderProcessUnresponsive))
            return;
        var name = kind.ToString();
        // Now, not when recovery runs: a response already queued would otherwise be posted to
        // the browser that has gone before the recovery panel replaces it (DSH-03).
        _workbenchGeneration = checked(_workbenchGeneration + 1);
        DispatcherQueue.TryEnqueue(
            () => ShowRecovery($"The app view stopped ({name}).", name));
    }

    private async void Workbench_WebMessageReceived(
        CoreWebView2 sender,
        CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!DesktopShellContract.IsAllowedWorkbenchUri(args.Source))
        {
            return;
        }

        var generation = _workbenchGeneration;
        var message = args.WebMessageAsJson;
        var droppedPath = DroppedFilePath(args);
        // A bounded calculation is real arithmetic inside an ordinary read, and this
        // handler starts on the UI thread, so its continuations would finish that
        // arithmetic there and freeze the window for as long as it takes. Methods
        // that never touch a native picker or a XAML element are handed to a worker;
        // everything else keeps running here, where that native work belongs.
        var response = WorkbenchProtocolHandler.RunsOffUiThread(message)
            ? await Task.Run(() => _protocol.HandleAsync(message, droppedPath))
            : await _protocol.HandleAsync(message, droppedPath);
        var responseJson = WorkbenchProtocolHandler.Serialize(response);
        void DeliverResponse()
        {
            if (_webView is { } view && _workbenchGeneration == generation)
            {
                // A native picker runs a nested window loop. Resolve the current
                // CoreWebView2 wrapper after it returns instead of reusing the
                // event sender wrapper captured before the dialog opened. The browser
                // may have gone in between, as PostWorkbenchEvent knows (DSH-03).
                DesktopShellSafety.TryPost(() => view.CoreWebView2?.PostWebMessageAsJson(responseJson));
            }
            // Every open, create, close and replacement answers through here, so the
            // title bar follows the session without a dedicated protocol message.
            App.CurrentWindow?.ApplyFileName(_session.CurrentFileName, _session.CurrentLook);
        }

        if (DispatcherQueue.HasThreadAccess)
        {
            DeliverResponse();
        }
        else if (!DispatcherQueue.TryEnqueue(DeliverResponse))
        {
            ShowRecovery("Nendo could not complete the request.");
        }
    }

    /// <summary>
    /// Where a file dragged onto the window came from.
    /// <para>
    /// A page cannot see a dropped file's path — that is a browser rule, and the right
    /// one. WebView2 carries the shell's own file object alongside the message instead,
    /// and this is the only place its path is read. The page names no path, so a page
    /// that had been tampered with could still only ask about a file a person had
    /// physically dropped on the window.
    /// </para>
    /// <para>
    /// Only a .nendo file counts. Anything else is nothing arriving at all, which is
    /// what the page has already told the person while the pointer was over the window.
    /// </para>
    /// </summary>
    private static string? DroppedFilePath(CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            foreach (var candidate in args.AdditionalObjects ?? [])
            {
                if (candidate is not CoreWebView2File file) continue;
                if (!string.Equals(Path.GetExtension(file.Path), NendoFormat.FileExtension, StringComparison.OrdinalIgnoreCase)) continue;
                return file.Path;
            }
            return null;
        }
        // Every exception, for the same reason the Jump List publish catches every
        // exception: this is read for every bridge message, on the UI thread, inside an
        // async void handler. AdditionalObjects is a newer WebView2 interface, so an
        // older runtime could refuse it in a way not listed here — and that would end
        // the process on every message rather than on a dropped file. No file is the
        // safe answer to "did a file arrive"; there is no unsafe way to be wrong here.
        catch (Exception)
        {
            return null;
        }
    }

    private async void RestartWorkbench_Click(object sender, RoutedEventArgs e)
    {
        await StartWorkbenchAsync();
    }

    /// <summary>
    /// For a view that brings the whole window down: start again with every view off. They stay
    /// off until the person turns them on in Studio or starts Nendo again.
    /// </summary>
    private async void RestartWithoutViews_Click(object sender, RoutedEventArgs e)
    {
        _session.SuspendExtensions();
        await StartWorkbenchAsync();
    }

    internal async Task ShutdownAsync()
    {
        _unloaded = true;
        DetachWorkbench();
        await _session.DisposeAsync();
    }

    /// <summary>
    /// Sends the renderer something it did not ask for. Best effort by design: there
    /// is no window to show a failure in when the renderer is gone, and the state the
    /// event points at is on the page anyway once somebody looks at it.
    /// </summary>
    private void PostWorkbenchEvent(string name, object? payload)
    {
        if (!DispatcherQueue.HasThreadAccess)
        {
            DispatcherQueue.TryEnqueue(() => PostWorkbenchEvent(name, payload));
            return;
        }
        var core = _webView?.CoreWebView2;
        if (core is null || _unloaded) return;
        // The renderer may go away between the check and the post. Nothing to recover.
        DesktopShellSafety.TryPost(() => core.PostWebMessageAsJson(WorkbenchProtocolHandler.SerializeEvent(
            new WorkbenchEvent(DesktopShellContract.EventBridgeProtocolVersion, name, payload))));
    }

    private void ShowRecovery(string reason, string? kind = null)
    {
        if (_unloaded)
        {
            return;
        }

        DetachWorkbench();
        RendererFailed?.Invoke(
            kind ?? "unspecified",
            (int)Math.Max(0, (DateTimeOffset.UtcNow - _viewStartedUtc).TotalSeconds));
        // Loaded here, not in the markup. Once the TitleBar control's icon was gone (W-093), a picture
        // in the collapsed panel was the first this window loaded, and loading it at startup brought
        // the process down inside XAML with E_UNEXPECTED (F-202).
        RecoveryMark.Source ??= new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(new Uri("ms-appx:///Assets/NendoMark.png"));
        RecoveryReason.Text = reason;
        RecoverySession.Text = "Checking the file session…";
        RecoveryActions.IsEnabled = false;
        WebHost.Visibility = Visibility.Collapsed;
        RecoveryPanel.Visibility = Visibility.Visible;
        _ = RefreshNativeRecoveryAsync();
    }

    private void DetachWorkbench()
    {
        _workbenchGeneration = checked(_workbenchGeneration + 1);
        _workbenchNavigationId = null;
        var webView = _webView;
        _webView = null;
        _extensionAssets?.Detach();
        _extensionAssets = null;

        if (webView?.CoreWebView2 is not null)
        {
            webView.CoreWebView2.NavigationCompleted -= Workbench_NavigationCompleted;
            webView.CoreWebView2.NavigationStarting -= Workbench_NavigationStarting;
            webView.CoreWebView2.ProcessFailed -= Workbench_ProcessFailed;
            webView.CoreWebView2.WebMessageReceived -= Workbench_WebMessageReceived;
            ExtensionWebViewPolicy.Detach(webView.CoreWebView2);
        }

        WebHost.Children.Clear();
        webView?.Close();
        ForgetTitleBarControls();
    }

    private async Task<bool> InitializeStartupSessionAsync()
    {
        if (_startupConsumed || _startupRequest is null)
        {
            return true;
        }

        _startupConsumed = true;
        DesktopStartupTiming.Mark("session.open.begin");
        var path = _startupRequest.Path;
        try
        {
            // Startup only needs open status. The renderer will query its own
            // record window after navigation; avoid allocating every record here.
            using var projection = _session.BindReadProjection(true);
            // A launch is a request somebody made, like a picked or a dropped file, and meets
            // the same questions: a folder that may be synced, another known file with this
            // one's instance, a file that opens only read-only. It ended on the recovery panel
            // with a fixed sentence instead (DSH-01). A question answered with Cancel leaves
            // the window open on no file.
            using var binding = _session.BindFileRequest(_session.CurrentFileSessionId);
            switch (_startupRequest.Mode)
            {
                case DesktopStartupMode.Create:
                    if (await ConfirmDestinationLocationAsync(path)) await _session.CreateAsync(path);
                    break;
                // Explorer's New menu has already picked the name and may have left an
                // empty file sitting at it, which is the picker's case exactly.
                case DesktopStartupMode.CreateFromShell:
                    if (await ConfirmDestinationLocationAsync(path)) await _session.CreateFromSavePickerAsync(path);
                    break;
                default:
                    var assessment = await _session.AssessOpenAsync(path);
                    if (DesktopStartupOpen.NeedsAQuestion(assessment)) await OpenNativeAssessmentAsync(assessment);
                    else await OpenAssessedOrReadOnlyAsync(assessment, readOnly: false);
                    break;
            }
            return true;
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException)
        {
            // The refusal's own words, which name what is wrong; the panel's actions follow them.
            ShowRecovery(DesktopRecoveryPresentation.FailureMessage(exception));
            return false;
        }
    }

    private async Task<string?> PickOpenPathAsync()
    {
        var window = App.CurrentWindow
            ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileOpenPicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            CommitButtonText = "Open Nendo file",
            FileTypeFilter = { NendoFormat.FileExtension },
        };
        var result = await picker.PickSingleFileAsync();
        return result?.Path;
    }

    private static void ApplyAppearance(AppearancePayload appearance)
    {
        App.CurrentWindow?.ApplyAppearance(appearance);
    }

}
