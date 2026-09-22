using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

/// <summary>
/// The little the shell needs to know about the session: enough for a tray tooltip,
/// a tray menu and a notification, and nothing else.
/// <para>
/// Deliberately not a <see cref="DesktopSessionView"/>. That one carries entities,
/// records and UI nodes because a renderer asked for them; the notification area asks
/// several times a minute and must never pay for a snapshot to draw a tooltip.
/// </para>
/// </summary>
internal sealed record DesktopShellState(
    string? FileName,
    string Health,
    bool RequiresApproval,
    bool IsApproved,
    bool CreatesRecords,
    bool UpdatesRecords,
    bool DeletesRecords,
    string AgentAccess,
    bool AgentAccessOn,
    bool AgentBusy = false,
    string? AgentEditingOwner = null)
{
    internal static DesktopShellState None { get; } =
        new(null, "noFile", false, true, false, false, false, "Off", false);
}

internal sealed partial class DesktopSessionController
{
    private Action<int>? _proposalAddedHandler;

    /// <summary>
    /// A validated agent proposal is waiting for a person, carrying how many now are.
    /// <para>
    /// Raised off the agent's own request thread, synchronously, exactly like
    /// <see cref="NendoWriteCoordinator.WriteAuthorityLost"/>: a handler must marshal
    /// and queue, never wait on this controller.
    /// </para>
    /// </summary>
    internal event Action<int>? ProposalWaiting;

    /// <summary>The open file can no longer be written. Same threading rules as above.</summary>
    internal event Action? WriteAuthorityWithdrawn;

    /// <summary>
    /// An agent started or finished a call. Raised on the agent's own request thread,
    /// outside every gate, so a handler marshals and returns like the two above.
    /// <para>
    /// This is the one thing the window could not previously find out. An agent write
    /// holds the Engine gate for its whole duration and nothing pushed, so the window
    /// stopped answering with no sentence anywhere saying why. The payload is what a
    /// person needs to read that sentence and nothing else: whether work is running, the
    /// client's display name, and the tool or resource it named.
    /// </para>
    /// </summary>
    internal event Action<NendoAgentWork>? AgentWorkChanged;

    /// <summary>
    /// The open file committed a change, carrying the change sequence it reached.
    /// <para>
    /// Raised for every writer, which is what makes it worth having: an agent writing
    /// through MCP moves the file and nothing in the renderer's own world moves with it,
    /// so a surface on screen has no way to know. Same threading rules as above -- it
    /// arrives on the writer's thread while the Engine gate is held, so a handler
    /// marshals and returns.
    /// </para>
    /// </summary>
    internal event Action<long>? FileCommitted;

    /// <summary>
    /// What the notification area should show, read without taking the request gate.
    /// <para>
    /// Every field is a field or property read — no snapshot, no I/O, no await — which
    /// is what makes it safe to call from a window procedure while the gate is held by
    /// a long agent operation. A tray menu that could deadlock behind a proposal
    /// validation would be worse than no tray menu.
    /// </para>
    /// </summary>
    internal DesktopShellState DescribeShellState()
    {
        var coordinator = _coordinator;
        if (coordinator is null || _disposed) return DesktopShellState.None;
        NendoBehaviourTrust trust;
        string health;
        try
        {
            trust = coordinator.BehaviourTrust;
            health = _service?.Health switch
            {
                NendoSessionHealth.Normal => "normal",
                NendoSessionHealth.ReadOnly => "readOnly",
                NendoSessionHealth.RecoveryRequired => "recoveryRequired",
                NendoSessionHealth.Closed => "closed",
                null => "noFile",
                _ => "unknown",
            };
        }
        catch (Exception exception) when (exception is ObjectDisposedException or InvalidOperationException)
        {
            return DesktopShellState.None;
        }

        var capabilities = trust.Required?.Capabilities ?? NendoBehaviourCapabilities.None;
        return new DesktopShellState(
            coordinator.FileName,
            health,
            trust.RequiresApproval,
            trust.IsApproved,
            capabilities.HasFlag(NendoBehaviourCapabilities.CreateRecords),
            capabilities.HasFlag(NendoBehaviourCapabilities.UpdateRecords),
            capabilities.HasFlag(NendoBehaviourCapabilities.DeleteRecords),
            AgentAccessLabel(_agentMode),
            _agentMode != AgentAccessMode.Disabled,
            _agentHost?.Work.Peek().Busy is true,
            _agentHost?.PeekLeaseStatus() is { HasLease: true } lease
                ? $"{lease.ClientDisplayName} ({lease.Owner})"
                : null);
    }

    /// <summary>
    /// Turns agent access off from the notification area. The same call the Agent page
    /// makes, so there is no second path to a mode change and nothing to keep in step.
    /// </summary>
    internal Task<DesktopAgentStatus> TurnAgentAccessOffAsync(CancellationToken cancellationToken = default) =>
        SetAgentModeAsync("off", cancellationToken);

    private void AttachProposalSignal(NendoAgentProposalStore store, NendoWriteCoordinator owner)
    {
        _proposalAddedHandler = pending =>
        {
            // A store outlives nothing, but the controller may already have moved on to
            // another file by the time this lands. Announcing the old one would name a
            // file that is no longer open.
            if (!ReferenceEquals(owner, _coordinator)) return;
            ProposalWaiting?.Invoke(pending);
        };
        store.ProposalAdded += _proposalAddedHandler;
    }

    /// <summary>
    /// Forwards the MCP host's work signal as this controller's own event, and only while
    /// this host is still the current one. A signal from a listener that has since been
    /// replaced would describe a file nobody has open.
    /// </summary>
    private void AttachWorkSignal(NendoLocalMcpHost host) =>
        host.Work.SetHandler(work =>
        {
            if (!ReferenceEquals(host, _agentHost)) return;
            AgentWorkChanged?.Invoke(work);
        });

    /// <summary>Says the agent is no longer working, for a listener that has stopped.</summary>
    private void AnnounceAgentIdle() =>
        AgentWorkChanged?.Invoke(new NendoAgentWork(false, string.Empty, string.Empty));

    private static string AgentAccessLabel(AgentAccessMode mode) => mode switch
    {
        AgentAccessMode.ReadOnly => "Read-only inspection",
        AgentAccessMode.DataMutation => "Data mutation",
        AgentAccessMode.ApplicationAuthoring => "Application authoring",
        AgentAccessMode.Unattended => "Unattended authoring",
        _ => "Off",
    };
}
