using System.Text.Json;
using Nendo.Engine;
using Windows.Graphics;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Open a tab in a window of its own (ADR-0002). The page hands over the tab's
    /// trail as an opaque string, which the host never reads, and whether the window opens at the
    /// pointer (the tab was let go outside the window) or beside this one (the command).
    /// </summary>
    internal const string WindowDetachTab = "window.detachTab";

    /// <summary>
    /// Which window this page is in, and the trail of the tab it was opened for. A tab window
    /// answers the trail once; a second ask, and the main window, answer none.
    /// </summary>
    internal const string WindowTakeTab = "window.takeTab";

    /// <summary>
    /// A tab is being dragged off the strip: the host shows a picture of it under the pointer, cut
    /// from what the page last drew at the tab's box, until <c>window.endTabDrag</c>.
    /// </summary>
    internal const string WindowBeginTabDrag = "window.beginTabDrag";

    /// <summary>
    /// The tab came back to the strip, or was let go. Let go (<c>dropped</c>), the host keeps where
    /// the pointer was and over which window, for the <c>window.detachTab</c> that follows.
    /// </summary>
    internal const string WindowEndTabDrag = "window.endTabDrag";

    /// <summary>Close this page's tab window as its close button does. Answered only when NENDO_NATIVE_DIAGNOSTICS=1.</summary>
    internal const string DiagnosticsCloseWindow = "diagnostics.closeWindow";

    /// <summary>End the process as the tray's Exit does. Answered only when NENDO_NATIVE_DIAGNOSTICS=1.</summary>
    internal const string DiagnosticsExit = "diagnostics.exit";

    /// <summary>
    /// The drag under way in any window of the file: whether it follows the pointer, its picture,
    /// and the window it is held over. With <c>point</c> (this page's pixels), the pointer is taken
    /// to be there until <c>point</c> is null, so a journey drags without the real pointer, which
    /// needs the foreground. Answered only when NENDO_NATIVE_DIAGNOSTICS=1.
    /// </summary>
    internal const string DiagnosticsTabDrag = "diagnostics.tabDrag";
}

/// <summary>What a page learns about its window: <c>main</c> or <c>tab</c>, and a tab window's trail once.</summary>
internal sealed record TabWindowStart(string Role, string? Trail);

/// <summary>What became of a tab let go: a window of its own, another window's, or its only window moved there.</summary>
internal static class TabMoveOutcome
{
    internal const string Window = "window";
    internal const string Joined = "joined";
    internal const string Moved = "moved";
}

/// <summary>
/// A drag as the host holds it, for the journey: whether it follows the pointer, the picture's
/// size in physical pixels and whether Windows shows it, how opaque its middle is, and the role of
/// the window it is held over and where along that window's tabs.
/// </summary>
internal sealed record TabDragDiagnostics(bool Following, int? PictureWidth, int? PictureHeight, bool PictureShown,
    int? CentreAlpha, string? Target, double? TargetX, int? OutlineDashes);

/// <summary>A colour the page draws with, as red, green and blue.</summary>
internal readonly record struct TabColour(byte R, byte G, byte B);

/// <summary>
/// The tab a picture is cut for: its box and where it was pressed, in the page's pixels, the
/// viewport they are measured in, and the colours and corner the strip draws a tab with.
/// </summary>
internal sealed record TabDragPicture(double X, double Y, double Width, double Height, double GrabX, double GrabY,
    double ViewportWidth, double ViewportHeight, TabColour Background, TabColour Border, double Radius,
    TabColour? Outline = null, double OutlineWidth = 0);

/// <summary>What the bridge needs from the window a page is in to move a tab out of it.</summary>
internal interface IWorkbenchTabWindowHost
{
    /// <summary>Whether this page is in a tab window rather than the window the process started with.</summary>
    bool IsTabWindow { get; }

    /// <summary>
    /// Move a tab on <paramref name="trail"/> out of this window: let go over another window of the
    /// file's tabs, into that window; otherwise into a new one at the pointer, or beside this one.
    /// <paramref name="last"/> is a tab window's only tab, which moves this window rather than
    /// opening another. Answers a <see cref="TabMoveOutcome"/>.
    /// </summary>
    string DetachTab(string trail, bool atPointer, bool last);

    /// <summary>Show the dragged tab's picture under the pointer, cut from what the page last drew.</summary>
    Task BeginTabDragAsync(TabDragPicture picture);

    /// <summary>The drag ended or came back to the strip; <paramref name="dropped"/> keeps the drop point.</summary>
    void EndTabDrag(bool dropped);

