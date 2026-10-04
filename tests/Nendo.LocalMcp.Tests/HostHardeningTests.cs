using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-086. Found in the 2026-09-27 review, none yet seen to fail: a depth cap two levels over
/// the deepest published example, replay caches kept for the life of a lease that never
/// expires, a proposal notification able to fail the validate that raised it, and nothing
/// bounding how many requests run at once or for how long.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class HostHardeningTests
{
    private const int Headroom = 8;

    /// <summary>
    /// Every published example, sent the way a client sends it, leaves room under the depth
    /// cap for an action a few levels richer. With the cap at 16 the deepest example sat two
    /// levels under it.
    /// </summary>
    [TestMethod]
    public void ThePublishedExamplesLeaveRoomUnderTheDepthCap()
    {
        var deepest = 0;
        var deepestName = string.Empty;
        foreach (var example in NendoAuthoringExamples.Description().Examples)
        {
            foreach (var mutation in example.Mutations)
            {
                var request = JsonSerializer.SerializeToUtf8Bytes(new
                {
                    jsonrpc = "2.0",
                    id = 1,
                    method = "tools/call",
                    @params = new
                    {
                        name = "nendo.change_set.add_operations",
                        arguments = new Dictionary<string, object?>
                        {
                            ["applicationHandle"] = new string('a', 64),
                            ["leaseId"] = new string('b', 64),
                            ["changeSetId"] = "change-set-0123456789abcdef0123456789abcdef",
                            ["idempotencyKey"] = "depth",
                            ["mutations"] = new[]
                            {
                                new NendoAgentMutationInput(
                                    mutation.Description,
                                    [.. mutation.Operations.Select(operation => new NendoAgentOperationInput(operation.OperationType, operation.Payload))]),
                            },
                        },
                    },
                }, NendoMcpJson.Options);
                using var body = new MemoryStream(request, 0, request.Length, writable: false, publiclyVisible: true);
                var depth = NendoMcpSecurityMiddleware.MeasureDepth(body)!.Value;
                if (depth > deepest) (deepest, deepestName) = (depth, example.Name);
            }
        }
        Assert.IsGreaterThan(10, deepest, "The measurement reached into the payloads.");
        Assert.IsLessThanOrEqualTo(NendoMcpSecurityMiddleware.MaximumJsonDepth - Headroom, deepest,
            $"{deepestName} nests {deepest} levels, within {Headroom} of the {NendoMcpSecurityMiddleware.MaximumJsonDepth}-level cap.");
    }

    [TestMethod]
    public void AReplayCacheKeepsTheNewestAndEveryReplayTheServiceKeepsIsOne()
    {
        var cache = new NendoReplayCache<int, string>();
        for (var index = 0; index < NendoReplayCache.Capacity + 44; index++) cache.Add(index, $"result {index}");
        Assert.AreEqual(NendoReplayCache.Capacity, cache.Count);
        Assert.IsFalse(cache.TryGetValue(43, out _), "The oldest fell away.");
        Assert.IsTrue(cache.TryGetValue(44, out var oldestKept));
        Assert.AreEqual("result 44", oldestKept);
        Assert.IsTrue(cache.TryGetValue(NendoReplayCache.Capacity + 43, out _), "The newest is kept.");

        // Every remembered result the authoring service holds, on itself or on a draft, is a
        // bounded cache: a plain dictionary of replays added later fails here.
        var holders = new[] { typeof(NendoAgentAuthoringService) }
            .Concat(typeof(NendoAgentAuthoringService).GetNestedTypes(BindingFlags.NonPublic));
        var unbounded = new List<string>();
        var bounded = 0;
        foreach (var holder in holders)
        {
            // Fields only: an auto-property is counted once, through its backing field.
            var members = holder.GetFields(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)
                .Select(field => (field.Name, field.FieldType));
            foreach (var (name, type) in members)
            {
                if (!type.IsGenericType || !type.GetGenericArguments().Any(IsReplay)) continue;
                if (type.GetGenericTypeDefinition() == typeof(NendoReplayCache<,>)) bounded++;
                else unbounded.Add($"{holder.Name}.{name}: {type.Name}");
            }
        }
        Assert.IsEmpty(unbounded, "Replays kept without a bound: " + string.Join(", ", unbounded));
        Assert.AreEqual(6, bounded, "Begin, add and amend, validate, revalidate, reject and accept each keep bounded replays.");
    }

    private static bool IsReplay(Type type) =>
        type.IsGenericType && type.GetGenericTypeDefinition().Name.StartsWith("Replay", StringComparison.Ordinal);

    [TestMethod]
    public async Task AThrowingProposalHandlerCannotFailTheValidateThatRaisedIt()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var store = new NendoAgentProposalStore();
        var raised = 0;
        store.ProposalAdded += _ =>
        {
            raised++;
            throw new InvalidOperationException("A window that could not be told.");
        };
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            store);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        var session = new Dictionary<string, object?> { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        var begun = (await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session)
        {
            ["title"] = "Notes",
            ["idempotencyKey"] = "begin-notes",
        })).StructuredContent!.Value.Deserialize<NendoChangeSetBeginResult>(NendoMcpJson.Options)!;
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        Assert.AreNotEqual(true, (await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create Notes",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" })),
                ]),
            },
            ["idempotencyKey"] = "add-notes",
        })).IsError);

        var validated = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped)
        {
            ["idempotencyKey"] = "validate-notes",
        });
        Assert.AreNotEqual(true, validated.IsError, "The handler's failure reached the agent: " + JsonSerializer.Serialize(validated));
        Assert.AreEqual(1, raised, "The handler was told.");
        Assert.HasCount(1, host.GetPendingProposals());
    }

    [TestMethod]
    public async Task TheRequestPastTheBoundIsRefusedByNameWhileTheOthersComplete()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        var held = new List<PartialRequest>();
        try
        {
            for (var index = 0; index < NendoRequestGate.DefaultMaximum; index++)
            {
                held.Add(await PartialRequest.OpenAsync(host.Endpoint, Initialize($"held-{index}")));
            }
            await WaitUntilAsync(() => host.InFlightRequests == NendoRequestGate.DefaultMaximum, "the held requests to arrive");

            using var http = LatestProtocolTests.Client(host);
            using var refused = await http.PostAsync(http.BaseAddress, new ByteArrayContent(Initialize("one-too-many"))
            {
                Headers = { ContentType = new("application/json") },
            });
            Assert.AreEqual(HttpStatusCode.TooManyRequests, refused.StatusCode);
            using var answer = JsonDocument.Parse(await refused.Content.ReadAsStringAsync());
            Assert.AreEqual("NENDO_BUSY", answer.RootElement.GetProperty("error").GetString());
            StringAssert.Contains(answer.RootElement.GetProperty("message").GetString(),
                $"{NendoRequestGate.DefaultMaximum} requests to this file are already in progress");
            Assert.IsNotNull(refused.Headers.RetryAfter, "The refusal says when to retry.");

            foreach (var request in held)
            {
                Assert.AreEqual(200, await request.FinishAsync(), "A held request did not complete once its body arrived.");
            }
            await WaitUntilAsync(() => host.InFlightRequests == 0, "every place to be given back");
            await using var client = await ProtocolResourceTests.ConnectAsync(host);
            await client.ListResourcesAsync();
        }
        finally
        {
            foreach (var request in held) request.Dispose();
        }
    }

    [TestMethod]
    public async Task ARequestThatOutlivesTheTimeoutIsStoppedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot) { RequestTimeout = TimeSpan.FromMilliseconds(400) });
        using var stalled = await PartialRequest.OpenAsync(host.Endpoint, Initialize("never-finishes"));
        var (status, body) = await stalled.ReadResponseAsync();
        Assert.AreEqual(503, status, body);
        StringAssert.Contains(body, "NENDO_REQUEST_TIMEOUT");
        StringAssert.Contains(body, "nendo.data.get_receipt");
        await WaitUntilAsync(() => host.InFlightRequests == 0, "the stalled request to give its place back");
    }

    private static byte[] Initialize(string client) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        jsonrpc = "2.0",
        id = 1,
        method = "initialize",
        @params = new
        {
            protocolVersion = "2025-06-18",
            capabilities = new { },
            clientInfo = new { name = client, version = "1" },
        },
    });

    private static async Task WaitUntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) Assert.Fail($"Timed out waiting for {what}.");
            await Task.Delay(20);
        }
    }

    /// <summary>A request whose headers and half its body are sent, and the rest held back.</summary>
    private sealed class PartialRequest : IDisposable
    {
        private readonly TcpClient _client;
        private readonly NetworkStream _stream;
        private readonly byte[] _rest;

        private PartialRequest(TcpClient client, byte[] rest)
        {
            _client = client;
            _stream = client.GetStream();
            _rest = rest;
        }

        internal static async Task<PartialRequest> OpenAsync(Uri endpoint, byte[] body)
        {
            var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, endpoint.Port);
            var request = new PartialRequest(client, body[(body.Length / 2)..]);
            var head = $"POST {endpoint.AbsolutePath} HTTP/1.1\r\nHost: 127.0.0.1:{endpoint.Port}\r\n" +
                "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n" +
                $"Mcp-Method: initialize\r\nContent-Length: {body.Length}\r\n\r\n";
            await request._stream.WriteAsync(Encoding.ASCII.GetBytes(head));
            await request._stream.WriteAsync(body.AsMemory(0, body.Length / 2));
            await request._stream.FlushAsync();
            return request;
        }

        internal async Task<int> FinishAsync()
        {
            await _stream.WriteAsync(_rest);
            await _stream.FlushAsync();
            return (await ReadResponseAsync()).Status;
        }

        internal async Task<(int Status, string Body)> ReadResponseAsync()
        {
            var received = new StringBuilder();
            var buffer = new byte[4096];
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (true)
            {
                var read = await _stream.ReadAsync(buffer, timeout.Token);
                if (read == 0) break;
                received.Append(Encoding.UTF8.GetString(buffer, 0, read));
                var text = received.ToString();
                var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (end >= 0 && (text.Contains('}') || !text.Contains("Content-Length", StringComparison.OrdinalIgnoreCase))) break;
            }
            var response = received.ToString();
            var status = int.Parse(response.Split(' ', 3)[1], System.Globalization.CultureInfo.InvariantCulture);
            return (status, response);
        }

        public void Dispose()
        {
            _stream.Dispose();
            _client.Dispose();
        }
    }
}
