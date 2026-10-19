using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http;

namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class McpSecurityTests
{
    private const int Port = 43127;

    [TestMethod]
    public void HostAndOriginMustMatchTheExactIpv4LoopbackEndpoint()
    {
        Assert.IsTrue(NendoMcpSecurityMiddleware.IsExactHost(new HostString("127.0.0.1", Port), Port));
        Assert.IsFalse(NendoMcpSecurityMiddleware.IsExactHost(new HostString("localhost", Port), Port));
        Assert.IsFalse(NendoMcpSecurityMiddleware.IsExactHost(new HostString("127.0.0.1", Port + 1), Port));
        Assert.IsTrue(NendoMcpSecurityMiddleware.IsExactOrigin($"http://127.0.0.1:{Port}", Port));
        Assert.IsFalse(NendoMcpSecurityMiddleware.IsExactOrigin($"http://localhost:{Port}", Port));
        Assert.IsFalse(NendoMcpSecurityMiddleware.IsExactOrigin($"http://127.0.0.1:{Port}/other", Port));
    }

    [TestMethod]
    public async Task PerimeterRejectsRemoteAndInvalidOriginBeforeDispatch()
    {
        await AssertRejectedAsync(
            configure: context => context.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.1"),
            expectedStatus: StatusCodes.Status403Forbidden,
            expectedCode: "NENDO_NON_LOOPBACK");
        await AssertRejectedAsync(
            configure: context => context.Request.Headers.Origin = "https://example.test",
            expectedStatus: StatusCodes.Status403Forbidden,
            expectedCode: "NENDO_INVALID_ORIGIN");
    }

    [TestMethod]
    public async Task PerimeterRejectsOversizeAndDeepJsonBeforeDispatch()
    {
        await AssertRejectedAsync(
            configure: context => context.Request.ContentLength = NendoMcpSecurityMiddleware.MaximumRequestBodyBytes + 1,
            expectedStatus: StatusCodes.Status413PayloadTooLarge,
            expectedCode: "NENDO_REQUEST_TOO_LARGE");

        var deepJson = string.Concat(
            Enumerable.Repeat("{\"a\":", NendoMcpSecurityMiddleware.MaximumJsonDepth + 1)) +
            "0" +
            new string('}', NendoMcpSecurityMiddleware.MaximumJsonDepth + 1);
        await AssertRejectedAsync(
            configure: context =>
            {
                context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(deepJson));
                context.Request.ContentLength = context.Request.Body.Length;
            },
            expectedStatus: StatusCodes.Status400BadRequest,
            expectedCode: "NENDO_INVALID_JSON");
    }

    /// <summary>
    /// A body with no Content-Length (chunked) is bounded while it is read, not after.
    /// The header check above never sees it; the count inside the read loop is the only bound,
    /// and no test sent such a body. The stream here is far larger than the cap and says nothing
    /// of its length: it is refused as too large, as its own request's error, never dispatched, and read only as far as the
    /// cap and the envelope scan that finds its id.
    /// </summary>
    [TestMethod]
    public async Task ABodyWithNoDeclaredLengthIsBoundedWhileItIsRead()
    {
        var authority = new NendoHostAuthority("chunked-run", AgentAccessMode.ReadOnly, new byte[32], "application", "instance");
        authority.SetPort(Port);
        var dispatched = false;
        var middleware = new NendoMcpSecurityMiddleware(_ => { dispatched = true; return Task.CompletedTask; });
        var context = NewContext();
        var length = NendoMcpSecurityMiddleware.MaximumRequestBodyBytes + NendoMcpSecurityMiddleware.EnvelopeScanBytes + 4 * 1024 * 1024;
        var body = new UndeclaredBody("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"resources/read\",\"params\":{\"uri\":\"", length);
        context.Request.Body = body;
        Assert.IsNull(context.Request.ContentLength, "The request declares a length, so the header check would refuse it first.");

        await middleware.InvokeAsync(context, authority, Gate());

        Assert.IsFalse(dispatched, "A body over the cap with no declared length was dispatched.");
        context.Response.Body.Position = 0;
        var response = await new StreamReader(context.Response.Body).ReadToEndAsync();
        // The envelope scan found its id, so the refusal is that request's JSON-RPC error.
        StringAssert.Contains(response, "\"id\":7,\"error\"", response);
        StringAssert.Contains(response, "NENDO_REQUEST_TOO_LARGE");
        Assert.IsLessThanOrEqualTo(NendoMcpSecurityMiddleware.MaximumRequestBodyBytes + NendoMcpSecurityMiddleware.EnvelopeScanBytes + 2 * 16 * 1024, body.Served,
            $"The host read {body.Served:N0} bytes of a {length:N0}-byte body it had already refused.");
    }

    /// <summary>A body of a given length, served in 16 KiB reads, that never says how long it is.</summary>
    private sealed class UndeclaredBody(string head, long length) : Stream
    {
        private readonly byte[] _head = Encoding.UTF8.GetBytes(head);

        internal long Served { get; private set; }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => Served; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            var take = (int)Math.Min(Math.Min(count, 16 * 1024), length - Served);
            buffer.AsSpan(offset, take).Fill((byte)'a');
            if (Served < _head.Length)
                _head.AsSpan((int)Served, (int)Math.Min(_head.Length - Served, take)).CopyTo(buffer.AsSpan(offset));
            Served += take;
            return take;
        }

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var array = new byte[Math.Min(buffer.Length, 16 * 1024)];
            var read = Read(array, 0, array.Length);
            array.AsSpan(0, read).CopyTo(buffer.Span);
            return ValueTask.FromResult(read);
        }
    }

    /// <summary>
    /// "The request host is invalid" left a client configured with localhost with
    /// nothing to change, and a body one level too deep read the same as one that was not
    /// JSON. Each perimeter refusal now says what to send instead.
    /// </summary>
    [TestMethod]
    public async Task EachPerimeterRefusalSaysWhatToSendInstead()
    {
        var host = await AssertRejectedAsync(
            configure: context => context.Request.Host = new HostString("localhost", Port),
            expectedStatus: StatusCodes.Status400BadRequest,
            expectedCode: "NENDO_INVALID_HOST");
        StringAssert.Contains(host, $"Send requests to http://127.0.0.1:{Port}/mcp, with exactly that Host header.");
        StringAssert.Contains(host, "localhost and every other name are refused by design");

        var origin = await AssertRejectedAsync(
            configure: context => context.Request.Headers.Origin = "https://example.test",
            expectedStatus: StatusCodes.Status403Forbidden,
            expectedCode: "NENDO_INVALID_ORIGIN");
        StringAssert.Contains(origin, $"must come from http://127.0.0.1:{Port}.");

        var invalid = await AssertRejectedAsync(
            configure: Body("{\"jsonrpc\": \"2.0\", \"id\": 1,"),
            expectedStatus: StatusCodes.Status400BadRequest,
            expectedCode: "NENDO_INVALID_JSON");
        StringAssert.Contains(invalid, "The request body is not valid JSON at line 1");

        var depth = NendoMcpSecurityMiddleware.MaximumJsonDepth + 1;
        var deep = await AssertRejectedAsync(
            configure: Body(string.Concat(Enumerable.Repeat("[", depth)) + new string(']', depth)),
            expectedStatus: StatusCodes.Status400BadRequest,
            expectedCode: "NENDO_INVALID_JSON");
        StringAssert.Contains(deep,
            $"The request body nests {depth} levels deep, and this host reads at most {NendoMcpSecurityMiddleware.MaximumJsonDepth}.");

        // Exactly at the cap is read, not refused.
        var dispatched = false;
        var authority = new NendoHostAuthority("depth-run", AgentAccessMode.ReadOnly, new byte[32], "application", "instance");
        authority.SetPort(Port);
        var middleware = new NendoMcpSecurityMiddleware(_ => { dispatched = true; return Task.CompletedTask; });
        var atCap = NewContext();
        Body(string.Concat(Enumerable.Repeat("[", depth - 1)) + new string(']', depth - 1))(atCap);
        await middleware.InvokeAsync(atCap, authority, Gate());
        Assert.IsTrue(dispatched, "A body exactly at the depth cap was refused.");
    }

    private static Action<DefaultHttpContext> Body(string json) => context =>
    {
        context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(json));
        context.Request.ContentLength = context.Request.Body.Length;
    };

    /// <returns>The refusal's message, as the client reads it.</returns>
    private static async Task<string> AssertRejectedAsync(
        Action<DefaultHttpContext> configure,
        int expectedStatus,
        string expectedCode)
    {
        var dispatched = false;
        var authority = new NendoHostAuthority(
            "test-run",
            AgentAccessMode.ReadOnly,
            new byte[32],
            "application-test",
            "instance-test");
        authority.SetPort(Port);
        var middleware = new NendoMcpSecurityMiddleware(_ =>
        {
            dispatched = true;
            return Task.CompletedTask;
        });
        var context = NewContext();
        configure(context);

        await middleware.InvokeAsync(context, authority, Gate());

        Assert.IsFalse(dispatched);
        Assert.AreEqual(expectedStatus, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        var response = await new StreamReader(context.Response.Body).ReadToEndAsync();
        StringAssert.Contains(response, expectedCode);
        using var document = System.Text.Json.JsonDocument.Parse(response);
        Assert.AreEqual(expectedCode, document.RootElement.GetProperty("error").GetString());
        return document.RootElement.GetProperty("message").GetString()!;
    }

    // No credential means passing the perimeter is the only admission a request has; a closed host must
    // still refuse a body that arrives after the close.
    [TestMethod]
    public async Task RequestAdmittedBeforeShutdownCannotDispatchAfterItsDelayedBodyArrives()
    {
        var authority = new NendoHostAuthority("closing-run", AgentAccessMode.DataMutation,
            new byte[32], "application", "instance");
        authority.SetPort(Port);
        var dispatched = false;
        var middleware = new NendoMcpSecurityMiddleware(_ => { dispatched = true; return Task.CompletedTask; });
        var context = NewContext();
        await using var body = new DelayedBody();
        context.Request.Body = body;
        var request = middleware.InvokeAsync(context, authority, Gate());
        await body.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        authority.CloseAdmission();
        body.Finish.SetResult();
        await request.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsFalse(dispatched);
        Assert.AreEqual(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        context.Response.Body.Position = 0;
        var result = await new StreamReader(context.Response.Body).ReadToEndAsync();
        StringAssert.Contains(result, "NENDO_HOST_CLOSED");
    }

    private sealed class DelayedBody : MemoryStream
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Finish { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal DelayedBody() : base(Encoding.UTF8.GetBytes("{}")) { }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Entered.TrySetResult();
            await Finish.Task.WaitAsync(cancellationToken);
            return await base.ReadAsync(buffer, cancellationToken);
        }
    }

    private static NendoRequestGate Gate() => new(NendoRequestGate.DefaultMaximum, NendoRequestGate.DefaultTimeout);

    private static DefaultHttpContext NewContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        context.Request.Path = "/mcp";
        context.Request.Host = new HostString("127.0.0.1", Port);
        context.Request.Body = new MemoryStream();
        context.Response.Body = new MemoryStream();
        return context;
    }
}
