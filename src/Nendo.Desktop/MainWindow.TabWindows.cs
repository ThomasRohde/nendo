using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Nendo.Desktop;

/// <summary>
/// A window of the same file, opened for one tab (ADR-0002).
/// <para>
/// The process keeps one file and one session; a tab dragged out of the strip, or moved by the
/// command, opens in another window on that session. The window the process started with stays
/// the main window: it alone has the notification area, the taskbar badge, notifications, the Jump
/// List and the file's saved place. A tab window has its own Workbench and so its own tabs, and it
/// lasts as long as its file session: it closes when the file changes under it, hides and shows
/// with the main window, and goes when the process exits.
/// </para>
/// </summary>
public sealed partial class MainWindow
{
    /// <summary>The windows opened for a tab, on the UI thread of the one process.</summary>
    private static readonly List<MainWindow> TabWindowList = [];

    /// <summary>The tab windows open now, for the journey that counts them.</summary>
    internal static IReadOnlyList<MainWindow> TabWindows => TabWindowList;

    /// <summary>A tab window, rather than the window the process started with.</summary>
    private readonly bool _isTabWindow;

    /// <summary>The file session a tab window was opened on: another one means its file is gone.</summary>
    private readonly string? _tabFileSession;

    /// <summary>A tab window the main window hid with itself, to show again with it.</summary>
    private bool _hiddenWithMain;

    /// <summary>What a tab window subscribed to on the shared session, to let go of when it closes.</summary>
    private Action? _detachFromSession;

    /// <summary>A window of <paramref name="session"/>'s file, on one tab's trail, at <paramref name="bounds"/>.</summary>
    private MainWindow(DesktopSessionController session, string trail, RectInt32 bounds)
    {
        _isTabWindow = true;
        _tabFileSession = session.CurrentFileSessionId;
        InitializeComponent();
        AttachTitleBar();
        DesktopShellSafety.TrySetIcon(AppWindow.SetIcon, Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        DesktopWindowPolicy.Apply(AppWindow, new DesktopWindowState(bounds.X, bounds.Y, bounds.Width, bounds.Height, false));
        ApplyPreference(App.CurrentWindow?._appearance.Preference ?? _appearance.Preference);
        AppWindow.Closing += TabWindow_Closing;
        var page = new MainPage(session, trail) { HostWindow = this };
        RootFrame.Content = page;
        // Grouped with the main window on the taskbar: the same file, under the same identity.
        DesktopShellIdentity.ApplyToWindow(Win32Interop.GetWindowFromWindowId(AppWindow.Id));
        AttachTabShell(page, session);
        ApplyFileName(session.CurrentFileName, session.CurrentLook);
    }

    /// <summary>
    /// Opens a window of this file on <paramref name="trail"/>: let go at the pointer, the size of
    /// this window with the pointer over its tab, or by the command, one step down and to the right.
    /// </summary>
    internal void OpenTabWindow(DesktopSessionController session, string trail, bool atPointer)
    {
        // A window that fills the screen hands on the size it had before it did.
        var fills = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized } ||
            AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
        var home = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        var size = DesktopTabWindowRules.SizeToCarry(AppWindow.Size, fills,
            _windowState is { } before ? new SizeInt32(before.Width, before.Height) : null, home);
        RectInt32 bounds;
        if (atPointer && GetCursorPos(out var cursor))
        {
            var pointer = new PointInt32(cursor.X, cursor.Y);
            var area = DisplayArea.GetFromPoint(pointer, DisplayAreaFallback.Nearest).WorkArea;
            bounds = DesktopTabWindowRules.AtPointer(size, Scale, pointer, area, DesktopWindowPolicy.ScaleOf(area));
        }
        else
        {
            var origin = fills ? new PointInt32(home.X, home.Y) : AppWindow.Position;
            bounds = DesktopTabWindowRules.Cascaded(new RectInt32(origin.X, origin.Y, size.Width, size.Height), home, Scale);
        }
        var window = new MainWindow(session, trail, bounds);
        TabWindowList.Add(window);
        window.Activate();
    }

