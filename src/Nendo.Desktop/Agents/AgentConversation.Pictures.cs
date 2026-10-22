using System.Security.Cryptography;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>A picture the agent showed in an entry: its ID for <c>agentSession.image</c>, its type, size and pixels.</summary>
internal sealed record AgentEntryImageView(string Id, string MediaType, long Length, int? Width, int? Height);

/// <summary>A window of a kept picture's bytes, as base64, and where the next one starts; null at the end.</summary>
internal sealed record AgentImageWindow(string Base64, long Length, string MediaType, long? Next);

/// <summary>
/// The pictures the agent and its tools send inline (ADR-0030). One is kept only when its own bytes
/// say PNG, JPEG, GIF or WebP, within the bound a person's picture has: never SVG, and never fetched
/// from an address it names. The conversation keeps a bounded number in memory, the same picture
/// once, and the oldest go first; the tab reads one in windows and draws it from its bytes.
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumKeptImages = 32;
    internal const long MaximumKeptImageBytes = 64L * 1024 * 1024;
    internal const int ImageWindowBytes = 150_000;

    private sealed record KeptImage(AgentEntryImageView View, byte[] Bytes);

    private readonly Dictionary<string, KeptImage> _keptImages = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _imageIdsByDigest = new(StringComparer.Ordinal);
    private readonly List<string> _imageOrder = [];
    private long _keptImageBytes;
    private int _imageCount;

    /// <summary>
    /// Keep a picture an image block carries, or null when there is none to keep: no inline data (an
    /// address alone, which Nendo does not fetch), not base64, empty, past its bound, or another
    /// type by its bytes. Called under the lock.
    /// </summary>
    private AgentEntryImageView? KeepImage(JsonElement block)
    {
        if (block.ValueKind != JsonValueKind.Object || Text(block, "type", 40) != "image") return null;
        if (!block.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.String) return null;
        var encoded = data.GetString()!;
        if (encoded.Length == 0 || encoded.Length > (MaximumImageBytes / 3 + 1) * 4) return null;
        var bytes = new byte[encoded.Length / 4 * 3 + 3];
        if (!Convert.TryFromBase64String(encoded, bytes, out var length) || length == 0 || length > MaximumImageBytes) return null;
        Array.Resize(ref bytes, length);
        var type = NendoMedia.Sniff(bytes);
        if (type is null || !ImageTypes.Contains(type)) return null;
        var digest = Convert.ToHexString(SHA256.HashData(bytes));
        if (_imageIdsByDigest.TryGetValue(digest, out var known) && _keptImages.TryGetValue(known, out var kept)) return kept.View;
        var size = NendoMedia.PictureSize(type, bytes);
        var view = new AgentEntryImageView($"i{++_imageCount}", type, bytes.LongLength, size?.Width, size?.Height);
        _keptImages[view.Id] = new KeptImage(view, bytes);
        _imageIdsByDigest[digest] = view.Id;
        _imageOrder.Add(view.Id);
        _keptImageBytes += bytes.LongLength;
        while (_imageOrder.Count > MaximumKeptImages || _keptImageBytes > MaximumKeptImageBytes)
        {
            var oldest = _imageOrder[0];
            _imageOrder.RemoveAt(0);
            if (_keptImages.Remove(oldest, out var gone)) _keptImageBytes -= gone.Bytes.LongLength;
            foreach (var pair in _imageIdsByDigest.Where(pair => pair.Value == oldest).ToArray()) _imageIdsByDigest.Remove(pair.Key);
        }
        return view;
    }

    /// <summary>The pictures a tool's content shows, kept, or null when it shows none Nendo can draw. Called under the lock.</summary>
    private List<AgentEntryImageView>? ToolImages(JsonElement content)
    {
        var images = content.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.Object && Text(item, "type", 40) == "content" && item.TryGetProperty("content", out _))
            .Select(item => KeepImage(item.GetProperty("content")))
            .OfType<AgentEntryImageView>()
            .DistinctBy(image => image.Id)
            .Take(MaximumKeptImages)
            .ToList();
        return images.Count == 0 ? null : images;
    }

    /// <summary>A window of a kept picture's bytes, for the tab to draw it.</summary>
    internal AgentImageWindow ReadImage(string imageId, long offset)
    {
        KeptImage image;
        lock (_sync)
        {
            if (!_keptImages.TryGetValue(imageId, out image!))
                throw new NendoPreconditionException("agent-image-gone", "That picture is no longer kept: the conversation keeps the newest pictures only.");
        }
        if (offset < 0 || offset > image.Bytes.LongLength) throw new NendoValidationException("offset is past the picture's end.");
        var count = (int)Math.Min(ImageWindowBytes, image.Bytes.LongLength - offset);
        var next = offset + count;
        return new AgentImageWindow(Convert.ToBase64String(image.Bytes, (int)offset, count), image.Bytes.LongLength, image.View.MediaType,
            next >= image.Bytes.LongLength ? null : next);
    }
}
