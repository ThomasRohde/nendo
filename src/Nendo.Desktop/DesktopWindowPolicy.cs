using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Nendo.Desktop;

/// <summary>
/// Where the window opens and how small it may become.
/// <para>
/// The sizes are the page's pixels, the ones the layout is drawn in. AppWindow and the
/// presenter take physical pixels ("like other sizing-related AppWindow APIs,
/// PreferredMinMaxWidthHeight work with screen coordinates", microsoft/microsoft-ui-xaml#10452),
/// so each is multiplied by the display's scale first: handed
/// over as they were, the first window on a screen at 200% opened at half the size and could be
/// shrunk below the layout's own minimum (DSH-14).
/// </para>
/// </summary>
internal static class DesktopWindowPolicy
{
    internal const int DefaultWidth = 1_600;
    internal const int DefaultHeight = 960;
    internal const int MinimumWidth = 1_024;
    internal const int MinimumHeight = 720;

    internal static void Apply(AppWindow appWindow, DesktopWindowState? saved = null)
    {
        var displayArea = saved is null
            ? DisplayArea.GetFromWindowId(appWindow.Id, DisplayAreaFallback.Primary)
            : DisplayArea.GetFromRect(new RectInt32(saved.X, saved.Y, saved.Width, saved.Height), DisplayAreaFallback.Nearest);
        var scale = ScaleOf(displayArea.WorkArea);
        var bounds = saved is null ? FitTo(displayArea.WorkArea, scale) : FitSavedTo(saved, displayArea.WorkArea, scale);
        var minimum = MinimumFor(displayArea.WorkArea, scale);

        if (appWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = minimum.Width;
            presenter.PreferredMinimumHeight = minimum.Height;
        }

        appWindow.MoveAndResize(bounds);
        if (saved?.Maximized == true && appWindow.Presenter is OverlappedPresenter overlapped) overlapped.Maximize();
    }

    /// <summary>
    /// The window's minimum at a new display scale, or null when the scale has not changed.
    /// <para>
    /// The presenter's minimum is in physical pixels and Windows does not rescale it when the
    /// window moves to a screen of another scale (microsoft/microsoft-ui-xaml#10452, open): a
    /// minimum set at a 200% laptop screen would keep the window from shrinking below twice the
    /// layout's minimum on a 100% monitor. So it is set again for each scale the window meets.
    /// </para>
    /// </summary>
    internal static SizeInt32? MinimumAfterScaleChange(RectInt32 workArea, double previousScale, double scale) =>
        previousScale == scale ? null : MinimumFor(workArea, scale);

    /// <summary>Sets the window's minimum for the display it is on now, at <paramref name="scale"/>.</summary>
    internal static void ApplyMinimum(AppWindow appWindow, double previousScale, double scale)
    {
        if (appWindow.Presenter is not OverlappedPresenter presenter) return;
        var workArea = DisplayArea.GetFromWindowId(appWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        if (MinimumAfterScaleChange(workArea, previousScale, scale) is not { } minimum) return;
        presenter.PreferredMinimumWidth = minimum.Width;
        presenter.PreferredMinimumHeight = minimum.Height;
    }

    /// <summary>A saved place, already in physical pixels, kept on the work area and above the minimum.</summary>
    internal static RectInt32 FitSavedTo(DesktopWindowState saved, RectInt32 workArea, double scale = 1.0)
    {
        var minimum = MinimumFor(workArea, scale);
        var width = Math.Clamp(saved.Width, minimum.Width, workArea.Width);
        var height = Math.Clamp(saved.Height, minimum.Height, workArea.Height);
        return new RectInt32(
            (int)Math.Clamp((long)saved.X, workArea.X, (long)workArea.X + workArea.Width - width),
            (int)Math.Clamp((long)saved.Y, workArea.Y, (long)workArea.Y + workArea.Height - height), width, height);
    }

    /// <summary>The first window on a device: the default size at the display's scale, centred, no larger than the work area.</summary>
    internal static RectInt32 FitTo(RectInt32 workArea, double scale = 1.0)
    {
        var width = Math.Min(Physical(DefaultWidth, scale), workArea.Width);
        var height = Math.Min(Physical(DefaultHeight, scale), workArea.Height);
        return new RectInt32(
            workArea.X + ((workArea.Width - width) / 2),
            workArea.Y + ((workArea.Height - height) / 2),
            width,
            height);
    }

    /// <summary>The smallest the window may be made, at the display's scale and no larger than the work area.</summary>
    internal static SizeInt32 MinimumFor(RectInt32 workArea, double scale = 1.0) =>
        new(
            Math.Min(Physical(MinimumWidth, scale), workArea.Width),
            Math.Min(Physical(MinimumHeight, scale), workArea.Height));

    private static int Physical(int pagePixels, double scale) =>
        (int)Math.Round(pagePixels * (double.IsFinite(scale) && scale >= 1.0 ? scale : 1.0));

    /// <summary>
    /// The scale of the display a work area is on: its effective DPI over 96. One when Windows
    /// cannot say, which is the size the window had before scales were applied.
    /// </summary>
    internal static double ScaleOf(RectInt32 workArea)
    {
        try
        {
            var centre = new NativePoint(workArea.X + workArea.Width / 2, workArea.Y + workArea.Height / 2);
            var monitor = MonitorFromPoint(centre, MonitorDefaultToNearest);
            return monitor != 0 && GetDpiForMonitor(monitor, EffectiveDpi, out var dpiX, out _) == 0 && dpiX >= 96 ? dpiX / 96.0 : 1.0;
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException)
        {
            return 1.0;
        }
    }

    private const uint MonitorDefaultToNearest = 2;
    private const int EffectiveDpi = 0;

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct NativePoint(int x, int y)
    {
        public readonly int X = x;
        public readonly int Y = y;
    }

    [DllImport("user32.dll")]
    private static extern nint MonitorFromPoint(NativePoint point, uint flags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(nint monitor, int dpiType, out uint dpiX, out uint dpiY);
}
