using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// Something in the open file the person pointed at with @ when writing to the agent: the address
/// that reads it through Nendo, what it is called, and a short description the Workbench wrote of
/// it, with its IDs (W-200). The person chose it, and the agent could read all of it through the
/// file's address at the level it works at; it travels with the message so the agent need not go
/// looking for what the person already had in front of them.
/// </summary>
internal sealed record AgentPromptContext(string Uri, string Title, string Text);

internal sealed partial class AgentConversation
{
    internal const int MaximumContextItems = 8;
    internal const int MaximumContextUriCharacters = 600;
    internal const int MaximumContextTitleCharacters = 120;
    internal const int MaximumContextTextCharacters = 8_000;
    internal const int MaximumContextTotalCharacters = 32_000;

    /// <summary>
    /// Refuse context Nendo would not send: more than a few items, an address that is not one of
    /// the file's own (nendo://), or text past its bounds. Nothing is sent when one item is refused.
    /// </summary>
    internal static void ValidateContext(IReadOnlyList<AgentPromptContext> context)
    {
        if (context.Count > MaximumContextItems)
            throw new NendoValidationException($"A message points at {MaximumContextItems} things at most.");
        var total = 0;
        foreach (var item in context)
        {
            if (item.Uri.Length is 0 or > MaximumContextUriCharacters || !item.Uri.StartsWith("nendo://", StringComparison.Ordinal)
                || item.Uri.Any(char.IsWhiteSpace))
                throw new NendoValidationException("A message points only at the file's own addresses, nendo://...");
            if (item.Title.Trim().Length is 0 or > MaximumContextTitleCharacters)
                throw new NendoValidationException($"What a message points at is named in 1 to {MaximumContextTitleCharacters} characters.");
            if (item.Text.Length > MaximumContextTextCharacters)
                throw new NendoValidationException($"What a message points at is described in {MaximumContextTextCharacters:N0} characters at most.");
            total += item.Text.Length;
        }
        if (total > MaximumContextTotalCharacters)
            throw new NendoValidationException($"What a message points at is described in {MaximumContextTotalCharacters:N0} characters at most, together.");
    }

    /// <summary>
    /// The ACP prompt: the person's words first, then what they pointed at. An agent that reads
    /// embedded context gets each as a resource with its address and description; any other gets
    /// a resource link, which every ACP agent reads, and the descriptions as text after it.
    /// </summary>
    internal static object[] PromptBlocks(string prompt, IReadOnlyList<AgentPromptContext> context, bool embeddedContext)
    {
        var blocks = new List<object> { new { type = "text", text = prompt } };
        if (context.Count == 0) return [.. blocks];
        if (embeddedContext)
        {
            blocks.AddRange(context.Select(item => (object)new
            {
                type = "resource",
                resource = new { uri = item.Uri, mimeType = "text/markdown", text = item.Text },
            }));
            return [.. blocks];
        }
        blocks.AddRange(context.Select(item => (object)new { type = "resource_link", uri = item.Uri, name = item.Title }));
        var described = new StringBuilder("What the person pointed at in the open file, as Nendo describes it:");
        foreach (var item in context) described.Append("\n\n").Append(item.Text);
        blocks.Add(new { type = "text", text = described.ToString() });
        return [.. blocks];
    }

    /// <summary>Whether the agent said, at initialize, that it reads resources embedded in a prompt.</summary>
    private static bool ReadsEmbeddedContext(JsonElement initialized) =>
        initialized.ValueKind == JsonValueKind.Object &&
        initialized.TryGetProperty("agentCapabilities", out var capabilities) && capabilities.ValueKind == JsonValueKind.Object &&
        capabilities.TryGetProperty("promptCapabilities", out var prompt) && prompt.ValueKind == JsonValueKind.Object &&
        prompt.TryGetProperty("embeddedContext", out var embedded) && embedded.ValueKind == JsonValueKind.True;
}
