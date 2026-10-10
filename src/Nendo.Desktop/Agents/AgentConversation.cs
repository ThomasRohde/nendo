using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Desktop;

/// <summary>One choice a permission request offers, as the agent worded it.</summary>
internal sealed record AgentPermissionOptionView(string OptionId, string Name, string Kind);

/// <summary>One line of an agent's plan.</summary>
internal sealed record AgentPlanItemView(string Text, string Status);

/// <summary>A way the agent offers to sign in. The agent signs in; Nendo only names the choice.</summary>
internal sealed record AgentSignInMethodView(string Id, string Name, string? Description);

/// <summary>
/// One entry of a conversation, as the tab draws it. <c>Kind</c> is <c>you</c>, <c>agent</c>,
/// <c>thought</c>, <c>tool</c>, <c>plan</c>, <c>permission</c> or <c>notice</c>. <c>Order</c> is
/// where it stands; <c>Revision</c> is when it last changed, so a reader asks only for what
/// changed since it last looked.
/// </summary>
internal sealed record AgentTranscriptEntry(
    string Id,
    long Order,
    long Revision,
    string Kind,
    string Text,
    string? Title = null,
    string? ToolKind = null,
    string? Status = null,
    string? Input = null,
    IReadOnlyList<AgentPermissionOptionView>? Options = null,
    string? Answer = null,
    IReadOnlyList<AgentPlanItemView>? Plan = null,
    string? Origin = null);

/// <summary>
/// What a reader is told: the state, and the entries that changed after its revision.
/// <c>FirstOrder</c> is the order of the oldest entry still kept: a reader drops every entry
/// before it, so a tab open from the start holds what a tab opened now would (ACP-03).
/// </summary>
internal sealed record AgentConversationSnapshot(
    string State,
    bool Working,
    string? Notice,
    string? AgentTitle,
    long Revision,
    IReadOnlyList<AgentTranscriptEntry> Entries,
    bool More,
    IReadOnlyList<AgentSignInMethodView> SignInMethods,
    IReadOnlyList<AgentOptionView> Options,
    long FirstOrder);

/// <summary>
/// One ACP session with one agent, over whatever carries its messages (ADR-0030).
/// <para>
/// Nendo declares no file-system and no terminal capability, names exactly one MCP server, the
/// open file's own address, and refuses an agent that cannot reach it over HTTP. It answers a
/// permission request only with what the person chose. Everything the agent says is kept as
/// text, bounded, for the tab to draw.
/// </para>
/// </summary>
internal sealed partial class AgentConversation : IAsyncDisposable
{
    internal const int ProtocolVersion = 1;
    internal const int MaximumEntries = 1000;
    internal const int MaximumEntryCharacters = 200_000;
    internal const int MaximumPromptCharacters = 100_000;
    internal const string McpServerName = "nendo";
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan SignInTimeout = TimeSpan.FromMinutes(5);

    private readonly object _sync = new();
    private readonly List<MutableEntry> _entries = [];
    private readonly Dictionary<string, MutableEntry> _toolEntries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, PendingPermission> _permissions = new(StringComparer.Ordinal);
    private readonly AcpConnection _connection;
    private readonly string _agentName;
    private readonly CancellationTokenSource _ending = new();
    private long _revision;
    private long _order;
    private string _state = "starting";
    private bool _working;
    private string? _notice;
    private string? _agentTitle;
    private string? _sessionId;
    private Uri? _endpoint;
    private string? _workingDirectory;
    private IReadOnlyList<AgentSignInMethodView> _signIn = [];
    private MutableEntry? _openMessage;
    private bool _embeddedContext;
    private readonly TaskCompletionSource _ended = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <param name="fromAgent">What the agent writes.</param>
    /// <param name="toAgent">What the agent reads.</param>
    internal AgentConversation(Stream fromAgent, Stream toAgent, string agentName)
    {
        _agentName = agentName;
        _connection = new AcpConnection(fromAgent, toAgent, AnswerAgentAsync, OnNotification);
    }

