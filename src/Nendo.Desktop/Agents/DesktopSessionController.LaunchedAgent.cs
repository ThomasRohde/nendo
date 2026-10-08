using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

/// <summary>An agent the Agent page offers, and whether it was found on this computer.</summary>
internal sealed record DesktopLaunchableAgentView(string Id, string Name, string CommandLine, bool Found);

/// <summary>The agent running for this file, as the Agent page names it.</summary>
internal sealed record DesktopLaunchedAgentSummary(string AgentId, string Name, string State, bool Working);

/// <summary>
/// What the Agent page shows under Launch: whether a launch is possible now and why not, the
/// agents it can offer, the person's own command, and the agent already running.
/// </summary>
internal sealed record DesktopLaunchableAgents(
    bool CanLaunch,
    string? Reason,
    IReadOnlyList<DesktopLaunchableAgentView> Agents,
    string? CustomCommandLine,
    DesktopLaunchedAgentSummary? Running);

/// <summary>
/// The conversation tab's read: who the agent is, the level it works at, the MCP address it was
/// given, its state, and the entries that changed after the revision the tab asked from.
/// </summary>
internal sealed record DesktopLaunchedAgentView(
    bool Exists,
    string? AgentId,
    string? Name,
    string? CommandLine,
    string? Endpoint,
    string Level,
    string State,
    bool Working,
    string? Notice,
    string? AgentTitle,
    long Revision,
    IReadOnlyList<AgentTranscriptEntry> Entries,
    bool More,
    IReadOnlyList<AgentSignInMethodView> SignInMethods,
    IReadOnlyList<AgentOptionView> Options)
{
    internal static DesktopLaunchedAgentView None(string level) =>
        new(false, null, null, null, null, level, "none", false, null, null, 0, [], false, [], []);
}

internal sealed partial class DesktopSessionController
{
    private volatile DesktopLaunchedAgent? _launched;
    private DesktopAgentLaunchStore? _agentLaunch;

    /// <summary>
    /// The launched agent's conversation changed, carrying its revision. Raised on the agent's
    /// own thread, outside every gate: a handler marshals and returns.
    /// </summary>
    internal event Action<long>? LaunchedAgentChanged;

    private DesktopAgentLaunchStore AgentLaunch() => _agentLaunch ??= new DesktopAgentLaunchStore(_deviceStateRoot);

    /// <summary>Where each launched agent's empty working folder is made.</summary>
    private string AgentSessionsRoot => Path.Combine(_deviceStateRoot, "agent-sessions");

    /// <summary>The agent running for this file, for the tests.</summary>
    internal DesktopLaunchedAgent? LaunchedAgent => _launched;

