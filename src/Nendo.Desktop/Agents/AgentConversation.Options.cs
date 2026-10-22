using System.Text.Json;
using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>One value an agent's option may take, as the agent names it, with its group when it has one.</summary>
internal sealed record AgentOptionValueView(string Value, string Name, string? Description, string? Group);

/// <summary>
/// One of the agent's own settings for this session: its model, how hard it thinks, its mode, or
/// anything else it offers (ADR-0030). <c>Category</c> is the agent's word for what it is
/// (<c>model</c>, <c>thought_level</c>, <c>mode</c>, <c>model_config</c>, or its own), and only
/// guides where the tab shows it. <c>Type</c> is <c>select</c>, or <c>boolean</c> for an on/off
/// setting, carried as the values <c>true</c> (On) and <c>false</c> (Off) so it is kept and picked
/// like any other.
/// </summary>
internal sealed record AgentOptionView(
    string Id,
    string Name,
    string? Description,
    string? Category,
    string CurrentValue,
    IReadOnlyList<AgentOptionValueView> Values,
    string Type = AgentConversation.SelectOption);

/// <summary>
/// The agent's own options, in the three forms ACP agents send them (ADR-0030).
/// <para>
/// The current form is session config options: the agent lists them when the session opens,
/// Nendo sets one with <c>session/set_config_option</c>, and the agent restates them all with
/// <c>config_option_update</c>. Older agents send <c>modes</c>, set with <c>session/set_mode</c>,
/// and an unstable <c>models</c> list, set with <c>session/set_model</c>; Nendo shows those as a
/// Mode and a Model option when the agent sends no config options. Nendo changes an option only
/// when the person picks a value; it never chooses one itself.
/// </para>
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumOptions = 16;
    internal const int MaximumOptionValues = 300;
    internal const string LegacyModeOption = "acp.mode";
    internal const string LegacyModelOption = "acp.model";
    internal const string SelectOption = "select";
    internal const string BooleanOption = "boolean";
    private static readonly AgentOptionValueView[] OnOff =
        [new("true", "On", null, null), new("false", "Off", null, null)];
    private static readonly TimeSpan OptionTimeout = TimeSpan.FromSeconds(30);

    private IReadOnlyList<AgentOptionView> _options = [];
    private bool _legacyOptions;

    /// <summary>
    /// The values the person picked for this agent before, by option ID, sent once the session
    /// opens and before it is ready (ADR-0030). Set before <see cref="StartAsync"/>.
    /// </summary>
    internal IReadOnlyDictionary<string, string> Kept { get; init; } = new Dictionary<string, string>();

    /// <summary>
    /// The options the agent offers, once the session is ready and after each one the person sets,
    /// for the device to keep. Raised outside every lock; a listener's failure is not the conversation's.
    /// </summary>
    internal Action<IReadOnlyList<AgentOptionView>>? OptionsOffered { get; init; }

    private void Offered(IReadOnlyList<AgentOptionView> options)
    {
        if (options.Count == 0) return;
        try { OptionsOffered?.Invoke(options); }
        catch (Exception) { /* Keeping them is a convenience; the conversation goes on. */ }
    }

    /// <summary>
    /// Send each kept value the agent still offers and does not hold already, in the agent's order
    /// of its options, since one may change what another offers. A value it no longer offers is
    /// not sent; one it refuses leaves a notice, and the session opens all the same.
    /// </summary>
    private async Task SendKeptAsync(string sessionId)
    {
        if (Kept.Count == 0) return;
        string[] order;
        lock (_sync) order = _options.Select(option => option.Id).ToArray();
        foreach (var optionId in order)
        {
            if (!Kept.TryGetValue(optionId, out var value)) continue;
            AgentOptionView? option;
            bool legacy;
            lock (_sync)
            {
                if (_state == "ended") return;
                option = _options.FirstOrDefault(candidate => candidate.Id == optionId);
                legacy = _legacyOptions;
            }
            if (option is null || option.CurrentValue == value || !option.Values.Any(candidate => candidate.Value == value)) continue;
            try
            {
                await SendOptionAsync(sessionId, option, value, legacy, CancellationToken.None);
            }
            catch (NendoPreconditionException exception)
            {
                lock (_sync) Add("notice", $"{exception.Message} It keeps its own {option.Name}.");
            }
        }
    }

    /// <summary>
    /// The names agents give this file's MCP tools: <c>nendo-nendo-read-resource</c>,
    /// <c>mcp__nendo__nendo.lease.acquire</c>, <c>nendo.read.resource</c>. A server prefix counts
    /// only when it is this session's server, <see cref="McpServerName"/>: every Nendo file's
    /// server offers the same tools, so <c>mcp__nendo-planner__nendo_data_delete_record</c> is a
    /// server the person registered for another file, and the agent's own.
    /// </summary>
    private static readonly Regex NendoTool = new(
        @"(?<![\w.-])(?:mcp_+nendo_+(?=nendo)|nendo[-_.]+(?=nendo))?nendo[-_.]+(?:read|lease|data|change[-_.]?set|health)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>
    /// Whether a tool went through this file's MCP server, judged only from what names the tool:
    /// the tool name in the agent's metadata, its title, and its kind. What the tool sends is
    /// never evidence: a shell command that prints <c>nendo://</c> is still the agent's own shell.
    /// A title naming a <c>nendo://</c> address counts unless the tool runs a command.
    /// </summary>
    internal static string? Origin(string? title, string? kind, string? toolName)
    {
        if (title is null && toolName is null) return null;
        // The tool's own name, when the agent gives one, decides: a title can name another
        // server's tool by its bare name, or echo the input.
        if (toolName is not null) return NendoTool.IsMatch(toolName) ? "nendo" : "agent";
        if (kind == "execute") return "agent";
        return title is not null && (NendoTool.IsMatch(title) || title.Contains("nendo://", StringComparison.OrdinalIgnoreCase)) ? "nendo" : "agent";
    }

    /// <summary>The tool's own name, where the agent's <c>_meta</c> carries one (as <c>toolName</c>, at most two levels down).</summary>
    private static string? MetaToolName(JsonElement call)
    {
        if (call.ValueKind != JsonValueKind.Object || !call.TryGetProperty("_meta", out var meta) || meta.ValueKind != JsonValueKind.Object) return null;
        if (Text(meta, "toolName", 200) is { } direct) return direct;
        foreach (var property in meta.EnumerateObject().Take(16))
            if (property.Value.ValueKind == JsonValueKind.Object && Text(property.Value, "toolName", 200) is { } nested) return nested;
        return null;
    }

    /// <summary>Take the options a session result offers. Called under the lock.</summary>
    private void ReadOptions(JsonElement session)
    {
        if (session.ValueKind != JsonValueKind.Object) return;
        if (session.TryGetProperty("configOptions", out var config) && config.ValueKind == JsonValueKind.Array)
        {
            _legacyOptions = false;
            _options = ParseConfigOptions(config);
            return;
        }
        _legacyOptions = true;
        var options = new List<AgentOptionView>();
        if (LegacyModes(session) is { } modes) options.Add(modes);
        if (LegacyModels(session) is { } models) options.Add(models);
        _options = options;
    }

    /// <summary>
    /// The agent's select and boolean options, in its order. A boolean is sent only to a client
    /// that declared <c>session.configOptions.boolean</c>, which Nendo does; any other type is left out.
    /// </summary>
    private static IReadOnlyList<AgentOptionView> ParseConfigOptions(JsonElement config) =>
        config.EnumerateArray()
            .Where(option => option.ValueKind == JsonValueKind.Object && Text(option, "type", 20) is SelectOption or BooleanOption)
            .Select(option =>
            {
                if (Text(option, "type", 20) == BooleanOption)
                {
                    var on = option.TryGetProperty("currentValue", out var stated) && stated.ValueKind == JsonValueKind.True;
                    return new AgentOptionView(
                        Text(option, "id", 200) ?? string.Empty,
                        Text(option, "name", 120) ?? Text(option, "id", 120) ?? "Option",
                        Text(option, "description", 500),
                        Text(option, "category", 60),
                        on ? "true" : "false",
                        OnOff,
                        BooleanOption);
                }
                var values = new List<AgentOptionValueView>();
                if (option.TryGetProperty("options", out var list) && list.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in list.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object) continue;
                        if (item.TryGetProperty("options", out var grouped) && grouped.ValueKind == JsonValueKind.Array)
                        {
                            var group = Text(item, "name", 120) ?? Text(item, "group", 120);
                            values.AddRange(grouped.EnumerateArray().Select(value => Value(value, group)).OfType<AgentOptionValueView>());
                        }
                        else if (Value(item, null) is { } value)
                        {
                            values.Add(value);
                        }
                    }
                }
                return new AgentOptionView(
                    Text(option, "id", 200) ?? string.Empty,
                    Text(option, "name", 120) ?? Text(option, "id", 120) ?? "Option",
                    Text(option, "description", 500),
                    Text(option, "category", 60),
                    Text(option, "currentValue", 300) ?? string.Empty,
                    values.Take(MaximumOptionValues).ToArray());
            })
            .Where(option => option.Id.Length > 0 && option.Values.Count > 0)
            .Take(MaximumOptions)
            .ToArray();

    private static AgentOptionValueView? Value(JsonElement value, string? group)
    {
        if (value.ValueKind != JsonValueKind.Object || Text(value, "value", 300) is not { } id) return null;
        return new AgentOptionValueView(id, Text(value, "name", 200) ?? id, Text(value, "description", 500), group);
    }

    private static AgentOptionView? LegacyModes(JsonElement session)
    {
        if (!session.TryGetProperty("modes", out var modes) || modes.ValueKind != JsonValueKind.Object) return null;
        var values = modes.TryGetProperty("availableModes", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray()
                .Where(mode => mode.ValueKind == JsonValueKind.Object && Text(mode, "id", 300) is not null)
                .Select(mode => new AgentOptionValueView(Text(mode, "id", 300)!, Text(mode, "name", 200) ?? Text(mode, "id", 200)!, Text(mode, "description", 500), null))
                .Take(MaximumOptionValues).ToArray()
            : [];
        return values.Length == 0 ? null
            : new AgentOptionView(LegacyModeOption, "Mode", null, "mode", Text(modes, "currentModeId", 300) ?? values[0].Value, values);
    }

    private static AgentOptionView? LegacyModels(JsonElement session)
    {
        if (!session.TryGetProperty("models", out var models) || models.ValueKind != JsonValueKind.Object) return null;
        var values = models.TryGetProperty("availableModels", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray()
                .Where(model => model.ValueKind == JsonValueKind.Object && Text(model, "modelId", 300) is not null)
                .Select(model => new AgentOptionValueView(Text(model, "modelId", 300)!, Text(model, "name", 200) ?? Text(model, "modelId", 200)!, Text(model, "description", 500), null))
                .Take(MaximumOptionValues).ToArray()
            : [];
        return values.Length == 0 ? null
            : new AgentOptionView(LegacyModelOption, "Model", null, "model", Text(models, "currentModelId", 300) ?? values[0].Value, values);
    }

    /// <summary>The agent restated its options, or changed its mode or model by itself. Called under the lock.</summary>
    private bool ApplyOptionUpdate(string? kind, JsonElement update)
    {
        if (kind == "config_option_update")
        {
            if (!update.TryGetProperty("configOptions", out var config) || config.ValueKind != JsonValueKind.Array) return false;
            _legacyOptions = false;
            _options = ParseConfigOptions(config);
            return true;
        }
        if (!_legacyOptions) return false;
        var (optionId, field) = kind == "current_mode_update" ? (LegacyModeOption, "currentModeId") : (LegacyModelOption, "currentModelId");
        var current = Text(update, field, 300) ?? Text(update, kind == "current_mode_update" ? "modeId" : "modelId", 300);
        if (current is null) return false;
        return WithCurrent(optionId, current);
    }

    private bool WithCurrent(string optionId, string value)
    {
        var index = _options.ToList().FindIndex(option => option.Id == optionId);
        if (index < 0) return false;
        var options = _options.ToArray();
        options[index] = options[index] with { CurrentValue = value };
        _options = options;
        return true;
    }

    /// <summary>Set one of the agent's options to a value it offered. The agent's answer is what the tab then shows.</summary>
    internal async Task SetOptionAsync(string optionId, string value, CancellationToken cancellationToken)
    {
        string sessionId;
        AgentOptionView option;
        bool legacy;
        lock (_sync)
        {
            if (_state != "ready" || _sessionId is null)
                throw new NendoPreconditionException("agent-not-ready", "The agent is not ready for that yet.");
            option = _options.FirstOrDefault(candidate => candidate.Id == optionId)
                ?? throw new NendoValidationException("The agent does not offer that option.");
            if (!option.Values.Any(candidate => candidate.Value == value))
                throw new NendoValidationException($"Choose one of the values {_agentName} offers for {option.Name}.");
            sessionId = _sessionId;
            legacy = _legacyOptions;
        }
        await SendOptionAsync(sessionId, option, value, legacy, cancellationToken);
        long revision;
        IReadOnlyList<AgentOptionView> options;
        lock (_sync)
        {
            revision = Touch();
            options = _options;
        }
        Raise(revision);
        Offered(options);
    }

    private async Task SendOptionAsync(string sessionId, AgentOptionView option, string value, bool legacy, CancellationToken cancellationToken)
    {
        var optionId = option.Id;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _ending.Token);
        timeout.CancelAfter(OptionTimeout);
        try
        {
            if (!legacy)
            {
                // An on/off setting goes as a JSON boolean, named as one.
                var answer = await _connection.RequestAsync("session/set_config_option", option.Type == BooleanOption
                    ? new { sessionId, configId = optionId, type = BooleanOption, value = value == "true" }
                    : (object)new { sessionId, configId = optionId, value }, timeout.Token);
                lock (_sync)
                {
                    if (answer.ValueKind == JsonValueKind.Object && answer.TryGetProperty("configOptions", out var config) && config.ValueKind == JsonValueKind.Array)
                        _options = ParseConfigOptions(config);
                    else
                        WithCurrent(optionId, value);
                }
            }
            else
            {
                await _connection.RequestAsync(optionId == LegacyModeOption ? "session/set_mode" : "session/set_model",
                    optionId == LegacyModeOption ? new { sessionId, modeId = value } : (object)new { sessionId, modelId = value }, timeout.Token);
                lock (_sync) WithCurrent(optionId, value);
            }
        }
        catch (AcpRemoteException exception)
        {
            throw new NendoPreconditionException("agent-option-refused", $"{_agentName} did not change {option.Name}: {exception.Message}");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new NendoPreconditionException("agent-option-refused", $"{_agentName} did not answer about {option.Name}.");
        }
        catch (AcpConnectionClosedException exception)
        {
            throw new NendoPreconditionException("agent-option-refused", exception.Message);
        }
    }
}
