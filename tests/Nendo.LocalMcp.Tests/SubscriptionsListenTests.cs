using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Channels;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-151: a 2026-07-28 client that opens subscriptions/listen hears that the proposal
/// queue, the manifest and health changed, instead of polling for them. The SDK's client
/// has no listen helper in this version, so the stream is read as the wire carries it.
/// </summary>
[TestClass]
public sealed class SubscriptionsListenTests
{
    [TestMethod]
    public async Task AListeningClientHearsProposalsManifestAndTheClose()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var stream = await ListenStream.OpenAsync(host, 11,
            "nendo://application/proposals", "nendo://application/manifest", "nendo://application/health");
        var acknowledged = await stream.NextAsync("notifications/subscriptions/acknowledged");
        // The acknowledgement carries the listen request's id, as the id itself: a number, here.
        // It carried none, and the later notifications carried the id as text, so GitHub Copilot
        // CLI, which matches the acknowledgement to its request, timed out and dropped the server
        // (2026-10-08; specification 2026-07-28, basic/patterns/subscriptions, Acknowledgment).
        AssertSubscriptionId(acknowledged, "The acknowledgement");
        CollectionAssert.AreEqual(
            new[] { "nendo://application/manifest", "nendo://application/proposals", "nendo://application/health" },
            acknowledged.GetProperty("params").GetProperty("notifications").GetProperty("resourceSubscriptions").EnumerateArray().Select(value => value.GetString()).ToArray());
        Assert.AreEqual(1, host.ListenerCount);

        // Another client validates: the queue changed.
        await using var author = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(author, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        var begun = await CallAsync<NendoChangeSetBeginResult>(author, "nendo.change_set.begin", new(session) { ["title"] = "Notes", ["idempotencyKey"] = "begin" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(author, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create Notes",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId = "notes", fieldId = "label", displayName = "Label", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = "add",
        });
        await CallAsync<NendoAgentProposalPreview>(author, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "validate" });
        var queued = await stream.NextUpdateAsync("nendo://application/proposals");
        AssertSubscriptionId(queued, "A streamed notification");

        // The person accepts in Nendo: the manifest moved.
        var promotion = await workspace.Service.PromoteProposalAsync(host.GetPendingProposals().Single().ProposalId);
        Assert.IsTrue(promotion.Applied, promotion.Message);
        await stream.NextUpdateAsync("nendo://application/manifest");

        // The file closes: health, then the stream ends.
        await host.DisposeAsync();
        await stream.NextUpdateAsync("nendo://application/health");
        Assert.IsTrue(await stream.EndedAsync(), "The stream did not end after the host closed.");
    }

    /// <summary>
    /// A listen that asks for every list change discover advertises is granted each of them.
    /// Discover says tools and resources may change, and GitHub Copilot CLI asks for both and
    /// refuses a server whose acknowledgement leaves an advertised one out: "MCP server did not
    /// accept its advertised list-change subscriptions" (2026-10-08).
    /// </summary>
    [TestMethod]
    public async Task EveryListChangeDiscoverAdvertisesIsGrantedWhenAskedFor()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = LatestProtocolTests.Client(host);
        var capabilities = (await LatestProtocolTests.Send(http, "server/discover", new())).GetProperty("result").GetProperty("capabilities");
        var advertised = new[] { ("tools", "toolsListChanged"), ("resources", "resourcesListChanged"), ("prompts", "promptsListChanged") }
            .Where(pair => capabilities.TryGetProperty(pair.Item1, out var capability) &&
                capability.TryGetProperty("listChanged", out var listChanged) && listChanged.ValueKind == JsonValueKind.True)
            .Select(pair => pair.Item2)
            .ToArray();
        CollectionAssert.IsSubsetOf(new[] { "toolsListChanged", "resourcesListChanged" }, advertised,
            "Discover no longer advertises the list changes this test was written for; check what a client now asks.");

