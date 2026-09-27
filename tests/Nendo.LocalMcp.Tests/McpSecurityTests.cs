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
    /// F-175: "The request host is invalid" left a client configured with localhost with
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
