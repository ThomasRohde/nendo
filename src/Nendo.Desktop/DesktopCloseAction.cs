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
/// preference says, because the tray menu's Exit item and a Windows shutdown are
/// the two ways out and neither may be overridden by a preference. A preference
/// that could swallow Exit would leave a process nobody can stop from the UI.
/// </para>
/// </summary>
internal static class DesktopCloseAction
{
    internal static DesktopCloseOutcome Resolve(string closeAction, bool exitRequested, bool trayAvailable) =>
        exitRequested || !trayAvailable || closeAction != "tray"
            ? DesktopCloseOutcome.Exit
            : DesktopCloseOutcome.Hide;
}
