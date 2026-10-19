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
    /// healthy view. Those carry another navigation's ID, which is all that tells them
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
    /// WinUI's WebView2 offers no controller to filter them one by one. Off in a shipped
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
    /// and ended the process, instead of the recovery panel this path exists to show.
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
    /// recovery panel existed.
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
    /// for a normal exit. The file's data is not at stake by then: every commit is
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
/// <para>
/// An agent's work shows only once it has lasted <see cref="AgentDelay"/>, the wait the status
/// bar's pill and the busy bar already make, because a fast read must not flash an indicator.
/// The taskbar showed every call at once, so a client polling the file every minute flashed the
/// button's progress each time.
/// </para>
/// </summary>
/// <param name="schedule">
/// Runs an action on the window's thread after a delay; a test names its own. Without one, an
/// agent's work shows at once.
/// </param>
internal sealed class DesktopTaskbarActivity(IDesktopTaskbarButton? button, Action<TimeSpan, Action>? schedule = null)
{
    /// <summary>The renderer's own wait before it says an agent is working (<c>busyBarDelayMs</c> in shell.ts).</summary>
    internal static readonly TimeSpan AgentDelay = TimeSpan.FromMilliseconds(700);

    private bool _fileAction;
    private bool _agent;
    private bool _agentWorking;
    private long _agentStretch;

    internal bool Busy => _fileAction || _agent;

    internal void Set(bool? fileAction = null, bool? agent = null)
    {
        if (fileAction is { } file) _fileAction = file;
        if (agent is { } working)
        {
            if (working != _agentWorking) _agentStretch++;
            var started = working && !_agentWorking;
            _agentWorking = working;
            if (!working) _agent = false;
            else if (schedule is null) _agent = true;
            else if (started)
            {
                var stretch = _agentStretch;
                schedule(AgentDelay, () =>
                {
                    // Shown only if the same stretch of work is still running.
                    if (!_agentWorking || _agentStretch != stretch || _agent) return;
                    _agent = true;
                    button?.SetBusy(Busy);
                });
            }
        }
        button?.SetBusy(Busy);
    }

    /// <summary>
    /// The taskbar button is new and bare: the window was hidden and shown again, or Explorer
    /// restarted. Its progress is put back with it, not only its badge, or an agent still at
    /// work showed nothing until its next call. The caller puts the badge back.
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
/// a Nendo resident in the notification area was ended with agent requests still admitted.
/// The window that hears it is the tray's own top-level window. Agreeing to end is
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
/// recovery panel with a fixed sentence.
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

    /// <summary>
    /// How long a refused launch looks for the Nendo that refused it to name itself. That Nendo
    /// writes its sidecar straight after taking the instance's guard, so this is a margin over
    /// one flush to disk, not over an inspection.
    /// </summary>
    internal static readonly TimeSpan HandOffPatience = TimeSpan.FromMilliseconds(750);

    /// <summary>
    /// Whether a refusal can be another Nendo opening this very file: its sidecar is held
    /// (path-in-use), or its instance's guard is, which an open takes just before writing that
    /// sidecar (instance-in-use). A folder Nendo may not write in (write-ownership-denied) or a
    /// guard it cannot make (instance-guard-unavailable) names nobody, and is offered read-only
    /// at once. A copy of an open file is refused on its instance with no sidecar beside it ever
    /// appearing: it waits out <see cref="HandOffPatience"/>, since the Engine takes the guard
    /// before the sidecar precisely so that a copy never gets one.
    /// </summary>
    internal static bool MayBeHandedOff(Nendo.Engine.NendoWriteOwnershipException refusal) =>
        refusal.Code is "path-in-use" or "instance-in-use";

    /// <summary>
    /// Runs a writable open, and when another Nendo's hold on the file refuses it, hands the file
    /// to that Nendo's window instead. True when it was handed over; a refusal nobody answered is
    /// thrown as it came, for the caller's read-only offer.
    /// <para>
    /// A launch hands a file another Nendo holds to that window before any window exists, by the
    /// write-owner sidecar that names it. A second launch while the first was still opening the
    /// file -- a double-click repeated while nothing showed yet -- found no sidecar, which is
    /// written only once the open has inspected the file, and then met that open's lease: it ended
    /// beside the healthy window on a refusal, first the recovery panel, later the
    /// read-only offer. The owner is now looked for again, briefly, while it has not yet
    /// said who it is; one that has, and does not answer, is not waited for, as before. A refusal
    /// that names nobody (<see cref="MayBeHandedOff"/>) is thrown at once, and so is the refusal
    /// when <paramref name="cancellationToken"/> ends the wait.
    /// </para>
    /// </summary>
    /// <param name="ownerOf">The Nendo that holds a file, as its sidecar names it; a test names its own.</param>
    /// <param name="show">Asks that Nendo to bring its window forward; a test names its own.</param>
    internal static async Task<bool> OpenOrHandOffAsync(Func<Task> open, string path,
        Func<string, int?>? ownerOf = null, Func<int, bool>? show = null, TimeSpan? patience = null,
        TimeSpan? interval = null, CancellationToken cancellationToken = default)
    {
        System.Runtime.ExceptionServices.ExceptionDispatchInfo refusal;
        try
        {
            await open();
            return false;
        }
        catch (Nendo.Engine.NendoWriteOwnershipException exception) when (MayBeHandedOff(exception))
        {
            refusal = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(exception);
        }
        ownerOf ??= static file => DesktopWindowHandoff.OwnerOf(file);
        show ??= static processId => DesktopWindowHandoff.TryShow(processId);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var wait = patience ?? HandOffPatience;
        try
        {
            while (true)
            {
                if (await Task.Run(() => ownerOf(path), cancellationToken) is { } owner)
                {
                    if (await Task.Run(() => show(owner), cancellationToken)) return true;
                    break;
                }
                if (clock.Elapsed >= wait) break;
                await Task.Delay(interval ?? TimeSpan.FromMilliseconds(50), cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The window is going: the refusal is what there is to say.
        }
        refusal.Throw();
        return false;
    }
}
