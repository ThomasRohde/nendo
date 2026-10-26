namespace Nendo.Session;

/// <summary>
/// The bridge's methods a host may own: the Windows host's windows, tabs, downloads, native
/// diagnostics and agents. One vocabulary for every host (ADR-0036); a host that owns none of
/// them refuses each by name.
/// </summary>
internal static partial class WorkbenchMethods
{
    // WorkbenchProtocol.Agents
    /// <summary>
    /// The agent launched from the Agent page and its conversation tab (ADR-0030). None of these
    /// waits on the request gate except list, setCommand, setHidden and launch: the tab keeps
    /// reading while an agent's own write holds the file. Each still names the file session it
    /// belongs to.
    /// </summary>
    internal const string AgentSessionPrefix = "agentSession.";
    internal const string AgentSessionList = "agentSession.list";
    internal const string AgentSessionSetCommand = "agentSession.setCommand";
    internal const string AgentSessionSetHidden = "agentSession.setHidden";
    internal const string AgentSessionLaunch = "agentSession.launch";
    internal const string AgentSessionRead = "agentSession.read";
    internal const string AgentSessionPrompt = "agentSession.prompt";
    internal const string AgentSessionAttach = "agentSession.attach";
    internal const string AgentSessionImage = "agentSession.image";
    internal const string AgentSessionRespond = "agentSession.respond";
    internal const string AgentSessionAnswer = "agentSession.answer";
    internal const string AgentSessionCancel = "agentSession.cancel";
    internal const string AgentSessionAuthenticate = "agentSession.authenticate";
    internal const string AgentSessionEnd = "agentSession.end";
    internal const string AgentSessionSetOption = "agentSession.setOption";
    internal const string AgentSessionSetViewAccess = "agentSession.setViewAccess";
    internal const string AgentSessionTurn = "agentSession.turn";
    internal const string AgentSessionSetStartIn = "agentSession.setStartIn";

    internal static readonly IReadOnlySet<string> AgentSessionMethods = new HashSet<string>(StringComparer.Ordinal)
    {
        AgentSessionList, AgentSessionSetCommand, AgentSessionSetHidden, AgentSessionLaunch, AgentSessionRead, AgentSessionPrompt,
        AgentSessionAnswer, AgentSessionCancel, AgentSessionAuthenticate, AgentSessionEnd, AgentSessionSetOption,
        AgentSessionSetViewAccess, AgentSessionTurn, AgentSessionSetStartIn, AgentSessionAttach, AgentSessionImage, AgentSessionRespond,
    };

    // ExtensionFrameDiagnostics
    /// <summary>
    /// Which browser process holds which view, with its private working set. Answered only when
    /// NENDO_NATIVE_DIAGNOSTICS=1, for the journeys that measure isolation and memory.
    /// </summary>
    internal const string DiagnosticsFrameProcesses = "diagnostics.frameProcesses";

    // WorkbenchProtocol.Downloads
    /// <summary>
    /// Show a file a view saved in its folder, in Explorer, by the identifier its downloadSaved
    /// event named. Only a download this window saved can be shown, so the page never hands the
    /// host a path.
    /// </summary>
    internal const string DownloadsShow = "downloads.show";

    // WorkbenchProtocol.TabWindows
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
