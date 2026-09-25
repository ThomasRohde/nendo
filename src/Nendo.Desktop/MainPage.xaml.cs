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
            PickCreatePathAsync,
            PickOpenPathAsync,
            ApplyAppearance,
            RunWorkbenchFileActionAsync,
            () => App.CurrentWindow?.GetAppearance() ?? new("system", "light", false, "The native window is unavailable."),
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
        if (!await InitializeStartupSessionAsync())
        {
            DesktopStartupTiming.Mark("session.failed");
            DesktopStartupTiming.Write();
            return;
        }
        DesktopStartupTiming.Mark("session.ready");
        await StartWorkbenchAsync();
    }

    private void Page_Unloaded(object sender, RoutedEventArgs e)
    {
        _unloaded = true;
        DetachWorkbench();
    }

    private async Task StartWorkbenchAsync()
    {
        DesktopStartupTiming.Mark("workbench.start");
        try
        {
            var assetRoot = Path.Combine(AppContext.BaseDirectory, "Workbench");
            var entryPoint = Path.Combine(assetRoot, DesktopShellContract.WorkbenchEntryPoint);
            if (!File.Exists(entryPoint))
            {
                throw new FileNotFoundException(
                    "The app view is missing. Reinstall Nendo and try again.",
                    entryPoint);
            }

            RecoveryPanel.Visibility = Visibility.Collapsed;
            WebHost.Visibility = Visibility.Visible;
            DetachWorkbench();

            _webView = new WebView2
            {
                DefaultBackgroundColor = ActualTheme == ElementTheme.Dark
                    ? Windows.UI.Color.FromArgb(255, 7, 23, 37)
                    : Windows.UI.Color.FromArgb(255, 244, 245, 247),
                IsTabStop = true,
            };
            AutomationProperties.SetAutomationId(_webView, "workbench.webview");
            WebHost.Children.Add(_webView);

            DesktopStartupTiming.Mark("webview.ensure.begin");
            await _webView.EnsureCoreWebView2Async();
            DesktopStartupTiming.Mark("webview.ensure.end");
            var core = _webView.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.Settings.IsZoomControlEnabled = false;
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
            ExtensionWebViewPolicy.Attach(core);
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
        }
    }

    private void Workbench_NavigationCompleted(
        CoreWebView2 sender,
        CoreWebView2NavigationCompletedEventArgs args)
    {
        DesktopStartupTiming.Mark(args.IsSuccess ? "webview.navigation.completed" : "webview.navigation.failed");
        DesktopStartupTiming.Write();
        if (args.IsSuccess)
        {
            return;
        }

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
            if (_webView is not null && _workbenchGeneration == generation)
            {
                // A native picker runs a nested window loop. Resolve the current
                // CoreWebView2 wrapper after it returns instead of reusing the
                // event sender wrapper captured before the dialog opened.
                _webView.CoreWebView2?.PostWebMessageAsJson(responseJson);
            }
            // Every open, create, close and replacement answers through here, so the
            // title bar follows the session without a dedicated protocol message.
            App.CurrentWindow?.ApplyFileName(_session.CurrentFileName);
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
        try
        {
            core.PostWebMessageAsJson(WorkbenchProtocolHandler.SerializeEvent(
                new WorkbenchEvent(DesktopShellContract.EventBridgeProtocolVersion, name, payload)));
        }
        catch (Exception)
        {
            // The renderer went away between the check and the post. Nothing to recover.
        }
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
    }

    private async Task<bool> InitializeStartupSessionAsync()
    {
        if (_startupConsumed || _startupRequest is null)
        {
            return true;
        }

        _startupConsumed = true;
        DesktopStartupTiming.Mark("session.open.begin");
        try
        {
            // Startup only needs open status. The renderer will query its own
            // record window after navigation; avoid allocating every record here.
            using var projection = _session.BindReadProjection(true);
            switch (_startupRequest.Mode)
            {
                case DesktopStartupMode.Create:
                    await _session.CreateAsync(_startupRequest.Path);
                    break;
                // Explorer's New menu has already picked the name and may have left an
                // empty file sitting at it, which is the picker's case exactly.
                case DesktopStartupMode.CreateFromShell:
                    await _session.CreateFromSavePickerAsync(_startupRequest.Path);
                    break;
                default:
                    await _session.OpenAsync(_startupRequest.Path);
                    break;
            }
            return true;
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException)
        {
            ShowRecovery("The requested file could not be opened. Use Open file or backup to inspect it and choose recovery actions.");
            return false;
        }
    }

    private async Task<string?> PickCreatePathAsync()
    {
        var window = App.CurrentWindow
            ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileSavePicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            SuggestedFileName = "Untitled",
            CommitButtonText = "Create Nendo file",
            DefaultFileExtension = NendoFormat.FileExtension,
            FileTypeChoices =
            {
                { "Nendo application", new List<string> { NendoFormat.FileExtension } },
            },
        };
        var result = await picker.PickSaveFileAsync();
        return result?.Path;
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
