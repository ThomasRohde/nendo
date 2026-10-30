using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Session;

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
    string? SettingsNotice,
    bool Remembered = false);

internal sealed partial class DesktopSessionController
{
    private readonly NendoLocalMcpHostOptions? _agentOptions;
    private DesktopAgentSettingsStore? _agentSettings;
    private DesktopAgentPortStore? _agentPorts;
    private DesktopAgentModeStore? _agentModes;
    private string? _agentApplicationId;
    private string? _agentInstanceId;
    private string? _agentFileName;
    private NendoLocalMcpHost? _agentHost;
    private NendoAgentProposalStore? _agentProposals;
    private AgentAccessMode _agentMode = AgentAccessMode.Disabled;
    private Action? _authorityLostHandler;
    private Action<long>? _committedHandler;
    private string? _agentCleanupNotice;

    /// <param name="agentOptions">Where the agent host publishes itself; null for the device's own.</param>
    internal DesktopSessionController(NendoLocalMcpHostOptions? agentOptions, string? fileHistoryRoot = null, DesktopLocationPolicy? locationPolicy = null, string? deviceStateRoot = null)
        : this(fileHistoryRoot, locationPolicy, deviceStateRoot) => _agentOptions = agentOptions;

    private partial Task StopAgentAccessForReplacementAsync() => StopAgentAccessCoreAsync();

    private partial string? ReadAgentCleanupNotice() => _agentCleanupNotice;

    partial void DetachFileHandlers(NendoWriteCoordinator? coordinator)
    {
        if (coordinator is not null && _authorityLostHandler is not null)
            coordinator.WriteAuthorityLost -= _authorityLostHandler;
        _authorityLostHandler = null;
        if (coordinator is not null && _committedHandler is not null)
            coordinator.Committed -= _committedHandler;
        _committedHandler = null;
    }

    private partial Task<NendoPromotionOutcome>? PromoteAgentProposal(NendoApplicationService service, string proposalId,
        string? expectedOperationDigest, CancellationToken cancellationToken) =>
        _agentProposals?.Snapshot().Any(value => value.ProposalId == proposalId) is true
            ? _agentProposals.PromoteAsync(service, proposalId, expectedOperationDigest, cancellationToken)
            : null;

    private partial Task<NendoPromotionOutcome>? RejectAgentProposal(NendoApplicationService service, string proposalId,
        CancellationToken cancellationToken) =>
        _agentProposals?.Snapshot().Any(value => value.ProposalId == proposalId) is true
            ? _agentProposals.RejectAsync(service, proposalId, cancellationToken)
            : null;

    // Composed per host start so a settings change takes effect on the next enable rather than needing a
    // relaunch. These are the single-user local defaults: a predictable port keeps an agent's saved
    // configuration working, and no lease expiry stops an in-flight draft dying mid-conversation. The
    // hardened behaviour remains available by choosing it.
    /// <param name="preferredPort">
    /// The port the open file keeps (<see cref="DesktopAgentPortStore"/>), or null for the
    /// device's own, which is what a controller with no file asks for.
    /// </param>
    internal NendoLocalMcpHostOptions CurrentHostOptions(int? preferredPort = null)
    {
        var settings = FreshSettings();
        // Discovery is part of the device state (ADR-0034): the person's root publishes where
        // NendoLocalMcpHostOptions.CreateDefault says, and a test's or a lane's root keeps its
        // entries out of the person's folder.
        var discoveryRoot = _agentOptions?.DiscoveryRoot ?? DesktopDeviceStateLayout.Discovery(_deviceStateRoot);
        return new NendoLocalMcpHostOptions(discoveryRoot)
        {
            PreferredPort = settings.FixedPort ? preferredPort ?? settings.Port : 0,
            LeaseTtl = settings.LeaseExpiry ? TimeSpan.FromSeconds(settings.LeaseExpirySeconds) : null,
            RecordFailure = RecordAgentFailure,
        };
    }

