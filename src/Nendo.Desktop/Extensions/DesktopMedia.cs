using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// Where a file's pictures are served from (ADR-0031 point 10): one origin per open file
/// instance, under the reserved suffix the view origins use, so a request the host does not answer
/// fails rather than leaving the machine. Its label is <c>media-</c> and sixteen hexadecimal
/// characters, which no view origin can be: a view's label ends in a hyphen and ten.
/// </summary>
internal static class DesktopMediaOrigins
{
    private const string Prefix = "media-";
    private const int KeyCharacters = 16;

    internal static string Host(string applicationId, string instanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("media\n" + applicationId + "\n" + instanceId)))[..KeyCharacters]
            .ToLowerInvariant();
        return Prefix + key + ExtensionOrigins.Suffix;
    }

    /// <summary>The page's address for a media address, or null when it has none: web addresses are loaded as they are.</summary>
    internal static string? PathFor(NendoMediaAddress address) => address.Source switch
    {
        NendoMediaSource.Embedded => "/m/" + address.Sha256,
        NendoMediaSource.LocalAbsolute or NendoMediaSource.LocalRelative => "/f/?a=" + Uri.EscapeDataString(address.Value),
        _ => null,
    };
}

/// <summary>
/// One answer of the media origin: a status, and for 200 the type, the length and a way to open the
/// bytes from an offset. Embedded pictures never change under their address, so they may be cached;
/// a local file may, so it is not.
/// </summary>
internal sealed record DesktopMediaAnswer(int Status, string? MediaType = null, long Length = 0,
    Func<long, long, Stream>? Open = null, bool Immutable = false)
{
    internal static DesktopMediaAnswer NotFound { get; } = new(404);
    internal static DesktopMediaAnswer NotAllowed { get; } = new(405);
}

internal static class DesktopMediaResponses
{
    /// <summary>
    /// The headers of a media answer. No <c>Access-Control-Allow-Origin</c> ever: an <c>img</c> on
    /// any page shows the picture, and no script on another origin can read its bytes. An SVG is
    /// sandboxed, so opened on its own it runs none of its script.
    /// </summary>
    internal static IReadOnlyList<string> Headers(DesktopMediaAnswer answer, int status, long start, long end)
    {
        var headers = new List<string>
        {
            "Content-Type: " + (status is 200 or 206 ? answer.MediaType ?? "application/octet-stream" : "text/plain; charset=utf-8"),
            "X-Content-Type-Options: nosniff",
            "Cache-Control: " + (answer.Immutable && status is 200 or 206 ? "private, max-age=31536000, immutable" : "no-store"),
        };
        if (answer.Status == 200) headers.Add("Accept-Ranges: bytes");
        if (status == 206) headers.Add(string.Create(CultureInfo.InvariantCulture, $"Content-Range: bytes {start}-{end}/{answer.Length}"));
        if (status == 416) headers.Add(string.Create(CultureInfo.InvariantCulture, $"Content-Range: bytes */{answer.Length}"));
        if (status == 405) headers.Add("Allow: GET, HEAD");
        if (answer.MediaType == "image/svg+xml") headers.Add("Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'");
        return headers;
    }

    /// <summary>One range, the only kind a media element asks for: <c>bytes=a-b</c>, <c>bytes=a-</c> or <c>bytes=-n</c>.</summary>
    internal static bool TryRange(string header, long length, out long start, out long end)
    {
        start = end = 0;
        if (!header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase) || header.Contains(',') || length == 0) return false;
        var parts = header[6..].Trim().Split('-', 2);
        if (parts.Length != 2) return false;
        if (parts[0].Length == 0)
        {
            if (!long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var suffix) || suffix <= 0) return false;
            start = Math.Max(0, length - suffix);
            end = length - 1;
            return true;
        }
        if (!long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out start) || start >= length) return false;
        if (parts[1].Length == 0) { end = length - 1; return true; }
        if (!long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out end) || end < start) return false;
        end = Math.Min(end, length - 1);
        return true;
    }
}

/// <summary>
/// An embedded picture's bytes as a stream, read from the file a buffer at a time through the
/// Engine's incremental blob reader, so a 64 MiB picture is never held whole.
/// </summary>
internal sealed class DesktopMediaContentStream(Func<long, Memory<byte>, CancellationToken, Task<int>> readRange, long start, long count) : Stream
{
    private long _position;

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => count;

    public override long Position
    {
        get => _position;
        set => _position = Math.Clamp(value, 0, count);
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var remaining = count - _position;
        if (remaining <= 0 || buffer.Length == 0) return 0;
        var slice = buffer[..(int)Math.Min(buffer.Length, remaining)];
        // WebView2 asks for the bytes on the UI thread and may wait there for them. The Engine's
        // read resumes wherever it began, so it begins on the thread pool, and nothing it awaits
        // needs the UI thread to finish.
        var position = start + _position;
        var got = await Task.Run(() => readRange(position, slice, cancellationToken), cancellationToken).ConfigureAwait(false);
        if (got < 0) throw new IOException("The picture is no longer in the file.");
        _position += got;
        return got;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int length, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, length), cancellationToken).AsTask();

    /// <summary>
    /// WebView2 reads a response's stream on the UI thread, synchronously. Waiting there on the
    /// read itself deadlocked: the Engine's continuations queue to the UI thread this wait was
    /// holding, so no picture loaded and every bridge request after it hung. The read runs on the
    /// thread pool, which has no context to queue to, and only its result is waited for.
    /// </summary>
    public override int Read(byte[] buffer, int offset, int length) =>
        Task.Run(() => ReadAsync(buffer.AsMemory(offset, length)).AsTask()).GetAwaiter().GetResult();

    public override long Seek(long offset, SeekOrigin origin) => Position = origin switch
    {
        SeekOrigin.Begin => offset,
        SeekOrigin.Current => _position + offset,
        _ => count + offset,
    };

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int length) => throw new NotSupportedException();
}

/// <summary>
/// A window of a seekable stream from where it stands, so a range of a local file is served
/// without reading the rest. Seekable itself, since WebView2 takes a response body only as a
/// random-access stream: a window that could not seek was refused, and every linked picture
/// was answered as a server error.
/// </summary>
internal sealed class DesktopStreamWindow : Stream
{
    private readonly Stream _inner;
    private readonly long _origin;
    private readonly long _count;
    private long _position;

    internal DesktopStreamWindow(Stream inner, long count)
    {
        if (!inner.CanSeek) throw new ArgumentException("The window needs a seekable stream.", nameof(inner));
        _inner = inner;
        _origin = inner.Position;
        _count = count;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _count;
    public override long Position { get => _position; set => _position = Math.Clamp(value, 0, _count); }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var remaining = _count - _position;
        if (remaining <= 0 || buffer.Length == 0) return 0;
        _inner.Position = _origin + _position;
        var read = await _inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, remaining)], cancellationToken).ConfigureAwait(false);
        _position += read;
        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int length, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, length), cancellationToken).AsTask();

    public override int Read(byte[] buffer, int offset, int length)
    {
        var remaining = _count - _position;
        if (remaining <= 0) return 0;
        _inner.Position = _origin + _position;
        var read = _inner.Read(buffer, offset, (int)Math.Min(length, remaining));
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin) => Position = origin switch
    {
        SeekOrigin.Begin => offset,
        SeekOrigin.Current => _position + offset,
        _ => _count + offset,
    };

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }

    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int length) => throw new NotSupportedException();
}