    private void AttachTabShell(MainPage page, DesktopSessionController session)
    {
        TitleBarChanged += page.TitleBarChanged;
        void FileSessionChanged() => DispatcherQueue.TryEnqueue(() =>
        {
            if (_closing) return;
            // Its tabs were places in the file that has gone, as the main window's are cleared with it.
            if (!string.Equals(session.CurrentFileSessionId, _tabFileSession, StringComparison.Ordinal)) _ = ShutDownTabWindowAsync();
            else ApplyFileName(session.CurrentFileName, session.CurrentLook);
        });
        void AgentWorkChanged(Nendo.LocalMcp.NendoAgentWork work) => DispatcherQueue.TryEnqueue(() => page.AgentWorking(work));
        session.FileSessionChanged += FileSessionChanged;
        session.FileCommitted += page.FileChanged;
        session.LaunchedAgentChanged += page.LaunchedAgentChanged;
        session.ExtensionDevelopmentChanged += page.ExtensionDevelopmentChanged;
        session.ExtensionSettingsChanged += page.ExtensionSettingsChanged;
        session.AgentWorkChanged += AgentWorkChanged;
        _detachFromSession = () =>
        {
            TitleBarChanged -= page.TitleBarChanged;
            session.FileSessionChanged -= FileSessionChanged;
            session.FileCommitted -= page.FileChanged;
            session.LaunchedAgentChanged -= page.LaunchedAgentChanged;
            session.ExtensionDevelopmentChanged -= page.ExtensionDevelopmentChanged;
            session.ExtensionSettingsChanged -= page.ExtensionSettingsChanged;
            session.AgentWorkChanged -= AgentWorkChanged;
        };
    }

    private async void TabWindow_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose) return;
        args.Cancel = true;
        await ShutDownTabWindowAsync();
    }

    /// <summary>
    /// Every way a tab window goes: its close button, its file changing, the process ending, and the
    /// journey's diagnostics. It leaves the list, lets go of the session's events and of its own
    /// view, and closes; the main window's page owns the session and ends it.
    /// </summary>
    private async Task ShutDownTabWindowAsync()
    {
        if (_closing) return;
        _closing = true;
        TabWindowList.Remove(this);
        _detachFromSession?.Invoke();
        _detachFromSession = null;
        try
        {
            if (RootFrame.Content is MainPage page) await DesktopShellSafety.ShutdownAsync(page.ShutdownAsync);
        }
        finally
        {
            _allowClose = true;
            Close();
        }
    }

    /// <summary>
    /// Closes a tab window as its close button does, for the journey under native diagnostics. The
    /// main window is closed by the person or the tray, never by a page.
    /// </summary>
    internal void CloseTabWindowForDiagnostics()
    {
        if (!_isTabWindow) throw new Nendo.Engine.NendoPreconditionException("main-window", "Only a tab window closes from its page.");
        DispatcherQueue.TryEnqueue(() => _ = ShutDownTabWindowAsync());
    }

    /// <summary>The main window went into the notification area: its tab windows go with it.</summary>
    private static void HideTabWindows()
    {
        foreach (var window in TabWindowList)
        {
            if (!window.AppWindow.IsVisible) continue;
            window._hiddenWithMain = true;
            window.AppWindow.Hide();
        }
    }

    /// <summary>The main window came back: so do the tab windows it hid.</summary>
    private static void ShowTabWindows()
    {
        foreach (var window in TabWindowList)
        {
            if (!window._hiddenWithMain) continue;
            window._hiddenWithMain = false;
            window.AppWindow.Show();
        }
    }

    /// <summary>The process is ending: every tab window lets go of its view before the session ends.</summary>
    private static async Task CloseTabWindowsAsync()
    {
        foreach (var window in TabWindowList.ToArray()) await window.ShutDownTabWindowAsync();
    }

    /// <summary>Every window of this file, the main window first.</summary>
    private IEnumerable<MainWindow> FileWindows() => [this, .. TabWindowList];

    [StructLayout(LayoutKind.Sequential)]
    private struct CursorPoint
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out CursorPoint point);
}
