using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Nendo.Desktop;

/// <summary>
/// A tab dragged off the strip (ADR-0002): its picture under the pointer, the window of this file
/// whose tabs it is held over, and where it was let go.
/// <para>
/// The page says when the tab leaves the strip and when it comes back or is let go; between the
/// two the window follows the pointer itself, a frame at a time, so the picture keeps up wherever
/// the pointer goes and whatever the page is doing. The window under the pointer is the one
/// Windows would give a click to there, so a window of the file behind another application's is
/// never joined. A drag the page never ends (its renderer gone, the release lost) ends once the
/// button has been up for a second.
/// </para>
/// </summary>
public sealed partial class MainWindow
{
    /// <summary>Raised by every end of a drag, so a picture still being cut for it is never shown.</summary>
    private long _tabDragGeneration;

    private DesktopTabDragPicture? _tabDragPicture;

    /// <summary>How many dashes of the leaving tab's outline the picture's top edge carries, for the journey.</summary>
    private int _tabDragDashes;

    /// <summary>Where the pointer holds the picture, in its physical pixels from its top left.</summary>
    private PointInt32 _tabDragGrab;

    private DispatcherQueueTimer? _tabDragTimer;

    /// <summary>The window whose tabs the drag is held over, and where along them it was last told.</summary>
    private MainWindow? _tabDragTarget;
    private double? _tabDragTargetX;

    private long _tabDragReleasedAt;

    /// <summary>Where the pointer is taken to be, for the journey under native diagnostics; null is the real pointer.</summary>
    private static PointInt32? s_diagnosticPointer;

    /// <summary>Where the last tab let go from this window was let go, and over which window, for the move that follows.</summary>
    private (PointInt32 Point, MainWindow? Target, double? X, long At)? _tabDrop;

    /// <summary>
    /// A drag left the strip: follow the pointer and say which window's tabs it is over. Answers the
    /// drag's generation, which the picture cut for it must still match when it is shown.
    /// </summary>
    internal long StartTabDrag()
    {
        StopTabDrag();
        _tabDrop = null;
        _tabDragReleasedAt = 0;
        _tabDragTimer = DispatcherQueue.CreateTimer();
        _tabDragTimer.Interval = TimeSpan.FromMilliseconds(15);
        _tabDragTimer.Tick += (_, _) => FollowTabDrag();
        _tabDragTimer.Start();
        FollowTabDrag();
        return _tabDragGeneration;
    }

    /// <summary>Show the picture cut for drag <paramref name="generation"/>, unless that drag has ended since.</summary>
    internal void ShowTabDragPicture(long generation, byte[] pixels, int width, int height, PointInt32 grab, int dashes)
    {
        if (generation != _tabDragGeneration || _tabDragTimer is null) return;
        _tabDragDashes = dashes;
        _tabDragPicture?.Dispose();
        _tabDragGrab = grab;
        _tabDragPicture = DesktopTabDragPicture.TryShow(pixels, width, height, PictureAt(CursorOrDefault()));
    }

    /// <summary>
    /// The drag came back to the strip or ended. Let go (<paramref name="dropped"/>), the point and
    /// the window under it are kept for the move the page asks for next.
    /// </summary>
    internal void EndTabDrag(bool dropped)
    {
        if (dropped && TryCursor(out var point))
        {
            var target = DropTargetAt(point);
            _tabDrop = (point, target?.Window, target?.X, Stopwatch.GetTimestamp());
        }
        StopTabDrag();
    }

    private void StopTabDrag()
    {
        _tabDragGeneration++;
        _tabDragTimer?.Stop();
        _tabDragTimer = null;
        _tabDragPicture?.Dispose();
        _tabDragPicture = null;
        HoldOver(null, null);
    }

    private void FollowTabDrag()
    {
        if (!TryCursor(out var point)) return;
        _tabDragPicture?.MoveTo(PictureAt(point));
        var target = DropTargetAt(point);
        HoldOver(target?.Window, target?.X);
        // The page normally ends the drag when the tab is let go; this ends one it never does.
        if (PrimaryButtonDown()) { _tabDragReleasedAt = 0; return; }
        if (_tabDragReleasedAt == 0) _tabDragReleasedAt = Stopwatch.GetTimestamp();
        else if (Stopwatch.GetElapsedTime(_tabDragReleasedAt) > DesktopTabWindowRules.ReleaseGrace) StopTabDrag();
    }

