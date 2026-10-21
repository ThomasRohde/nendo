using System.ComponentModel;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// The person's own agent program, launched from the Agent page for the open file (ADR-0030):
/// its process, its working folder and its conversation.
/// <para>
/// Ending it ends the program and everything it started, and removes the folder when Nendo made
/// it; the file's repository, when the person chose to start there, is never removed. The
/// conversation's transcript stays readable until the file closes or another agent is launched.
/// </para>
/// </summary>
internal sealed class DesktopLaunchedAgent : IAsyncDisposable
{
    private readonly AgentProcess _process;
    private readonly AgentConversation _conversation;
    private readonly CancellationTokenSource _stop = new();
    private readonly bool _ownsFolder;
    private int _ended;

    /// <summary>
    /// The person's kept values for this agent, sent before it is ready, and where the options it
    /// offers go to be kept (ADR-0030).
    /// </summary>
    internal sealed record AgentSettings(IReadOnlyDictionary<string, string>? Kept, Action<IReadOnlyList<AgentOptionView>>? Offered);

    /// <summary>The folders of the agents this process runs now, which a sweep never takes.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, byte> LiveFolders = new(StringComparer.OrdinalIgnoreCase);

    private DesktopLaunchedAgent(DesktopAgentCommand command, Uri endpoint, string workingDirectory, AgentProcess process, bool ownsFolder,
        AgentSettings settings)
    {
        Command = command;
        Endpoint = endpoint;
        WorkingDirectory = workingDirectory;
        _ownsFolder = ownsFolder;
        _process = process;
        _conversation = new AgentConversation(process.StandardOutput, process.StandardInput, command.Name)
        {
            Kept = settings.Kept ?? new Dictionary<string, string>(),
            OptionsOffered = settings.Offered,
        };
        _conversation.Changed += revision => Changed?.Invoke(revision);
    }

    internal DesktopAgentCommand Command { get; }

    /// <summary>
    /// This launch, and no other: every read carries it, and a request that names another is
    /// refused, so an answer meant for a replaced conversation never reaches this one.
    /// </summary>
    internal string ConversationId { get; } = Guid.NewGuid().ToString("N");

    /// <summary>The one MCP address the agent was given: the open file's own.</summary>
    internal Uri Endpoint { get; }

    internal string WorkingDirectory { get; }

    /// <summary>Whether the agent works in the file's repository, which the person chose, rather than an empty folder.</summary>
    internal bool InRepository => !_ownsFolder;

    internal int ProcessId => _process.ProcessId;

    internal AgentConversation Conversation => _conversation;

    /// <summary>The handshake: done when the agent is ready, waiting to sign in, or refused.</summary>
    internal Task Started { get; private set; } = Task.CompletedTask;

    internal bool HasEnded => Volatile.Read(ref _ended) != 0 || _conversation.State == "ended";

    /// <summary>Something in the conversation changed, carrying its new revision.</summary>
    internal event Action<long>? Changed;

    /// <summary>
    /// Start <paramref name="command"/> in a new empty folder under <paramref name="sessionsRoot"/>,
    /// or in <paramref name="repository"/> when the person chose the file's repository, and begin
    /// the handshake, which runs on. Throws a refusal the Agent page can show when the program is
    /// not installed or Windows cannot start it.
    /// </summary>
    internal static DesktopLaunchedAgent Launch(DesktopAgentCommand command, Uri endpoint, string sessionsRoot, string clientVersion,
        IReadOnlyDictionary<string, string>? environment = null, string? repository = null, AgentSettings? settings = null)
    {
        if (command.ResolvedPath is null)
            throw new NendoPreconditionException("agent-not-found", $"{command.Name} is not installed on this computer: {command.Program} was not found.");
        if (repository is not null && !Directory.Exists(repository))
            throw new NendoPreconditionException("agent-folder-missing", $"The folder to start {command.Name} in is gone: {repository}. Choose an empty folder on the Agent page, or put it back.");
        // Every folder left by a launch that did not end through EndAsync -- a host that was
        // killed, upgraded over or logged off, or a delete that gave up -- goes first. Only
        // folders under the sessions root are ever swept; a repository never is.
        SweepFolders(sessionsRoot);
        var owns = repository is null;
        var folder = repository ?? Path.Combine(sessionsRoot, FolderName(Environment.ProcessId));
        if (owns)
        {
            Directory.CreateDirectory(folder);
            LiveFolders[Path.GetFullPath(folder)] = 0;
        }
        AgentProcess process;
        try
        {
            process = AgentProcess.Start(command, folder, environment);
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or IOException)
        {
            if (owns) RemoveFolder(folder);
            throw new NendoPreconditionException("agent-start-failed", $"{command.Name} could not start: {exception.Message}");
        }
        var agent = new DesktopLaunchedAgent(command, endpoint, folder, process, owns, settings ?? new AgentSettings(null, null));
        agent.Started = agent._conversation.StartAsync(endpoint, folder, clientVersion, agent._stop.Token);
        _ = agent.WatchAsync();
        return agent;
    }