    /// <summary>
    /// Keeps a request that failed inside the host, under the tray's one "Record failures"
    /// switch that also governs view failures (ADR-0002). Read fresh
    /// each time, so switching it off stops the next line without a restart. Runs on the
    /// agent's thread and never throws into it.
    /// </summary>
    internal void RecordAgentFailure(NendoAgentFailure failure)
    {
        try
        {
            if (!new DesktopShellStore(_deviceStateRoot).RecordViewFailures) return;
            new DesktopAgentFailureLog(_deviceStateRoot).Record(failure);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    private DesktopAgentSettingsStore Settings() =>
        _agentSettings ??= new DesktopAgentSettingsStore(_deviceStateRoot);

    /// <summary>
    /// The settings as the device holds them now, which another window may have changed since
    /// this one last looked. Read before each listener start and each status read.
    /// </summary>
    private DesktopAgentSettingsStore FreshSettings()
    {
        var settings = Settings();
        settings.Refresh();
        return settings;
    }

    private DesktopAgentPortStore Ports() =>
        _agentPorts ??= new DesktopAgentPortStore(_deviceStateRoot);

    private DesktopAgentModeStore Modes() =>
        _agentModes ??= new DesktopAgentModeStore(_deviceStateRoot);

    /// <summary>
    /// Which application the open file is, and which instance of it, read once per file session:
    /// the port and the level it keeps are filed under both, so a moved or renamed file keeps
    /// them and a Fork, a Duplicate or a new file of the application gets its own.
    /// </summary>
    private async Task<string> AgentApplicationIdAsync(NendoApplicationService service, CancellationToken cancellationToken)
    {
        if (_agentApplicationId is { } known) return known;
        var snapshot = await service.GetDefinitionSnapshotAsync(cancellationToken);
        _agentFileName = snapshot.FileName;
        _agentInstanceId = snapshot.Manifest.InstanceId;
        return _agentApplicationId = snapshot.Manifest.ApplicationId;
    }

    /// <summary>
    /// Keeps the level the person chose for this file, or forgets it on Off (ADR-0009).
    /// Best effort: a level that could not be kept is still this run's.
    /// </summary>
    private async Task RememberAgentModeAsync(NendoApplicationService service, AgentAccessMode mode, CancellationToken cancellationToken)
    {
        try
        {
            var applicationId = await AgentApplicationIdAsync(service, cancellationToken);
            Modes().Remember(applicationId, _agentInstanceId!, _agentFileName, ModeName(mode));
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// A writable open of a file this device remembers a level for turns that level on again.
    /// Never fails the open: a level that cannot start leaves the file at Off, as before.
    /// </summary>
    private partial async Task RestoreAgentModeAsync(bool writable, CancellationToken cancellationToken)
    {
        if (!writable || _service is not { } service || !service.Capabilities.AgentAccess || _agentHost is not null) return;
        try
        {
            var applicationId = await AgentApplicationIdAsync(service, cancellationToken);
            if (Modes().Recall(applicationId, _agentInstanceId!) is not { } remembered) return;
            var mode = ParseMode(remembered);
            if (mode == AgentAccessMode.Disabled) return;
            await StartAgentHostCoreAsync(service, mode, cancellationToken);
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            await StopAgentAccessCoreAsync();
        }
    }

    private async Task StartAgentHostCoreAsync(NendoApplicationService service, AgentAccessMode mode, CancellationToken cancellationToken)
    {
        // A new level restarts the listener. A launched agent keeps running across it and meets
        // the new level on its next call, unless the address itself moved (ADR-0030).
        await StopAgentAccessCoreAsync(restarting: true);
        EnsureProposalStore();
        try
        {
            _agentHost = await NendoLocalMcpHost.StartAsync(
                service,
                mode,
                CurrentHostOptions(await FilePortAsync(service, cancellationToken)),
                _agentProposals,
                UnattendedConsent(mode),
                cancellationToken);
        }
        catch
        {
            // No listener came back, so a launched agent has nothing left to talk to.
            await EndLaunchedAgentCoreAsync("Agent access could not start again, so the agent was ended.", forget: false);
            throw;
        }
        _agentMode = mode;
        AttachWorkSignal(_agentHost);
        await EndLaunchedAgentIfMovedCoreAsync();
        SayLevelChanged();
    }

    /// <summary>The port this file listens on: its own kept port, or a new one each time with Fixed port off.</summary>
    private async Task<int?> FilePortAsync(NendoApplicationService service, CancellationToken cancellationToken) =>
        FreshSettings().FixedPort
            ? Ports().Claim(await AgentApplicationIdAsync(service, cancellationToken), _agentInstanceId!, _agentFileName, Settings().Port)
            : null;

    /// <summary>
    /// What the Port field shows: the port this file keeps, or would be given, when a file is
    /// open; the device's first port when none is. Never claims one: reading the page must not
    /// hand out a port.
    /// </summary>
    private async Task<int> PortPreferenceAsync(CancellationToken cancellationToken)
    {
        if (_service is not { } service) return Settings().Port;
        try { return Ports().Peek(await AgentApplicationIdAsync(service, cancellationToken), _agentInstanceId!, Settings().Port, _agentFileName); }
        catch (NendoException) { return Settings().Port; }
    }

    internal async Task<DesktopAgentStatus> SetAgentSettingsAsync(
        bool leaseExpiry,
        int leaseExpirySeconds,
        bool fixedPort,
        int port,
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            // Refuse the whole request before either device store changes. A valid
            // port paired with an invalid expiry must not be kept for the next start.
            DesktopAgentSettingsStore.Validate(leaseExpirySeconds, port);
            if (_service is { Capabilities.AgentAccess: true } open)
            {
                // With a file open the Port field is that file's own port. Its
                // reservation can still be refused, before saving the validated settings.
                if (fixedPort) Ports().Set(await AgentApplicationIdAsync(open, cancellationToken), _agentInstanceId!, _agentFileName, port);
                Settings().Save(leaseExpiry, leaseExpirySeconds, fixedPort, Settings().Port);
            }
            else
            {
                Settings().Save(leaseExpiry, leaseExpirySeconds, fixedPort, port);
            }
            // Restart an already-running host so a changed setting takes effect now rather than silently
            // waiting for the next enable.
            if (_agentHost is not null)
            {
                var mode = _agentMode;
                if (mode != AgentAccessMode.Disabled && _service is { } service) await StartAgentHostCoreAsync(service, mode, cancellationToken);
                else await StopAgentAccessCoreAsync();
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
                // Off is remembered first: a listener whose cleanup throws has still stopped, and
                // the next open must not start the level the person just turned off.
                await RememberAgentModeAsync(service, requested, cancellationToken);
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

            await StartAgentHostCoreAsync(service, requested, cancellationToken);
            await RememberAgentModeAsync(service, requested, cancellationToken);
            return await ReadAgentStatusCoreAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Makes the file a <c>-new</c> launch named and starts the level its <c>-access</c> asked
    /// for, as if the person had chosen it on the Agent page (ADR-0009). Only a file this call
    /// made gets a level: a create that finds a file already there is refused before it.
    /// A level that cannot start leaves the new file at Off, as a remembered one does on open.
    /// </summary>
    internal async Task<DesktopSessionView> CreateForLaunchAsync(
        string path,
        string? access,
        CancellationToken cancellationToken = default)
    {
        var created = await CreateFromSavePickerAsync(path, cancellationToken);
        if (access is null) return created;
        try
        {
            await SetAgentModeAsync(access, cancellationToken);
        }
        catch (Exception exception) when (exception is NendoException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
        }
        return created;
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

    partial void BeginAgentFileSession()
    {
        _agentHost = null;
        _agentMode = AgentAccessMode.Disabled;
        _agentApplicationId = null;
        _agentInstanceId = null;
        _agentFileName = null;
        _agentProposals = null;
        _agentProposals = EnsureProposalStore();
        RotateFileSession();
        _agentCleanupNotice = null;
        var coordinator = _coordinator!;
        // An observer the coordinator swallowed is kept by its type alone, under the same
        // "Record failures" switch, and off the Engine gate.
        coordinator.ObserverFailed = type => _ = Task.Run(() => RecordAgentFailure(new NendoAgentFailure(
            DateTimeOffset.UtcNow, Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(),
            "engine", "coordinator.observer", type.FullName ?? type.Name, string.Empty)));
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

    /// <param name="restarting">
    /// True only when a new listener takes this one's place at once. Otherwise agent access is
    /// ending, and the agent launched from the Agent page ends with it (ADR-0030).
    /// </param>
    private async Task StopAgentAccessCoreAsync(bool restarting = false)
    {
        if (!restarting)
            await EndLaunchedAgentCoreAsync("Agent access was turned off for this file, so the agent was ended.", forget: false);
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
            try
            {
                await host.DisposeAsync();
            }
            finally
            {
                AnnounceAgentIdle();
            }
        }
    }

    private partial async Task CloseAgentFileSessionCoreAsync()
    {
        try
        {
            await EndLaunchedAgentCoreAsync("The file was closed, so the agent was ended.", forget: true);
            await StopAgentAccessCoreAsync();
            if (_agentProposals is not null && _service?.Capabilities.Mutate is true)
                await _agentProposals.CloseFileSessionAsync(_service);
        }
        finally { _agentProposals = null; }
    }

    private partial async Task StopUnhealthyAgentAccessCoreAsync()
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

    /// <summary>The status of agent access that is off: no agent, no lease, no activity, and the saved settings.</summary>
    private DesktopAgentStatus OffStatus(
        bool available, string state, IReadOnlyList<NendoAgentProposalSummary> pendingProposals, int portPreference) =>
        new(available, "off", state, null, null, null, [], pendingProposals,
            Settings().LeaseExpiry, Settings().LeaseExpirySeconds, Settings().FixedPort,
            portPreference, null, true, Settings().Persisted, Settings().Notice);

    private async Task<DesktopAgentStatus> ReadAgentStatusCoreAsync(CancellationToken cancellationToken)
    {
        FreshSettings();
        if (_service is null)
        {
            return OffStatus(false, "noFile", [], Settings().Port);
        }
        await StopUnhealthyAgentAccessCoreAsync();
        if (!_service.Capabilities.AgentAccess)
        {
            return OffStatus(
                false,
                _service.Health == NendoSessionHealth.ReadOnly ? "readOnly" : "recoveryRequired",
                _agentProposals?.Snapshot() ?? [],
                Settings().Port);
        }
        if (_agentHost is null)
        {
            return OffStatus(true, "off", _agentProposals?.Snapshot() ?? [], await PortPreferenceAsync(cancellationToken));
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
            await PortPreferenceAsync(cancellationToken),
            _agentHost.Endpoint.AbsoluteUri,
            !_agentHost.UsedFallbackPort,
            Settings().Persisted,
            Settings().Notice,
            _agentApplicationId is { } applicationId && _agentInstanceId is { } instanceId &&
                Modes().Recall(applicationId, instanceId) == ModeName(_agentMode));
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
    /// (ADR-0009).
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
            if (_coordinator is { } coordinator && coordinator.BehaviourTrust.Required is { } required)
            {
                BehaviourGrants.Approve(required);
                // The shell's copy, read here on the agent's thread rather than by the window.
                _shellTrust = coordinator.BehaviourTrust;
            }
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
