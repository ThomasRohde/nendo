namespace Nendo.Desktop;

/// <summary>
/// Decides which notifications a change of state has earned.
/// <para>
/// Separated from both the state it reads and the manager that shows the result, so
/// the rule that matters here is under test: a notification marks a <em>transition</em>,
/// never a condition. A file that opens read-only has not just become read-only, and
/// saying so would train a person to dismiss the message that means something.
/// </para>
/// <para>
/// Not thread-safe by construction. Every caller is on the window's UI thread, which
/// is also where notifications are shown, and a lock here would only hide a caller
/// that had wandered off it.
/// </para>
/// </summary>
internal sealed class DesktopNotificationTrigger
{
    private bool _seenFile;
    private bool _unwritable;
    private bool _approvalOutstanding;
    private bool _approvalAnnounced;
    private bool _rendererFailed;

    /// <summary>
    /// Forgets everything, for a new file session. State from the last file would
    /// otherwise make the next one's first reading look like a change.
    /// </summary>
    internal void Reset()
    {
        _seenFile = false;
        _unwritable = false;
        _approvalOutstanding = false;
        _approvalAnnounced = false;
        _rendererFailed = false;
    }

    /// <summary>Whether consent is currently outstanding, for the tray tooltip.</summary>
    internal bool ApprovalOutstanding => _approvalOutstanding;

    /// <summary>
    /// Takes a reading of the open file. Returns what to say, if anything.
    /// <para>
    /// The first reading of a file only records: it establishes what "unchanged"
    /// means. Everything after it is compared against the last.
    /// </para>
    /// </summary>
    internal DesktopNotification? Observe(DesktopShellState state)
    {
        if (state.FileName is null && state.Health == "noFile")
        {
            Reset();
            return null;
        }

        var unwritable = state.Health is "readOnly" or "recoveryRequired" or "rejected" or "closed";
        var approvalOutstanding = state is { RequiresApproval: true, IsApproved: false };

        if (!_seenFile)
        {
            _seenFile = true;
            _unwritable = unwritable;
            _approvalOutstanding = approvalOutstanding;
            return null;
        }

        var wasUnwritable = _unwritable;
        var wasOutstanding = _approvalOutstanding;
        _unwritable = unwritable;
        _approvalOutstanding = approvalOutstanding;
        if (!approvalOutstanding) _approvalAnnounced = false;

        if (unwritable && !wasUnwritable)
        {
            return DesktopNotificationContent.FileUnwritable(state.FileName, state.Health);
        }

        if (approvalOutstanding && !wasOutstanding && !_approvalAnnounced)
        {
            _approvalAnnounced = true;
            return DesktopNotificationContent.ApprovalNeeded(
                state.FileName, state.CreatesRecords, state.UpdatesRecords, state.DeletesRecords);
        }

        return null;
    }

    /// <summary>
    /// The reminder a person earns by walking away from a file that is waiting on
    /// them. Unlike <see cref="Observe"/> this is not a transition — leaving is the
    /// event — but it is still said only once per outstanding approval.
    /// </summary>
    internal DesktopNotification? OnHidden(DesktopShellState state)
    {
        if (state is not { RequiresApproval: true, IsApproved: false }) return null;
        if (_approvalAnnounced) return null;
        _approvalAnnounced = true;
        _approvalOutstanding = true;
        _seenFile = true;
        return DesktopNotificationContent.ApprovalNeeded(
            state.FileName, state.CreatesRecords, state.UpdatesRecords, state.DeletesRecords);
    }

    /// <summary>
    /// Write authority was withdrawn under the open file. This arrives as a push from
    /// the coordinator rather than as a reading, so it is its own entry point — while
    /// the window is hidden nothing is asking for readings at all.
    /// </summary>
    internal DesktopNotification? OnWriteAuthorityLost(string? fileName)
    {
        if (_unwritable) return null;
        _unwritable = true;
        _seenFile = true;
        return DesktopNotificationContent.FileUnwritable(fileName, "recoveryRequired");
    }

    /// <summary>The workspace stopped responding. Said once until it comes back.</summary>
    internal DesktopNotification? OnRendererFailed(string? fileName)
    {
        if (_rendererFailed) return null;
        _rendererFailed = true;
        return DesktopNotificationContent.RendererFailed(fileName);
    }

    /// <summary>The workspace started, so a later failure is a new one.</summary>
    internal void OnRendererStarted() => _rendererFailed = false;
}
