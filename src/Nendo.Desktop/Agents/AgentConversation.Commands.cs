using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// One of the agent's own slash commands, as it advertised it: its name without the slash, what it
/// does, and, when it takes input, the hint shown until the person types some.
/// </summary>
internal sealed record AgentCommandView(string Name, string Description, string? Hint);

/// <summary>
/// The agent's slash commands (ACP <c>available_commands_update</c>). The agent states them after
/// the session opens and again whenever they change, each time whole. Nendo only lists them for
/// the message box: running one is a message that starts with <c>/name</c>, sent as any other, and
/// the agent decides what it means.
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumCommands = 200;
    internal const int MaximumCommandNameCharacters = 100;

    private IReadOnlyList<AgentCommandView> _commands = [];

    /// <summary>The agent restated its commands. Called under the lock; false when the update carried no list.</summary>
    private bool ApplyCommands(JsonElement update)
    {
        if (!update.TryGetProperty("availableCommands", out var list) || list.ValueKind != JsonValueKind.Array) return false;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        _commands = list.EnumerateArray()
            .Where(command => command.ValueKind == JsonValueKind.Object)
            .Select(command => new AgentCommandView(
                CommandName(Text(command, "name", MaximumCommandNameCharacters + 1)),
                Redact(Text(command, "description", 500) ?? string.Empty),
                command.TryGetProperty("input", out var input) && input.ValueKind == JsonValueKind.Object
                    ? Redact(Text(input, "hint", 200) ?? string.Empty)
                    : null))
            // A name the box could not write back as one word is not a command the person can run.
            .Where(command => command.Name.Length is > 0 and <= MaximumCommandNameCharacters
                && !command.Name.Any(char.IsWhiteSpace) && seen.Add(command.Name))
            .Take(MaximumCommands)
            .ToArray();
        return true;
    }

    /// <summary>The name as the box writes it after its slash: one the agent sent with its own slash keeps one.</summary>
    private static string CommandName(string? name) => name is null ? string.Empty : name.Trim().TrimStart('/');
}
