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
    private DesktopTaskbarActivity _taskbarActivity = new(null);
    private string? _jumpListFile;
    private readonly DesktopViewFailureLog _viewFailures = new(DesktopViewFailureLog.DefaultRoot);
    private DesktopNotifier? _notifier;
    private DesktopWindowState? _windowState;
    private string? _placementFile;

    public MainWindow() : this(null)
    {
    }

    internal MainWindow(DesktopStartupRequest? startupRequest)
    {
        InitializeComponent();

        AttachTitleBar();
        // Without its icon the window still opens; without the guard it never did (DSH-23).
        DesktopShellSafety.TrySetIcon(AppWindow.SetIcon, Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        // Where this file's window was, when the launch names a file: two files no longer
        // open on the same rectangle, one exactly on top of the other.
        _placementFile = startupRequest?.Path;
        var savedWindow = _windowStore.Load(_placementFile);
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
        // Every window of the file takes the device's theme, and each page draws it (W-277): the
        // page that asked has drawn it already, and drawing it again changes nothing.
        foreach (var window in FileWindows())
        {
            window.ApplyPreference(_appearance.Preference);
            (window.RootFrame.Content as MainPage)?.AppearanceChanged(_appearance.Preference);
        }
    }

    /// <summary>
    /// Names the open file where Windows shows the window without its content, the taskbar
    /// and Alt+Tab, and draws its look there. Inside the window the top bar names the page and
    /// the status bar the file (W-093).
    /// </summary>
    internal void ApplyFileName(string? fileName, NendoResolvedLook? look = null)
    {
        ApplyLook(fileName is null ? null : look);
        var caption = fileName is null ? "Nendo" : $"Nendo — {fileName}";
        if (!string.Equals(Title, caption, StringComparison.Ordinal))
        {
            Title = caption;
        }
        // The Jump List, the saved place, notifications and the badge are the main window's.
        if (_isTabWindow) return;
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
        if (!string.Equals(_placementFile, openFile, StringComparison.OrdinalIgnoreCase))
        {
            // The place this window had belongs to the file it showed until now. The window
            // itself stays where it is: moving it under the pointer because another file
            // opened in it would be worse than the stacking this avoids.
            if (_placementFile is not null && _windowState is not null) _windowStore.Save(_windowState, _placementFile);
            _placementFile = openFile;
        }
        _trigger.OnFileSession(Page?.Session.CurrentFileSessionId);
        _notifier?.FileSessionChanged(Page?.Session.CurrentFileSessionId);
        RefreshShellState();
    }

    private string? _appliedLook = "";

    /// <summary>
    /// Puts the file's look on everything that shows this window without its content: the
    /// window icon (the taskbar thumbnail and Alt+Tab), the notification area and the picture
    /// on a notification (W-089). Inside the window the status bar draws it. Drawn off the UI
    /// thread, once per look on a device, and put back to the plain mark when no file is open.
    /// </summary>
    private void ApplyLook(NendoResolvedLook? look)
    {
        var key = look is null ? null : DesktopFileIcon.KeyFor(look);
        if (string.Equals(_appliedLook, key, StringComparison.Ordinal)) return;
        _appliedLook = key;
        if (look is null)
        {
            ApplyIcons(null);
            return;
        }
        var cache = DesktopFileIcon.CacheRoot(DesktopAppearanceStore.DefaultRoot);
        var mark = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
        var session = Page?.Session;
        var openFile = session?.CurrentFilePath;
        var remembers = !_isTabWindow;
        _ = Task.Run(async () =>
        {
            DesktopFileIconFiles? files = null;
            // A missing icon is a missing convenience; the plain mark stays until one is drawn.
            // A file's own picture that cannot be read or drawn falls back to its tone and letter.
            try
            {
                var picture = look.Icon is { } icon && session is not null ? await session.ReadIconPictureAsync(icon) : null;
                var drawn = picture is null ? look with { Icon = null } : look;
                try { files = await DesktopFileIcon.EnsureAsync(cache, drawn, mark, picture); }
                catch (Exception) when (drawn.Icon is not null) { files = await DesktopFileIcon.EnsureAsync(cache, look with { Icon = null }, mark); }
            }
            catch (Exception) { }
            // The taskbar menu shows each file's own icon once this device has drawn it (W-001).
            var remembered = false;
            if (files is not null && remembers && openFile is not null)
            {
                try { remembered = DesktopFileIconIndex.Remember(cache, openFile, files.Icon); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
            DispatcherQueue.TryEnqueue(() =>
            {
                if (files is not null && string.Equals(_appliedLook, key, StringComparison.Ordinal)) ApplyIcons(files);
                if (remembered && !_closing) RefreshJumpList();
            });
        });
    }

    private void ApplyIcons(DesktopFileIconFiles? files)
    {
        var plain = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
        try
        {
            AppWindow.SetIcon(files?.Icon ?? plain);
        }
        catch (Exception)
        {
            // The window keeps whatever icon it had; nothing about the file depends on it.
        }
        _tray?.SetIcon(files?.Icon ?? plain);
        if (_notifier is { } notifier) notifier.Logo = files?.NotificationImage;
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

    internal DesktopAppearanceView GetAppearance() => _isTabWindow && App.CurrentWindow is { } main
        ? main.GetAppearance()
        : new(_appearance.Preference,
            Content is FrameworkElement { ActualTheme: ElementTheme.Dark } ? "dark" : "light",
            _appearance.Persisted, _appearance.Notice);

    private void ApplySavedAppearance() => ApplyPreference(_appearance.Preference);

    private void ApplyPreference(string preference)
    {
        var requested = preference switch
        {
            "light" => ElementTheme.Light,
            "dark" => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        if (Content is FrameworkElement root)
        {
            root.RequestedTheme = requested;
        }
        AppWindow.TitleBar.PreferredTheme = preference switch
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
        _tray = new DesktopTrayIcon(DescribeTray, OnTrayCommand, RestoreTaskbarState,
            (route, generation) => RouteFromNotification(DesktopNotificationContent.ForFileSession(
                route ?? DesktopNotificationContent.RouteOpen, generation, _notifier?.Generation ?? 0)), EndSession);
        var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        DesktopShellIdentity.ApplyToWindow(hwnd);
        _taskbar = new DesktopTaskbarStatus(hwnd);
        _taskbarActivity = new DesktopTaskbarActivity(_taskbar, (delay, action) =>
        {
            var timer = DispatcherQueue.CreateTimer();
            timer.Interval = delay;
            timer.IsRepeating = false;
            timer.Tick += (_, _) =>
            {
                timer.Stop();
                action();
            };
            timer.Start();
        });
        _notifier = new DesktopNotifier(route => DispatcherQueue.TryEnqueue(() => RouteFromNotification(route)),
            register: DesktopRuntimeConfiguration.WritesShellState);
        // A person looking at the window does not need a notification telling them to look at
        // it, however the window came back: the taskbar left them in place (R2SP-10).
        Activated += (_, args) =>
        {
            if (args.WindowActivationState != WindowActivationState.Deactivated) _notifier?.ClearAll();
        };
        RefreshShellState();
        // Once at startup as well as on every change, so a file deleted since the last
        // session drops out of the menu without anybody having to open one first. Not
        // when the launch names a file: its open refreshes the menu once it lands, and
        // checking every recent file twice while that file is opening slowed the open.
        if (_placementFile is null) RefreshJumpList();

        if (Page is not { } page) return;
        page.HostWindow = this;
        TitleBarChanged += page.TitleBarChanged;
        // Every open, close and replacement, including the recovery panel's own actions and
        // the open a launch asked for, which answer no Workbench request (DSH-11).
        page.Session.FileSessionChanged += () => DispatcherQueue.TryEnqueue(() =>
        {
            if (!_closing) ApplyFileName(page.Session.CurrentFileName, page.Session.CurrentLook);
        });
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
        page.Session.LaunchedAgentChanged += page.LaunchedAgentChanged;
        page.Session.ExtensionDevelopmentChanged += page.ExtensionDevelopmentChanged;
        page.Session.ExtensionSettingsChanged += page.ExtensionSettingsChanged;
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

    /// <summary>A file action or an agent started or stopped; see <see cref="DesktopTaskbarActivity"/>.</summary>
    private void SetTaskbarBusy(bool? fileAction = null, bool? agent = null) =>
        _taskbarActivity.Set(fileAction, agent);

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
        // A lane on an isolated device state would write the person's Jump List (BL-01).
        if (!DesktopRuntimeConfiguration.WritesShellState) return;
        var identity = DesktopShellIdentity.AppUserModelId;
        // The executable that is actually running, not the name it usually has: a
        // Jump List row is a shortcut, and a shortcut to the wrong file opens nothing.
        var executable = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Nendo.Desktop.exe");
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "DocumentIcon.ico");
        var cache = DesktopFileIcon.CacheRoot(DesktopAppearanceStore.DefaultRoot);
        _ = Task.Run(async () =>
        {
            IReadOnlyList<DesktopShellRecentFile> files;
            var fileIcons = DesktopFileIconIndex.Read(cache);
            try
            {
                files = await page.Session.GetShellRecentFilesAsync(DesktopJumpList.Considered);
            }
            catch (Exception exception) when (exception is NendoException or ObjectDisposedException
                or IOException or UnauthorizedAccessException or OperationCanceledException)
            {
                return;
            }
            DispatcherQueue.TryEnqueue(() => DesktopJumpList.Publish(files, identity, executable, icon, fileIcons));
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
    /// <para>
    /// Written off the window's thread: the log waits for the device-wide lock that every window
    /// takes, and the failure that reaches every window at once is the one this keeps, so the
    /// recovery panel waited behind the other windows' lines (R2SP-06, after review). Only the
    /// way out waits for it, since the process ends straight after.
    /// </para>
    /// </summary>
    private void RecordViewFailure(string kind, int viewUpSeconds, bool waitForIt = false)
    {
        // Another window may have switched it off since this one read it (DSH-09).
        _shell.Refresh();
        if (!_shell.RecordViewFailures) return;
        var outOfSight = IsOutOfSight;
        var log = _viewFailures;
        var record = Task.Run(() =>
        {
            try
            {
                var (availableMb, loadPercent) = DesktopViewFailureLog.MemoryNow();
                log.Record(new DesktopViewFailure(DateTimeOffset.UtcNow, kind, viewUpSeconds, outOfSight, availableMb, loadPercent));
            }
            catch (Exception)
            {
            }
        });
        if (waitForIt) record.Wait(TimeSpan.FromSeconds(2));
    }

    private DesktopTrayMenuState DescribeTray()
    {
        // The menu ticks what this device chose, which another window may have changed (DSH-09).
        _shell.Refresh();
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
        _taskbarActivity.ButtonRecreated();
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
        ShowTabWindows();
        Activate();
        // Activate shows the window, but a window that is already showing stays behind whatever
        // is in front of it (owner-reported, 2026-10-01: a file picked from the taskbar's Recent
        // list while its window sat behind others). The Nendo that received the click has
        // allowed this process the foreground (DesktopWindowHandoff.TryShow), so it may take it.
        DesktopNativeMethods.SetForegroundWindow(Win32Interop.GetWindowFromWindowId(AppWindow.Id));
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
        // The way out runs here, not through Close: Window.Close raises no AppWindow.Closing, so
        // the tray's Exit closed this window alone, and a tab window kept the process and its file
        // open without the notification-area icon (W-277, reported 2026-10-17).
        _ = ExitAsync();
    }

    /// <summary>
    /// Windows is ending the session, which closes no window, so the close handler below never
    /// runs (DSH-07). Agent admission stops and the file closes as an exit would close it,
    /// within <see cref="DesktopSessionEnd.Bound"/>, on the window procedure's own thread.
    /// </summary>
    private void EndSession()
    {
        if (_closing) return;
        _closing = true;
        if (_windowState is not null) _windowStore.Save(_windowState, _placementFile);
        if (Page is { } page) DesktopSessionEnd.Drain(() => page.Session.DisposeAsync().AsTask(), DesktopSessionEnd.Bound);
    }

    private async void AppWindow_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose)
        {
            return;
        }

        args.Cancel = true;
        _shell.Refresh();

        if (DesktopCloseAction.Resolve(CloseAction, _exitRequested, _tray?.IsPresent ?? false)
            == DesktopCloseOutcome.Hide)
        {
            if (_windowState is not null) _windowStore.Save(_windowState, _placementFile);
            HideTabWindows();
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

        await ExitAsync();
    }

    /// <summary>
    /// Ends the process: the tab windows, then the session, then the shell's own parts, then this
    /// window and the application. Every way out comes here, the close button and the tray's Exit.
    /// </summary>
    private async Task ExitAsync()
    {
        if (_closing)
        {
            return;
        }

        _closing = true;
        if (_windowState is not null) _windowStore.Save(_windowState, _placementFile);
        try
        {
            // Before the session ends, so no tab window's view is left asking a closed one.
            await CloseTabWindowsAsync();
            // Returned rather than thrown: this handler is async void and the application is
            // already on its way out, so a cleanup failure here ended in a crash report (DSH-19).
            // Kept in the device's failure record when the person records failures, by its kind
            // alone: its message can name a path.
            if (RootFrame.Content is MainPage page && await DesktopShellSafety.ShutdownAsync(page.ShutdownAsync) is { } failure)
                RecordViewFailure($"ShutdownFailed:{failure.GetType().Name}", 0, waitForIt: true);
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
