using System.Buffers.Binary;
using System.Text;

namespace Nendo.Engine;

/// <summary>
/// Media in user data (ADR-0031). A media field is a Text field with the presentation
/// <see cref="Presentation"/>, and its value is an address: embedded content by its SHA-256, an
/// <c>https:</c> address, or a local path. Pictures are the kinds this host knows; sound and video
/// join the same store, address and origin when they are built.
/// </summary>
public static class NendoMedia
{
    /// <summary>The presentation of a Text field whose value is a media address.</summary>
    public const string Presentation = "media";

    /// <summary>The scheme of an embedded item's address, followed by 64 lowercase hexadecimal digits.</summary>
    public const string EmbeddedScheme = "media:";

    /// <summary>The most one embedded item may hold (ADR-0031 point 6).</summary>
    public const long MaximumItemBytes = 64L * 1024 * 1024;

    /// <summary>The most embedded content one file may hold (ADR-0031 point 6), measured on 2026-10-16 (W-264).</summary>
    public const long MaximumFileBytes = 2048L * 1024 * 1024;

    /// <summary>How long an address may be, in characters: room for a long web address or a deep path.</summary>
    public const int MaximumAddressCharacters = 2048;

    /// <summary>How long the name an item was added under may be.</summary>
    public const int MaximumNameCharacters = 240;

