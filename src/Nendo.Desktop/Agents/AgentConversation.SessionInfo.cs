using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// The agent's name for the conversation (ACP <c>session_info_update</c>), which the tab shows
/// beside the agent's own name. The update is partial: a title it leaves out stays as it was, and
/// a null one clears it.
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumSessionTitleCharacters = 200;

    private string? _sessionTitle;

    /// <summary>The agent named the conversation, or cleared its name. Called under the lock; false when the title did not change.</summary>
    private bool ApplySessionInfo(JsonElement update)
    {
        if (!update.TryGetProperty("title", out var stated)) return false;
        string? title = stated.ValueKind switch
        {
            JsonValueKind.Null => null,
            // A title is one line of the agent's text: bounded, white space folded, any handle hidden.
            JsonValueKind.String => Redact(string.Join(' ', stated.GetString()!.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))),
            _ => _sessionTitle,
        };
        if (title is { Length: 0 }) title = null;
        if (title is not null) title = AcpConnection.Bounded(title, MaximumSessionTitleCharacters);
        if (title == _sessionTitle) return false;
        _sessionTitle = title;
        return true;
    }
}
