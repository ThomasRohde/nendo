using System.Text.Json;
using Nendo.Engine;
using Windows.Graphics;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Open a tab in a window of its own (W-277, ADR-0002 2026-10-16). The page hands over the tab's
    /// trail as an opaque string, which the host never reads, and whether the window opens at the
    /// pointer (the tab was let go outside the window) or beside this one (the command).
    /// </summary>
    internal const string WindowDetachTab = "window.detachTab";

    /// <summary>
    /// Which window this page is in, and the trail of the tab it was opened for. A tab window
    /// answers the trail once; a second ask, and the main window, answer none.
    /// </summary>
    internal const string WindowTakeTab = "window.takeTab";

    /// <summary>Close this page's tab window as its close button does. Answered only when NENDO_NATIVE_DIAGNOSTICS=1.</summary>
    internal const string DiagnosticsCloseWindow = "diagnostics.closeWindow";

    /// <summary>End the process as the tray's Exit does. Answered only when NENDO_NATIVE_DIAGNOSTICS=1.</summary>
    internal const string DiagnosticsExit = "diagnostics.exit";
}

/// <summary>What a page learns about its window: <c>main</c> or <c>tab</c>, and a tab window's trail once.</summary>
internal sealed record TabWindowStart(string Role, string? Trail);

/// <summary>What the bridge needs from the window a page is in to move a tab out of it.</summary>
internal interface IWorkbenchTabWindowHost
{
    /// <summary>Whether this page is in a tab window rather than the window the process started with.</summary>
    bool IsTabWindow { get; }

    /// <summary>Open a window of this file on <paramref name="trail"/>, at the pointer or beside this one.</summary>
    void DetachTab(string trail, bool atPointer);

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
        TabWindows().DetachTab(trail, atPointer);
        return new { opened = true };
    }
}
