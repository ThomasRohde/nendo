using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Where the page's controls are in the window's title bar (W-093), so Windows moves the window
    /// from the rest of it. Answered with the title bar itself: its height and the width Windows
    /// keeps at each end for its own buttons.
    /// </summary>
    internal const string WindowSetTitleBarControls = "window.setTitleBarControls";

    /// <summary>
    /// The title bar as Windows holds it and what it answers at points of the page. Answered only
    /// when NENDO_NATIVE_DIAGNOSTICS=1, for the journey that measures it.
    /// </summary>
    internal const string DiagnosticsTitleBar = "diagnostics.titleBar";

    /// <summary>Give the window's client area a size, for the journey that measures a narrow window. Diagnostics only.</summary>
    internal const string DiagnosticsResizeWindow = "diagnostics.resizeWindow";
}

/// <summary>A rectangle of the page in its CSS pixels, from the page's top left.</summary>
internal sealed record TitleBarRect(double X, double Y, double Width, double Height);

/// <summary>
/// The window's title bar in the page's CSS pixels (W-093): how tall it is, and how much of its
/// width Windows keeps for its own buttons at the left and at the right.
/// </summary>
internal sealed record TitleBarView(double Height, double Left, double Right);

/// <summary>What a press at one point reaches: the window's class and its hit-test code.</summary>
internal sealed record TitleBarHit(string Window, int Code);

/// <summary>
/// What the journey measures: the page's place in the window, the title bar, the regions Windows
/// holds (in the page's CSS pixels) and what a press reaches at each point asked about.
/// </summary>
internal sealed record TitleBarDiagnosticsView(
    double Scale,
    double PageLeft,
    double PageTop,
    double ClientWidth,
    double ClientHeight,
    TitleBarView Bar,
    IReadOnlyList<TitleBarRect> Caption,
    IReadOnlyList<TitleBarRect> Passthrough,
    IReadOnlyList<TitleBarHit> Hits);

/// <summary>What the title bar needs from the page that owns the window and its WebView.</summary>
internal interface IWorkbenchWindowHost
{
    /// <summary>Hand Windows the rectangles of the page's controls in the title bar; answers the title bar.</summary>
    TitleBarView SetTitleBarControls(IReadOnlyList<TitleBarRect> controls);

    /// <summary>The title bar as Windows holds it, and its hit-test code at each point of the page.</summary>
    TitleBarDiagnosticsView DiagnoseTitleBar(IReadOnlyList<TitleBarRect> points);

    /// <summary>Give the window's client area this size, in the page's CSS pixels.</summary>
    TitleBarDiagnosticsView ResizeWindow(double width, double height);
}

/// <summary>A rectangle of the window's client area in physical pixels.</summary>
internal readonly record struct TitleBarPixels(int X, int Y, int Width, int Height);

/// <summary>
/// The page's rectangles, checked and turned into what Windows is handed. A pure function of the
/// page's numbers and the window's scale and size, so a test can hold it without a window.
/// </summary>
internal static class DesktopTitleBarRegions
{
    /// <summary>More than a top bar holds with every control a rectangle of its own.</summary>
    internal const int MaximumControls = 64;

    private const double Limit = 100_000;

    /// <summary>The <c>controls</c> of a request: at most <see cref="MaximumControls"/> rectangles of finite numbers.</summary>
    internal static IReadOnlyList<TitleBarRect> ReadControls(JsonElement payload) => ReadRects(payload, "controls", true);

    /// <summary>The <c>points</c> of a diagnostics request, each a rectangle whose size is ignored.</summary>
    internal static IReadOnlyList<TitleBarRect> ReadPoints(JsonElement payload) => ReadRects(payload, "points", false);

    private static IReadOnlyList<TitleBarRect> ReadRects(JsonElement payload, string name, bool sized)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(name, out var list) || list.ValueKind != JsonValueKind.Array)
            throw new NendoValidationException($"Request property {name} must be a list.");
        if (list.GetArrayLength() > MaximumControls)
            throw new NendoValidationException($"A title bar takes at most {MaximumControls} rectangles.");
        var rects = new List<TitleBarRect>();
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw new NendoValidationException($"Each of {name} must be an object.");
            var x = Number(item, "x");
            var y = Number(item, "y");
            var width = sized ? Number(item, "width") : 0;
            var height = sized ? Number(item, "height") : 0;
            if (width < 0 || height < 0) throw new NendoValidationException("A rectangle cannot have a negative size.");
            rects.Add(new TitleBarRect(x, y, width, height));
        }
        return rects;
    }

    private static double Number(JsonElement item, string name)
    {
        if (!item.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) ||
            !double.IsFinite(number) || Math.Abs(number) > Limit)
            throw new NendoValidationException($"Rectangle property {name} must be a finite number.");
        return number;
    }

    /// <summary>
    /// The page's rectangles in the client area's physical pixels, grown outwards to whole
    /// pixels so a control's edge is never left to the window, clipped to the client area, and
    /// without the ones that are left empty.
    /// </summary>
    internal static IReadOnlyList<TitleBarPixels> ToPixels(
        IReadOnlyList<TitleBarRect> rects, double scale, double pageLeft, double pageTop, int clientWidth, int clientHeight)
    {
        var result = new List<TitleBarPixels>(rects.Count);
        foreach (var rect in rects)
        {
            var left = Math.Max(0, (int)Math.Floor((rect.X + pageLeft) * scale));
            var top = Math.Max(0, (int)Math.Floor((rect.Y + pageTop) * scale));
            var right = Math.Min(clientWidth, (int)Math.Ceiling((rect.X + pageLeft + rect.Width) * scale));
            var bottom = Math.Min(clientHeight, (int)Math.Ceiling((rect.Y + pageTop + rect.Height) * scale));
            if (right > left && bottom > top) result.Add(new TitleBarPixels(left, top, right - left, bottom - top));
        }
        return result;
    }

    /// <summary>Physical pixels of the client area back in the page's CSS pixels.</summary>
    internal static TitleBarRect ToPage(TitleBarPixels pixels, double scale, double pageLeft, double pageTop) =>
        new(pixels.X / scale - pageLeft, pixels.Y / scale - pageTop, pixels.Width / scale, pixels.Height / scale);
}

internal sealed partial class WorkbenchProtocolHandler
{
    private IWorkbenchWindowHost WindowHost() => _windowHost ?? throw new NendoPreconditionException(
        "window-unavailable", "The window is not available.");

    private TitleBarView SetTitleBarControls(JsonElement payload) =>
        WindowHost().SetTitleBarControls(DesktopTitleBarRegions.ReadControls(payload));

    private TitleBarDiagnosticsView DiagnoseTitleBar(JsonElement payload) =>
        WindowHost().DiagnoseTitleBar(DesktopTitleBarRegions.ReadPoints(payload));

    private TitleBarDiagnosticsView ResizeWindow(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("width", out var width) || !width.TryGetDouble(out var w) ||
            !payload.TryGetProperty("height", out var height) || !height.TryGetDouble(out var h) ||
            w is < 320 or > 10_000 || h is < 240 or > 10_000)
            throw new NendoValidationException("A window is between 320 × 240 and 10000 × 10000.");
        return WindowHost().ResizeWindow(w, h);
    }
}
