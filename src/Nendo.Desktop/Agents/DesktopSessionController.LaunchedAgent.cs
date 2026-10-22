using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop;

/// <summary>
/// An agent the Agent page offers, whether it was found on this computer, and what a person would
/// run in a terminal to install it or, when it came from a renamed package, to move it to the one
/// still updated. Nendo shows these commands and never runs them. <c>Settings</c> are the ones
/// kept for it on this device, which a view's launch card shows before it starts; null when its
/// options were never kept here.
/// </summary>
internal sealed record DesktopLaunchableAgentView(
    string Id,
    string Name,
    string CommandLine,
    bool Found,
    string? Package,
    string? InstallCommand,
    string? RenamedFrom,
    string? UpdateCommand,
    IReadOnlyList<DesktopAgentSettingView>? Settings = null);

/// <summary>The agent running for this file, as the Agent page names it.</summary>
internal sealed record DesktopLaunchedAgentSummary(string AgentId, string Name, string State, bool Working);

/// <summary>
/// What the Agent page shows under Launch: whether a launch is possible now and why not, the
/// agents it can offer, the person's own command, the agent already running, and the agents this
/// person hid on this device (by ID, <c>custom</c> for their own command). A hidden agent is still
/// listed, so the page can offer to show it again. <c>LastAgentId</c> is the agent last launched
/// on this device and <c>ViewAccess</c> whether custom views may message the agent (ADR-0033).
/// <c>StartInRepository</c> says whether this file's agent starts in <c>RepositoryFolder</c>, the
/// file's repository, rather than an empty folder; the folder is named whichever is chosen.
/// </summary>
internal sealed record DesktopLaunchableAgents(
    bool CanLaunch,
    string? Reason,
    IReadOnlyList<DesktopLaunchableAgentView> Agents,
    string? CustomCommandLine,
    DesktopLaunchedAgentSummary? Running,
    IReadOnlyList<string> Hidden,
    string? LastAgentId = null,
    string ViewAccess = DesktopAgentLaunchStore.ViewAccessAsk,
    bool StartInRepository = false,
    string? RepositoryFolder = null);

/// <summary>
/// The conversation tab's read: which launch it is, who the agent is, the level it works at, the
/// MCP address it was given, its state, the entries that changed after the revision the tab asked
/// from, the order of the oldest entry still kept, whether a sign-in runs, and the agent's
/// slash commands.
/// </summary>
internal sealed record DesktopLaunchedAgentView(
    bool Exists,
    string? ConversationId,
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
    IReadOnlyList<AgentOptionView> Options,
    long FirstOrder,
    bool SigningIn = false,
    IReadOnlyList<AgentCommandView>? Commands = null,
    string? TurnId = null,
    int Queued = 0,
    string? WorkingFolder = null)
{
    internal static DesktopLaunchedAgentView None(string level) =>
        new(false, null, null, null, null, null, level, "none", false, null, null, 0, [], false, [], [], 0, false, []);
}

internal sealed partial class DesktopSessionController
{
    private volatile DesktopLaunchedAgent? _launched;
    private DesktopAgentLaunchStore? _agentLaunch;
    private readonly object _catalogSync = new();
    private readonly SemaphoreSlim _catalogWalk = new(1, 1);
    private Task<AgentCatalog>? _catalog;
    private string? _catalogFor;
    private long _catalogStarted;

    /// <summary>A catalogue this recent is reused, so a list and a launch close together walk PATH once.</summary>
    private const long CatalogReuseMilliseconds = 2000;

    /// <summary>The agents found, and the environment they were found in and will start with.</summary>
    private sealed record AgentCatalog(IReadOnlyList<DesktopAgentCommand> Agents, IReadOnlyDictionary<string, string> Environment);

    /// <summary>
    /// The person's environment as Windows holds it now. The tests put another in its
    /// place; it is read off the request gate, with the catalogue.
    /// </summary>
    internal Func<IReadOnlyDictionary<string, string>> AgentEnvironmentReader
    {
        get => _agentEnvironmentReader;
        set
        {
            // Another environment is another catalogue.
            lock (_catalogSync)
            {
                _agentEnvironmentReader = value;
                _catalog = null;
            }
        }
    }
    private Func<IReadOnlyDictionary<string, string>> _agentEnvironmentReader = AgentEnvironment.Read;

