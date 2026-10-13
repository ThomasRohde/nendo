namespace Nendo.Desktop;

/// <summary>
/// The rules the window and its page follow around the Workbench's browser, apart from the
/// window so a test can hold each one without a window, a browser or a taskbar.
/// </summary>
internal static class DesktopWorkbenchNavigation
{
    /// <summary>
    /// Whether a navigation that ended is a reason to replace the app view with recovery.
    /// <para>
    /// Only the Workbench's own latest navigation failing is. The host cancels every other
    /// top-level navigation, and the browser reports a cancelled or superseded one as a failure:
    /// a link dragged onto the window, or a file dropped while a dialog was open, tore down a
    /// healthy view (DSH-02). Those carry another navigation's ID, which is all that tells them
    /// apart. The Workbench's own latest navigation failing, cancelled included, is fatal
    /// whatever its status, or the window would be left on a blank view.
    /// </para>
    /// </summary>
    /// <param name="navigationId">The navigation that ended.</param>
    /// <param name="hostNavigationId">The Workbench's own latest navigation, once one has started.</param>
    internal static bool IsFatal(ulong navigationId, ulong? hostNavigationId, bool isSuccess) =>
        !isSuccess && (hostNavigationId is null || hostNavigationId == navigationId);

    /// <summary>
    /// Whether the Workbench's document keeps the browser's own keys: reload, print, find, and
    /// F12 for DevTools. WebView2 handles them before the page sees them (the order its
    /// AcceleratorKeyPressed documentation gives: the host's event, then the browser's own
    /// handling, then the page), so the page cannot stop F5 dropping an open form's typing, and
    /// WinUI's WebView2 offers no controller to filter them one by one (DSH-15). Off in a shipped
    /// build; on in a Debug build, where F12 on the Workbench is the developer's way into it.
    /// </summary>
    internal static bool BrowserAcceleratorKeys =>
#if DEBUG
        true;
#else
        false;
#endif
}

/// <summary>Calls into native chrome that may fail without anything depending on them.</summary>
internal static class DesktopShellSafety
{
    /// <summary>
    /// Posts to the Workbench's browser, which may have gone between the check and the post.
    /// A response landing after the browser process died threw out of the async message handler
    /// and ended the process, instead of the recovery panel this path exists to show (DSH-03).
    /// </summary>
    internal static bool TryPost(Action post)
    {
        try
        {
            post();
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Gives the window its icon. A missing or unreadable icon file is a missing convenience:
    /// called unguarded from the window's constructor, it ended the launch before any window or
    /// recovery panel existed (DSH-23).
    /// </summary>
    internal static bool TrySetIcon(Action<string> setIcon, string path)
    {
        try
        {
            setIcon(path);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Ends the session on the way out, and returns what went wrong rather than throwing it. The
    /// close handler is async void and runs after the window has asked the application to exit,
    /// so a cleanup failure there (a discovery entry another reader held, say) reported a crash
    /// for a normal exit (DSH-19). The file's data is not at stake by then: every commit is
    /// already durable, and what failed is tidying up after it.
    /// </summary>
    internal static async Task<Exception?> ShutdownAsync(Func<Task> shutdown)
    {
        try
        {
            await shutdown();
            return null;
        }
        catch (Exception exception)
        {
            return exception;
        }
    }
}

/// <summary>The taskbar button as the window drives it; <see cref="DesktopTaskbarStatus"/> is the real one.</summary>
internal interface IDesktopTaskbarButton
{
    void Forget();
    void SetBusy(bool busy);
}

/// <summary>
/// One taskbar indicator, two things that can be running. Whichever finishes first must not
/// clear the other's progress -- a file action and an agent overlap easily, and the version
/// that just called SetBusy(false) turned the indicator off halfway through the work still in
/// flight.
/// </summary>
internal sealed class DesktopTaskbarActivity(IDesktopTaskbarButton? button)
{
    private bool _fileAction;
    private bool _agent;

    internal bool Busy => _fileAction || _agent;

    internal void Set(bool? fileAction = null, bool? agent = null)
    {
        if (fileAction is { } file) _fileAction = file;
        if (agent is { } working) _agent = working;
        button?.SetBusy(Busy);
    }

    /// <summary>
    /// The taskbar button is new and bare: the window was hidden and shown again, or Explorer
    /// restarted. Its progress is put back with it, not only its badge, or an agent still at
    /// work showed nothing until its next call (DSH-13). The caller puts the badge back.
    /// </summary>
    internal void ButtonRecreated()
    {
        button?.Forget();
        button?.SetBusy(Busy);
    }
}

/// <summary>
/// Windows ending the session: a shutdown, a restart for an update, a sign-out.
/// <para>
/// None of these closes the window, so the only orderly exit, the close handler, never ran and
/// a Nendo resident in the notification area was ended with agent requests still admitted
/// (DSH-07). The window that hears it is the tray's own top-level window. Agreeing to end is
/// immediate; the session is ended when Windows says it is ending, within a bound, because
/// Windows ends the process soon after that message is answered whether or not it is done.
/// </para>
/// </summary>
internal static class DesktopSessionEnd
{
    internal const uint QueryEndSession = 0x0011;
    internal const uint EndSession = 0x0016;

    /// <summary>How long the session is given to end before the message is answered anyway.</summary>
    internal static readonly TimeSpan Bound = TimeSpan.FromSeconds(4);

    /// <summary>Whether a window message is one of these two.</summary>
    internal static bool Handles(uint message) => message is QueryEndSession or EndSession;

    /// <summary>
    /// The answer to the message, ending the session first when it is ending. Never throws:
    /// it runs inside a window procedure.
    /// </summary>
    internal static nint Answer(uint message, nint wParam, Action? endSession)
    {
        if (message == QueryEndSession) return 1;
        if (message == EndSession && wParam != 0)
        {
            try { endSession?.Invoke(); }
            catch (Exception) { }
        }
        return 0;
    }

    /// <summary>
    /// Runs <paramref name="shutdown"/> away from the calling thread and waits for it, at most
    /// <paramref name="bound"/>. The caller is the UI thread inside a window procedure, which a
    /// continuation of the shutdown must never need: it would wait on itself.
    /// </summary>
    internal static bool Drain(Func<Task> shutdown, TimeSpan bound)
    {
        try { return Task.Run(shutdown).Wait(bound); }
        catch (Exception) { return false; }
    }
}

/// <summary>
/// The open a launch asked for: a double-click, the Jump List, Explorer's New, a new file's own
/// window. It meets the questions a picked or dropped file meets, rather than ending on the
/// recovery panel with a fixed sentence (DSH-01).
/// </summary>
internal static class DesktopStartupOpen
{
    /// <summary>
    /// Whether the assessment needs the person before the file opens: another known file holds
    /// its instance, its folder may be synced, or it cannot be opened for editing. Otherwise it
    /// opens for editing at once, as a launch always did.
    /// </summary>
    internal static bool NeedsAQuestion(DesktopFileOpenAssessment assessment) =>
        assessment.KnownInstanceCollision ||
        assessment.LocationWarning is not null ||
        !assessment.Inspection.CanAcquireWriteAuthority;
}
