using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

internal sealed partial class WorkbenchProtocolHandler
{
    private async Task<DesktopAgentStatus> SetAgentModeAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<AgentModePayload>(payload);
        return await _session.SetAgentModeAsync(request.Mode, cancellationToken);
    }

    private async Task<DesktopAgentStatus> SetAgentSettingsAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<AgentSettingsPayload>(payload);
        // Re-validated in the store; the renderer is never the authority on a bounded value.
        return await _session.SetAgentSettingsAsync(
            request.LeaseExpiry,
            request.LeaseExpirySeconds,
            request.FixedPort,
            request.Port,
            cancellationToken);
    }

    private async Task<Nendo.LocalMcp.NendoAgentProposalPreview> GetAgentProposalAsync(
        JsonElement payload,
        CancellationToken cancellationToken)
    {
        var request = Deserialize<ProposalIdPayload>(payload);
        return await _session.GetAgentProposalAsync(request.ProposalId, cancellationToken);
    }

    /// <summary>Pictures on their way to the agent's next message, by file session and the tab's key.</summary>
    private readonly NendoMediaUploads<object> _agentPictures = new();

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
                OptionalString(payload, "text", AgentConversation.MaximumPromptCharacters) ?? string.Empty, after, PointedAt(payload), conversation,
                OptionalString(payload, "from", 120), Pictures(fileSessionId, payload)),
            WorkbenchMethods.AgentSessionAttach => StageAgentPicture(fileSessionId, payload, conversation),
            WorkbenchMethods.AgentSessionRespond => _session.RespondLaunchedAgent(fileSessionId, RequiredString(payload, "entryId", 40),
                RequiredString(payload, "action", 20), payload.TryGetProperty("content", out var answered) ? answered : default, after, conversation),
            WorkbenchMethods.AgentSessionImage => _session.ReadLaunchedAgentImage(fileSessionId, RequiredString(payload, "imageId", 20),
                OptionalInt64(payload, "offset"), conversation),
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
    /// A chunk of a picture for the agent's next message, staged in memory under the tab's own key
    /// for this file session. A picture is refused before its bytes arrive when the agent does not
    /// read pictures, and as soon as it passes its bound.
    /// </summary>
    private object StageAgentPicture(string fileSessionId, JsonElement payload, string? conversation)
    {
        _session.RequireLaunchedAgentTakesImages(fileSessionId, conversation);
        var key = fileSessionId + "\n" + RequiredString(payload, "uploadKey", 80);
        var offset = OptionalInt64(payload, "offset");
        byte[] chunk;
        try { chunk = Convert.FromBase64String(RequiredString(payload, "base64", MaximumMessageCharacters)); }
        catch (FormatException) { throw new NendoValidationException("base64 is not valid base64."); }
        var staged = _agentPictures.Stage(key, offset, chunk);
        if (staged > AgentConversation.MaximumImageBytes)
        {
            _agentPictures.Forget(key);
            throw new NendoPreconditionException("agent-image-too-large", $"A picture is at most {AgentConversation.MaximumImageBytes / (1024 * 1024)} MiB.");
        }
        return new { staged };
    }

    /// <summary>
    /// The pictures a message carries: at most eight {uploadKey, name}, each taken from what was
    /// staged under its key, or none. A key with nothing staged refuses the message.
    /// </summary>
    private IReadOnlyList<AgentPromptImage> Pictures(string fileSessionId, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("images", out var list) || list.ValueKind == JsonValueKind.Null)
            return [];
        if (list.ValueKind != JsonValueKind.Array) throw new NendoValidationException("Request property images must be a list.");
        if (list.GetArrayLength() > AgentConversation.MaximumImages)
            throw new NendoValidationException($"A message carries {AgentConversation.MaximumImages} pictures at most.");
        var pictures = new List<AgentPromptImage>();
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) throw new NendoValidationException("Each picture is an object with uploadKey and name.");
            var key = fileSessionId + "\n" + RequiredString(item, "uploadKey", 80);
            pictures.Add(AgentConversation.Image(OptionalString(item, "name", 400), _agentPictures.Take(key)));
        }
        return pictures;
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
