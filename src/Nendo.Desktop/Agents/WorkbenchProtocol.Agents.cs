using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
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
        AgentSessionSetViewAccess, AgentSessionTurn, AgentSessionSetStartIn,
    };
}

internal sealed partial class WorkbenchProtocolHandler
{
    private async Task<object> HandleAgentSessionAsync(string method, string fileSessionId, JsonElement payload, CancellationToken cancellationToken)
    {
        var after = OptionalInt64(payload, "after");
        // The launch the tab meant; absent from a tab that has not read one yet.
        var conversation = OptionalString(payload, "conversationId", 64);
        return method switch
        {
            WorkbenchMethods.AgentSessionList => await _session.ListLaunchableAgentsAsync(fileSessionId, cancellationToken),
            WorkbenchMethods.AgentSessionSetCommand => await _session.SetAgentCommandAsync(fileSessionId,
                OptionalString(payload, "commandLine", DesktopAgentCatalog.MaximumCommandLineLength), cancellationToken),
            WorkbenchMethods.AgentSessionSetHidden => await _session.SetAgentHiddenAsync(fileSessionId,
                RequiredString(payload, "agentId", 40), RequiredBoolean(payload, "hidden"), cancellationToken),
            WorkbenchMethods.AgentSessionSetViewAccess => await _session.SetAgentViewAccessAsync(fileSessionId,
                RequiredString(payload, "access", 20), cancellationToken),
            WorkbenchMethods.AgentSessionSetStartIn => await _session.SetAgentStartInRepositoryAsync(fileSessionId,
                RequiredBoolean(payload, "repository"), cancellationToken),
            WorkbenchMethods.AgentSessionLaunch => await _session.LaunchAgentAsync(fileSessionId, RequiredString(payload, "agentId", 40), cancellationToken,
                LaunchSettings(payload)),
            WorkbenchMethods.AgentSessionTurn => _session.ReadLaunchedAgentTurn(fileSessionId, RequiredString(payload, "turnId", 40), conversation),
            WorkbenchMethods.AgentSessionRead => _session.ReadLaunchedAgent(fileSessionId, after),
            WorkbenchMethods.AgentSessionPrompt => _session.PromptLaunchedAgent(fileSessionId,
                OptionalString(payload, "text", AgentConversation.MaximumPromptCharacters)
                    ?? throw new NendoValidationException("Type something for the agent first."), after, PointedAt(payload), conversation,
                OptionalString(payload, "from", 120)),
            WorkbenchMethods.AgentSessionAnswer => _session.AnswerLaunchedAgent(fileSessionId,
                RequiredString(payload, "entryId", 40), OptionalString(payload, "optionId", 200), after, conversation),
            WorkbenchMethods.AgentSessionCancel => await _session.CancelLaunchedAgentTurnAsync(fileSessionId, after, conversation,
                OptionalString(payload, "turnId", 40)),
            WorkbenchMethods.AgentSessionAuthenticate => _session.AuthenticateLaunchedAgent(fileSessionId,
                RequiredString(payload, "methodId", 200), after, conversation),
            WorkbenchMethods.AgentSessionEnd => await _session.EndLaunchedAgentAsync(fileSessionId, after, conversation),
            WorkbenchMethods.AgentSessionSetOption => await _session.SetLaunchedAgentOptionAsync(fileSessionId,
                RequiredString(payload, "configId", 200), RequiredString(payload, "value", 300), after, cancellationToken, conversation),
            _ => throw new NendoPreconditionException("unknown-method", $"Workbench method {method} is not part of this protocol."),
        };
    }

    /// <summary>
    /// What the person pointed at with @: an array of {uri, title, text}, or none. The
    /// conversation checks the bounds and the addresses; here only the shape is read.
    /// </summary>
    private static IReadOnlyList<AgentPromptContext> PointedAt(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("context", out var list) || list.ValueKind == JsonValueKind.Null)
            return [];
        if (list.ValueKind != JsonValueKind.Array) throw new NendoValidationException("Request property context must be a list.");
        if (list.GetArrayLength() > AgentConversation.MaximumContextItems)
            throw new NendoValidationException($"A message points at {AgentConversation.MaximumContextItems} things at most.");
        return list.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.Object
            ? new AgentPromptContext(
                OptionalString(item, "uri", AgentConversation.MaximumContextUriCharacters) ?? string.Empty,
                OptionalString(item, "title", AgentConversation.MaximumContextTitleCharacters) ?? string.Empty,
                OptionalString(item, "text", AgentConversation.MaximumContextTextCharacters) ?? string.Empty)
            : throw new NendoValidationException("Each thing a message points at is an object with uri, title and text.")).ToArray();
    }

    /// <summary>
    /// The settings a view's launch card picked: an object of at most 16 option IDs to values, or
    /// none. Whether each is one the agent offered is the launch's to check.
    /// </summary>
    private static IReadOnlyDictionary<string, string>? LaunchSettings(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("settings", out var settings) || settings.ValueKind == JsonValueKind.Null)
            return null;
        if (settings.ValueKind != JsonValueKind.Object) throw new NendoValidationException("Request property settings must be an object.");
        var picked = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var setting in settings.EnumerateObject())
        {
            if (picked.Count == AgentConversation.MaximumOptions)
                throw new NendoValidationException($"A launch sets {AgentConversation.MaximumOptions} settings at most.");
            if (setting.Name.Length is 0 or > 200) throw new NendoValidationException("A setting's ID is 1 to 200 characters.");
            if (setting.Value.ValueKind != JsonValueKind.String || setting.Value.GetString() is not { Length: > 0 and <= 300 } value)
                throw new NendoValidationException("A setting's value is text of 1 to 300 characters.");
            picked[setting.Name] = value;
        }
        return picked;
    }

    private static long OptionalInt64(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) && number >= 0
            ? number
            : 0;

    /// <summary>A string up to <paramref name="maximumLength"/>, or null when it is absent, null or empty.</summary>
    private static string? OptionalString(JsonElement payload, string name, int maximumLength)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind != JsonValueKind.String) throw new NendoValidationException($"Request property {name} must be text.");
        var text = value.GetString()!;
        if (text.Length > maximumLength) throw new NendoValidationException($"Request property {name} is longer than {maximumLength:N0} characters.");
        return text.Length == 0 ? null : text;
    }
}