    /// <summary>Tell the window the drag is held over where it would land, and the one it left that it has gone.</summary>
    private void HoldOver(MainWindow? target, double? x)
    {
        if (!ReferenceEquals(target, _tabDragTarget)) (_tabDragTarget?.RootFrame.Content as MainPage)?.ShowTabDropTarget(null);
        else if (target is null || (x is { } now && _tabDragTargetX is { } before && Math.Abs(now - before) < 1)) return;
        _tabDragTarget = target;
        _tabDragTargetX = x;
        if (target?.RootFrame.Content is MainPage page) page.ShowTabDropTarget(x);
    }

    private PointInt32 PictureAt(PointInt32 pointer) => new(pointer.X - _tabDragGrab.X, pointer.Y - _tabDragGrab.Y);

    /// <summary>
    /// The window of this file whose tabs are at <paramref name="point"/>, and where along them in its
    /// page's pixels: the window Windows finds there, if it is another window of this file, showing,
    /// with its page ready, and the point is in its title bar.
    /// </summary>
    private (MainWindow Window, double X)? DropTargetAt(PointInt32 point)
    {
        // A journey's windows may lie behind the person's own, so a pointer the journey placed finds
        // the topmost window of the file there instead; Windows' own answer would be the window in front.
        var under = s_diagnosticPointer is null ? GetAncestor(WindowFromPoint(new CursorPoint { X = point.X, Y = point.Y }), RootAncestor) : TopFileWindowAt(point);
        if (under == 0) return null;
        foreach (var window in OpenFileWindows())
        {
            if (ReferenceEquals(window, this) || window._closing || !window.AppWindow.IsVisible) continue;
            var handle = Win32Interop.GetWindowFromWindowId(window.AppWindow.Id);
            if (handle != under || window.RootFrame.Content is not MainPage { IsReadyForTabs: true }) continue;
            if (window.AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized }) continue;
            var client = ClientArea(handle);
            var bar = window.AppWindow.TitleBar;
            if (!DesktopTabWindowRules.Contains(DesktopTabWindowRules.JoinBand(client, bar.Height, bar.RightInset), point)) return null;
            return (window, DesktopTabWindowRules.PageX(point, client, window.Scale));
        }
        return null;
    }

    /// <summary>
    /// The drag under way in any window of the file, for the journey. With <paramref name="setPoint"/>,
    /// the pointer is taken to be at <paramref name="point"/> in this window's page, or is the real
    /// pointer again when it is null.
    /// </summary>
    internal TabDragDiagnostics DiagnoseTabDrag(bool setPoint, (double X, double Y)? point)
    {
        if (setPoint)
        {
            var client = ClientArea(Win32Interop.GetWindowFromWindowId(AppWindow.Id));
            s_diagnosticPointer = point is { } at
                ? new PointInt32(client.X + (int)Math.Round(at.X * Scale), client.Y + (int)Math.Round(at.Y * Scale)) : null;
            foreach (var window in OpenFileWindows()) if (window._tabDragTimer is not null) window.FollowTabDrag();
        }
        var dragging = OpenFileWindows().FirstOrDefault(window => window._tabDragTimer is not null);
        var picture = dragging?._tabDragPicture;
        var target = dragging?._tabDragTarget;
        return new TabDragDiagnostics(dragging is not null, picture?.Size.Width, picture?.Size.Height, picture?.Shown ?? false,
            picture?.CentreAlpha, target is null ? null : target._isTabWindow ? "tab" : "main", target is null ? null : dragging!._tabDragTargetX,
            picture is null ? null : dragging!._tabDragDashes);
    }

    /// <summary>The window of this file nearest the top of the screen's order whose bounds hold <paramref name="point"/>, this one included.</summary>
    private static nint TopFileWindowAt(PointInt32 point)
    {
        var mine = OpenFileWindows().Select(window => Win32Interop.GetWindowFromWindowId(window.AppWindow.Id)).ToHashSet();
        for (var window = GetTopWindow(0); window != 0; window = GetWindow(window, NextWindow))
        {
            if (!mine.Contains(window) || !IsWindowVisible(window) || !GetWindowRect(window, out var box)) continue;
            if (point.X >= box.Left && point.X < box.Right && point.Y >= box.Top && point.Y < box.Bottom) return window;
        }
        return 0;
    }

    /// <summary>Every window of this file now: the main window and the tab windows.</summary>
    private static IEnumerable<MainWindow> OpenFileWindows() =>
        App.CurrentWindow is { } main ? [main, .. TabWindowList.Where(window => !ReferenceEquals(window, main))] : TabWindowList;

    /// <summary>
    /// Where a tab let go now lands, and the window it joins there, if any: the point the page's
    /// release kept, while it is fresh, or the pointer now.
    /// </summary>
    private (PointInt32 Point, MainWindow? Target, double? X) TakeTabDrop()
    {
        var kept = _tabDrop;
        _tabDrop = null;
        if (kept is { } drop && Stopwatch.GetElapsedTime(drop.At) < DesktopTabWindowRules.DropPointLifetime)
        {
            // The window it was let go over may have closed while the move waited.
            var target = drop.Target is { _closing: false, RootFrame.Content: MainPage { IsReadyForTabs: true } } ? drop.Target : null;
            return (drop.Point, target, target is null ? null : drop.X);
        }
        var point = CursorOrDefault();
        var now = DropTargetAt(point);
        return (point, now?.Window, now?.X);
    }

    /// <summary>
    /// Move a tab out of this window (<c>window.detachTab</c>). Let go over another window's tabs,
    /// it joins that window, which comes to the front; a tab window that gave up its only tab
    /// closes. A tab window's only tab let go anywhere else moves its window there. Any other tab
    /// opens in a window of its own, where it was let go or beside this one.
    /// </summary>
    internal string MoveTab(DesktopSessionController session, string trail, bool atPointer, bool last)
    {
        var drop = atPointer ? TakeTabDrop() : default;
        if (atPointer && drop.Target?.RootFrame.Content is MainPage target)
        {
            target.ReceiveTab(trail, drop.X);
            drop.Target!.Activate();
            if (last) DispatcherQueue.TryEnqueue(() => _ = ShutDownTabWindowAsync());
            return TabMoveOutcome.Joined;
        }
        if (last)
        {
            if (!_isTabWindow) throw new Nendo.Engine.NendoPreconditionException("main-window", "The main window keeps its last tab.");
            MoveWindowTo(drop.Point);
            return TabMoveOutcome.Moved;
        }
        OpenTabWindow(session, trail, atPointer ? drop.Point : null);
        return TabMoveOutcome.Window;
    }

    /// <summary>This window, dragged by its only tab, goes where the tab was let go, the pointer over its tab.</summary>
    private void MoveWindowTo(PointInt32 pointer)
    {
        var fills = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized } ||
            AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
        var home = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        var size = DesktopTabWindowRules.SizeToCarry(AppWindow.Size, fills,
            _windowState is { } before ? new SizeInt32(before.Width, before.Height) : null, home);
        if (AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) AppWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Maximized } presenter) presenter.Restore();
        var area = DisplayArea.GetFromPoint(pointer, DisplayAreaFallback.Nearest).WorkArea;
        AppWindow.MoveAndResize(DesktopTabWindowRules.AtPointer(size, Scale, pointer, area, DesktopWindowPolicy.ScaleOf(area)));
        Activate();
    }

    private static PointInt32 CursorOrDefault() => TryCursor(out var point) ? point : default;

    private static bool TryCursor(out PointInt32 point)
    {
        if (s_diagnosticPointer is { } taken) { point = taken; return true; }
        var found = GetCursorPos(out var cursor);
        point = new PointInt32(cursor.X, cursor.Y);
        return found;
    }

    /// <summary>Whether the button that drags is down: the left one, or the right one when the buttons are swapped.</summary>
    private static bool PrimaryButtonDown() => s_diagnosticPointer is not null ||
        (GetAsyncKeyState(GetSystemMetrics(SwappedButtons) != 0 ? RightButton : LeftButton) & 0x8000) != 0;

    /// <summary>A window's client area on the screen, in physical pixels.</summary>
    private static RectInt32 ClientArea(nint window)
    {
        var origin = new CursorPoint();
        ClientToScreen(window, ref origin);
        GetClientRect(window, out var client);
        return new RectInt32(origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top);
    }

    private const uint RootAncestor = 2;
    private const int SwappedButtons = 23;
    private const int LeftButton = 0x01;
    private const int RightButton = 0x02;

    [DllImport("user32.dll")]
    private static extern nint WindowFromPoint(CursorPoint point);

    [DllImport("user32.dll")]
    private static extern nint GetAncestor(nint window, uint flags);

    private const uint NextWindow = 2;

    [DllImport("user32.dll")]
    private static extern nint GetTopWindow(nint window);


    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(nint window, ref CursorPoint point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(nint window, out NativeRect rect);
}
