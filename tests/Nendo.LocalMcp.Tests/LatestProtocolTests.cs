using System.Net.Http.Json;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class LatestProtocolTests
{
    [TestMethod]
    public async Task WireDiscoveryAndPrivateResourcesWorkWithoutInitializationOrSessionHeaders()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new(workspace.DiscoveryRoot));
        using var http = Client(host);
        var discovery = await Send(http, "server/discover", new());
        StringAssert.Contains(discovery.GetRawText(), "2026-07-28");
        Assert.DoesNotContain("2025-11-25", discovery.GetRawText());
        foreach (var method in new[] { "tools/list", "resources/list", "resources/templates/list", "resources/read" })
        {
            var parameters = new Dictionary<string, object?>();
            if (method == "resources/read") parameters["uri"] = "nendo://application/manifest";
            var response = await Send(http, method, parameters);
            Assert.IsFalse(response.TryGetProperty("error", out _), $"{method}: {response}");
            var result = response.GetProperty("result");
            Assert.AreEqual("complete", result.GetProperty("resultType").GetString());
            Assert.AreEqual("private", result.GetProperty("cacheScope").GetString());
            Assert.AreEqual(0, result.GetProperty("ttlMs").GetInt64());
        }
        Assert.IsTrue(host.GetActivities().Any(item => item.Client == "wire-probe 1"));
    }

    // Codex CLI 0.152 speaks the initialize handshake and could not connect while the host was pinned to
    // 2026-07-28. Both eras are served now: a handshake client gets its own version back and proceeds
    // without a session header; the discover path is unchanged.
    [TestMethod]
    public async Task InitializeHandshakeIsAnsweredAndHeaderMismatchCannotAcquireAuthority()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new(workspace.DiscoveryRoot));
        using var http = Client(host);
        var handshake = await Send(http, "initialize", new()
        {
            ["protocolVersion"] = "2025-06-18", ["capabilities"] = new { },
            ["clientInfo"] = new { name = "handshake", version = "1" },
        }, legacy: true);
        Assert.IsFalse(handshake.TryGetProperty("error", out _), handshake.GetRawText());
        Assert.AreEqual("2025-06-18", handshake.GetProperty("result").GetProperty("protocolVersion").GetString());
        Assert.AreEqual("nendo-local", handshake.GetProperty("result").GetProperty("serverInfo").GetProperty("name").GetString());
        var mismatch = await Send(http, "tools/call", new()
        {
            ["name"] = "nendo.lease.acquire", ["arguments"] = new { },
        }, headerMethod: "resources/read");
        Assert.IsTrue(mismatch.TryGetProperty("error", out _));
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease);
    }

    [TestMethod]
    public async Task HandlePossessionWorksAcrossRequestsButReleaseAndRevocationInvalidateWrites()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new(workspace.DiscoveryRoot));
        await using var first = await ProtocolResourceTests.ConnectAsync(host);
        await using var second = await ProtocolResourceTests.ConnectAsync(host);
        var grant = (await first.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        Assert.AreEqual(64, grant.ApplicationHandle.Length);
        Assert.AreNotEqual(grant.LeaseId, grant.ApplicationHandle);
        var args = new Dictionary<string, object?> { ["leaseId"] = grant.LeaseId, ["applicationHandle"] = grant.ApplicationHandle };
        Assert.IsFalse((await second.CallToolAsync("nendo.lease.renew", args)).IsError ?? false);
        Assert.IsFalse((await second.CallToolAsync("nendo.lease.release", args)).IsError ?? false);
        Assert.IsTrue((await first.CallToolAsync("nendo.lease.renew", args)).IsError);
        grant = (await first.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        args["applicationHandle"] = grant.ApplicationHandle;
        args["leaseId"] = grant.LeaseId;
        await host.RevokeEditingAsync();
        var denied = await first.CallToolAsync("nendo.lease.renew", args);
        Assert.IsTrue(denied.IsError);
        var visible = JsonSerializer.Serialize(new { activities = host.GetActivities(), status = await host.GetLeaseStatusAsync(), denied });
        Assert.DoesNotContain(grant.ApplicationHandle, visible);
        Assert.DoesNotContain(grant.LeaseId, visible);
    }

    private static HttpClient Client(NendoLocalMcpHost host)
    {
        var client = new HttpClient { BaseAddress = host.Endpoint, Timeout = TimeSpan.FromSeconds(10) };
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        client.DefaultRequestHeaders.Accept.ParseAdd("text/event-stream");
        return client;
    }

    private static async Task<JsonElement> Send(HttpClient http, string method, Dictionary<string, object?> parameters,
        bool legacy = false, string? headerMethod = null)
    {
        if (!legacy) parameters["_meta"] = new Dictionary<string, object?>
        {
            ["io.modelcontextprotocol/protocolVersion"] = "2026-07-28",
            ["io.modelcontextprotocol/clientCapabilities"] = new { },
            ["io.modelcontextprotocol/clientInfo"] = new { name = "wire-probe", version = "1" },
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, http.BaseAddress);
        if (!legacy) request.Headers.Add("MCP-Protocol-Version", "2026-07-28");
        request.Headers.Add("Mcp-Method", headerMethod ?? method);
        if (parameters.TryGetValue("name", out var name)) request.Headers.Add("Mcp-Name", name!.ToString());
        else if (parameters.TryGetValue("uri", out var uri)) request.Headers.Add("Mcp-Name", uri!.ToString());
        request.Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method, @params = parameters });
        using var response = await http.SendAsync(request);
        Assert.IsFalse(response.Headers.Contains("Mcp-Session-Id"));
        var text = await response.Content.ReadAsStringAsync();
        if (text.StartsWith("event:", StringComparison.Ordinal) || text.StartsWith("data:", StringComparison.Ordinal))
            text = text.Split('\n').First(line => line.StartsWith("data:", StringComparison.Ordinal))[5..].Trim();
        return JsonDocument.Parse(text).RootElement.Clone();
    }
}
