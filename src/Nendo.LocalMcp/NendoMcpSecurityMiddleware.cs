using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Http;

namespace Nendo.LocalMcp;

internal sealed class NendoMcpSecurityMiddleware(RequestDelegate next)
{
    internal const long MaximumRequestBodyBytes = 256 * 1024;
    internal const int MaximumJsonDepth = 16;

    public async Task InvokeAsync(HttpContext context, NendoHostAuthority authority)
    {
        if (!context.Request.Path.StartsWithSegments("/mcp", StringComparison.Ordinal))
        {
            await next(context);
            return;
        }

        if (!IPAddress.Loopback.Equals(context.Connection.RemoteIpAddress))
        {
            await RejectAsync(context, StatusCodes.Status403Forbidden, "NENDO_NON_LOOPBACK", "Only this computer may connect.");
            return;
        }
        if (!IsExactHost(context.Request.Host, authority.Port))
        {
            await RejectAsync(context, StatusCodes.Status400BadRequest, "NENDO_INVALID_HOST", "The request host is invalid.");
            return;
        }
        var origin = context.Request.Headers.Origin.ToString();
        if (!string.IsNullOrEmpty(origin) && !IsExactOrigin(origin, authority.Port))
        {
            await RejectAsync(context, StatusCodes.Status403Forbidden, "NENDO_INVALID_ORIGIN", "The request origin is invalid.");
            return;
        }
        if (context.Request.ContentLength > MaximumRequestBodyBytes)
        {
            await RejectTooLargeAsync(context);
            return;
        }

        var originalBody = context.Request.Body;
        await using var buffered = new MemoryStream(
            context.Request.ContentLength is > 0
                ? (int)context.Request.ContentLength.Value
                : 0);
        try
        {
            try
            {
                await new SizeLimitedReadStream(originalBody, MaximumRequestBodyBytes)
                    .CopyToAsync(buffered, context.RequestAborted);
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
                catch (JsonException)
                {
                    await RejectAsync(
                        context,
                        StatusCodes.Status400BadRequest,
                        "NENDO_INVALID_JSON",
                        "The request body is not valid bounded JSON.");
                    return;
                }
            }

            buffered.Position = 0;
            context.Request.Body = buffered;
            // A body may have arrived slowly while the host was closing. Passing the
            // perimeter earlier is not admission after a lifecycle boundary.
            if (!authority.IsActive)
            {
                await RejectAsync(context, StatusCodes.Status401Unauthorized, "NENDO_HOST_CLOSED", "This agent endpoint is closed.");
                return;
            }
            await next(context);
        }
        finally
        {
            context.Request.Body = originalBody;
        }
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
            var read = await inner.ReadAsync(buffer, offset, Limit(count), cancellationToken);
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