    /// <summary>
    /// When the program stops on its own, the conversation says so, with what it last said. When
    /// the conversation ends first -- an agent refused at the handshake keeps running with its
    /// input open -- the program is ended with it.
    /// </summary>
    private async Task WatchAsync()
    {
        var first = await Task.WhenAny(_process.Exited, _conversation.Closed, _conversation.Ended);
        if (Volatile.Read(ref _ended) != 0) return;
        if (first == _conversation.Ended)
        {
            await EndAsync("The conversation ended.");
            return;
        }
        // Give the error pump a moment: a program that refuses a flag says why and exits.
        try { await _process.Exited.WaitAsync(TimeSpan.FromSeconds(2)); } catch (TimeoutException) { }
        var tail = _process.StandardErrorTail;
        var said = tail.Length == 0 ? string.Empty : $" It said: {Last(tail, 600)}";
        // A connection that ended while the program still runs says why it ended: Nendo may have
        // ended it, over a message too large, and "stopped answering" blamed the agent.
        var how = _process.ExitCode is { } code ? $"{Command.Name} stopped (exit code {code})."
            : _conversation.Closed.IsCompleted ? $"{Command.Name} was disconnected. {_conversation.Closed.Result}"
            : $"{Command.Name} stopped answering.";
        _conversation.End(how + said);
        await EndAsync(how);
    }

    /// <summary>
    /// End the program, keep the transcript, and remove the folder Nendo made for it; never the
    /// file's repository. Safe to call more than once.
    /// </summary>
    internal async Task EndAsync(string notice)
    {
        _conversation.End(notice);
        if (Interlocked.Exchange(ref _ended, 1) != 0) return;
        await _stop.CancelAsync();
        await _process.DisposeAsync();
        if (_ownsFolder) RemoveFolder(WorkingDirectory);
    }

    /// <summary>
    /// A launch's folder name: the host process that made it, then a new GUID. The process ID is
    /// how a sweep tells a folder another running Nendo window still uses from one left behind.
    /// </summary>
    internal static string FolderName(int processId) => $"{processId}-{Guid.NewGuid():N}";

    /// <summary>
    /// Remove every launch folder under <paramref name="sessionsRoot"/> that no running agent can
    /// still be using. This process runs one agent at a time and sweeps before it launches the
    /// next, so a folder of its own is left over; a folder of another process is left over once
    /// that process has ended. A folder named before process IDs were part of the name is left
    /// over unless Windows refuses its removal because a program still works in it. A folder that
    /// will not go now goes at a later launch.
    /// </summary>
    internal static void SweepFolders(string sessionsRoot)
    {
        string[] folders;
        try
        {
            if (!Directory.Exists(sessionsRoot)) return;
            folders = Directory.GetDirectories(sessionsRoot);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return; }
        foreach (var folder in folders)
        {
            var name = Path.GetFileName(folder);
            var dash = name.IndexOf('-', StringComparison.Ordinal);
            if (LiveFolders.ContainsKey(Path.GetFullPath(folder))) continue;
            if (dash > 0 && int.TryParse(name.AsSpan(0, dash), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var owner))
            {
                if (owner != Environment.ProcessId && IsRunning(owner)) continue;
            }
            else if (!Guid.TryParseExact(name, "N", out _)) continue;
            TryRemoveFolder(folder);
        }
    }

    private static bool IsRunning(int processId)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Win32Exception)
        {
            // Not running, or not ours to ask about: a process Windows will not open is still running.
            return exception is Win32Exception;
        }
    }

    private static void TryRemoveFolder(string folder)
    {
        // A folder a program still has a file open in is not left over, whatever its name says:
        // an older Nendo's folder is not emptied around the agent working in it.
        if (InUse(folder)) return;
        try { Directory.Delete(folder, recursive: true); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Whether any file under <paramref name="folder"/> cannot be opened for this process alone.</summary>
    private static bool InUse(string folder)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
            {
                try { using var probe = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { return true; }
            }
            return false;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return true;
        }
    }

    private static void RemoveFolder(string folder)
    {
        LiveFolders.TryRemove(Path.GetFullPath(folder), out _);
        // The program has just been ended, and Windows may still hold a handle it had open.
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
                return;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(100);
            }
        }
    }

    private static string Last(string text, int characters) =>
        text.Length <= characters ? text : string.Concat("…", text.AsSpan(text.Length - characters));

    public async ValueTask DisposeAsync()
    {
        await EndAsync("The conversation ended.");
        await _conversation.DisposeAsync();
    }
}