        await using var stream = await ListenStream.OpenAsync(host, 11);
        var acknowledged = await stream.NextAsync("notifications/subscriptions/acknowledged");
        AssertSubscriptionId(acknowledged, "The acknowledgement");
        var granted = acknowledged.GetProperty("params").GetProperty("notifications");
        foreach (var name in advertised)
        {
            Assert.IsTrue(granted.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True,
                $"Discover advertises {name} and the acknowledgement does not grant it: {granted}");
        }
    }

    private static void AssertSubscriptionId(JsonElement notification, string what)
    {
        var id = notification.GetProperty("params").TryGetProperty("_meta", out var meta) &&
            meta.TryGetProperty("io.modelcontextprotocol/subscriptionId", out var found) ? found : default;
        Assert.AreNotEqual(JsonValueKind.Undefined, id.ValueKind,
            $"{what} carries no io.modelcontextprotocol/subscriptionId: {notification}");
        Assert.AreEqual(JsonValueKind.Number, id.ValueKind, $"{what} carries the request id 11 as {id.ValueKind}: {id}");
        Assert.AreEqual(11L, id.GetInt64());
    }

    [TestMethod]
    public async Task AListenForAResourceTheHostDoesNotPushIsAcknowledgedWithoutItAndStreamsAreCapped()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        await using var first = await ListenStream.OpenAsync(host, 7, "nendo://application/proposals", "nendo://application/entities");
        var acknowledged = await first.NextAsync("notifications/subscriptions/acknowledged");
        var honoured = acknowledged.GetProperty("params").GetProperty("notifications");
        CollectionAssert.AreEqual(new[] { "nendo://application/proposals" }, honoured.GetProperty("resourceSubscriptions").EnumerateArray().Select(value => value.GetString()).ToArray());
        // Granted since 2026-10-08, as discover advertises it: a level change restarts the listener,
        // so the list never changes under a stream and no notification is ever due on it.
        Assert.IsTrue(honoured.TryGetProperty("toolsListChanged", out var tools) && tools.GetBoolean(), "toolsListChanged is advertised and not granted.");
        Assert.AreEqual(1, host.ListenerCount);

        // The cap: the fifth stream is refused by name, and the four stay open.
        var more = new List<ListenStream>();
        try
        {
            for (var index = 0; index < NendoChangeFeed.MaximumListeners - 1; index++)
            {
                var stream = await ListenStream.OpenAsync(host, 20 + index, "nendo://application/manifest");
                more.Add(stream);
                await stream.NextAsync("notifications/subscriptions/acknowledged");
            }
            Assert.AreEqual(NendoChangeFeed.MaximumListeners, host.ListenerCount);
            await using var extra = await ListenStream.OpenAsync(host, 99, "nendo://application/manifest");
            var refused = await extra.NextAsync(null);
            StringAssert.Contains(refused.GetProperty("error").GetProperty("message").GetString(), "NENDO_BUSY", StringComparison.Ordinal);
            StringAssert.Contains(refused.GetProperty("error").GetProperty("message").GetString(), "subscriptions/listen streams are already open", StringComparison.Ordinal);
            Assert.AreEqual(NendoChangeFeed.MaximumListeners, host.ListenerCount);
        }
        finally
        {
            foreach (var stream in more) await stream.DisposeAsync();
        }
    }

    /// <summary>
    /// W-171: a client waiting on a record type hears when a commit changes one of its records,
    /// and which, and not when a commit changes another type's. An outside author polled every
    /// two seconds for the requests a screen's buttons file.
    /// </summary>
    [TestMethod]
    public async Task AListeningClientHearsWhichRecordsOfATypeChanged()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes and tasks", "test",
            new([new("test", "schema", "test", "Notes and tasks", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "notes.label", "Label", "label", NendoStorageKind.Text, false),
                new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
                new AddFieldOperation("t-label", "tasks", "tasks.label", "Label", "label", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var stream = await ListenStream.OpenAsync(host, 31,
            "nendo://application/entity/notes/records", "nendo://application/entity/{entityId}/records");
        var acknowledged = await stream.NextAsync("notifications/subscriptions/acknowledged");
        CollectionAssert.AreEqual(new[] { "nendo://application/entity/notes/records" },
            acknowledged.GetProperty("params").GetProperty("notifications").GetProperty("resourceSubscriptions").EnumerateArray().Select(value => value.GetString()).ToArray(),
            "A record type is named, not templated.");

        async Task WriteAsync(string entityId, string recordId) =>
            await workspace.Service.CreateRecordAsync(new(entityId, recordId,
                new Dictionary<string, object?> { [$"{entityId}.label"] = recordId }, new("test", $"create-{recordId}", "test")));
        await WriteAsync("notes", "n1");
        AssertNamed(await stream.NextUpdateAsync("nendo://application/entity/notes/records"), "n1");
        // A task changes: nothing is said about notes, so the next notes update is n2's.
        await WriteAsync("tasks", "t1");
        await WriteAsync("notes", "n2");
        AssertNamed(await stream.NextUpdateAsync("nendo://application/entity/notes/records"), "n2");

        static void AssertNamed(JsonElement update, string recordId)
        {
            var changes = update.GetProperty("params").GetProperty("_meta").GetProperty("io.github.thomasrohde.nendo/changes");
            Assert.AreEqual("notes", changes.GetProperty("entityId").GetString());
            CollectionAssert.AreEqual(new[] { recordId }, changes.GetProperty("recordIds").EnumerateArray().Select(value => value.GetString()).ToArray(), update.ToString());
            Assert.IsFalse(changes.GetProperty("definitionChanged").GetBoolean());
            Assert.AreEqual(1, changes.GetProperty("revisionIds").GetArrayLength());
        }
    }

    /// <summary>One subscriptions/listen request, read line by line as the server streams it.</summary>
    private sealed class ListenStream : IAsyncDisposable
    {
        private readonly HttpClient _http;
        private readonly HttpResponseMessage _response;
        private readonly Channel<JsonElement> _messages = Channel.CreateUnbounded<JsonElement>();
        private readonly Task _pump;

        private ListenStream(HttpClient http, HttpResponseMessage response, Stream body)
        {
            _http = http;
            _response = response;
            _pump = Task.Run(async () =>
            {
                using var reader = new StreamReader(body);
                try
                {
                    while (await reader.ReadLineAsync() is { } line)
                    {
                        if (line.StartsWith("data:", StringComparison.Ordinal))
                            _messages.Writer.TryWrite(JsonDocument.Parse(line[5..].Trim()).RootElement.Clone());
                    }
                }
                catch (Exception exception) when (exception is IOException or ObjectDisposedException or HttpRequestException)
                {
                }
                _messages.Writer.TryComplete();
            });
        }

        internal static async Task<ListenStream> OpenAsync(NendoLocalMcpHost host, int id, params string[] uris)
        {
            var http = LatestProtocolTests.Client(host);
            http.Timeout = Timeout.InfiniteTimeSpan;
            var request = new HttpRequestMessage(HttpMethod.Post, http.BaseAddress);
            request.Headers.Add("MCP-Protocol-Version", "2026-07-28");
            request.Headers.Add("Mcp-Method", "subscriptions/listen");
            request.Content = JsonContent.Create(new
            {
                jsonrpc = "2.0", id, method = "subscriptions/listen",
                @params = new Dictionary<string, object?>
                {
                    // What GitHub Copilot CLI asks for: both list changes discover advertises.
                    ["notifications"] = new { toolsListChanged = true, resourcesListChanged = true, resourceSubscriptions = uris },
                    ["_meta"] = new Dictionary<string, object?>
                    {
                        ["io.modelcontextprotocol/protocolVersion"] = "2026-07-28",
                        ["io.modelcontextprotocol/clientCapabilities"] = new { },
                        ["io.modelcontextprotocol/clientInfo"] = new { name = "listen-probe", version = "1" },
                    },
                },
            });
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            var body = await response.Content.ReadAsStreamAsync();
            return new ListenStream(http, response, body);
        }

        /// <summary>The next message with this method, or any message when method is null.</summary>
        internal async Task<JsonElement> NextAsync(string? method)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                while (await _messages.Reader.WaitToReadAsync(timeout.Token))
                {
                    while (_messages.Reader.TryRead(out var message))
                    {
                        if (method is null || (message.TryGetProperty("method", out var name) && name.GetString() == method)) return message;
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            throw new AssertFailedException($"No {method ?? "message"} arrived on the listen stream within ten seconds.");
        }

        internal async Task<JsonElement> NextUpdateAsync(string uri)
        {
            while (true)
            {
                var message = await NextAsync("notifications/resources/updated");
                if (message.GetProperty("params").GetProperty("uri").GetString() == uri) return message;
            }
        }

        internal async Task<bool> EndedAsync()
        {
            var finished = await Task.WhenAny(_pump, Task.Delay(TimeSpan.FromSeconds(10)));
            return finished == _pump;
        }

        public async ValueTask DisposeAsync()
        {
            _response.Dispose();
            _http.Dispose();
            try { await _pump.WaitAsync(TimeSpan.FromSeconds(5)); } catch (TimeoutException) { }
        }
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
