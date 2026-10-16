using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Embeds one picture in the file (ADR-0031 point 4). The bytes travel beside the operation, as a
/// package file's do, and the operation row records the hash, the media type, the size and the
/// name, never the bytes, so history does not grow with the picture. Each distinct content is
/// stored once: putting content the file already holds changes nothing. A field names the picture
/// by its address, <c>media:</c> and the hash, in the same mutation or a later one.
/// </summary>
public sealed record PutMediaOperation : NendoOperation
{
    private readonly byte[]? _content;

    private PutMediaOperation(string operationId, string sha256, string mediaType, long byteLength, string? name,
        (int Width, int Height)? size, byte[]? content)
        : base(operationId)
    {
        if (!NendoExtensionContent.IsSha256(sha256))
            throw new NendoValidationException("A media item's SHA-256 must be 64 lowercase hexadecimal characters.");
        if (!NendoMedia.PictureTypes.ContainsKey(mediaType))
            throw new NendoPreconditionException("media-type-mismatch",
                $"{mediaType} is not a picture type Nendo stores. Use one of: {string.Join(", ", NendoMedia.PictureTypes.Keys)}.");
        if (byteLength is < 1 or > NendoMedia.MaximumItemBytes)
            throw new NendoPreconditionException("media-too-large",
                $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB, and this one is {Megabytes(byteLength)} MiB.");
        if (name is not null && (name.Length is 0 or > NendoMedia.MaximumNameCharacters || name.Any(char.IsControl)))
            throw new NendoValidationException($"A picture's name must contain 1-{NendoMedia.MaximumNameCharacters} characters and no control characters.");
        Sha256 = sha256;
        MediaType = mediaType;
        ByteLength = byteLength;
        Name = name;
        Width = size?.Width;
        Height = size?.Height;
        _content = content;
    }

    /// <summary>
    /// Embeds these bytes. The hash, the size, the type and the picture's width and height are read
    /// from the content here, never taken on trust: a stated type the content does not begin as is
    /// refused rather than stored under the wrong name.
    /// </summary>
    public static PutMediaOperation FromContent(string operationId, byte[] content, string? mediaType = null, string? name = null)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (content.Length > NendoMedia.MaximumItemBytes)
            throw new NendoPreconditionException("media-too-large",
                $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB, and this one is {Megabytes(content.Length)} MiB.");
        if (content.Length == 0) throw new NendoValidationException("A picture cannot be empty.");
        var sniffed = NendoMedia.Sniff(content);
        if (sniffed is null)
            throw new NendoPreconditionException("media-type-mismatch",
                $"The content does not begin as any picture type Nendo stores ({string.Join(", ", NendoMedia.PictureTypes.Keys)}).");
        if (mediaType is not null && mediaType != sniffed)
            throw new NendoPreconditionException("media-type-mismatch",
                $"The content was sent as {mediaType}, and it begins as {sniffed}. Send it as {sniffed}.");
        return new(operationId, NendoExtensionContent.Sha256(content), sniffed, content.Length, name,
            NendoMedia.PictureSize(sniffed, content), content.ToArray());
    }

    public string Sha256 { get; }
    public string MediaType { get; }
    public long ByteLength { get; }
    public string? Name { get; }
    public int? Width { get; }
    public int? Height { get; }

    /// <summary>The address a field names this picture by.</summary>
    public string Address => NendoMediaAddress.Embedded(Sha256);

    internal byte[]? ContentArray => _content;

    /// <summary>The new content bytes this operation brings with it, for the per-mutation bound.</summary>
    internal long CarriedBytes => _content?.LongLength ?? 0;

    public override string OperationType => "media.put";
    public override NendoRevisionLane Lane => NendoRevisionLane.Data;

    // The inverse takes nothing away: the content stays stored, unreferenced, until the person
    // removes unused media. What a field showed comes back with the field's own undo.
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteNumber("byteLength", ByteLength);
        if (Height is { } height) writer.WriteNumber("height", height);
        writer.WriteString("mediaType", MediaType);
        if (Name is not null) writer.WriteString("name", Name);
        writer.WriteString("sha256", Sha256);
        if (Width is { } width) writer.WriteNumber("width", width);
        writer.WriteEndObject();
    }

    private static string Megabytes(long bytes) => (bytes / (1024.0 * 1024)).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture);
}