    /// <summary>The drag under way; <paramref name="point"/>, when set, is where the pointer is taken to be. Diagnostics only.</summary>
    TabDragDiagnostics DiagnoseTabDrag(bool setPoint, (double X, double Y)? point);

    /// <summary>The window's role, and the trail it was opened for the first time it is asked.</summary>
    TabWindowStart TakeTab();

    /// <summary>Close this tab window as its close button does; refused in the main window. Diagnostics only.</summary>
    void CloseWindow();

    /// <summary>End the process as the tray's Exit does, from any window. Diagnostics only.</summary>
    void Exit();
}

/// <summary>
/// The rules a tab window keeps, kept apart from the window so a test can hold them: how large a
/// trail may be, which file actions are the main window's, and where a new window opens.
/// </summary>
internal static class DesktopTabWindowRules
{
    /// <summary>
    /// The most a trail may hold. A trail is 50 places at most (navigation-trail.ts), and it travels
    /// as a string inside a bridge message of at most 262,144 characters.
    /// </summary>
    internal const int MaximumTrailCharacters = 200_000;

    /// <summary>Where the pointer holds the new window, in the page's pixels from its top left: over its tab.</summary>
    internal const int GrabX = 140;
    internal const int GrabY = 24;

    /// <summary>How far a window opened by the command stands from the one it came from, in the page's pixels.</summary>
    internal const int Cascade = 32;

    /// <summary>
    /// How long a drop point is kept for the move it was taken for. A move waits for an action that
    /// is running when the tab is let go; one that waits longer opens where the pointer is then.
    /// </summary>
    internal static readonly TimeSpan DropPointLifetime = TimeSpan.FromSeconds(30);

    /// <summary>How long the mouse button may be up during a drag before the host ends it, in case the page never says so.</summary>
    internal static readonly TimeSpan ReleaseGrace = TimeSpan.FromSeconds(1);

    /// <summary>How opaque the dragged tab's picture is drawn, out of 255: a little see-through, as Windows draws a dragged item.</summary>
    internal const byte PictureOpacity = 235;

    /// <summary>The largest picture a tab is cut to, in physical pixels: a tab at 400% is well within it.</summary>
    internal const int MaximumPictureSide = 2_048;

