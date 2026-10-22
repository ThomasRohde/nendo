using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// A picture the person put in a message: the name it came under, its type as its own bytes say
/// it, and the bytes. It goes to the agent as an ACP image block and is never kept.
/// </summary>
internal sealed record AgentPromptImage(string Name, string MediaType, byte[] Bytes);

internal sealed partial class AgentConversation
{
    internal const int MaximumImages = 8;
    internal const int MaximumImageBytes = 5 * 1024 * 1024;
    internal const int MaximumImagesBytes = 20 * 1024 * 1024;
    internal const int MaximumImageNameCharacters = 120;

    /// <summary>The picture types an agent that reads images takes: the ones a model reads.</summary>
    internal static readonly IReadOnlySet<string> ImageTypes =
        new HashSet<string>(StringComparer.Ordinal) { "image/png", "image/jpeg", "image/gif", "image/webp" };

    /// <summary>
    /// A picture as it goes to the agent, its type read from its bytes rather than taken from its
    /// name. Refuses an empty one, one past its bound, and any type a model does not read.
    /// </summary>
    internal static AgentPromptImage Image(string? name, byte[] bytes)
    {
        var shown = AcpConnection.Bounded((name ?? string.Empty).Trim(), MaximumImageNameCharacters - 1);
        if (shown.Length == 0) shown = "image";
        if (bytes.Length == 0) throw new NendoValidationException($"{shown} did not arrive. Add it again.");
        if (bytes.Length > MaximumImageBytes)
            throw new NendoPreconditionException("agent-image-too-large", $"{shown} is larger than the {MaximumImageBytes / (1024 * 1024)} MiB a picture may be.");
        var type = NendoMedia.Sniff(bytes);
        if (type is null || !ImageTypes.Contains(type))
            throw new NendoPreconditionException("agent-image-type", $"{shown} is not a PNG, JPEG, GIF or WebP picture.");
        return new AgentPromptImage(shown, type, bytes);
    }

    /// <summary>Refuse more pictures, or more bytes together, than one message carries.</summary>
    internal static void ValidateImages(IReadOnlyList<AgentPromptImage> images)
    {
        if (images.Count > MaximumImages)
            throw new NendoValidationException($"A message carries {MaximumImages} pictures at most.");
        if (images.Sum(image => (long)image.Bytes.Length) > MaximumImagesBytes)
            throw new NendoPreconditionException("agent-image-too-large", $"A message carries {MaximumImagesBytes / (1024 * 1024)} MiB of pictures at most.");
    }

    /// <summary>Whether the agent said, at initialize, that it reads images in a prompt.</summary>
    internal bool TakesImages { get { lock (_sync) return _images; } }

    /// <summary>One of the agent's prompt capabilities from its initialize answer: true only when stated as true.</summary>
    private static bool PromptCapability(JsonElement initialized, string name) =>
        initialized.ValueKind == JsonValueKind.Object &&
        initialized.TryGetProperty("agentCapabilities", out var capabilities) && capabilities.ValueKind == JsonValueKind.Object &&
        capabilities.TryGetProperty("promptCapabilities", out var prompt) && prompt.ValueKind == JsonValueKind.Object &&
        prompt.TryGetProperty(name, out var stated) && stated.ValueKind == JsonValueKind.True;
}
