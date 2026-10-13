using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal sealed class NendoMcpSecurityMiddleware(RequestDelegate next)
{
    internal static readonly long MaximumRequestBodyBytes = NendoAuthoringLimits.Current.RequestBodyBytes;

    /// <summary>
    /// How much of an oversized body is read to find the JSON-RPC id it should be answered under.
    /// A client may write the id after the arguments, so the scan reads to the end; past this it
    /// stops, and the body is refused as a plain HTTP 413.
    /// </summary>
    internal const long EnvelopeScanBytes = 16L * 1024 * 1024;
    // 32 leaves eighteen levels over the deepest published example; 16 left two, so an
    // automatic action one level richer than the examples was refused (F-182).
    internal const int MaximumJsonDepth = 32;

    public async Task InvokeAsync(HttpContext context, NendoHostAuthority authority, NendoRequestGate gate)
    {
        // Every request passes the perimeter, whatever its path. Routing matches /mcp without
        // regard to case, so a path test here once let /MCP past every check below (MHS-01).

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
        // Counted before the body is read: a request still sending its body holds a place,
        // which is what stops a client from opening requests without ever finishing them. One
        // past the bound waits for a place before it is refused (NendoRequestGate).
        bool admitted;
        try
        {
            admitted = await gate.EnterAsync(context.RequestAborted);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            return;
        }
        if (!admitted)
        {
            context.Response.Headers.RetryAfter = "1";
            await RejectAsync(
                context,
                StatusCodes.Status429TooManyRequests,
                "NENDO_BUSY",
                $"{gate.Maximum} requests to this file were in progress for {(int)gate.QueueWait.TotalSeconds} seconds, the most " +
                "this host serves at once, and this one waited for a place that did not come. Retry when one of them has answered.");
            return;
        }
        var aborted = context.RequestAborted;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        // Every request, its body included, runs under the timeout. A subscriptions/listen stream
        // is held open on purpose, for as long as its client listens (W-151), so the timeout is
        // lifted once the body has been read and its own method is subscriptions/listen. The
        // client's Mcp-Method header used to decide it before any body was read, so a tools/call
        // carrying that header ran without the bound (MHS-09).
        timeout.CancelAfter(gate.Timeout);
        context.RequestAborted = timeout.Token;
        try
        {
            // An oversized body is scanned for its id here, holding a place and under the timeout:
            // the scan used to run before the gate, so neither bounded it (MHS-08).
            if (context.Request.ContentLength > MaximumRequestBodyBytes)
            {
                var envelope = context.Request.ContentLength <= EnvelopeScanBytes
                    ? await new EnvelopeScanner().ScanAsync(context.Request.Body, 0, context.RequestAborted)
                    : default;
                await RejectTooLargeAsync(context, envelope, context.Request.ContentLength);
            }
            else
            {
                await AdmitAsync(context, authority, () => timeout.CancelAfter(Timeout.InfiniteTimeSpan));
            }
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

    private async Task AdmitAsync(HttpContext context, NendoHostAuthority authority, Action holdOpen)
    {
        var originalBody = context.Request.Body;
        await using var buffered = new MemoryStream(
            context.Request.ContentLength is > 0
                ? (int)context.Request.ContentLength.Value
                : 0);
        try
        {
            var chunk = new byte[16 * 1024];
            var total = 0L;
            while (await originalBody.ReadAsync(chunk, context.RequestAborted) is var read and > 0)
            {
                total += read;
                if (total > MaximumRequestBodyBytes)
                {
                    var scanner = new EnvelopeScanner();
                    scanner.Feed(buffered.GetBuffer().AsSpan(0, (int)buffered.Length));
                    scanner.Feed(chunk.AsSpan(0, read));
                    await RejectTooLargeAsync(context, await scanner.ScanAsync(originalBody, total, context.RequestAborted), null);
                    return;
                }
                buffered.Write(chunk, 0, read);
            }

            if (buffered.Length > 0)
            {
                buffered.Position = 0;
                try
                {
                    using var parsed = await JsonDocument.ParseAsync(
                        buffered,
                        new JsonDocumentOptions { MaxDepth = MaximumJsonDepth },
                        context.RequestAborted);
                    if (IsListen(parsed.RootElement)) holdOpen();
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
                    NendoHostAuthority.ClosedMessage);
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

    /// <summary>Whether the body is a subscriptions/listen request, by its own JSON-RPC method.</summary>
    internal static bool IsListen(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object &&
        body.TryGetProperty("method", out var method) &&
        method.ValueKind == JsonValueKind.String &&
        method.ValueEquals("subscriptions/listen");

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

    /// <summary>
    /// Refuses a body over the cap. A plain HTTP 413 reaches an MCP client as a transport failure,
    /// so a request whose JSON-RPC id can be read from the head of the body is answered under that
    /// id instead (W-165): a tool call as a refused tool result with the code in <c>_meta</c>, as
    /// every other refusal, and anything else as a JSON-RPC error carrying the code.
    /// </summary>
    private static Task RejectTooLargeAsync(HttpContext context, Envelope envelope, long? length)
    {
        var message = (length is { } bytes ? $"This request body is {bytes} bytes, and " : "This request body is larger than ") +
            $"this host reads at most {MaximumRequestBodyBytes} (limits.requestBodyBytes). Send fewer writes per call; a write's " +
            "values are bounded by limits.recordValueBytes per value and limits.recordValuesBytes per write.";
        if (envelope.Id is null) return RejectAsync(context, StatusCodes.Status413PayloadTooLarge, "NENDO_REQUEST_TOO_LARGE", message);
        const string code = "NENDO_REQUEST_TOO_LARGE";
        var response = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = envelope.Id };
        if (envelope.Method == "tools/call")
        {
            response["result"] = new JsonObject
            {
                ["content"] = new JsonArray(new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = $"An error occurred invoking '{envelope.ToolName ?? "the tool"}': {code}: {message}",
                }),
                ["isError"] = true,
                ["_meta"] = new JsonObject
                {
                    [NendoToolRefusal.MetaKey] = JsonSerializer.SerializeToNode(new NendoToolRefusal(code, message), NendoMcpJson.Options),
                },
            };
        }
        else
        {
            response["error"] = new JsonObject
            {
                ["code"] = -32600,
                ["message"] = $"{code}: {message}",
                ["data"] = JsonSerializer.SerializeToNode(new NendoToolRefusal(code, message), NendoMcpJson.Options),
            };
        }
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync(response.ToJsonString(), Encoding.UTF8);
    }

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

    /// <summary>The id, method and tool name of a JSON-RPC request; any is null when the body did not carry it.</summary>
    internal readonly record struct Envelope(JsonNode? Id, string? Method, string? ToolName);

    /// <summary>
    /// Reads a JSON-RPC request's id, method and tool name from a body fed in pieces, without
    /// keeping the body: only a token cut by a piece's end is carried to the next.
    /// <para>
    /// A string longer than <see cref="CarryBytes"/> is not carried: its bytes are skipped up to
    /// the closing quote, and the reader is handed an empty string in its place. A 15 MiB value
    /// ahead of the id was copied and parsed again from its start on every 16 KiB piece, which
    /// cost time quadratic in its length (MHS-08). A token of any other kind that long is no
    /// envelope this scan can read, and the scan gives up.
    /// </para>
    /// </summary>
    internal sealed class EnvelopeScanner
    {
        internal const int CarryBytes = 4 * 1024;
        private JsonReaderState _state = new(new JsonReaderOptions { MaxDepth = MaximumJsonDepth });
        private byte[] _carry = [];
        // Inside a long string being skipped: the separators before it, and whether the last byte was a backslash.
        private byte[]? _skipping;
        private bool _escaped;
        private bool _ignoreNext;
        private string? _property;
        private bool _inParams;
        private bool _failed;
        private JsonNode? _id;
        private string? _method;
        private string? _tool;

        internal Envelope Result => new(_id, _method, _tool);

        private bool Done => _failed || (_id is not null && _method is not null && (_method != "tools/call" || _tool is not null));

        /// <summary>Feeds the rest of <paramref name="body"/> until the envelope is known, the body ends or the scan cap is reached.</summary>
        internal async Task<Envelope> ScanAsync(Stream body, long alreadyRead, CancellationToken cancellationToken)
        {
            var chunk = new byte[16 * 1024];
            var total = alreadyRead;
            try
            {
                while (!Done && total < EnvelopeScanBytes &&
                    await body.ReadAsync(chunk, cancellationToken) is var read and > 0)
                {
                    total += read;
                    Feed(chunk.AsSpan(0, read));
                }
            }
            catch (IOException)
            {
            }
            return Result;
        }

        internal void Feed(ReadOnlySpan<byte> piece)
        {
            if (Done) return;
            if (_skipping is { } before)
            {
                if (ClosingQuote(piece) is not { } end) return;
                // The string ends here: the reader sees an empty one in its place, then the rest.
                _skipping = null;
                _ignoreNext = true;
                byte[] resumed = [.. before, (byte)'"', (byte)'"', .. piece[(end + 1)..]];
                piece = resumed;
            }
            var buffer = _carry.Length == 0 ? piece.ToArray() : [.. _carry, .. piece];
            var reader = new Utf8JsonReader(buffer, isFinalBlock: false, _state);
            try
            {
                while (!Done && reader.Read()) Take(ref reader);
            }
            catch (JsonException)
            {
                _failed = true;
                return;
            }
            _state = reader.CurrentState;
            _carry = buffer[(int)reader.BytesConsumed..];
            if (_carry.Length > CarryBytes && !Done) Skip();
        }

        /// <summary>
        /// The carried token is long. A string begins with a quote after any separators: from there
        /// its bytes are skipped. Anything else is not an envelope worth reading.
        /// </summary>
        private void Skip()
        {
            var start = 0;
            while (start < _carry.Length && _carry[start] is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n' or (byte)',' or (byte)':')
                start++;
            if (start >= _carry.Length || _carry[start] != (byte)'"')
            {
                _failed = true;
                return;
            }
            var before = _carry[..start];
            var rest = _carry.AsSpan(start + 1);
            _escaped = false;
            _carry = [];
            // The carry holds no closing quote, or the reader would have read the string whole.
            _skipping = before;
            if (ClosingQuote(rest) is { } end)
            {
                _skipping = null;
                _ignoreNext = true;
                _carry = [.. before, (byte)'"', (byte)'"', .. rest[(end + 1)..]];
            }
        }

        /// <summary>Where the skipped string's closing quote is in this piece, or null; keeps the escape state across pieces.</summary>
        private int? ClosingQuote(ReadOnlySpan<byte> piece)
        {
            for (var index = 0; index < piece.Length; index++)
            {
                if (_escaped) _escaped = false;
                else if (piece[index] == (byte)'\\') _escaped = true;
                else if (piece[index] == (byte)'"') return index;
            }
            return null;
        }

        private void Take(ref Utf8JsonReader reader)
        {
            if (_ignoreNext && reader.TokenType is JsonTokenType.PropertyName or JsonTokenType.String)
            {
                // The empty string that stands for a skipped one names nothing and is no value.
                _ignoreNext = false;
                _property = null;
                return;
            }
            if (reader.TokenType == JsonTokenType.PropertyName)
            {
                _property = reader.GetString();
                return;
            }
            if (reader.CurrentDepth == 1)
            {
                switch (_property)
                {
                    case "id" when reader.TokenType == JsonTokenType.Number:
                        _id = reader.TryGetInt64(out var number) ? JsonValue.Create(number) : JsonValue.Create(reader.GetDouble());
                        break;
                    case "id" when reader.TokenType == JsonTokenType.String:
                        _id = JsonValue.Create(reader.GetString());
                        break;
                    case "method" when reader.TokenType == JsonTokenType.String:
                        _method = reader.GetString();
                        break;
                    case "params" when reader.TokenType == JsonTokenType.StartObject:
                        _inParams = true;
                        break;
                }
                if (reader.TokenType == JsonTokenType.EndObject) _inParams = false;
            }
            else if (reader.CurrentDepth == 2 && _inParams && _property == "name" && reader.TokenType == JsonTokenType.String)
            {
                _tool = reader.GetString();
            }
            _property = null;
        }
    }
}
