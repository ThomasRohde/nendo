namespace Nendo.Desktop;

internal enum DesktopCloseOutcome
{
    /// <summary>Hide the window and stay resident in the notification area.</summary>
    Hide,

    /// <summary>Shut the session down and end the process.</summary>
    Exit,
}

/// <summary>
/// What a close request should do, separated from the window so it can be tested
/// without one.
/// <para>
/// The asymmetry is deliberate: an explicit exit always exits, whatever the
/// preference says, because the tray menu's Exit item is the way out and no
/// preference may override it. A preference that could swallow Exit would leave a
/// process nobody can stop from the UI.
/// </para>
/// <para>
/// A Windows shutdown, restart or sign-out closes no window, so it never comes through
/// here: the tray's window hears it and ends the session through
/// <see cref="DesktopSessionEnd"/> (DSH-07).
/// </para>
/// </summary>
internal static class DesktopCloseAction
{
    internal static DesktopCloseOutcome Resolve(string closeAction, bool exitRequested, bool trayAvailable) =>
        exitRequested || !trayAvailable || closeAction != "tray"
            ? DesktopCloseOutcome.Exit
            : DesktopCloseOutcome.Hide;
}
