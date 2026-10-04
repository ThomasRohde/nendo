using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Nendo.LocalMcp;

internal sealed class NendoMcpSecurityMiddleware(RequestDelegate next)
{
    internal const long MaximumRequestBodyBytes = 256 * 1024;
    // 32 leaves eighteen levels over the deepest published example; 16 left two, so an
    // automatic action one level richer than the examples was refused (F-182).
    internal const int MaximumJsonDepth = 32;

    public async Task InvokeAsync(HttpContext context, NendoHostAuthority authority, NendoRequestGate gate)
    {
        if (!context.Request.Path.StartsWithSegments("/mcp", StringComparison.Ordinal))
        {
            await next(context);
            return;
        }

        // The request's User-Agent names a handshake-era client on every request (W-150).
        using var client = NendoTransportIdentity.FromUserAgent(context.Request.Headers.UserAgent.ToString());
        if (!IPAddress.Loopback.Equals(context.Connection.RemoteIpAddress))
        {
            await RejectAsync(context, StatusCodes.Status403Forbidden, "NENDO_NON_LOOPBACK", "Only this computer may connect.");
            return;
        }
        // Each refusal says what to send instead: "The request host is invalid" left a
        // client configured with localhost with nothing to change (F-175).
        if (!IsExactHost(context.Request.Host, authority.Port))
        {
            await RejectAsync(
                context,
                StatusCodes.Status400BadRequest,
                "NENDO_INVALID_HOST",
                $"Send requests to http://127.0.0.1:{authority.Port}/mcp, with exactly that Host header. localhost and " +
                "every other name are refused by design, so that a web page cannot reach this endpoint by DNS rebinding.");
            return;
        }
        var origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrEmpty(origin) && !IsExactOrigin(origin, authority.Port))
        {
            await RejectAsync(
                context,
                StatusCodes.Status403Forbidden,
                "NENDO_INVALID_ORIGIN",
                $"A request that carries an Origin must come from http://127.0.0.1:{authority.Port}. A page served from " +
                "anywhere else is refused, so that a browser cannot be used to reach this endpoint.");
            return;
        }
        if (context.Request.ContentLength > MaximumRequestBodyBytes)
        {
            await RejectTooLargeAsync(context);
            return;
        }
        // Counted before the body is read: a request still sending its body holds a place,
        // which is what stops a client from opening requests without ever finishing them.
        if (!gate.TryEnter())
        {
            context.Response.Headers.RetryAfter = "1";
            await RejectAsync(
                context,
                StatusCodes.Status429TooManyRequests,
                "NENDO_BUSY",
                $"{gate.Maximum} requests to this file are already in progress, the most this host serves at once. " +
                "Retry when one of them has answered.");
            return;
        }
        var aborted = context.RequestAborted;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        // A subscriptions/listen stream is held open on purpose, for as long as its client
        // listens; it keeps its gate place and is not a request that failed to finish (W-151).
        if (!string.Equals(context.Request.Headers["Mcp-Method"].ToString(), "subscriptions/listen", StringComparison.Ordinal))
            timeout.CancelAfter(gate.Timeout);
        context.RequestAborted = timeout.Token;
        try
        {
            await AdmitAsync(context, authority);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested && !aborted.IsCancellationRequested)
        {
        }
        finally
        {
            context.RequestAborted = aborted;
            gate.Exit();
        }
        if (timeout.IsCancellationRequested && !aborted.IsCancellationRequested && !context.Response.HasStarted)
        {
            await RejectAsync(
                context,
                StatusCodes.Status503ServiceUnavailable,
                "NENDO_REQUEST_TIMEOUT",
                $"The request did not finish within {(int)gate.Timeout.TotalSeconds} seconds and was stopped. A write " +
                "may still have committed: nendo.data.get_receipt with the same idempotency key says whether it did.");
        }
    }

    private async Task AdmitAsync(HttpContext context, NendoHostAuthority authority)
    {
        var originalBody = context.Request.Body;
        await using var buffered = new MemoryStream(
            context.Request.ContentLength is > 0
                ? (int)context.Request.ContentLength.Value
                : 0);
        try
        {
            try
            {
                await using var limited = new SizeLimitedReadStream(originalBody, MaximumRequestBodyBytes);
                await limited.CopyToAsync(buffered, context.RequestAborted);
            }
            catch (RequestBodyTooLargeException)
            {
                await RejectTooLargeAsync(context);
                return;
            }

            if (buffered.Length > 0)
            {
                buffered.Position = 0;
                try
                {
                    using var _ = await JsonDocument.ParseAsync(
                        buffered,
                        new JsonDocumentOptions { MaxDepth = MaximumJsonDepth },
                        context.RequestAborted);
                }
                catch (JsonException error)
                {
                    await RejectAsync(
                        context,
                        StatusCodes.Status400BadRequest,
                        "NENDO_INVALID_JSON",
                        InvalidJsonMessage(buffered, error));
                    return;
                }
            }

            buffered.Position = 0;
            context.Request.Body = buffered;
            // A body may have arrived slowly while the host was closing. Passing the
            // perimeter earlier is not admission after a lifecycle boundary.
            if (!authority.IsActive)
            {
                await RejectAsync(
                    context,
                    StatusCodes.Status401Unauthorized,
                    "NENDO_HOST_CLOSED",
                    "This agent endpoint is closed: the file was closed, switched or entered recovery, or agent access " +
                    "was turned off. Every handle and lease from it has ended. Ask the person which file is open; Nendo " +
                    "shows the current address on the Agent page.");
                return;
            }
            await next(context);
        }
        finally
        {
            context.Request.Body = originalBody;
        }
    }

    /// <summary>
    /// Why a body was refused. A body nested past the cap is valid JSON that the host will not
    /// read, and says so with both numbers; it used to share one sentence with a body that was
    /// not JSON at all, so an agent whose change set was one level too rich had nothing to
    /// correct (F-182).
    /// </summary>
    internal static string InvalidJsonMessage(MemoryStream body, JsonException error)
    {
        if (MeasureDepth(body) is { } depth && depth > MaximumJsonDepth)
        {
            return $"The request body nests {depth} levels deep, and this host reads at most {MaximumJsonDepth}. " +
                "Send a shallower payload, or split the change set over more calls.";
        }
        var position = error.LineNumber is { } line && error.BytePositionInLine is { } column
            ? $" at line {line + 1}, byte {column + 1}"
            : string.Empty;
        return $"The request body is not valid JSON{position}. Send one JSON-RPC message per request.";
    }

    /// <summary>
    /// How many containers deep a body nests, or null when it is not JSON. The reader's own
    /// ceiling is the body limit, which no 256 KiB body can nest past, so a failure here is
    /// the text itself and never the measurement.
    /// </summary>
    internal static int? MeasureDepth(MemoryStream body)
    {
        var reader = new Utf8JsonReader(
            body.GetBuffer().AsSpan(0, (int)body.Length),
            new JsonReaderOptions { MaxDepth = (int)MaximumRequestBodyBytes });
        var deepest = 0;
        try
        {
            while (reader.Read())
            {
                if (reader.TokenType is JsonTokenType.StartObject or JsonTokenType.StartArray)
                {
                    deepest = Math.Max(deepest, reader.CurrentDepth + 1);
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        return deepest;
    }

    internal static bool IsExactHost(HostString host, int port) =>
        string.Equals(host.Host, IPAddress.Loopback.ToString(), StringComparison.Ordinal) &&
        host.Port == port;

    internal static bool IsExactOrigin(string value, int port)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var origin))
        {
            return false;
        }
        return origin.Scheme == Uri.UriSchemeHttp &&
            string.Equals(origin.Host, IPAddress.Loopback.ToString(), StringComparison.Ordinal) &&
            origin.Port == port &&
            origin.AbsolutePath == "/" &&
            string.IsNullOrEmpty(origin.Query) &&
            string.IsNullOrEmpty(origin.Fragment) &&
            string.IsNullOrEmpty(origin.UserInfo);
    }

    private static Task RejectTooLargeAsync(HttpContext context) => RejectAsync(
        context,
        StatusCodes.Status413PayloadTooLarge,
        "NENDO_REQUEST_TOO_LARGE",
        $"Agent requests are limited to {MaximumRequestBodyBytes} bytes.");

    private static async Task RejectAsync(
        HttpContext context,
        int status,
        string code,
        string message)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsJsonAsync(new { error = code, message });
    }

    private sealed class RequestBodyTooLargeException : IOException;

    private sealed class SizeLimitedReadStream(Stream inner, long maximumBytes) : Stream
    {
        private long _bytesRead;

        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => _bytesRead;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, Limit(count));
            Count(read);
            return read;
        }

        public override int Read(Span<byte> buffer)
        {
            var read = inner.Read(buffer[..Limit(buffer.Length)]);
            Count(read);
            return read;
        }

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer[..Limit(buffer.Length)], cancellationToken);
            Count(read);
            return read;
        }

        public override async Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            CancellationToken cancellationToken)
        {
            var read = await inner.ReadAsync(buffer.AsMemory(offset, Limit(count)), cancellationToken);
            Count(read);
            return read;
        }

        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Limit(int requested)
        {
            var remainingThroughFailureByte = maximumBytes - _bytesRead + 1;
            if (remainingThroughFailureByte <= 0)
            {
                throw new RequestBodyTooLargeException();
            }
            return (int)Math.Min(requested, remainingThroughFailureByte);
        }

        private void Count(int read)
        {
            _bytesRead += read;
            if (_bytesRead > maximumBytes)
            {
                throw new RequestBodyTooLargeException();
            }
        }
    }
}