    internal async Task<DesktopLaunchableAgents> ListLaunchableAgentsAsync(string fileSessionId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            return DescribeLaunchableCore();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Keep the person's own command line on this device, or forget it with an empty one.</summary>
    internal async Task<DesktopLaunchableAgents> SetAgentCommandAsync(string fileSessionId, string? commandLine, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            try { AgentLaunch().Save(commandLine); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new NendoPreconditionException("agent-command-not-saved", "Your command could not be kept on this computer.");
            }
            return DescribeLaunchableCore();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Start <paramref name="agentId"/> for the open file, at the access level it is at now. The
    /// handshake runs on; the conversation tab reads how it went.
    /// </summary>
    internal async Task<DesktopLaunchedAgentView> LaunchAgentAsync(string fileSessionId, string agentId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            var launchable = DescribeLaunchableCore();
            if (!launchable.CanLaunch)
                throw new NendoPreconditionException("agent-launch-unavailable", launchable.Reason ?? "An agent cannot be launched now.");
            if (_launched is { HasEnded: false } running)
                throw new NendoPreconditionException("agent-already-running",
                    $"{running.Command.Name} is already running for this file. End it before launching another.");
            var command = DesktopAgentCatalog.List(AgentLaunch().CommandLine).FirstOrDefault(candidate => candidate.Id == agentId)
                ?? throw new NendoValidationException("Choose one of the agents the Agent page offers.");
            var endpoint = _agentHost!.Endpoint;
            var previous = _launched;
            _launched = null;
            if (previous is not null) await previous.DisposeAsync();
            var agent = DesktopLaunchedAgent.Launch(command, endpoint, AgentSessionsRoot, NendoProduct.Version);
            agent.Changed += revision =>
            {
                // A conversation that has since been replaced, or whose file has closed, is not news.
                if (ReferenceEquals(agent, _launched)) LaunchedAgentChanged?.Invoke(revision);
            };
            _launched = agent;
            return ReadLaunchedCore(agent, 0);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The conversation's state and what changed after <paramref name="after"/>. Not gated: the tab
    /// must keep reading while an agent's own write holds the file.
    /// </summary>
    internal DesktopLaunchedAgentView ReadLaunchedAgent(string fileSessionId, long after)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        RequireFileSession(fileSessionId);
        return _launched is { } agent ? ReadLaunchedCore(agent, Math.Max(0, after)) : DesktopLaunchedAgentView.None(LevelName());
    }

    internal DesktopLaunchedAgentView PromptLaunchedAgent(string fileSessionId, string text, long after)
    {
        var agent = RequireLaunched(fileSessionId);
        agent.Conversation.Prompt(text);
        return ReadLaunchedCore(agent, after);
    }

    internal DesktopLaunchedAgentView AnswerLaunchedAgent(string fileSessionId, string entryId, string? optionId, long after)
    {
        var agent = RequireLaunched(fileSessionId);
        agent.Conversation.Answer(entryId, optionId);
        return ReadLaunchedCore(agent, after);
    }

    internal async Task<DesktopLaunchedAgentView> CancelLaunchedAgentTurnAsync(string fileSessionId, long after)
    {
        var agent = RequireLaunched(fileSessionId);
        await agent.Conversation.CancelTurnAsync();
        return ReadLaunchedCore(agent, after);
    }

    /// <summary>Ask the agent to sign in by the way the person chose. Runs on; the tab reads how it went.</summary>
    internal DesktopLaunchedAgentView AuthenticateLaunchedAgent(string fileSessionId, string methodId, long after)
    {
        var agent = RequireLaunched(fileSessionId);
        if (agent.Conversation.State != "signIn")
            throw new NendoPreconditionException("agent-not-signing-in", "The agent is not waiting to sign in.");
        _ = agent.Conversation.AuthenticateAsync(methodId, CancellationToken.None);
        return ReadLaunchedCore(agent, after);
    }

    /// <summary>Set one of the agent's own options to a value it offered (ADR-0030, 2026-10-08).</summary>
    internal async Task<DesktopLaunchedAgentView> SetLaunchedAgentOptionAsync(string fileSessionId, string optionId, string value, long after, CancellationToken cancellationToken = default)
    {
        var agent = RequireLaunched(fileSessionId);
        await agent.Conversation.SetOptionAsync(optionId, value, cancellationToken);
        return ReadLaunchedCore(agent, after);
    }

    internal async Task<DesktopLaunchedAgentView> EndLaunchedAgentAsync(string fileSessionId, long after)
    {
        var agent = RequireLaunched(fileSessionId);
        await agent.EndAsync("You ended the conversation.");
        return ReadLaunchedCore(agent, after);
    }

    /// <summary>
    /// End the launched agent because agent access stopped, the file closed or the file was
    /// replaced. Called under the request gate.
    /// </summary>
    private async Task EndLaunchedAgentCoreAsync(string notice, bool forget)
    {
        var agent = _launched;
        if (agent is null) return;
        if (forget) _launched = null;
        try { await agent.EndAsync(notice); }
        catch (Exception) { /* The program is in a job that ends with the host. */ }
        if (forget) await agent.DisposeAsync();
    }

    /// <summary>A restarted listener with a new address strands the agent on the old one: end it.</summary>
    private async Task EndLaunchedAgentIfMovedCoreAsync()
    {
        if (_launched is not { HasEnded: false } agent || _agentHost is null) return;
        if (agent.Endpoint == _agentHost.Endpoint) return;
        await EndLaunchedAgentCoreAsync(
            $"This file's agent address changed to {_agentHost.Endpoint.AbsoluteUri}, so the agent lost its connection. Launch it again from the Agent page.",
            forget: false);
    }

    private DesktopLaunchableAgents DescribeLaunchableCore()
    {
        var custom = AgentLaunch().CommandLine;
        var agents = DesktopAgentCatalog.List(custom)
            .Select(agent => new DesktopLaunchableAgentView(agent.Id, agent.Name, agent.CommandLine, agent.ResolvedPath is not null))
            .ToArray();
        var running = _launched is { HasEnded: false } agent
            ? new DesktopLaunchedAgentSummary(agent.Command.Id, agent.Command.Name, agent.Conversation.State, agent.Conversation.Working)
            : null;
        return new DesktopLaunchableAgents(LaunchRefusal() is null, LaunchRefusal(), agents, custom, running);
    }

    /// <summary>Why an agent cannot be launched now, or null when it can.</summary>
    private string? LaunchRefusal()
    {
        if (_service is null) return "Open a file first.";
        if (!_service.Capabilities.AgentAccess)
            return _service.Health == NendoSessionHealth.ReadOnly
                ? "Agents cannot connect while this file is open read-only."
                : "Agents cannot connect until this file is healthy again.";
        if (_agentHost is null || _agentMode == AgentAccessMode.Disabled)
            return "Choose Inspect or a higher access level first. The agent works at the level you choose.";
        if (!_agentHost.IsReady) return "Agent access is not ready. Choose the level again.";
        return null;
    }

    private DesktopLaunchedAgentView ReadLaunchedCore(DesktopLaunchedAgent agent, long after)
    {
        var snapshot = agent.Conversation.Read(after);
        return new DesktopLaunchedAgentView(true, agent.Command.Id, agent.Command.Name, agent.Command.CommandLine,
            agent.Endpoint.AbsoluteUri, LevelName(), snapshot.State, snapshot.Working, snapshot.Notice, snapshot.AgentTitle,
            snapshot.Revision, snapshot.Entries, snapshot.More, snapshot.SignInMethods, snapshot.Options);
    }

    private string LevelName() => NendoAccessLevels.DisplayName(_agentMode);

    private DesktopLaunchedAgent RequireLaunched(string fileSessionId)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        RequireFileSession(fileSessionId);
        return _launched ?? throw new NendoPreconditionException("agent-not-launched",
            "No agent is running for this file. Launch one from the Agent page.");
    }

    /// <summary>
    /// The request names the file session that is open now. The launched agent's methods are not
    /// gated, so they check this themselves rather than through the request binding.
    /// </summary>
    private void RequireFileSession(string fileSessionId)
    {
        if (!string.Equals(fileSessionId, _fileSessionId, StringComparison.Ordinal))
            throw new NendoPreconditionException("stale-file-session",
                "This action belongs to a file session that has closed. Refresh the view before continuing.");
    }
}
