using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Windowing;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainWindow : Window
{
    private bool _closing;
    private bool _allowClose;
    private bool _exitRequested;
    private readonly DesktopAppearanceStore _appearance = new(DesktopAppearanceStore.DefaultRoot);
    private readonly DesktopWindowStore _windowStore = new(DesktopAppearanceStore.DefaultRoot);
    private readonly DesktopShellStore _shell = new(DesktopShellStore.DefaultRoot);
    private readonly DesktopNotificationTrigger _trigger = new();
    private DesktopTrayIcon? _tray;
    private DesktopTaskbarStatus? _taskbar;
    private string? _jumpListFile;
    private readonly DesktopViewFailureLog _viewFailures = new(DesktopViewFailureLog.DefaultRoot);
    private DesktopNotifier? _notifier;
    private DesktopWindowState? _windowState;

    public MainWindow() : this(null)
    {
    }

    internal MainWindow(DesktopStartupRequest? startupRequest)
    {
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        var savedWindow = _windowStore.Load();
        // Establish normal bounds before maximizing so Restore retains the saved size.
        DesktopWindowPolicy.Apply(AppWindow, savedWindow is null ? null : savedWindow with { Maximized = false });
        CaptureWindowState();
        AppWindow.Changed += (_, _) => CaptureWindowState();
        if (savedWindow?.Maximized == true && AppWindow.Presenter is OverlappedPresenter presenter) presenter.Maximize();
        ApplySavedAppearance();
        AppWindow.Closing += AppWindow_Closing;
        RootFrame.Navigate(typeof(MainPage), startupRequest);
        AttachShell();
    }

    internal void ApplyAppearance(AppearancePayload appearance)
    {
        _appearance.Save(appearance.Preference);
        ApplySavedAppearance();
    }

    /// <summary>
    /// Reports the open file beside the product name, where a document name belongs,
    /// so the Workbench header is free to name the page instead.
    /// </summary>
    internal void ApplyFileName(string? fileName)
    {
        var subtitle = fileName ?? string.Empty;
        if (!string.Equals(AppTitleBar.Subtitle, subtitle, StringComparison.Ordinal))
        {
            AppTitleBar.Subtitle = subtitle;
        }
        // The TitleBar control draws its own Title/Subtitle; Window.Title is what the
        // taskbar and Alt+Tab read, so both need the open file to stay in step.
        var caption = fileName is null ? "Nendo" : $"Nendo — {fileName}";
        if (!string.Equals(Title, caption, StringComparison.Ordinal))
        {
            Title = caption;
        }
        // Keyed on where the file is, not on what the caption says. The caption carries
        // the name alone, and two files can share one: opening C:\work\Plan.nendo and
        // then C:ackups\Plan.nendo leaves the caption identical, so a refresh keyed
        // on it never runs and the second file never reaches the menu — which is exactly
        // the pair the menu goes to the trouble of telling apart by folder.
        var openFile = Page?.Session.CurrentFilePath;
        if (!string.Equals(_jumpListFile, openFile, StringComparison.OrdinalIgnoreCase))
        {
            _jumpListFile = openFile;
            RefreshJumpList();
        }
        RefreshShellState();
    }

    private void CaptureWindowState()
    {
        if (AppWindow.Presenter is not OverlappedPresenter presenter) return;
        if (presenter.State == OverlappedPresenterState.Restored)
            _windowState = new(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height, false);
        else if (presenter.State == OverlappedPresenterState.Maximized && _windowState is not null)
            _windowState = _windowState with { Maximized = true };
        // Minimize retains the last usable bounds and maximized preference.
    }

    internal DesktopAppearanceView GetAppearance() => new(_appearance.Preference,
        Content is FrameworkElement { ActualTheme: ElementTheme.Dark } ? "dark" : "light",
        _appearance.Persisted, _appearance.Notice);

    private void ApplySavedAppearance()
    {
        var requested = _appearance.Preference switch
        {
            "light" => ElementTheme.Light,
            "dark" => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        if (Content is FrameworkElement root)
        {
            root.RequestedTheme = requested;
        }
        AppWindow.TitleBar.PreferredTheme = _appearance.Preference switch
        {
            "light" => TitleBarTheme.Light,
            "dark" => TitleBarTheme.Dark,
            _ => TitleBarTheme.UseDefaultAppMode,
        };
    }

    // ---- The notification area -------------------------------------------------

    private MainPage? Page => RootFrame.Content as MainPage;

    /// <summary>
    /// What this window does when it is closed: the process owner's pin where there is
    /// one, otherwise the saved preference. Read each time rather than cached, so the
    /// tray menu's toggle takes effect on the very next close.
    /// </summary>
    private string CloseAction => DesktopRuntimeConfiguration.CloseAction ?? _shell.CloseAction;

    /// <summary>
    /// Whether the person cannot currently see the window. Both cases count: closing
    /// to the notification area and minimising leave somebody equally unaware, and a
    /// notification that only fired for one of them would be unreliable in the way
    /// that teaches people to ignore notifications.
    /// </summary>
    private bool IsOutOfSight =>
        !AppWindow.IsVisible ||
        AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized };

    private void AttachShell()
    {
        // The third argument is Explorer having restarted: the tray icon puts itself
        // back, and the taskbar button needs its badge back for the same reason.
        _tray = new DesktopTrayIcon(DescribeTray, OnTrayCommand, RestoreTaskbarState);
        var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        DesktopShellIdentity.ApplyToWindow(hwnd);
        _taskbar = new DesktopTaskbarStatus(hwnd);
        _notifier = new DesktopNotifier(route => DispatcherQueue.TryEnqueue(() => RouteFromNotification(route)));
        RefreshShellState();
        // Once at startup as well as on every change, so a file deleted since the last
        // session drops out of the menu without anybody having to open one first.
        RefreshJumpList();

        if (Page is not { } page) return;
        page.RendererFailed += (kind, viewUpSeconds) => DispatcherQueue.TryEnqueue(() =>
        {
            RecordViewFailure(kind, viewUpSeconds);
            Notify(_trigger.OnRendererFailed(page.Session.DescribeShellState().FileName));
        });
        page.RendererStarted += () => DispatcherQueue.TryEnqueue(_trigger.OnRendererStarted);
        page.FileActionRunning += running => DispatcherQueue.TryEnqueue(() => SetTaskbarBusy(fileAction: running));
        page.Session.ProposalWaiting += pending => DispatcherQueue.TryEnqueue(() => OnProposalWaiting(pending));
        page.Session.WriteAuthorityWithdrawn += () => DispatcherQueue.TryEnqueue(
            () => Notify(_trigger.OnWriteAuthorityLost(page.Session.DescribeShellState().FileName)));
        // No notification and no tray change: a write is not an event a person is told
        // about. It goes to the renderer alone, which is the only thing that needs it.
        page.Session.FileCommitted += page.FileChanged;
        page.Session.ExtensionDevelopmentChanged += page.ExtensionDevelopmentChanged;
        // The renderer draws the sentence; the taskbar shows the same thing to somebody
        // whose window is behind another one. Both are told, neither waits on a gate.
        page.Session.AgentWorkChanged += work => DispatcherQueue.TryEnqueue(() =>
        {
            page.AgentWorking(work);
            SetTaskbarBusy(agent: work.Busy);
        });
    }

    private void OnProposalWaiting(int pending)
    {
        var state = ShellState();
        RefreshShellState();
        // Fed through the trigger as well, because a proposal that installs automatic
        // actions is the moment consent starts being outstanding, and the person who
        // is not looking at the window needs both sentences, not one.
        Notify(DesktopNotificationContent.ProposalWaiting(state.FileName, pending));
        Notify(_trigger.Observe(state));
    }

    private bool _fileActionBusy;
    private bool _agentBusy;

    /// <summary>
    /// One taskbar indicator, two things that can be running. Whichever finishes first
    /// must not clear the other's progress -- a file action and an agent overlap easily,
    /// and the version that just called SetBusy(false) turned the indicator off halfway
    /// through the work still in flight.
    /// </summary>
    private void SetTaskbarBusy(bool? fileAction = null, bool? agent = null)
    {
        if (fileAction is { } file) _fileActionBusy = file;
        if (agent is { } working) _agentBusy = working;
        _taskbar?.SetBusy(_fileActionBusy || _agentBusy);
    }

    private DesktopShellState ShellState() => Page?.Session.DescribeShellState() ?? DesktopShellState.None;

    private void Notify(DesktopNotification? notification)
    {
        if (notification is null) return;
        RefreshShellState();
        if (!IsOutOfSight) return;
        if (_notifier is { IsAvailable: true } notifier) notifier.Show(notification);
        else _tray?.ShowBalloon(notification.Title, notification.Body);
    }

    /// <summary>
    /// Puts the open file's state everywhere it belongs outside the window: the
    /// notification-area tooltip, and the badge on the taskbar button. One badge, read
    /// once, so the two can never say different things about the same file.
    /// </summary>
    private void RefreshShellState()
    {
        var state = ShellState();
        var badge = DesktopShellBadge.For(state);
        if (_tray is { IsPresent: true } tray) tray.SetTooltip(badge.Tooltip(state.FileName));
        _taskbar?.Apply(badge);
    }

    /// <summary>
    /// Rebuilds the Recent list Windows shows on the taskbar icon.
    /// <para>
    /// The history read is off the UI thread because it opens every remembered file to
    /// check it is still the same one; the shell write is back on it, because the
    /// destination list is apartment-threaded and this is the thread that owns the
    /// window. Failure is silence: a stale taskbar menu is not worth a message.
    /// </para>
    /// </summary>
    private void RefreshJumpList()
    {
        if (Page is not { } page) return;
        var identity = DesktopShellIdentity.AppUserModelId;
        // The executable that is actually running, not the name it usually has: a
        // Jump List row is a shortcut, and a shortcut to the wrong file opens nothing.
        var executable = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Nendo.Desktop.exe");
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "DocumentIcon.ico");
        _ = Task.Run(async () =>
        {
            IReadOnlyList<DesktopShellRecentFile> files;
            try
            {
                files = await page.Session.GetShellRecentFilesAsync(DesktopJumpList.Considered);
            }
            catch (Exception exception) when (exception is NendoException or ObjectDisposedException
                or IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                return;
            }
            DispatcherQueue.TryEnqueue(() => DesktopJumpList.Publish(files, identity, executable, icon));
        });
    }

    /// <summary>
    /// Keeps what the host knows about a view failure, while the person has asked for it.
    /// <para>
    /// Whether the window was out of sight is added here rather than by the page, because
    /// this is the object that knows: a failure nobody was looking at and a failure in
    /// front of somebody are the same event to the view and different events to a person.
    /// Nothing here can throw into the failure path — the recovery panel is already on its
    /// way up, and a diagnostic that broke it would be the worse defect.
    /// </para>
    /// </summary>
    private void RecordViewFailure(string kind, int viewUpSeconds)
    {
        if (!_shell.RecordViewFailures) return;
        try
        {
            var (availableMb, loadPercent) = DesktopViewFailureLog.MemoryNow();
            _viewFailures.Record(new DesktopViewFailure(
                DateTimeOffset.UtcNow,
                kind,
                viewUpSeconds,
                IsOutOfSight,
                availableMb,
                loadPercent));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    private DesktopTrayMenuState DescribeTray()
    {
        var state = ShellState();
        return new DesktopTrayMenuState(
            state.FileName is null ? "Nendo — no file open" : $"Nendo — {state.FileName}",
            state.FileName is null ? null : state.AgentAccess,
            state.AgentAccessOn,
            CloseAction == "tray",
            _shell.RecordViewFailures);
    }

    private void OnTrayCommand(DesktopTrayCommand command)
    {
        switch (command)
        {
            case DesktopTrayCommand.Open:
                RestoreFromTray();
                break;
            case DesktopTrayCommand.TurnAgentAccessOff:
                // Fire and forget: the menu has already closed, and the Agent page shows
                // the result whenever somebody next looks at it.
                if (Page is { } page) _ = page.Session.TurnAgentAccessOffAsync();
                RefreshShellState();
                break;
            case DesktopTrayCommand.ToggleCloseAction:
                _shell.SetCloseAction(CloseAction == "tray" ? "exit" : "tray");
                break;
            case DesktopTrayCommand.ToggleViewFailureLog:
                _shell.SetRecordViewFailures(!_shell.RecordViewFailures);
                break;
            case DesktopTrayCommand.Exit:
                RequestExit();
                break;
        }
    }

    /// <summary>
    /// The taskbar button is new and bare — hidden and shown again, or Explorer
    /// restarted — so whatever was on it has to be put back rather than remembered.
    /// </summary>
    private void RestoreTaskbarState()
    {
        _taskbar?.Forget();
        RefreshShellState();
    }

    /// <summary>Brings the window back, from the tray or from a notification.</summary>
    internal void RestoreFromTray()
    {
        var wasHidden = !AppWindow.IsVisible;
        if (wasHidden) AppWindow.Show();
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter)
        {
            presenter.Restore();
        }
        Activate();
        _notifier?.ClearAll();
        // Hiding destroyed the taskbar button and showing made a new, bare one. The
        // badge has to be put back on it, and the only reason a person is looking at
        // the window again may be that they saw the badge in the first place.
        if (wasHidden) RestoreTaskbarState();
    }

    private void RouteFromNotification(string route)
    {
        RestoreFromTray();
        if (route == DesktopNotificationContent.RouteOpen) return;
        Page?.RouteTo(route);
    }

    /// <summary>
    /// Ends the session and the process. The one way out that a preference cannot
    /// override, which is what makes closing to the notification area safe to default.
    /// </summary>
    internal void RequestExit()
    {
        _exitRequested = true;
        Close();
    }

    private async void AppWindow_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose)
        {
            return;
        }

        args.Cancel = true;

        if (DesktopCloseAction.Resolve(CloseAction, _exitRequested, _tray?.IsPresent ?? false)
            == DesktopCloseOutcome.Hide)
        {
            if (_windowState is not null) _windowStore.Save(_windowState);
            AppWindow.Hide();
            // Said once per device. The window has just vanished from the taskbar with
            // the file still open and an agent still able to reach it; somebody who was
            // not told that will reasonably conclude Nendo has quit.
            if (!_shell.TrayIntroShown)
            {
                _shell.MarkTrayIntroShown();
                var state = ShellState();
                if (_notifier is { IsAvailable: true } notifier)
                    notifier.Show(DesktopNotificationContent.TrayIntro(state.FileName));
                else
                {
                    var intro = DesktopNotificationContent.TrayIntro(state.FileName);
                    _tray?.ShowBalloon(intro.Title, intro.Body);
                }
            }
            Notify(_trigger.OnHidden(ShellState()));
            return;
        }

        if (_closing)
        {
            return;
        }

        _closing = true;
        if (_windowState is not null) _windowStore.Save(_windowState);
        try
        {
            if (RootFrame.Content is MainPage page)
            {
                await page.ShutdownAsync();
            }
        }
        finally
        {
            _notifier?.Dispose();
            _taskbar?.Dispose();
            _tray?.Dispose();
            _allowClose = true;
            Close();
            Application.Current.Exit();
        }
    }
}
