using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace Nendo.Desktop;

/// <summary>
/// The window's title bar is Nendo's top bar (W-093; docs/design/console-direction.md).
/// <para>
/// The window draws no title bar of its own. The page fills it from its top edge, and Windows
/// keeps drawing Minimise, Maximise and Close over the top bar's right end, at the tall title
/// bar's 48 pixels, the top bar's own height. Windows moves the window from every part of the
/// title bar's height that has not been passed through to the page, and the page hands over the
/// rectangles of its controls there whenever they move. So a control there is pressed, and the
/// rest of the band is the caption: a drag moves the window, a double-click maximises it, a
/// right-click opens its menu, and the Maximise button offers the snap layouts.
/// </para>
/// </summary>
public sealed partial class MainWindow
{
    private TitleBarView? _titleBar;

    /// <summary>The title bar changed shape: a new display scale, so a new height or new button widths.</summary>
    internal event Action<TitleBarView>? TitleBarChanged;

    private void AttachTitleBar()
    {
        ExtendsContentIntoTitleBar = true;
        // The tall title bar: Windows' buttons are as tall as the top bar they sit on.
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        AppWindow.Changed += (_, args) =>
        {
            if (args.DidSizeChange || args.DidPresenterChange) RefreshTitleBar();
        };
        if (Content is FrameworkElement root)
        {
            root.Loaded += (_, _) =>
            {
                if (root.XamlRoot is { } xamlRoot) xamlRoot.Changed += (_, _) => RefreshTitleBar();
                RefreshTitleBar();
            };
        }
    }

    /// <summary>Physical pixels to one of the page's CSS pixels, which are the window's device-independent pixels.</summary>
    private double Scale => Content is FrameworkElement { XamlRoot: { } root } ? root.RasterizationScale : 1.0;

    /// <summary>The title bar in the page's CSS pixels.</summary>
    internal TitleBarView DescribeTitleBar()
    {
        var scale = Scale;
        var bar = AppWindow.TitleBar;
        return new TitleBarView(bar.Height / scale, bar.LeftInset / scale, bar.RightInset / scale);
    }

    private void RefreshTitleBar()
    {
        var bar = DescribeTitleBar();
        if (bar == _titleBar) return;
        _titleBar = bar;
        TitleBarChanged?.Invoke(bar);
    }

    private InputNonClientPointerSource NonClient => InputNonClientPointerSource.GetForWindowId(AppWindow.Id);

    /// <summary>
    /// Passes the page's controls in the title bar through to the page; the rest of the bar stays
    /// the caption. <paramref name="pageLeft"/> and <paramref name="pageTop"/> are where the page
    /// starts in the window, in its pixels.
    /// </summary>
    internal TitleBarView SetTitleBarControls(IReadOnlyList<TitleBarRect> controls, double pageLeft, double pageTop)
    {
        var size = AppWindow.ClientSize;
        var pixels = DesktopTitleBarRegions.ToPixels(controls, Scale, pageLeft, pageTop, size.Width, size.Height);
        if (pixels.Count == 0) NonClient.ClearRegionRects(NonClientRegionKind.Passthrough);
        else NonClient.SetRegionRects(NonClientRegionKind.Passthrough, [.. pixels.Select(p => new RectInt32(p.X, p.Y, p.Width, p.Height))]);
        return DescribeTitleBar();
    }

    /// <summary>No page, so no controls: the whole title bar moves the window again, over the recovery panel too.</summary>
    internal void ClearTitleBarControls() => NonClient.ClearRegionRects(NonClientRegionKind.Passthrough);

    /// <summary>
    /// The title bar as Windows holds it, and what Windows answers at each point of the page: the
    /// window a press there reaches and its hit-test code, 1 for the page, 2 for the caption, and
    /// 8, 9 and 20 for Minimise, Maximise and Close. For the journey that measures it, under native
    /// diagnostics.
    /// </summary>
    internal TitleBarDiagnosticsView DiagnoseTitleBar(IReadOnlyList<TitleBarRect> points, double pageLeft, double pageTop)
    {
        var scale = Scale;
        var size = AppWindow.ClientSize;
        var window = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        // A kind with no rectangles, as the passthrough is once the page claims nothing, reads as none.
        TitleBarRect[] Regions(NonClientRegionKind kind) => [.. (NonClient.GetRegionRects(kind) ?? []).Select(r =>
            DesktopTitleBarRegions.ToPage(new TitleBarPixels(r.X, r.Y, r.Width, r.Height), scale, pageLeft, pageTop))];
        var hits = points.Select(point =>
        {
            var at = new NativePoint((int)Math.Round((point.X + pageLeft) * scale), (int)Math.Round((point.Y + pageTop) * scale));
            ClientToScreen(window, ref at);
            return HitTest(window, at);
        }).ToArray();
        return new TitleBarDiagnosticsView(scale, pageLeft, pageTop, size.Width / scale, size.Height / scale, DescribeTitleBar(),
            Regions(NonClientRegionKind.Caption), Regions(NonClientRegionKind.Passthrough), hits);
    }

    /// <summary>Gives the client area a size in the page's pixels, below the usual minimum if asked. Diagnostics only.</summary>
    internal void ResizeClient(double width, double height)
    {
        var scale = Scale;
        var target = new SizeInt32((int)Math.Round(width * scale), (int)Math.Round(height * scale));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            if (presenter.State != OverlappedPresenterState.Restored) presenter.Restore();
            presenter.PreferredMinimumWidth = Math.Min(presenter.PreferredMinimumWidth ?? target.Width, target.Width);
            presenter.PreferredMinimumHeight = Math.Min(presenter.PreferredMinimumHeight ?? target.Height, target.Height);
        }
        AppWindow.ResizeClient(target);
    }

    /// <summary>
    /// What a press at a screen point reaches, found as Windows finds it: the window's visible
    /// children from the top of the z-order down, past each that answers transparent (the caption
    /// strip does over a control passed through), and the window itself when none answers.
    /// </summary>
    private static TitleBarHit HitTest(nint window, NativePoint at)
    {
        var lParam = (nint)(((at.Y & 0xFFFF) << 16) | (at.X & 0xFFFF));
        for (var child = GetWindow(window, GwChild); child != 0; child = GetWindow(child, GwHwndNext))
        {
            if (!IsWindowVisible(child) || !GetWindowRect(child, out var bounds) ||
                at.X < bounds.Left || at.X >= bounds.Right || at.Y < bounds.Top || at.Y >= bounds.Bottom) continue;
            var code = (int)SendMessage(child, WmNcHitTest, 0, lParam);
            if (code != HtTransparent) return new TitleBarHit(ClassOf(child), code);
        }
        return new TitleBarHit(ClassOf(window), (int)SendMessage(window, WmNcHitTest, 0, lParam));
    }

    private static string ClassOf(nint window)
    {
        var name = new char[256];
        var length = GetClassName(window, name, name.Length);
        return new string(name, 0, Math.Max(0, length));
    }

    private const uint WmNcHitTest = 0x0084;
    private const int HtTransparent = -1;
    private const uint GwHwndNext = 2;
    private const uint GwChild = 5;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern nint GetWindow(nint window, uint command);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint window, out NativeRect rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, char[] name, int length);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint(int x, int y)
    {
        public int X = x;
        public int Y = y;
    }

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(nint window, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint window, uint message, nint wParam, nint lParam);
}
