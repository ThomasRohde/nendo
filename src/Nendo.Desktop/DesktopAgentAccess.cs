using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

internal sealed record DesktopAgentStatus(
    bool Available,
    string Mode,
    string State,
    string? ConnectedAgent,
    string? EditingOwner,
    DateTimeOffset? LeaseExpiresAt,
    IReadOnlyList<NendoAgentActivity> RecentActivity,
    IReadOnlyList<NendoAgentProposalSummary> PendingProposals,
    bool LeaseExpiry,
    int LeaseExpirySeconds,
    bool FixedPort,
    int PortPreference,
    string? Endpoint,
    bool UsingPreferredPort,
    bool SettingsPersisted,
    string? SettingsNotice);

internal sealed partial class DesktopSessionController
{
    private readonly NendoLocalMcpHostOptions? _agentOptions;
    private readonly string _deviceStateRoot;
    private DesktopAgentSettingsStore? _agentSettings;
    private NendoLocalMcpHost? _agentHost;
    private NendoAgentProposalStore? _agentProposals;
    private AgentAccessMode _agentMode = AgentAccessMode.Disabled;
    private Action? _authorityLostHandler;
    private Action<long>? _committedHandler;
    private string _fileSessionId = $"file-session-{Guid.NewGuid():N}";
    private string? _agentCleanupNotice;

    internal DesktopSessionController(NendoLocalMcpHostOptions? agentOptions = null, string? fileHistoryRoot = null, DesktopLocationPolicy? locationPolicy = null, string? deviceStateRoot = null)
    {
        _agentOptions = agentOptions;
        _deviceStateRoot = deviceStateRoot ?? DesktopAppearanceStore.DefaultRoot;
        _fileHistory = new DesktopFileHistory(fileHistoryRoot ?? DesktopFileHistory.DefaultRoot);
        _locationPolicy = locationPolicy ?? DesktopLocationPolicy.ForDevice();
    }

    // Composed per host start so a settings change takes effect on the next enable rather than needing a
    // relaunch. These are the single-user local defaults: a predictable port keeps an agent's saved
    // configuration working, and no lease expiry stops an in-flight draft dying mid-conversation. The
    // hardened behaviour remains available by choosing it.
    private NendoLocalMcpHostOptions CurrentHostOptions()
    {
        var settings = Settings();
        var discoveryRoot = _agentOptions?.DiscoveryRoot
            ?? NendoLocalMcpHostOptions.CreateDefault().DiscoveryRoot;
        return new NendoLocalMcpHostOptions(discoveryRoot)
        {
            PreferredPort = settings.FixedPort ? settings.Port : 0,
            LeaseTtl = settings.LeaseExpiry ? TimeSpan.FromSeconds(settings.LeaseExpirySeconds) : null,
        };
    }

    private DesktopAgentSettingsStore Settings() =>
        _agentSettings ??= new DesktopAgentSettingsStore(_deviceStateRoot);