    /// <summary>The picture's request, checked: a box inside a viewport, finite and positive, and three colours.</summary>
    internal static TabDragPicture ReadPicture(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object) throw new NendoValidationException("A tab's picture needs its box.");
        var box = Member(payload, "box");
        var grab = Member(payload, "grab");
        var viewport = Member(payload, "viewport");
        var picture = new TabDragPicture(Number(box, "x"), Number(box, "y"), Number(box, "width"), Number(box, "height"),
            Number(grab, "x"), Number(grab, "y"), Number(viewport, "width"), Number(viewport, "height"),
            Colour(payload, "background"), Colour(payload, "border"),
            payload.TryGetProperty("radius", out var radius) && radius.ValueKind == JsonValueKind.Number && radius.GetDouble() is var r && double.IsFinite(r) ? Math.Clamp(r, 0, 64) : 0,
            payload.TryGetProperty("outline", out _) ? Colour(payload, "outline") : null,
            payload.TryGetProperty("outlineWidth", out var thick) && thick.ValueKind == JsonValueKind.Number && thick.GetDouble() is var t && double.IsFinite(t) ? Math.Clamp(t, 0, 8) : 0);
        if (picture.Width <= 0 || picture.Height <= 0 || picture.ViewportWidth <= 0 || picture.ViewportHeight <= 0 ||
            picture.Width > picture.ViewportWidth || picture.Height > picture.ViewportHeight)
            throw new NendoValidationException("A tab's box must lie in its viewport.");
        return picture;
    }

    private static JsonElement Member(JsonElement value, string name) =>
        value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.Object ? member
            : throw new NendoValidationException($"Request property {name} must be an object.");

    private static double Number(JsonElement value, string name) =>
        value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.Number && member.GetDouble() is var number && double.IsFinite(number) && Math.Abs(number) < 100_000
            ? number : throw new NendoValidationException($"Request property {name} must be a finite number.");

    private static TabColour Colour(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var member) || member.ValueKind != JsonValueKind.Array || member.GetArrayLength() != 3)
            throw new NendoValidationException($"Request property {name} must be three numbers.");
        var parts = member.EnumerateArray().Select(part => part.ValueKind == JsonValueKind.Number && part.GetDouble() is var channel && double.IsFinite(channel)
            ? (byte)Math.Clamp(Math.Round(channel), 0, 255) : throw new NendoValidationException($"Request property {name} must be three numbers.")).ToArray();
        return new TabColour(parts[0], parts[1], parts[2]);
    }

    /// <summary>
    /// The part of a capture <paramref name="captureWidth"/> by <paramref name="captureHeight"/> that
    /// shows the tab, at <paramref name="scale"/> capture pixels to one of the page's; null when the
    /// box falls outside it.
    /// </summary>
    internal static RectInt32? PictureBounds(TabDragPicture picture, double scale, int captureWidth, int captureHeight)
    {
        if (!double.IsFinite(scale) || scale <= 0) return null;
        var left = Math.Clamp((int)Math.Floor(picture.X * scale), 0, captureWidth);
        var top = Math.Clamp((int)Math.Floor(picture.Y * scale), 0, captureHeight);
        var right = Math.Clamp((int)Math.Ceiling((picture.X + picture.Width) * scale), 0, captureWidth);
        var bottom = Math.Clamp((int)Math.Ceiling((picture.Y + picture.Height) * scale), 0, captureHeight);
        var width = Math.Min(right - left, MaximumPictureSide);
        var height = Math.Min(bottom - top, MaximumPictureSide);
        return width > 0 && height > 0 ? new RectInt32(left, top, width, height) : null;
    }

    /// <summary>
    /// The dragged tab's picture: the tab as the page drew it (<paramref name="tab"/>, premultiplied
    /// BGRA rows) over a tab's background with a one-pixel border, its corners rounded to
    /// <paramref name="radius"/>, so a tab not on screen, drawn on the window's backdrop, is a whole
    /// tab under the pointer too. Premultiplied BGRA, as a layered window takes it.
    /// </summary>
    internal static byte[] ComposePicture(ReadOnlySpan<byte> tab, int width, int height, TabColour background, TabColour border, int radius,
        TabColour? outline = null, int outlineWidth = 0)
    {
        if (width <= 0 || height <= 0 || tab.Length != width * height * 4) throw new ArgumentException("The picture's pixels do not match its size.");
        radius = Math.Clamp(radius, 0, Math.Min(width, height) / 2);
        var picture = new byte[tab.Length];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var (cover, edge) = Shape(x + 0.5, y + 0.5, width, height, radius);
                if (cover <= 0) continue;
                var at = (y * width + x) * 4;
                // The strip's dashed outline for a tab that is leaving, drawn over the tab as the strip draws it.
                if (outline is { } dash && Dashed(x + 0.5, y + 0.5, width, height, radius, outlineWidth))
                {
                    picture[at] = Scale(dash.B, cover);
                    picture[at + 1] = Scale(dash.G, cover);
                    picture[at + 2] = Scale(dash.R, cover);
                    picture[at + 3] = Scale(255, cover);
                    continue;
                }
                var fill = edge ? border : background;
                var keep = 255 - tab[at + 3];
                // The tab over an opaque fill is opaque; the shape's edge then lets it fade out.
                picture[at] = Scale(tab[at] + fill.B * keep / 255, cover);
                picture[at + 1] = Scale(tab[at + 1] + fill.G * keep / 255, cover);
                picture[at + 2] = Scale(tab[at + 2] + fill.R * keep / 255, cover);
                picture[at + 3] = Scale(255, cover);
            }
        }
        return picture;
    }

    /// <summary>How much of the pixel centred at (<paramref name="x"/>, <paramref name="y"/>) a rounded box covers, and whether it is on the box's edge.</summary>
    private static (double Cover, bool Edge) Shape(double x, double y, int width, int height, int radius)
    {
        var cx = x < radius ? radius : x > width - radius ? width - radius : x;
        var cy = y < radius ? radius : y > height - radius ? height - radius : y;
        if (cx != x && cy != y && radius > 0)
        {
            var inside = radius - Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
            return (Math.Clamp(inside + 0.5, 0, 1), inside < 1);
        }
        return (1, x < 1 || y < 1 || x > width - 1 || y > height - 1);
    }

    /// <summary>
    /// Whether the pixel centred at (<paramref name="x"/>, <paramref name="y"/>) is on a dash of an
    /// outline <paramref name="thickness"/> wide just inside a rounded box's edge: dashes and gaps
    /// three times as long as the outline is wide, measured along the edge from the top left.
    /// </summary>
    private static bool Dashed(double x, double y, int width, int height, int radius, int thickness)
    {
        if (thickness <= 0) return false;
        double inside;
        var cx = x < radius ? radius : x > width - radius ? width - radius : x;
        var cy = y < radius ? radius : y > height - radius ? height - radius : y;
        if (cx != x && cy != y && radius > 0) inside = radius - Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        else inside = Math.Min(Math.Min(x, width - x), Math.Min(y, height - y));
        if (inside < 0 || inside >= thickness) return false;
        // Along the edge nearest the pixel, clockwise from the top left corner.
        var top = y; var right = width - x; var bottom = height - y; var left = x;
        var nearest = Math.Min(Math.Min(top, right), Math.Min(bottom, left));
        var along = nearest == top ? x : nearest == right ? width + y : nearest == bottom ? width + height + (width - x) : 2.0 * width + height + (height - y);
        return (int)(along / (3 * thickness)) % 2 == 0;
    }

    /// <summary>How many dashes of <paramref name="outline"/> run along a picture's top row: what the journey reads of the outline.</summary>
    internal static int DashesAlongTop(ReadOnlySpan<byte> picture, int width, TabColour? outline)
    {
        if (outline is not { } dash || width <= 0 || picture.Length < width * 4) return 0;
        var dashes = 0;
        var on = false;
        for (var x = 0; x < width; x++)
        {
            var at = x * 4;
            var now = picture[at + 3] == 255 && picture[at] == dash.B && picture[at + 1] == dash.G && picture[at + 2] == dash.R;
            if (now && !on) dashes++;
            on = now;
        }
        return dashes;
    }

    private static byte Scale(int channel, double cover) => (byte)Math.Clamp(Math.Round(Math.Min(channel, 255) * cover), 0, 255);

    /// <summary>
    /// The band of a window, in physical pixels, that a tab from another window joins it over: its
    /// title bar, where its tabs are, short of Windows' buttons. <paramref name="client"/> is the
    /// window's client area on the screen.
    /// </summary>
    internal static RectInt32 JoinBand(RectInt32 client, int titleBarHeight, int rightInset) =>
        new(client.X, client.Y, Math.Max(0, client.Width - Math.Max(0, rightInset)), Math.Max(0, Math.Min(titleBarHeight, client.Height)));

    internal static bool Contains(RectInt32 area, PointInt32 point) =>
        point.X >= area.X && point.Y >= area.Y && point.X < area.X + area.Width && point.Y < area.Y + area.Height;

    /// <summary>Where <paramref name="point"/> falls in a window's page, in its pixels from the left of <paramref name="client"/>.</summary>
    internal static double PageX(PointInt32 point, RectInt32 client, double scale) => (point.X - client.X) / Positive(scale);

    /// <summary>
    /// The file actions that open, close or replace the file, and so switch the session every window
    /// of it shows. Only the main window offers them: a tab window closes when its file changes, and
    /// a switch made from one would leave the main window drawing a file that is no longer open.
    /// </summary>
    internal static readonly IReadOnlySet<string> MainWindowOnly = new HashSet<string>(StringComparer.Ordinal)
    {
        WorkbenchMethods.SessionCreateFile, WorkbenchMethods.SessionOpenFile,
        WorkbenchMethods.FileOpenRecent, WorkbenchMethods.FileOpenDropped, WorkbenchMethods.FileClose,
        WorkbenchMethods.FileNewFile, WorkbenchMethods.FileDuplicate, WorkbenchMethods.FileFork,
        WorkbenchMethods.FileRestore, WorkbenchMethods.FileUpgrade, WorkbenchMethods.FileResolveRecovery,
    };

    /// <summary>The trail of a <c>window.detachTab</c>: a non-empty string no longer than <see cref="MaximumTrailCharacters"/>.</summary>
    internal static string ReadTrail(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("trail", out var trail) || trail.ValueKind != JsonValueKind.String)
            throw new NendoValidationException("Request property trail must be a string.");
        var text = trail.GetString()!;
        if (text.Length == 0) throw new NendoValidationException("A tab's trail cannot be empty.");
        if (text.Length > MaximumTrailCharacters)
            throw new NendoValidationException($"A tab's trail holds at most {MaximumTrailCharacters:N0} characters.");
        return text;
    }

    /// <summary>
    /// A window let go at <paramref name="pointer"/>: the size of the window it came from, at the
    /// scale of the screen it lands on, with the pointer over its tab, and kept on that screen's work
    /// area. Every number is physical pixels except the source's size, which is turned into the
    /// page's pixels at <paramref name="sourceScale"/> first, so a window dragged from a 150% laptop
    /// to a 100% monitor keeps the size it showed.
    /// </summary>
    internal static RectInt32 AtPointer(SizeInt32 sourceSize, double sourceScale, PointInt32 pointer, RectInt32 workArea, double scale)
    {
        var width = Physical(sourceSize.Width / Positive(sourceScale), scale);
        var height = Physical(sourceSize.Height / Positive(sourceScale), scale);
        var place = new DesktopWindowState(pointer.X - Physical(GrabX, scale), pointer.Y - Physical(GrabY, scale), width, height, false);
        return DesktopWindowPolicy.FitSavedTo(place, workArea, scale);
    }

    /// <summary>
    /// The size a new window takes from the one it came from: its own, or, when that window fills
    /// the screen (maximised or full screen), the size it had before, so the new window does not
    /// cover the screen in turn. With no smaller size known, three quarters of the screen. Physical
    /// pixels of the source's screen.
    /// </summary>
    internal static SizeInt32 SizeToCarry(SizeInt32 current, bool fillsScreen, SizeInt32? restored, RectInt32 workArea)
    {
        if (!fillsScreen) return current;
        if (restored is { } before && before.Width < workArea.Width && before.Height < workArea.Height) return before;
        return new SizeInt32(workArea.Width * 3 / 4, workArea.Height * 3 / 4);
    }

    /// <summary>A window opened by the command: the source's place, one step down and to the right, on its work area.</summary>
    internal static RectInt32 Cascaded(RectInt32 source, RectInt32 workArea, double scale)
    {
        var step = Physical(Cascade, scale);
        return DesktopWindowPolicy.FitSavedTo(new DesktopWindowState(source.X + step, source.Y + step, source.Width, source.Height, false), workArea, scale);
    }

    private static double Positive(double scale) => double.IsFinite(scale) && scale > 0 ? scale : 1.0;

    private static int Physical(double pagePixels, double scale) => (int)Math.Round(pagePixels * Positive(scale));
}