    /// <summary>The conversation changed, carrying its new revision. Raised outside every lock.</summary>
    internal event Action<long>? Changed;

    /// <summary>The connection ended, with its reason.</summary>
    internal Task<string> Closed => _connection.Closed;

    /// <summary>
    /// The conversation ended, for whatever reason: a refusal at the handshake as much as the
    /// person's End. Whoever runs the program ends it then too (ACP-01).
    /// </summary>
    internal Task Ended => _ended.Task;

    internal string State { get { lock (_sync) return _state; } }

    internal bool Working { get { lock (_sync) return _working; } }

    /// <summary>The revision now, for a nudge that carries no entry of its own (a new access level).</summary>
    internal long Revision { get { lock (_sync) return _revision; } }

    /// <summary>The MCP address the agent was given, for the tests and the tab.</summary>
    internal Uri? Endpoint => _endpoint;

    /// <summary>
    /// Speak first: <c>initialize</c>, then <c>session/new</c>. Ends the conversation with a
    /// sentence, rather than throwing, when the agent cannot be used.
    /// </summary>
    internal async Task StartAsync(Uri mcpEndpoint, string workingDirectory, string clientVersion, CancellationToken cancellationToken)
    {
        _endpoint = mcpEndpoint;
        _workingDirectory = workingDirectory;
        _connection.Start();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _ending.Token);
        timeout.CancelAfter(HandshakeTimeout);
        try
        {
            var initialized = await _connection.RequestAsync("initialize", new
            {
                protocolVersion = ProtocolVersion,
                // Nothing through Nendo: no files, no terminal. The agent reaches the open file
                // only through the MCP address below, at the person's access level.
                clientCapabilities = new { fs = new { readTextFile = false, writeTextFile = false }, terminal = false },
                clientInfo = new { name = "nendo", title = "Nendo", version = clientVersion },
            }, timeout.Token);
            var version = initialized.ValueKind == JsonValueKind.Object && initialized.TryGetProperty("protocolVersion", out var v) && v.TryGetInt32(out var parsed) ? parsed : 0;
            if (version != ProtocolVersion)
            {
                End($"{_agentName} speaks ACP version {version}; Nendo speaks version {ProtocolVersion}.");
                return;
            }
            if (!SupportsHttpMcp(initialized))
            {
                End($"{_agentName} cannot reach Nendo: it does not connect to MCP servers over HTTP, which is the only way Nendo offers.");
                return;
            }
            lock (_sync)
            {
                _signIn = ReadSignIn(initialized);
                _agentTitle = ReadAgentTitle(initialized);
                _embeddedContext = ReadsEmbeddedContext(initialized);
            }
            await OpenSessionAsync(timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && !_ending.IsCancellationRequested)
        {
            End($"{_agentName} did not answer within {HandshakeTimeout.TotalSeconds:0} seconds.");
        }
        catch (OperationCanceledException) { }
        catch (AcpConnectionClosedException exception)
        {
            End(exception.Message);
        }
        catch (AcpRemoteException exception)
        {
            End($"{_agentName} refused to start: {exception.Message}");
        }
    }