    internal async Task<DesktopAgentStatus> SetAgentSettingsAsync(
        bool leaseExpiry,
        int leaseExpirySeconds,
        bool fixedPort,
        int port,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            Settings().Save(leaseExpiry, leaseExpirySeconds, fixedPort, port);
            // Restart an already-running host so a changed setting takes effect now rather than silently
            // waiting for the next enable.
            if (_agentHost is not null)
            {
                var mode = _agentMode;
                await StopAgentAccessCoreAsync();
                if (mode != AgentAccessMode.Disabled && _service is { } service)
                {
                    EnsureProposalStore();
                    _agentHost = await NendoLocalMcpHost.StartAsync(
                        service, mode, CurrentHostOptions(), _agentProposals, cancellationToken,
                        UnattendedConsent(mode));
                    _agentMode = mode;
                    AttachWorkSignal(_agentHost);
                }
            }
            return await ReadAgentStatusCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<DesktopAgentStatus> GetAgentStatusAsync(
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return await ReadAgentStatusCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<DesktopAgentStatus> SetAgentModeAsync(
        string mode,
        CancellationToken cancellationToken = default)
    {
        var requested = ParseMode(mode);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var service = RequireService();
            if (requested == AgentAccessMode.Disabled)
            {
                await StopAgentAccessCoreAsync();
                return await ReadAgentStatusCoreAsync(cancellationToken);
            }
            if (!service.Capabilities.AgentAccess)
            {
                throw new NendoPreconditionException(
                    "recovery-required",
                    "Agent access is unavailable while this file requires recovery.");
            }
            if (_agentMode == requested &&
                (requested == AgentAccessMode.Disabled || _agentHost?.IsReady is true))
            {
                return await ReadAgentStatusCoreAsync(cancellationToken);
            }

            await StopAgentAccessCoreAsync();
            if (requested != AgentAccessMode.Disabled)
            {
                EnsureProposalStore();
                _agentHost = await NendoLocalMcpHost.StartAsync(
                    service,
                    requested,
                    CurrentHostOptions(),
                    _agentProposals,
                    cancellationToken,
                    UnattendedConsent(requested));
                _agentMode = requested;
                AttachWorkSignal(_agentHost);
            }
            return await ReadAgentStatusCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<DesktopAgentStatus> RevokeAgentEditingAsync(
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _ = RequireService();
            if (_agentHost is not null)
            {
                await _agentHost.RevokeEditingAsync();
            }
            return await ReadAgentStatusCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<NendoAgentProposalPreview> GetAgentProposalAsync(
        string proposalId,
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!RequireService().Capabilities.Mutate)
                throw new NendoPreconditionException("proposal-unavailable", "Pending proposals are unavailable in this inspection or recovery session.");
            cancellationToken.ThrowIfCancellationRequested();
            return (_agentProposals ?? throw new NendoPreconditionException(
                "proposal-not-found",
                "The pending agent proposal does not exist."))
                .Get(proposalId);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The proposal store for this file session, with the shell signal already on it.
    /// Created here rather than at three call sites so a store can never exist without
    /// the event the notification area depends on.
    /// </summary>
    private NendoAgentProposalStore EnsureProposalStore()
    {
        if (_agentProposals is not null) return _agentProposals;
        _agentProposals = new NendoAgentProposalStore();
        if (_coordinator is { } coordinator) AttachProposalSignal(_agentProposals, coordinator);
        return _agentProposals;
    }

    private void BeginAgentFileSession()
    {
        _agentHost = null;
        _agentMode = AgentAccessMode.Disabled;
        _agentProposals = null;
        _agentProposals = EnsureProposalStore();
        RotateFileSession();
        _agentCleanupNotice = null;
        var coordinator = _coordinator!;
        _authorityLostHandler = () =>
        {
            // Said before the drain, not after: the drain waits on the Desktop gate, and
            // a person whose file just stopped accepting writes should not wait with it.
            WriteAuthorityWithdrawn?.Invoke();
            // The MCP host closes admission synchronously through its own service
            // subscription. Do not wait under the Engine gate: drain only after
            // the Desktop gate is available, and never touch a newer file session.
            _ = Task.Run(async () =>
            {
                await _gate.WaitAsync();
                try
                {
                    if (ReferenceEquals(coordinator, _coordinator))
                        await StopUnhealthyAgentAccessCoreAsync();
                }
                finally { _gate.Release(); }
            });
        };
        coordinator.WriteAuthorityLost += _authorityLostHandler;
        _committedHandler = sequence =>
        {
            // Under the Engine gate. Say it and return: whatever the shell does with it
            // must not be done here, and must not be done for a file that has since been
            // closed and replaced by another.
            if (!ReferenceEquals(coordinator, _coordinator)) return;
            FileCommitted?.Invoke(sequence);
        };
        coordinator.Committed += _committedHandler;
    }

    private async Task StopAgentAccessCoreAsync()
    {
        var host = _agentHost;
        _agentHost = null;
        _agentMode = AgentAccessMode.Disabled;
        if (host is not null)
        {
            // Detach before disposing, then say idle once on this controller's behalf.
            // A listener that is going away cannot raise its own last event, and a busy
            // indicator left standing after the agent is gone is worse than none.
            host.Work.SetHandler(null);
            host.CloseAdmission();
            await host.DisposeAsync();
            AnnounceAgentIdle();
        }
    }

    private async Task CloseAgentFileSessionCoreAsync()
    {
        try
        {
            await StopAgentAccessCoreAsync();
            if (_agentProposals is not null && _service?.Capabilities.Mutate is true)
                await _agentProposals.CloseFileSessionAsync(_service);
        }
        finally { _agentProposals = null; }
    }

    private async Task StopUnhealthyAgentAccessCoreAsync()
    {
        if (_service?.Capabilities.AgentAccess is not false) return;
        try { await StopAgentAccessCoreAsync(); }
        catch (Exception)
        {
            // Admission is already closed. Keep the recovery route available and
            // expose only a bounded notice, not credentials or filesystem errors.
            _agentCleanupNotice = "Agent access is off, but local cleanup did not finish. Close the application before reconnecting an agent.";
        }
        _agentProposals = null;
        _openCandidates.Clear();
    }

    private async Task<DesktopAgentStatus> ReadAgentStatusCoreAsync(CancellationToken cancellationToken)
    {
        if (_service is null)
        {
            return new DesktopAgentStatus(false, "off", "noFile", null, null, null, [], [],
                Settings().LeaseExpiry, Settings().LeaseExpirySeconds, Settings().FixedPort,
                Settings().Port, null, true, Settings().Persisted, Settings().Notice);
        }
        await StopUnhealthyAgentAccessCoreAsync();
        if (!_service.Capabilities.AgentAccess)
        {
            return new DesktopAgentStatus(
                false,
                "off",
                _service.Health == NendoSessionHealth.ReadOnly ? "readOnly" : "recoveryRequired",
                null,
                null,
                null,
                [],
                _agentProposals?.Snapshot() ?? [],
                Settings().LeaseExpiry, Settings().LeaseExpirySeconds, Settings().FixedPort,
                Settings().Port, null, true, Settings().Persisted, Settings().Notice);
        }
        if (_agentHost is null)
        {
            return new DesktopAgentStatus(
                true,
                "off",
                "off",
                null,
                null,
                null,
                [],
                _agentProposals?.Snapshot() ?? [],
                Settings().LeaseExpiry, Settings().LeaseExpirySeconds, Settings().FixedPort,
                Settings().Port, null, true, Settings().Persisted, Settings().Notice);
        }

        // Peek, not the gated read: the gated one waits on the same semaphore an agent
        // write holds, so the Agent page used to block behind the very edit it reports --
        // while holding this controller's gate, which stopped every other request too.
        var lease = _agentHost.PeekLeaseStatus();
        var activity = _agentHost.GetActivities(20);
        var connected = ResolveConnectedAgent(activity);
        return new DesktopAgentStatus(
            true,
            ModeName(_agentMode),
            _agentHost.IsReady ? "ready" : "unavailable",
            connected,
            lease.HasLease ? $"{lease.ClientDisplayName} ({lease.Owner})" : null,
            lease.ExpiresAt,
            activity,
            _agentProposals?.Snapshot() ?? [],
            Settings().LeaseExpiry,
            Settings().LeaseExpirySeconds,
            Settings().FixedPort,
            Settings().Port,
            _agentHost.Endpoint.AbsoluteUri,
            !_agentHost.UsedFallbackPort,
            Settings().Persisted,
            Settings().Notice);
    }

    internal static string? ResolveConnectedAgent(IReadOnlyList<NendoAgentActivity> activity) =>
        activity.LastOrDefault(item => item.Category != "session")?.Client;

    private static AgentAccessMode ParseMode(string mode) => mode switch
    {
        "off" => AgentAccessMode.Disabled,
        "inspect" => AgentAccessMode.ReadOnly,
        "editData" => AgentAccessMode.DataMutation,
        "shapeApp" => AgentAccessMode.ApplicationAuthoring,
        "unattended" => AgentAccessMode.Unattended,
        _ => throw new NendoValidationException(
            "Agent access must be Off, Inspect, Edit data, Shape app or Unattended."),
    };

    // No catch-all. A mode this table does not name would otherwise be reported as Off
    // while the listener was serving something else entirely, and the window, the tray
    // tooltip and the taskbar would all repeat that one wrong word in unison.
    private static string ModeName(AgentAccessMode mode) => mode switch
    {
        AgentAccessMode.Disabled => "off",
        AgentAccessMode.ReadOnly => "inspect",
        AgentAccessMode.DataMutation => "editData",
        AgentAccessMode.ApplicationAuthoring => "shapeApp",
        AgentAccessMode.Unattended => "unattended",
        _ => throw new ArgumentOutOfRangeException(nameof(mode)),
    };

    /// <summary>
    /// The consent this device grants on the person's behalf at Unattended, and only
    /// there: the listener is handed this delegate for that mode alone
    /// (ADR-0009, 2026-09-22 amendment).
    /// <para>
    /// It writes exactly what the person's own approval writes -- the grant for the
    /// behaviour the open file currently holds, scoped to its digest -- so it appears in
    /// the same place, reads the same way and is withdrawn by the same control. It runs
    /// without taking this controller's gate: the agent call that needs it is already
    /// inside the Engine, and waiting here for a gate the request path holds would
    /// deadlock the very write it is trying to let through.
    /// </para>
    /// </summary>
    private NendoUnattendedConsent? UnattendedConsent(AgentAccessMode mode)
    {
        // Retained as well as handed over, so a test can invoke the delegate the listener
        // actually received rather than a stand-in for it. Nothing else reads it.
        _unattendedConsent = mode < AgentAccessMode.Unattended ? null : _ =>
        {
            if (_coordinator?.BehaviourTrust.Required is { } required) BehaviourGrants.Approve(required);
            return Task.CompletedTask;
        };
        return _unattendedConsent;
    }

    private NendoUnattendedConsent? _unattendedConsent;

    /// <summary>
    /// Runs the consent delegate this session handed its listener, or reports that it was
    /// handed none. The delegate itself is what the agent surface calls; this is the only
    /// way to exercise it without an agent, and it grants nothing a level below Unattended
    /// would not already have refused, because below that level there is no delegate here
    /// to run.
    /// </summary>
    internal async Task<bool> GrantUnattendedBehaviourForTestAsync(CancellationToken cancellationToken = default)
    {
        if (_unattendedConsent is not { } consent) return false;
        await consent(cancellationToken);
        return true;
    }
}
