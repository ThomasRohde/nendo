using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-158: the lanes the review found missing. A two-client race runs in the default set;
/// the soak lane runs behind NENDO_RUN_SOAK=1 and is Inconclusive otherwise, as the
/// installed-client lanes now are; the protocol matrix covers every version the SDK lists.
/// </summary>
[TestClass]
public sealed class EvidenceLaneTests
{
    /// <summary>
    /// Client A validates and releases; client B takes the lease, validates its own and
    /// accepts at Unattended; A's cursor and proposal are stale. A recovers through the
    /// documented path: resume under its handle, read proposals, revalidate, accept.
    /// </summary>
    [TestMethod]
    public async Task TwoClientsThroughAlternatingLeasesRecoverFromEachOthersAcceptance()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var a = await ProtocolResourceTests.ConnectAsync(host);
        await using var b = await ProtocolResourceTests.ConnectAsync(host);

        var grantA = await CallAsync<NendoLeaseGrant>(a, "nendo.lease.acquire", new() { ["idempotencyKey"] = "a-acquire" });
        var sessionA = Session(grantA);
        var pageA = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ProtocolResourceTests.ReadTextAsync(a, $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records?limit=1"));
        var proposalA = await ValidateAsync(a, sessionA, "tasks", "a");
        var held = await b.CallToolAsync("nendo.lease.acquire", new Dictionary<string, object?> { ["idempotencyKey"] = "b-acquire" });
        StringAssert.Contains(Text(held), "NENDO_LEASE_HELD", StringComparison.Ordinal);
        await CallAsync<NendoLeaseRelease>(a, "nendo.lease.release", new(sessionA));

        var grantB = await CallAsync<NendoLeaseGrant>(b, "nendo.lease.acquire", new() { ["idempotencyKey"] = "b-acquire" });
        var sessionB = Session(grantB);
        var proposalB = await ValidateAsync(b, sessionB, "notes", "b");
        var acceptedB = await CallAsync<NendoChangeSetAcceptResult>(b, "nendo.change_set.accept", new(sessionB) { ["changeSetId"] = proposalB.ChangeSetId, ["idempotencyKey"] = "b-accept" });
        Assert.IsTrue(acceptedB.Applied, acceptedB.Message);
        // B cannot touch A's proposal: it is not B's.
        var notYours = await b.CallToolAsync("nendo.change_set.reject", new Dictionary<string, object?>(sessionB) { ["changeSetId"] = proposalA.ChangeSetId, ["idempotencyKey"] = "b-reject-a" });
        StringAssert.Contains(Text(notYours), "NENDO_CHANGE_SET_NOT_FOUND", StringComparison.Ordinal);
        await CallAsync<NendoLeaseRelease>(b, "nendo.lease.release", new(sessionB));

        // A comes back: its cursor is stale, its proposal reads stale, and both recover.
        var resumed = await CallAsync<NendoLeaseGrant>(a, "nendo.lease.acquire", new() { ["resumeApplicationHandle"] = grantA.ApplicationHandle });
        Assert.AreEqual(grantA.Owner, resumed.Owner);
        var sessionA2 = Session(resumed);
        var staleCursor = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(
            a, $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records?cursor={Uri.EscapeDataString(pageA.NextCursor!)}&limit=1"));
        StringAssert.Contains(staleCursor.Message, "NENDO_STALE_CURSOR", StringComparison.Ordinal);
        var listed = ProtocolResourceTests.Deserialize<IReadOnlyList<NendoAgentProposalSummary>>(await ProtocolResourceTests.ReadTextAsync(a, "nendo://application/proposals"));
        var mine = listed.Single(entry => entry.ProposalId == proposalA.ProposalId);
        Assert.AreEqual(NendoProposalState.Stale, mine.State);
        Assert.AreEqual(grantA.Owner, mine.Owner);
        var revalidated = await CallAsync<NendoAgentProposalPreview>(a, "nendo.change_set.revalidate", new(sessionA2) { ["changeSetId"] = proposalA.ChangeSetId, ["idempotencyKey"] = "a-revalidate" });
        Assert.AreEqual(NendoProposalState.Previewable, revalidated.State, JsonSerializer.Serialize(revalidated.Diagnostics, NendoMcpJson.Options));
        var acceptedA = await CallAsync<NendoChangeSetAcceptResult>(a, "nendo.change_set.accept", new(sessionA2) { ["changeSetId"] = proposalA.ChangeSetId, ["idempotencyKey"] = "a-accept" });
        Assert.IsTrue(acceptedA.Applied, acceptedA.Message);
        var entities = (await workspace.Service.GetSnapshotAsync()).Entities.Select(entity => entity.EntityId).ToArray();
        CollectionAssert.IsSubsetOf(new[] { "tasks", "notes" }, entities);
        Assert.IsEmpty(host.GetPendingProposals());
    }

    /// <summary>
    /// Renewals under a short expiry, and the proposal cap filled and emptied twice over.
    /// Opt-in: it takes minutes on purpose, and a gate run that did not run it says so.
    /// </summary>
    [TestMethod]
    public async Task SoakRenewsALeaseAndFillsTheProposalCapTwice()
    {
        if (Environment.GetEnvironmentVariable("NENDO_RUN_SOAK") != "1")
        {
            Assert.Inconclusive("The soak lane runs with NENDO_RUN_SOAK=1; this run did not exercise it.");
        }
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot) { LeaseTtl = TimeSpan.FromSeconds(2) });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = Session(grant);
        for (var renewal = 0; renewal < 30; renewal++)
        {
            await Task.Delay(500);
            var renewed = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.renew", new(session));
            Assert.AreEqual(grant.LeaseId, renewed.LeaseId, $"Renewal {renewal} lost the lease.");
        }
        var limit = NendoAuthoringLimits.Current.ProposalsPerSession;
        for (var round = 0; round < 2; round++)
        {
            var changeSets = new List<string>();
            for (var index = 0; index < limit; index++)
            {
                changeSets.Add((await ValidateAsync(client, session, $"soak{round}x{index:D2}", $"soak-{round}-{index}")).ChangeSetId);
            }
            Assert.HasCount(limit, host.GetPendingProposals());
            foreach (var changeSetId in changeSets)
            {
                await CallAsync<NendoChangeSetRejectResult>(client, "nendo.change_set.reject", new(session) { ["changeSetId"] = changeSetId, ["idempotencyKey"] = $"reject-{changeSetId}" });
            }
            Assert.IsEmpty(host.GetPendingProposals());
            Assert.IsEmpty(await workspace.Service.ListProposalsAsync(), "A rejected clone stayed behind.");
            for (var index = 0; index < NendoAuthoringLimits.Current.DraftsPerSession; index++)
            {
                await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = $"Draft {index}", ["idempotencyKey"] = $"begin-{round}-{index}" });
            }
            var over = await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session) { ["title"] = "One too many", ["idempotencyKey"] = $"begin-over-{round}" });
            StringAssert.Contains(Text(over), "NENDO_DRAFT_LIMIT", StringComparison.Ordinal);
            await CallAsync<NendoLeaseRelease>(client, "nendo.lease.release", new(session));
            grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", new() { ["resumeApplicationHandle"] = grant.ApplicationHandle });
            session = Session(grant);
        }
        Assert.IsTrue((await host.GetLeaseStatusAsync()).HasLease);
    }

    /// <summary>Every version the SDK lists is answered: the handshake ones by initialize, the per-request ones by server/discover.</summary>
    [TestMethod]
    public async Task EveryProtocolVersionTheSdkListsIsServedByItsEra()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = LatestProtocolTests.Client(host);
        // The SDK keeps its version table internal; the test reads it by reflection so a new
        // revision in a later SDK is served, or this test says which one is not.
        var versions = typeof(McpServer).Assembly.GetType("ModelContextProtocol.Protocol.McpProtocolVersions")
            ?? throw new AssertFailedException("The SDK no longer declares McpProtocolVersions.");
        static string[] Versions(Type type, string member) =>
            ((System.Collections.IEnumerable)(type.GetField(member, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.GetValue(null)
                ?? type.GetProperty(member, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)?.GetValue(null)
                ?? throw new AssertFailedException($"McpProtocolVersions.{member} is gone."))).Cast<object>().Select(value => value.ToString()!).ToArray();
        var handshake = Versions(versions, "InitializeHandshakeProtocolVersions");
        var perRequest = Versions(versions, "PerRequestMetadataProtocolVersions");
        Assert.IsNotEmpty(handshake);
        Assert.IsNotEmpty(perRequest);
        CollectionAssert.AreEquivalent(handshake.Concat(perRequest).ToArray(), Versions(versions, "SupportedProtocolVersions"));

        foreach (var version in handshake)
        {
            var reply = await LatestProtocolTests.Send(http, "initialize", new()
            {
                ["protocolVersion"] = version, ["capabilities"] = new { }, ["clientInfo"] = new { name = "matrix", version = "1" },
            }, legacy: true);
            Assert.IsFalse(reply.TryGetProperty("error", out _), $"{version}: {reply.GetRawText()}");
            Assert.AreEqual(version, reply.GetProperty("result").GetProperty("protocolVersion").GetString(), version);
        }
        foreach (var version in perRequest)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, http.BaseAddress);
            request.Headers.Add("MCP-Protocol-Version", version);
            request.Headers.Add("Mcp-Method", "server/discover");
            request.Content = System.Net.Http.Json.JsonContent.Create(new
            {
                jsonrpc = "2.0", id = 1, method = "server/discover",
                @params = new Dictionary<string, object?>
                {
                    ["_meta"] = new Dictionary<string, object?>
                    {
                        ["io.modelcontextprotocol/protocolVersion"] = version,
                        ["io.modelcontextprotocol/clientCapabilities"] = new { },
                        ["io.modelcontextprotocol/clientInfo"] = new { name = "matrix", version = "1" },
                    },
                },
            });
            using var response = await http.SendAsync(request);
            var text = await response.Content.ReadAsStringAsync();
            if (text.StartsWith("event:", StringComparison.Ordinal) || text.StartsWith("data:", StringComparison.Ordinal))
                text = text.Split('\n').First(line => line.StartsWith("data:", StringComparison.Ordinal))[5..].Trim();
            var reply = JsonDocument.Parse(text).RootElement;
            Assert.IsFalse(reply.TryGetProperty("error", out _), $"{version}: {text}");
            StringAssert.Contains(reply.GetRawText(), version, StringComparison.Ordinal);
        }
    }

    private sealed record Validated(string ChangeSetId, string ProposalId);

    private static async Task<Validated> ValidateAsync(McpClient client, Dictionary<string, object?> session, string entityId, string key)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = entityId, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput($"Create {entityId}",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId, displayName = entityId })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.title", displayName = "Title", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = $"add-{key}",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new Validated(begun.ChangeSetId, validated.ProposalId);
    }

    private static Dictionary<string, object?> Session(NendoLeaseGrant grant) => new(StringComparer.Ordinal)
    {
        ["applicationHandle"] = grant.ApplicationHandle,
        ["leaseId"] = grant.LeaseId,
    };

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
