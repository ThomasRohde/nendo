using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// The agent launched from the Agent page and its conversation tab (ADR-0030). None of these
    /// waits on the request gate except list, setCommand and launch: the tab keeps reading while an
    /// agent's own write holds the file. Each still names the file session it belongs to.
    /// </summary>
    internal const string AgentSessionPrefix = "agentSession.";
    internal const string AgentSessionList = "agentSession.list";
    internal const string AgentSessionSetCommand = "agentSession.setCommand";
    internal const string AgentSessionLaunch = "agentSession.launch";
    internal const string AgentSessionRead = "agentSession.read";
    internal const string AgentSessionPrompt = "agentSession.prompt";
    internal const string AgentSessionAnswer = "agentSession.answer";
    internal const string AgentSessionCancel = "agentSession.cancel";
    internal const string AgentSessionAuthenticate = "agentSession.authenticate";
    internal const string AgentSessionEnd = "agentSession.end";
    internal const string AgentSessionSetOption = "agentSession.setOption";

    internal static readonly IReadOnlySet<string> AgentSessionMethods = new HashSet<string>(StringComparer.Ordinal)
    {
        AgentSessionList, AgentSessionSetCommand, AgentSessionLaunch, AgentSessionRead, AgentSessionPrompt,
        AgentSessionAnswer, AgentSessionCancel, AgentSessionAuthenticate, AgentSessionEnd, AgentSessionSetOption,
    };
}

internal sealed partial class WorkbenchProtocolHandler
{
    private async Task<object> HandleAgentSessionAsync(string method, string fileSessionId, JsonElement payload, CancellationToken cancellationToken)
    {
        var after = OptionalInt64(payload, "after");
        return method switch
        {
            WorkbenchMethods.AgentSessionList => await _session.ListLaunchableAgentsAsync(fileSessionId, cancellationToken),
            WorkbenchMethods.AgentSessionSetCommand => await _session.SetAgentCommandAsync(fileSessionId,
                OptionalString(payload, "commandLine", DesktopAgentCatalog.MaximumCommandLineLength), cancellationToken),
            WorkbenchMethods.AgentSessionLaunch => await _session.LaunchAgentAsync(fileSessionId, RequiredString(payload, "agentId", 40), cancellationToken),
            WorkbenchMethods.AgentSessionRead => _session.ReadLaunchedAgent(fileSessionId, after),
            WorkbenchMethods.AgentSessionPrompt => _session.PromptLaunchedAgent(fileSessionId,
                OptionalString(payload, "text", AgentConversation.MaximumPromptCharacters)
                    ?? throw new NendoValidationException("Type something for the agent first."), after),
            WorkbenchMethods.AgentSessionAnswer => _session.AnswerLaunchedAgent(fileSessionId,
                RequiredString(payload, "entryId", 40), OptionalString(payload, "optionId", 200), after),
            WorkbenchMethods.AgentSessionCancel => await _session.CancelLaunchedAgentTurnAsync(fileSessionId, after),
            WorkbenchMethods.AgentSessionAuthenticate => _session.AuthenticateLaunchedAgent(fileSessionId,
                RequiredString(payload, "methodId", 200), after),
            WorkbenchMethods.AgentSessionEnd => await _session.EndLaunchedAgentAsync(fileSessionId, after),
            WorkbenchMethods.AgentSessionSetOption => await _session.SetLaunchedAgentOptionAsync(fileSessionId,
                RequiredString(payload, "configId", 200), RequiredString(payload, "value", 300), after, cancellationToken),
            _ => throw new NendoPreconditionException("unknown-method", $"Workbench method {method} is not part of this protocol."),
        };
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
