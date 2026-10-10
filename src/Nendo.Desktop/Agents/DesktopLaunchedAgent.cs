using System.ComponentModel;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// The person's own agent program, launched from the Agent page for the open file (ADR-0030):
/// its process, its empty working folder and its conversation.
/// <para>
/// Ending it ends the program and everything it started, and removes the folder. The
/// conversation's transcript stays readable until the file closes or another agent is launched.
/// </para>
/// </summary>
internal sealed class DesktopLaunchedAgent : IAsyncDisposable
{
    private readonly AgentProcess _process;
    private readonly AgentConversation _conversation;
    private readonly CancellationTokenSource _stop = new();
    private int _ended;

    private DesktopLaunchedAgent(DesktopAgentCommand command, Uri endpoint, string workingDirectory, AgentProcess process)
    {
        Command = command;
        Endpoint = endpoint;
        WorkingDirectory = workingDirectory;
        _process = process;
        _conversation = new AgentConversation(process.StandardOutput, process.StandardInput, command.Name);
        _conversation.Changed += revision => Changed?.Invoke(revision);
    }

    internal DesktopAgentCommand Command { get; }

    /// <summary>
    /// This launch, and no other: every read carries it, and a request that names another is
    /// refused, so an answer meant for a replaced conversation never reaches this one (ACP-07).
    /// </summary>
    internal string ConversationId { get; } = Guid.NewGuid().ToString("N");

    /// <summary>The one MCP address the agent was given: the open file's own.</summary>
    internal Uri Endpoint { get; }

    internal string WorkingDirectory { get; }

    internal int ProcessId => _process.ProcessId;

    internal AgentConversation Conversation => _conversation;

    /// <summary>The handshake: done when the agent is ready, waiting to sign in, or refused.</summary>
    internal Task Started { get; private set; } = Task.CompletedTask;

    internal bool HasEnded => Volatile.Read(ref _ended) != 0 || _conversation.State == "ended";

    /// <summary>Something in the conversation changed, carrying its new revision.</summary>
    internal event Action<long>? Changed;

    /// <summary>
    /// Start <paramref name="command"/> in a new empty folder under <paramref name="sessionsRoot"/>
    /// and begin the handshake, which runs on. Throws a refusal the Agent page can show when
    /// the program is not installed or Windows cannot start it.
    /// </summary>
    internal static DesktopLaunchedAgent Launch(DesktopAgentCommand command, Uri endpoint, string sessionsRoot, string clientVersion)
    {
        if (command.ResolvedPath is null)
            throw new NendoPreconditionException("agent-not-found", $"{command.Name} is not installed on this computer: {command.Program} was not found.");
        var folder = Path.Combine(sessionsRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        AgentProcess process;
        try
        {
            process = AgentProcess.Start(command, folder);
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or IOException)
        {
            RemoveFolder(folder);
            throw new NendoPreconditionException("agent-start-failed", $"{command.Name} could not start: {exception.Message}");
        }
        var agent = new DesktopLaunchedAgent(command, endpoint, folder, process);
        agent.Started = agent._conversation.StartAsync(endpoint, folder, clientVersion, agent._stop.Token);
        _ = agent.WatchAsync();
        return agent;
    }

    /// <summary>
    /// When the program stops on its own, the conversation says so, with what it last said. When
    /// the conversation ends first -- an agent refused at the handshake keeps running with its
    /// input open -- the program is ended with it (ACP-01).
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
        var how = _process.ExitCode is { } code ? $"{Command.Name} stopped (exit code {code})." : $"{Command.Name} stopped answering.";
        _conversation.End(how + said);
        await EndAsync(how);
    }

    /// <summary>End the program, keep the transcript, remove the folder. Safe to call more than once.</summary>
    internal async Task EndAsync(string notice)
    {
        _conversation.End(notice);
        if (Interlocked.Exchange(ref _ended, 1) != 0) return;
        await _stop.CancelAsync();
        await _process.DisposeAsync();
        RemoveFolder(WorkingDirectory);
    }

    private static void RemoveFolder(string folder)
    {
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