    /// <summary>The picture types, by media type, with the file extensions a local picture may have.</summary>
    public static IReadOnlyDictionary<string, string[]> PictureTypes { get; } = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["image/png"] = [".png"],
        ["image/jpeg"] = [".jpg", ".jpeg"],
        ["image/gif"] = [".gif"],
        ["image/webp"] = [".webp"],
        ["image/avif"] = [".avif"],
        ["image/svg+xml"] = [".svg"],
    };

    /// <summary>The media type a local file's extension names, or null when it is not a picture's.</summary>
    public static string? MediaTypeForExtension(string extension) =>
        PictureTypes.FirstOrDefault(pair => pair.Value.Contains(extension.ToLowerInvariant())).Key;

    /// <summary>
    /// The media type the content itself says it is, read from its first bytes, or null when it
    /// begins as none of the picture types. SVG is text, so it is recognised by an <c>svg</c>
    /// element near the start, after any XML declaration, comments and doctype.
    /// </summary>
    public static string? Sniff(ReadOnlySpan<byte> content)
    {
        if (content.StartsWith(PngSignature)) return "image/png";
        if (content.Length >= 3 && content[0] == 0xFF && content[1] == 0xD8 && content[2] == 0xFF) return "image/jpeg";
        if (content.StartsWith("GIF87a"u8) || content.StartsWith("GIF89a"u8)) return "image/gif";
        if (content.Length >= 12 && content.StartsWith("RIFF"u8) && content[8..12].SequenceEqual("WEBP"u8)) return "image/webp";
        if (content.Length >= 12 && content[4..8].SequenceEqual("ftyp"u8) &&
            (content[8..12].SequenceEqual("avif"u8) || content[8..12].SequenceEqual("avis"u8))) return "image/avif";
        return LooksLikeSvg(content) ? "image/svg+xml" : null;
    }

    // Bytes, not a u8 string: an escape above 0x7F in one is encoded as two UTF-8 bytes.
    private static ReadOnlySpan<byte> PngSignature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    private static ReadOnlySpan<byte> Utf8ByteOrderMark => [0xEF, 0xBB, 0xBF];

    private static bool LooksLikeSvg(ReadOnlySpan<byte> content)
    {
        var head = content[..Math.Min(content.Length, 4096)];
        if (head.StartsWith(Utf8ByteOrderMark)) head = head[3..];
        string text;
        try { text = new UTF8Encoding(false, true).GetString(head); }
        catch (DecoderFallbackException) when (head.Length == 4096) { text = Encoding.UTF8.GetString(head); }
        catch (DecoderFallbackException) { return false; }
        var at = 0;
        while (true)
        {
            while (at < text.Length && char.IsWhiteSpace(text[at])) at++;
            if (at >= text.Length) return false;
            if (string.CompareOrdinal(text, at, "<?xml", 0, 5) == 0 || string.CompareOrdinal(text, at, "<!DOCTYPE", 0, 9) == 0)
            {
                var end = text.IndexOf('>', at);
                if (end < 0) return false;
                at = end + 1;
            }
            else if (string.CompareOrdinal(text, at, "<!--", 0, 4) == 0)
            {
                var end = text.IndexOf("-->", at, StringComparison.Ordinal);
                if (end < 0) return false;
                at = end + 3;
            }
            else return string.CompareOrdinal(text, at, "<svg", 0, 4) == 0 && at + 4 < text.Length &&
                (char.IsWhiteSpace(text[at + 4]) || text[at + 4] is '>' or '/');
        }
    }

    /// <summary>
    /// A picture's width and height in pixels, read from its header where the format says them
    /// plainly (PNG, GIF, JPEG, WebP); null for AVIF, SVG and anything the header does not settle.
    /// </summary>
    public static (int Width, int Height)? PictureSize(string mediaType, ReadOnlySpan<byte> content)
    {
        try
        {
            (int, int)? size = mediaType switch
            {
                "image/png" when content.Length >= 24 && content[12..16].SequenceEqual("IHDR"u8) =>
                    ((int)BinaryPrimitives.ReadUInt32BigEndian(content[16..]), (int)BinaryPrimitives.ReadUInt32BigEndian(content[20..])),
                "image/gif" when content.Length >= 10 =>
                    (BinaryPrimitives.ReadUInt16LittleEndian(content[6..]), BinaryPrimitives.ReadUInt16LittleEndian(content[8..])),
                "image/jpeg" => JpegSize(content),
                "image/webp" => WebpSize(content),
                _ => null,
            };
            return size is { } value && value.Item1 > 0 && value.Item2 > 0 ? value : null;
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    private static (int, int)? JpegSize(ReadOnlySpan<byte> content)
    {
        var at = 2;
        while (at + 9 < content.Length)
        {
            if (content[at] != 0xFF) return null;
            var marker = content[at + 1];
            if (marker == 0xFF) { at++; continue; }
            if (marker is 0xD8 or 0x01 || marker is >= 0xD0 and <= 0xD7) { at += 2; continue; }
            var length = BinaryPrimitives.ReadUInt16BigEndian(content[(at + 2)..]);
            // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
            if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
                return (BinaryPrimitives.ReadUInt16BigEndian(content[(at + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(content[(at + 5)..]));
            if (length < 2) return null;
            at += 2 + length;
        }
        return null;
    }

    private static (int, int)? WebpSize(ReadOnlySpan<byte> content)
    {
        if (content.Length < 30) return null;
        var chunk = content[12..16];
        if (chunk.SequenceEqual("VP8X"u8))
            return (1 + (content[24] | content[25] << 8 | content[26] << 16), 1 + (content[27] | content[28] << 8 | content[29] << 16));
        if (chunk.SequenceEqual("VP8L"u8) && content[20] == 0x2F)
        {
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(content[21..]);
            return ((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
        }
        if (chunk.SequenceEqual("VP8 "u8) && content[23] == 0x9D && content[24] == 0x01 && content[25] == 0x2A)
            return (BinaryPrimitives.ReadUInt16LittleEndian(content[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(content[28..]) & 0x3FFF);
        return null;
    }
}

/// <summary>Which of the three sources an address names.</summary>
public enum NendoMediaSource
{
    Embedded,
    Web,
    LocalAbsolute,
    LocalRelative,
}

/// <summary>
/// A media address, parsed (ADR-0031 point 3). The grammar is the Engine's, so every client gets
/// the same answer: <c>media:</c> and a SHA-256, an absolute <c>https:</c> address, a drive-letter
/// path, or a path relative to the folder holding the file that starts <c>.\</c> or <c>..\</c>
/// (forward slashes are read the same). <c>http:</c>, network shares and anything else are refused.
/// </summary>
public sealed record NendoMediaAddress(NendoMediaSource Source, string Value)
{
    /// <summary>For an embedded address, the SHA-256 it names; otherwise null.</summary>
    public string? Sha256 => Source == NendoMediaSource.Embedded ? Value[NendoMedia.EmbeddedScheme.Length..] : null;

    public static string Embedded(string sha256) => NendoMedia.EmbeddedScheme + sha256;

    public static bool TryParse(string? value, out NendoMediaAddress? address)
    {
        address = Parse(value);
        return address is not null;
    }

    private static NendoMediaAddress? Parse(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > NendoMedia.MaximumAddressCharacters ||
            value.Any(character => char.IsControl(character)) || value != value.Trim()) return null;
        if (value.StartsWith(NendoMedia.EmbeddedScheme, StringComparison.Ordinal))
            return NendoExtensionContent.IsSha256(value[NendoMedia.EmbeddedScheme.Length..]) ? new(NendoMediaSource.Embedded, value) : null;
        if (value.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
                !string.IsNullOrEmpty(uri.Host) && string.IsNullOrEmpty(uri.UserInfo) && !value.Any(char.IsWhiteSpace)
                ? new(NendoMediaSource.Web, value) : null;
        if (value.Length >= 4 && char.IsAsciiLetter(value[0]) && value[1] == ':' && value[2] is '\\' or '/')
            return LocalSegmentsValid(value[3..]) ? new(NendoMediaSource.LocalAbsolute, value) : null;
        if (value.StartsWith(@".\", StringComparison.Ordinal) || value.StartsWith("./", StringComparison.Ordinal) ||
            value.StartsWith(@"..\", StringComparison.Ordinal) || value.StartsWith("../", StringComparison.Ordinal))
            return LocalSegmentsValid(value) ? new(NendoMediaSource.LocalRelative, value) : null;
        return null;
    }

    /// <summary>
    /// The path after its drive, or a relative path: segments of characters Windows allows in a
    /// file name, none empty and none ending in a space or dot, except <c>.</c> and <c>..</c>; the
    /// last segment names a file.
    /// </summary>
    private static bool LocalSegmentsValid(string path)
    {
        var segments = path.Split('\\', '/');
        for (var index = 0; index < segments.Length; index++)
        {
            var segment = segments[index];
            if (segment is "." or "..") { if (index == segments.Length - 1) return false; continue; }
            if (segment.Length == 0 || segment.EndsWith(' ') || segment.EndsWith('.') ||
                segment.Any(character => character is '<' or '>' or ':' or '"' or '|' or '?' or '*')) return false;
        }
        return true;
    }
}

/// <summary>One embedded item, without its bytes.</summary>
public sealed record NendoMediaItem(string Sha256, string MediaType, long ByteLength, string? Name, int? Width, int? Height)
{
    public string Address => NendoMediaAddress.Embedded(Sha256);
}