    /// <summary>
    /// The launched agent's conversation changed, carrying its revision. Raised on the agent's
    /// own thread, outside every gate: a handler marshals and returns.
    /// </summary>
    internal event Action<long>? LaunchedAgentChanged;

    private DesktopAgentLaunchStore AgentLaunch() => _agentLaunch ??= new DesktopAgentLaunchStore(_deviceStateRoot);

    private DesktopAgentOptionsStore AgentPicks() => _agentPicks ??= new DesktopAgentOptionsStore(_deviceStateRoot);
    private DesktopAgentOptionsStore? _agentPicks;

    /// <summary>Keep for <paramref name="agentId"/> what the person picked, or what the agent offers; a device that cannot keep it still runs the agent.</summary>
    private void KeepSettings(Action<DesktopAgentOptionsStore> keep)
    {
        try { keep(AgentPicks()); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or TimeoutException) { }
    }

    /// <summary>Where each launched agent's empty working folder is made.</summary>
    private string AgentSessionsRoot => DesktopDeviceStateLayout.AgentSessions(_deviceStateRoot);

    /// <summary>The agent running for this file, for the tests.</summary>
    internal DesktopLaunchedAgent? LaunchedAgent => _launched;

    internal async Task<DesktopLaunchableAgents> ListLaunchableAgentsAsync(string fileSessionId, CancellationToken cancellationToken = default)
    {
        // Finding the agents walks every PATH folder, and an unreachable share there took about
        // 20 seconds; under the request gate the Agent page's poll held every save and every
        // switch behind it. It reads no file state, so it runs before the gate.
        var catalog = await CatalogAsync(AgentLaunch().CommandLine, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            return DescribeLaunchableCore(catalog);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Keep the person's own command line on this device, or forget it with an empty one.</summary>
    internal async Task<DesktopLaunchableAgents> SetAgentCommandAsync(string fileSessionId, string? commandLine, CancellationToken cancellationToken = default)
    {
        var line = commandLine?.Trim();
        var catalog = await CatalogAsync(string.IsNullOrEmpty(line) ? null : line, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            var before = AgentLaunch().CommandLine;
            try { AgentLaunch().Save(commandLine); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new NendoPreconditionException("agent-command-not-saved", "Your command could not be kept on this computer.");
            }
            // Another command may be another program, with other settings.
            if (!string.Equals(before, AgentLaunch().CommandLine, StringComparison.Ordinal))
                KeepSettings(store => store.Forget(DesktopAgentCatalog.CustomId));
            return DescribeLaunchableCore(catalog);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Hide an agent from Launch on this device, or show it again.</summary>
    internal async Task<DesktopLaunchableAgents> SetAgentHiddenAsync(string fileSessionId, string agentId, bool hidden, CancellationToken cancellationToken = default)
    {
        var catalog = await CatalogAsync(AgentLaunch().CommandLine, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            try { AgentLaunch().SetHidden(agentId, hidden); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new NendoPreconditionException("agent-choice-not-saved", "That choice could not be kept on this computer.");
            }
            return DescribeLaunchableCore(catalog);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Start this file's agent in the file's repository, or in an empty folder again (ADR-0030),
    /// kept on this device for this file. An agent already running keeps the folder it has.
    /// </summary>
    internal async Task<DesktopLaunchableAgents> SetAgentStartInRepositoryAsync(string fileSessionId, bool repository, CancellationToken cancellationToken = default)
    {
        var catalog = await CatalogAsync(AgentLaunch().CommandLine, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            var path = _currentPath ?? throw new NendoPreconditionException("agent-launch-unavailable", "Open a file first.");
            try { AgentLaunch().SetStartInRepository(path, repository); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new NendoPreconditionException("agent-choice-not-saved", "That choice could not be kept on this computer.");
            }
            return DescribeLaunchableCore(catalog);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The repository a file is in: the nearest folder above it that holds <c>.git</c>, a folder
    /// or the file a worktree has, or the file's own folder when none does.
    /// </summary>
    internal static string RepositoryFolderOf(string filePath)
    {
        var own = Path.GetDirectoryName(Path.GetFullPath(filePath))!;
        for (var folder = own; folder is not null; folder = Path.GetDirectoryName(folder))
        {
            var git = Path.Combine(folder, ".git");
            if (Directory.Exists(git) || File.Exists(git)) return folder;
        }
        return own;
    }

    /// <summary>Choose on this device whether custom views may message the agent (ADR-0033).</summary>
    internal async Task<DesktopLaunchableAgents> SetAgentViewAccessAsync(string fileSessionId, string access, CancellationToken cancellationToken = default)
    {
        var catalog = await CatalogAsync(AgentLaunch().CommandLine, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            try { AgentLaunch().SetViewAccess(access); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                throw new NendoPreconditionException("agent-choice-not-saved", "That choice could not be kept on this computer.");
            }
            return DescribeLaunchableCore(catalog);
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
    /// <param name="settings">
    /// What the person picked on a view's launch card, by option ID: each one of the settings kept
    /// for this agent, and a value it offered. Kept before the agent starts, and sent with the rest.
    /// </param>
    internal async Task<DesktopLaunchedAgentView> LaunchAgentAsync(string fileSessionId, string agentId, CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? settings = null)
    {
        var catalog = await CatalogAsync(AgentLaunch().CommandLine, cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            RequireFileSession(fileSessionId);
            var launchable = DescribeLaunchableCore(catalog);
            if (!launchable.CanLaunch)
                throw new NendoPreconditionException("agent-launch-unavailable", launchable.Reason ?? "An agent cannot be launched now.");
            if (_launched is { HasEnded: false } running)
                throw new NendoPreconditionException("agent-already-running",
                    $"{running.Command.Name} is already running for this file. End it before launching another.");
            var command = catalog.Agents.FirstOrDefault(candidate => candidate.Id == agentId)
                ?? throw new NendoValidationException("Choose one of the agents the Agent page offers.");
            if (settings is { Count: > 0 })
            {
                var offered = AgentPicks().Settings(command.Id) ?? [];
                foreach (var (optionId, value) in settings)
                {
                    var option = offered.FirstOrDefault(candidate => candidate.Id == optionId)
                        ?? throw new NendoValidationException($"{command.Name} has no setting {optionId} kept on this computer.");
                    if (!option.Values.Any(candidate => candidate.Value == value))
                        throw new NendoValidationException($"Choose one of the values {command.Name} offered for {option.Name}.");
                }
                KeepSettings(store => store.Pick(command.Id, settings));
            }
            var endpoint = _agentHost!.Endpoint;
            var previous = _launched;
            _launched = null;
            // An old conversation that fails to close does not stop the new launch.
            if (previous is not null)
            {
                try { await previous.DisposeAsync(); }
                catch (Exception) { /* The program is in a job that ends with the host. */ }
            }
            // The file's repository when the person chose it for this file; otherwise an empty folder.
            var repository = _currentPath is { } path && AgentLaunch().StartsInRepository(path) ? RepositoryFolderOf(path) : null;
            var kept = AgentPicks().For(command.Id)?.Picked;
            var agent = DesktopLaunchedAgent.Launch(command, endpoint, AgentSessionsRoot, NendoProduct.Version, catalog.Environment, repository,
                new DesktopLaunchedAgent.AgentSettings(kept, options => KeepSettings(store => store.Offered(command.Id, options))));
            agent.Changed += revision =>
            {
                // A conversation that has since been replaced, or whose file has closed, is not news.
                if (ReferenceEquals(agent, _launched)) LaunchedAgentChanged?.Invoke(revision);
            };
            _launched = agent;
            // The launch answers what it started before the device is written: the write took long
            // enough for a quick agent's handshake to finish first, so the answer said Ready.
            var started = ReadLaunchedCore(agent, 0);
            // Which agent a view's card offers next; a device that cannot keep it still launches.
            try { AgentLaunch().SetLastAgent(command.Id); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            return started;
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

    /// <param name="from">
    /// The custom view that sent the message, by its title (ADR-0033), or null for the person's
    /// own. Refused while the person chose Never for views on this device.
    /// </param>
    internal DesktopLaunchedAgentView PromptLaunchedAgent(string fileSessionId, string text, long after, IReadOnlyList<AgentPromptContext>? pointedAt = null, string? conversationId = null, string? from = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
        if (from is not null && AgentLaunch().ViewAccess == DesktopAgentLaunchStore.ViewAccessNever)
            throw new NendoPreconditionException("assistant-off", "Views may not message the agent on this computer. Change it on the Agent page.");
        var turnId = agent.Conversation.Prompt(text, pointedAt, from);
        return ReadLaunchedCore(agent, after) with { TurnId = turnId };
    }

    /// <summary>A turn of this conversation read back: whether it ended, its reply and why it stopped.</summary>
    internal AgentTurnView ReadLaunchedAgentTurn(string fileSessionId, string turnId, string? conversationId = null) =>
        RequireLaunched(fileSessionId, conversationId).Conversation.ReadTurn(turnId);

    internal DesktopLaunchedAgentView AnswerLaunchedAgent(string fileSessionId, string entryId, string? optionId, long after, string? conversationId = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
        agent.Conversation.Answer(entryId, optionId);
        return ReadLaunchedCore(agent, after);
    }

    /// <param name="turnId">
    /// A view's own turn to stop (ADR-0033): dropped if it still waits, cancelled if it runs. Null
    /// for the person's Stop, which cancels the running turn and drops every waiting message.
    /// </param>
    internal async Task<DesktopLaunchedAgentView> CancelLaunchedAgentTurnAsync(string fileSessionId, long after, string? conversationId = null, string? turnId = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
        if (turnId is null) await agent.Conversation.CancelTurnAsync();
        else await agent.Conversation.CancelTurnAsync(turnId);
        return ReadLaunchedCore(agent, after);
    }

    /// <summary>Ask the agent to sign in by the way the person chose. Runs on; the tab reads how it went.</summary>
    internal DesktopLaunchedAgentView AuthenticateLaunchedAgent(string fileSessionId, string methodId, long after, string? conversationId = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
        if (agent.Conversation.State != "signIn")
            throw new NendoPreconditionException("agent-not-signing-in", "The agent is not waiting to sign in.");
        _ = agent.Conversation.AuthenticateAsync(methodId, CancellationToken.None);
        return ReadLaunchedCore(agent, after);
    }

    /// <summary>Set one of the agent's own options to a value it offered (ADR-0030).</summary>
    internal async Task<DesktopLaunchedAgentView> SetLaunchedAgentOptionAsync(string fileSessionId, string optionId, string value, long after, CancellationToken cancellationToken = default, string? conversationId = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
        await agent.Conversation.SetOptionAsync(optionId, value, cancellationToken);
        // The person's pick, kept for this agent's next start (ADR-0030).
        KeepSettings(store => store.Pick(agent.Command.Id, new Dictionary<string, string> { [optionId] = value }));
        return ReadLaunchedCore(agent, after);
    }

    internal async Task<DesktopLaunchedAgentView> EndLaunchedAgentAsync(string fileSessionId, long after, string? conversationId = null)
    {
        var agent = RequireLaunched(fileSessionId, conversationId);
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
        if (!forget) return;
        // Closing the file goes on to stop agent access and close its proposals however the
        // conversation's own close went: a throw here once left the file's listener running.
        try { await agent.DisposeAsync(); }
        catch (Exception) { /* The program is in a job that ends with the host. */ }
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

    /// <summary>
    /// The agents this computer has, with <paramref name="customCommandLine"/> as the person's own,
    /// found in the environment as it is now. One walk of PATH at a time, whatever the command line:
    /// a request for the same one that comes while it runs, or within two seconds of its start,
    /// shares it, and one for another waits for it to end.
    /// </summary>
    private Task<AgentCatalog> CatalogAsync(string? customCommandLine, CancellationToken cancellationToken)
    {
        Task<AgentCatalog> catalog;
        lock (_catalogSync)
        {
            var now = Environment.TickCount64;
            if (_catalog is { } held && string.Equals(_catalogFor, customCommandLine, StringComparison.Ordinal) &&
                (!held.IsCompleted || held.IsCompletedSuccessfully && now - _catalogStarted < CatalogReuseMilliseconds))
            {
                catalog = held;
            }
            else
            {
                var read = _agentEnvironmentReader;
                _catalogFor = customCommandLine;
                _catalogStarted = now;
                _catalog = catalog = Task.Run(async () =>
                {
                    // One walk of PATH at a time, whatever command line it is for.
                    await _catalogWalk.WaitAsync();
                    try
                    {
                        var environment = read();
                        return new AgentCatalog(DesktopAgentCatalog.List(customCommandLine, AgentEnvironment.PathOf(environment)), environment);
                    }
                    finally
                    {
                        _catalogWalk.Release();
                    }
                });
            }
        }
        return catalog.WaitAsync(cancellationToken);
    }

    private DesktopLaunchableAgents DescribeLaunchableCore(AgentCatalog catalog)
    {
        var custom = AgentLaunch().CommandLine;
        var agents = catalog.Agents
            .Select(agent => new DesktopLaunchableAgentView(agent.Id, agent.Name, agent.CommandLine, agent.ResolvedPath is not null,
                agent.Package, agent.InstallCommand, agent.RenamedFrom, agent.UpdateCommand, KeptSettings(agent.Id)))
            .ToArray();
        var running = _launched is { HasEnded: false } agent
            ? new DesktopLaunchedAgentSummary(agent.Command.Id, agent.Command.Name, agent.Conversation.State, agent.Conversation.Working)
            : null;
        var choices = AgentLaunch();
        var path = _currentPath;
        return new DesktopLaunchableAgents(LaunchRefusal() is null, LaunchRefusal(), agents, custom, running, choices.Hidden, choices.LastAgentId, choices.ViewAccess,
            path is not null && choices.StartsInRepository(path), path is null ? null : RepositoryFolderOf(path));
    }

    private IReadOnlyList<DesktopAgentSettingView>? KeptSettings(string agentId)
    {
        try { return AgentPicks().Settings(agentId); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return null; }
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
        return new DesktopLaunchedAgentView(true, agent.ConversationId, agent.Command.Id, agent.Command.Name, agent.Command.CommandLine,
            agent.Endpoint.AbsoluteUri, LevelName(), snapshot.State, snapshot.Working, snapshot.Notice, snapshot.AgentTitle,
            snapshot.Revision, snapshot.Entries, snapshot.More, snapshot.SignInMethods, snapshot.Options, snapshot.FirstOrder, snapshot.SigningIn, snapshot.Commands ?? [],
            Queued: snapshot.Queued, WorkingFolder: agent.InRepository ? agent.WorkingDirectory : null);
    }

    private string LevelName() => NendoAccessLevels.DisplayName(_agentMode);

    /// <param name="conversationId">
    /// The launch the request was meant for, when the tab names one. Entry IDs start again with
    /// every launch, so an answer to a replaced conversation's question would otherwise land on
    /// this one's.
    /// </param>
    private DesktopLaunchedAgent RequireLaunched(string fileSessionId, string? conversationId = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        RequireFileSession(fileSessionId);
        var agent = _launched ?? throw new NendoPreconditionException("agent-not-launched",
            "No agent is running for this file. Launch one from the Agent page.");
        if (conversationId is not null && !string.Equals(conversationId, agent.ConversationId, StringComparison.Ordinal))
            throw new NendoPreconditionException("agent-conversation-replaced",
                "That conversation has been replaced by a new one. Nothing was sent.");
        return agent;
    }

    /// <summary>
    /// The access level changed while the agent kept running: tell the tab, which shows the level
    /// and what becomes of the agent's changes, though nothing in the transcript moved.
    /// </summary>
    private void SayLevelChanged()
    {
        if (_launched is { } agent) LaunchedAgentChanged?.Invoke(agent.Conversation.Revision);
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