internal sealed partial class WorkbenchProtocolHandler
{
    /// <summary>The window this page is in, for moving a tab; set by the page that owns the bridge.</summary>
    internal IWorkbenchTabWindowHost? TabWindowHost { get; init; }

    private IWorkbenchTabWindowHost TabWindows() => TabWindowHost ?? throw new NendoPreconditionException(
        "window-unavailable", "The window is not available.");

    /// <summary>A file action a tab window does not run, refused before anything else happens.</summary>
    private void RefuseOutsideTheMainWindow(string method)
    {
        if (TabWindowHost is { IsTabWindow: true } && DesktopTabWindowRules.MainWindowOnly.Contains(method))
            throw new NendoPreconditionException("main-window-only",
                "Open, close and replace files in the main window. This window shows a tab of the file open there.");
    }

    private object CloseWindow()
    {
        TabWindows().CloseWindow();
        return new { closing = true };
    }

    private object Exit()
    {
        TabWindows().Exit();
        return new { exiting = true };
    }

    private object DetachTab(JsonElement payload)
    {
        var trail = DesktopTabWindowRules.ReadTrail(payload);
        var atPointer = payload.TryGetProperty("atPointer", out var pointer) && pointer.ValueKind == JsonValueKind.True;
        var last = payload.TryGetProperty("last", out var only) && only.ValueKind == JsonValueKind.True;
        if (last && !atPointer) throw new NendoValidationException("A window's only tab moves only where it is let go.");
        return new { outcome = TabWindows().DetachTab(trail, atPointer, last) };
    }

    private async Task<object> BeginTabDragAsync(JsonElement payload)
    {
        var picture = DesktopTabWindowRules.ReadPicture(payload);
        await TabWindows().BeginTabDragAsync(picture);
        return new { shown = true };
    }

    private TabDragDiagnostics DiagnoseTabDrag(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("point", out var point)) return TabWindows().DiagnoseTabDrag(false, null);
        if (point.ValueKind == JsonValueKind.Null) return TabWindows().DiagnoseTabDrag(true, null);
        if (point.ValueKind != JsonValueKind.Object || !point.TryGetProperty("x", out var x) || !point.TryGetProperty("y", out var y) ||
            x.ValueKind != JsonValueKind.Number || y.ValueKind != JsonValueKind.Number)
            throw new NendoValidationException("Request property point must have numbers x and y.");
        return TabWindows().DiagnoseTabDrag(true, (x.GetDouble(), y.GetDouble()));
    }

    private object EndTabDrag(JsonElement payload)
    {
        var dropped = payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("dropped", out var value) && value.ValueKind == JsonValueKind.True;
        TabWindows().EndTabDrag(dropped);
        return new { ended = true };
    }
}