    private async Task OpenSessionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var session = await _connection.RequestAsync("session/new", new
            {
                cwd = _workingDirectory,
                mcpServers = new object[]
                {
                    new { type = "http", name = McpServerName, url = _endpoint!.AbsoluteUri, headers = Array.Empty<object>() },
                },
            }, cancellationToken);
            var sessionId = session.ValueKind == JsonValueKind.Object && session.TryGetProperty("sessionId", out var id) && id.ValueKind == JsonValueKind.String
                ? id.GetString() : null;
            if (string.IsNullOrEmpty(sessionId))
            {
                End($"{_agentName} did not open a session.");
                return;
            }
            lock (_sync)
            {
                _sessionId = sessionId;
                if (_state != "ended") _state = "ready";
                _notice = null;
                ReadOptions(session);
            }
            Raise(Touch());
        }
        catch (AcpRemoteException exception) when (exception.Code == -32000)
        {
            // ACP's auth_required: the agent wants its own sign-in first.
            lock (_sync)
            {
                if (_state == "ended") return;
                _state = "signIn";
                _notice = _signIn.Count == 0
                    ? $"{_agentName} needs you to sign in. Sign in from a terminal, then launch it again."
                    : $"{_agentName} needs you to sign in. Choose how below; {_agentName} does the signing in, not Nendo.";
            }
            Raise(Touch());
        }
    }

    /// <summary>
    /// Ask the agent to sign in by one of the ways it offered, then open the session. A choice it
    /// did not offer is refused at once; the signing in itself runs on.
    /// </summary>
    internal Task AuthenticateAsync(string methodId, CancellationToken cancellationToken)
    {
        long revision;
        lock (_sync)
        {
            if (_state != "signIn") throw new Nendo.Engine.NendoPreconditionException("agent-not-signing-in", "The agent is not waiting to sign in.");
            if (!_signIn.Any(method => method.Id == methodId))
                throw new Nendo.Engine.NendoValidationException("Choose one of the ways the agent offered to sign in.");
            _notice = $"Waiting for {_agentName} to sign in…";
            revision = Touch();
        }
        Raise(revision);
        return SignInAsync(methodId, cancellationToken);
    }

    private async Task SignInAsync(string methodId, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _ending.Token);
        timeout.CancelAfter(SignInTimeout);
        try
        {
            await _connection.RequestAsync("authenticate", new { methodId }, timeout.Token);
            await OpenSessionAsync(timeout.Token);
        }
        catch (AcpRemoteException exception)
        {
            lock (_sync) _notice = $"{_agentName} could not sign in: {exception.Message}";
            Raise(Touch());
        }
        catch (OperationCanceledException) when (!_ending.IsCancellationRequested)
        {
            lock (_sync) _notice = $"{_agentName} did not finish signing in.";
            Raise(Touch());
        }
        catch (AcpConnectionClosedException exception)
        {
            End(exception.Message);
        }
    }

    /// <summary>
    /// Send what the person typed, with anything in the file they pointed at. The turn runs on;
    /// its end is told through <see cref="Changed"/>.
    /// </summary>
    internal void Prompt(string text, IReadOnlyList<AgentPromptContext>? pointedAt = null)
    {
        var prompt = text.Trim();
        var context = pointedAt ?? [];
        if (prompt.Length == 0) throw new Nendo.Engine.NendoValidationException("Type something for the agent first.");
        if (prompt.Length > MaximumPromptCharacters)
            throw new Nendo.Engine.NendoValidationException($"A message is at most {MaximumPromptCharacters:N0} characters.");
        ValidateContext(context);
        string sessionId;
        bool embedded;
        long revision;
        lock (_sync)
        {
            if (_state != "ready" || _sessionId is null)
                throw new Nendo.Engine.NendoPreconditionException("agent-not-ready", _state == "ended"
                    ? "This conversation has ended. Launch the agent again from the Agent page."
                    : "The agent is not ready for a message yet.");
            if (_working)
                throw new Nendo.Engine.NendoPreconditionException("agent-working", "The agent is still working. Wait, or press Stop.");
            sessionId = _sessionId;
            embedded = _embeddedContext;
            _working = true;
            _openMessage = null;
            var said = Add("you", prompt);
            // The person's own entry names what they pointed at, so the thread shows it.
            if (context.Count > 0) said.Title = string.Join(" · ", context.Select(item => item.Title.Trim()));
            revision = Touch();
        }
        Raise(revision);
        _ = Task.Run(() => RunTurnAsync(sessionId, PromptBlocks(prompt, context, embedded)));
    }

    private async Task RunTurnAsync(string sessionId, object[] prompt)
    {
        string? stopped = null;
        try
        {
            var result = await _connection.RequestAsync("session/prompt", new
            {
                sessionId,
                prompt,
            }, _ending.Token);
            var reason = result.ValueKind == JsonValueKind.Object && result.TryGetProperty("stopReason", out var r) && r.ValueKind == JsonValueKind.String
                ? r.GetString() : null;
            stopped = reason switch
            {
                null or "end_turn" => null,
                "cancelled" => "Stopped.",
                "max_tokens" => $"{_agentName} stopped: it reached its limit for one answer.",
                "max_turn_requests" => $"{_agentName} stopped: it reached its limit of steps for one message.",
                "refusal" => $"{_agentName} declined to continue.",
                _ => $"{_agentName} stopped ({AcpConnection.Bounded(reason, 80)}).",
            };
        }
        catch (AcpRemoteException exception)
        {
            stopped = $"{_agentName} could not answer: {exception.Message}";
        }
        catch (Exception exception) when (exception is AcpConnectionClosedException or OperationCanceledException) { }
        long revision;
        lock (_sync)
        {
            _working = false;
            _openMessage = null;
            if (stopped is not null && _state != "ended") Add("notice", stopped);
            revision = Touch();
        }
        Raise(revision);
    }

    /// <summary>Stop the turn that is running. Any question the agent is waiting on is answered as cancelled.</summary>
    internal async Task CancelTurnAsync()
    {
        string? sessionId;
        PendingPermission[] open;
        lock (_sync)
        {
            sessionId = _working ? _sessionId : null;
            open = _permissions.Values.ToArray();
        }
        foreach (var permission in open) permission.Answer.TrySetResult(null);
        if (sessionId is null) return;
        try { await _connection.NotifyAsync("session/cancel", new { sessionId }); }
        catch (AcpConnectionClosedException) { }
    }

    /// <summary>The person's answer to a permission request: one of its options, or null to cancel it.</summary>
    internal void Answer(string entryId, string? optionId)
    {
        PendingPermission? permission;
        lock (_sync)
        {
            permission = _permissions.Values.FirstOrDefault(candidate => candidate.Entry.Id == entryId);
            if (permission is null)
                throw new Nendo.Engine.NendoPreconditionException("agent-question-gone", "The agent is no longer waiting for that answer.");
            if (optionId is not null && !permission.Entry.Options!.Any(option => option.OptionId == optionId))
                throw new Nendo.Engine.NendoValidationException("Choose one of the answers the agent offered.");
        }
        permission.Answer.TrySetResult(optionId);
    }

    /// <summary>End the conversation, keeping what was said. The transcript stays readable.</summary>
    internal void End(string notice)
    {
        PendingPermission[] open;
        long revision;
        lock (_sync)
        {
            if (_state == "ended") return;
            _state = "ended";
            _working = false;
            // A notice may carry what the program last wrote to stderr, which is the agent's own text.
            _notice = Redact(AcpConnection.Bounded(notice));
            _openMessage = null;
            Add("notice", _notice);
            open = _permissions.Values.ToArray();
            revision = Touch();
        }
        foreach (var permission in open) permission.Answer.TrySetResult(null);
        _ending.Cancel();
        _ended.TrySetResult();
        Raise(revision);
    }

    /// <summary>The state, and up to <paramref name="limit"/> entries that changed after <paramref name="after"/>.</summary>
    internal AgentConversationSnapshot Read(long after, int limit = 200)
    {
        lock (_sync)
        {
            var changed = _entries.Where(entry => entry.Revision > after).OrderBy(entry => entry.Revision).ToList();
            var more = changed.Count > limit;
            var taken = changed.Take(limit).Select(entry => entry.View()).ToArray();
            var revision = more ? taken[^1].Revision : _revision;
            var firstOrder = _entries.Count == 0 ? _order + 1 : _entries[0].Order;
            return new AgentConversationSnapshot(_state, _working, _notice is null ? null : Redact(_notice), _agentTitle, revision, taken, more, _signIn, _options, firstOrder);
        }
    }

    private Task<object?> AnswerAgentAsync(string method, JsonElement parameters, CancellationToken cancellationToken) =>
        method switch
        {
            "session/request_permission" => AskPersonAsync(parameters, cancellationToken),
            // Declared off in initialize; an agent that asks anyway is told Nendo does not serve it.
            _ => throw new AcpMethodNotFoundException(method),
        };

    private async Task<object?> AskPersonAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        var options = parameters.TryGetProperty("options", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray()
                .Where(option => option.ValueKind == JsonValueKind.Object)
                .Select(option => new AgentPermissionOptionView(
                    Text(option, "optionId", 200) ?? string.Empty,
                    Text(option, "name", 200) ?? "Allow",
                    Text(option, "kind", 40) ?? "allow_once"))
                .Where(option => option.OptionId.Length > 0)
                .Take(8)
                .ToArray()
            : [];
        var call = parameters.TryGetProperty("toolCall", out var toolCall) && toolCall.ValueKind == JsonValueKind.Object ? toolCall : default;
        var callId = call.ValueKind == JsonValueKind.Object ? Text(call, "toolCallId", 200) : null;
        var permission = new PendingPermission(new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously));
        long revision;
        lock (_sync)
        {
            if (_state == "ended" || options.Length == 0) return Cancelled();
            var known = callId is not null && _toolEntries.TryGetValue(callId, out var tool) ? tool : null;
            permission.Entry = Add("permission", string.Empty);
            permission.Entry.Title = (call.ValueKind == JsonValueKind.Object ? Text(call, "title", 500) : null) ?? known?.Title ?? "A tool call";
            permission.Entry.ToolKind = (call.ValueKind == JsonValueKind.Object ? Text(call, "kind", 40) : null) ?? known?.ToolKind;
            permission.Entry.Input = (call.ValueKind == JsonValueKind.Object ? RawInput(call) : null) ?? known?.Input;
            // What the operation would do, as the agent supplied it: a diff, its output so far,
            // the places it touches. The person decides with it in front of them (ACP-11).
            var details = call.ValueKind == JsonValueKind.Object ? CallDetails(call) : string.Empty;
            permission.Entry.Text.Append(details.Length > 0 ? details : known?.Text.ToString() ?? string.Empty);
            permission.Entry.Options = options;
            permission.Entry.ToolName = (call.ValueKind == JsonValueKind.Object ? MetaToolName(call) : null) ?? known?.ToolName;
            permission.Entry.Origin = Origin(known?.Title ?? permission.Entry.Title, permission.Entry.ToolKind, permission.Entry.ToolName);
            _permissions[permission.Entry.Id] = permission;
            revision = Touch();
        }
        Raise(revision);
        string? chosen;
        try
        {
            using var registration = cancellationToken.Register(() => permission.Answer.TrySetResult(null));
            chosen = await permission.Answer.Task;
        }
        finally
        {
            lock (_sync)
            {
                _permissions.Remove(permission.Entry.Id);
            }
        }
        lock (_sync)
        {
            permission.Entry.Answer = chosen is null ? "Cancelled" : options.First(option => option.OptionId == chosen).Name;
            permission.Entry.Revision = ++_revision;
            revision = _revision;
        }
        Raise(revision);
        return chosen is null
            ? Cancelled()
            : new { outcome = new { outcome = "selected", optionId = chosen } };
    }

    private static object Cancelled() => new { outcome = new { outcome = "cancelled" } };

    private void OnNotification(string method, JsonElement parameters)
    {
        if (method != "session/update" || parameters.ValueKind != JsonValueKind.Object) return;
        if (!parameters.TryGetProperty("update", out var update) || update.ValueKind != JsonValueKind.Object) return;
        var kind = Text(update, "sessionUpdate", 60);
        long revision;
        lock (_sync)
        {
            if (_state == "ended") return;
            switch (kind)
            {
                case "agent_message_chunk":
                    AppendChunk("agent", ContentText(update));
                    break;
                case "agent_thought_chunk":
                    AppendChunk("thought", ContentText(update));
                    break;
                case "tool_call":
                case "tool_call_update":
                    ApplyToolCall(update, kind == "tool_call");
                    break;
                case "plan":
                    ApplyPlan(update);
                    break;
                case "config_option_update":
                case "current_mode_update":
                case "current_model_update":
                    if (!ApplyOptionUpdate(kind, update)) return;
                    break;
                default:
                    // Commands, modes and the agent's echo of what the person typed are not drawn.
                    return;
            }
            revision = Touch();
        }
        Raise(revision);
    }

    private void AppendChunk(string kind, string text)
    {
        if (text.Length == 0) return;
        if (_openMessage is { } open && open.Kind == kind && ReferenceEquals(_entries.LastOrDefault(), open))
        {
            open.Text.Append(text);
            if (open.Text.Length > MaximumEntryCharacters) open.Text.Length = MaximumEntryCharacters;
            open.Revision = _revision + 1;
            return;
        }
        _openMessage = Add(kind, text);
    }

    private void ApplyToolCall(JsonElement update, bool created)
    {
        var callId = Text(update, "toolCallId", 200);
        if (callId is null) return;
        if (!_toolEntries.TryGetValue(callId, out var entry))
        {
            entry = Add("tool", string.Empty);
            _toolEntries[callId] = entry;
        }
        _openMessage = null;
        if (Text(update, "title", 500) is { } title) entry.Title = title;
        if (Text(update, "kind", 40) is { } toolKind) entry.ToolKind = toolKind;
        if (Text(update, "status", 40) is { } status) entry.Status = status;
        else if (created) entry.Status ??= "pending";
        if (RawInput(update) is { } input) entry.Input = input;
        if (MetaToolName(update) is { } name) entry.ToolName = name;
        if (update.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            entry.Text.Clear();
            entry.Text.Append(Redact(ToolContentText(content)));
        }
        entry.Origin = Origin(entry.Title, entry.ToolKind, entry.ToolName);
        entry.Revision = _revision + 1;
    }

    private void ApplyPlan(JsonElement update)
    {
        if (!update.TryGetProperty("entries", out var items) || items.ValueKind != JsonValueKind.Array) return;
        var plan = items.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Object)
            .Select(item => new AgentPlanItemView(Redact(Text(item, "content", 500) ?? string.Empty), Text(item, "status", 40) ?? "pending"))
            .Take(50)
            .ToArray();
        // One plan, replaced whole each time the agent states it.
        var entry = _entries.LastOrDefault(candidate => candidate.Kind == "plan") ?? Add("plan", string.Empty);
        entry.Plan = plan;
        entry.Revision = _revision + 1;
    }

    private MutableEntry Add(string kind, string text)
    {
        var entry = new MutableEntry($"e{++_order}", _order, kind) { Revision = _revision + 1 };
        entry.Text.Append(text.Length > MaximumEntryCharacters ? text[..MaximumEntryCharacters] : text);
        _entries.Add(entry);
        if (_entries.Count > MaximumEntries)
        {
            var dropped = _entries[0];
            _entries.RemoveAt(0);
            foreach (var pair in _toolEntries.Where(pair => ReferenceEquals(pair.Value, dropped)).ToArray())
                _toolEntries.Remove(pair.Key);
        }
        return entry;
    }

    /// <summary>Close one change: every entry touched since the last one carries this revision.</summary>
    private long Touch() => ++_revision;

    private void Raise(long revision)
    {
        try { Changed?.Invoke(revision); }
        catch (Exception) { /* A listener's failure is not the conversation's. */ }
    }

    private static bool SupportsHttpMcp(JsonElement initialized) =>
        initialized.ValueKind == JsonValueKind.Object &&
        initialized.TryGetProperty("agentCapabilities", out var capabilities) && capabilities.ValueKind == JsonValueKind.Object &&
        capabilities.TryGetProperty("mcpCapabilities", out var mcp) && mcp.ValueKind == JsonValueKind.Object &&
        mcp.TryGetProperty("http", out var http) && http.ValueKind == JsonValueKind.True;

    private static IReadOnlyList<AgentSignInMethodView> ReadSignIn(JsonElement initialized) =>
        initialized.TryGetProperty("authMethods", out var methods) && methods.ValueKind == JsonValueKind.Array
            ? methods.EnumerateArray()
                .Where(method => method.ValueKind == JsonValueKind.Object)
                .Select(method => new AgentSignInMethodView(Text(method, "id", 200) ?? string.Empty, Text(method, "name", 200) ?? "Sign in", Text(method, "description", 500)))
                .Where(method => method.Id.Length > 0)
                .Take(8)
                .ToArray()
            : [];

    private static string? ReadAgentTitle(JsonElement initialized)
    {
        if (!initialized.TryGetProperty("agentInfo", out var info) || info.ValueKind != JsonValueKind.Object) return null;
        var name = Text(info, "title", 120) ?? Text(info, "name", 120);
        var version = Text(info, "version", 40);
        return name is null ? null : version is null ? name : $"{name} {version}";
    }

    private static string ContentText(JsonElement update) =>
        update.TryGetProperty("content", out var content) ? BlockText(content) : string.Empty;

    private static string BlockText(JsonElement block)
    {
        if (block.ValueKind != JsonValueKind.Object) return string.Empty;
        return Text(block, "type", 40) switch
        {
            "text" => block.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String ? text.GetString()! : string.Empty,
            "image" => "(an image)",
            "audio" => "(a sound)",
            "resource_link" => Text(block, "name", 500) ?? Text(block, "uri", 500) ?? "(a link)",
            "resource" => block.TryGetProperty("resource", out var resource) && resource.ValueKind == JsonValueKind.Object
                ? Text(resource, "text", MaximumEntryCharacters) ?? Text(resource, "uri", 500) ?? "(a resource)"
                : "(a resource)",
            _ => string.Empty,
        };
    }

    private static string ToolContentText(JsonElement content)
    {
        var text = new StringBuilder();
        foreach (var item in content.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            var line = Text(item, "type", 40) switch
            {
                "content" => item.TryGetProperty("content", out var block) ? BlockText(block) : string.Empty,
                // The change itself, not only its path: a permission request may carry nothing else.
                "diff" => DiffText(item),
                "terminal" => "(terminal output)",
                _ => string.Empty,
            };
            if (line.Length == 0) continue;
            if (text.Length > 0) text.Append('\n');
            text.Append(line);
            if (text.Length > 20_000) { text.Length = 20_000; text.Append('…'); break; }
        }
        return text.ToString();
    }

    private const int MaximumDiffSideCharacters = 8_000;

    private static string DiffText(JsonElement diff)
    {
        var path = Text(diff, "path", 500) ?? "a file";
        var before = Text(diff, "oldText", MaximumDiffSideCharacters + 1);
        var after = Text(diff, "newText", MaximumDiffSideCharacters + 1) ?? string.Empty;
        static string Side(string text) => text.Length > MaximumDiffSideCharacters
            ? string.Concat(text.AsSpan(0, MaximumDiffSideCharacters), "\n… (cut short)") : text;
        return before is null
            ? $"Creates {path}:\n{Side(after)}"
            : $"Changes {path}\nBefore:\n{Side(before)}\nAfter:\n{Side(after)}";
    }

    /// <summary>
    /// What a tool call in a permission request says it would do: its content (a diff, text) and
    /// the places it names. Empty when it supplied neither; bounded and redacted like a tool's output.
    /// </summary>
    private static string CallDetails(JsonElement call)
    {
        var text = new StringBuilder();
        if (call.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
            text.Append(ToolContentText(content));
        if (call.TryGetProperty("locations", out var locations) && locations.ValueKind == JsonValueKind.Array)
        {
            var places = locations.EnumerateArray()
                .Where(location => location.ValueKind == JsonValueKind.Object && Text(location, "path", 500) is not null)
                .Take(20)
                .Select(location => location.TryGetProperty("line", out var line) && line.TryGetInt32(out var number)
                    ? $"{Text(location, "path", 500)}:{number}" : Text(location, "path", 500)!)
                .ToArray();
            if (places.Length > 0)
            {
                if (text.Length > 0) text.Append('\n');
                text.Append("Where: ").Append(string.Join(", ", places));
            }
        }
        return Redact(text.ToString());
    }

    private static string? RawInput(JsonElement call)
    {
        if (!call.TryGetProperty("rawInput", out var input) || input.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return null;
        return AcpConnection.Bounded(Redact(input.GetRawText()), 2000);
    }

    /// <summary>
    /// The agent's private application handle, as a tool call sends it or a lease grant returns
    /// it, plain or inside an escaped string, or as the agent repeats it in its own words
    /// (<c>applicationHandle: abc</c>, <c>application_handle=`abc`</c>). It is a capability
    /// (ADR-0009): whoever holds it may write as the agent, so the tab shows that it was sent and
    /// never what it was. A value cut off at the end of the text is hidden too, so a message
    /// still streaming never shows the start of one.
    /// </summary>
    private static readonly Regex Handle = new(
        @"((?:resume[_ ]?)?application[_ ]?handle\\?[""'`*]{0,2}\s*[:=]\s*\\?[""'`*]{0,2})(?!\(hidden\))[^""'`*\\\s,;}\])]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>
    /// Hide every application handle. Applied wherever the agent's text enters the transcript, and
    /// again to each entry as it is read, so a handle split across streamed chunks is hidden once
    /// the chunks meet (ACP-08).
    /// </summary>
    internal static string Redact(string text) => Handle.Replace(text, "$1(hidden)");

    private static string? Text(JsonElement element, string name, int maximum) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? AcpConnection.Bounded(value.GetString()!, maximum)
            : null;

    public async ValueTask DisposeAsync()
    {
        End("The conversation ended.");
        await _connection.DisposeAsync();
    }

    private sealed class MutableEntry(string id, long order, string kind)
    {
        internal string Id { get; } = id;
        internal long Order { get; } = order;
        internal string Kind { get; } = kind;
        internal long Revision { get; set; }
        internal StringBuilder Text { get; } = new();
        internal string? Title { get; set; }
        internal string? ToolKind { get; set; }
        internal string? Status { get; set; }
        internal string? Input { get; set; }
        internal IReadOnlyList<AgentPermissionOptionView>? Options { get; set; }
        internal string? Answer { get; set; }
        internal IReadOnlyList<AgentPlanItemView>? Plan { get; set; }
        internal string? Origin { get; set; }

        /// <summary>The tool's name as the agent's metadata gives it, when it does. Not shown.</summary>
        internal string? ToolName { get; set; }

        /// <summary>The entry as the tab is sent it: every text the agent wrote passes the one redaction boundary.</summary>
        internal AgentTranscriptEntry View() =>
            new(Id, Order, Revision, Kind, Redact(Text.ToString()), Title is null ? null : Redact(Title), ToolKind, Status,
                Input is null ? null : Redact(Input), Options, Answer, Plan, Origin);
    }

    private sealed class PendingPermission(TaskCompletionSource<string?> answer)
    {
        internal TaskCompletionSource<string?> Answer { get; } = answer;
        internal MutableEntry Entry { get; set; } = null!;
    }
}
