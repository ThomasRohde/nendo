using System.Text.Json;
using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-150: a handshake-era client is named from its User-Agent on the stateless path; one
/// record type is one small read; describe takes the facets a client needs.
/// </summary>
[TestClass]
public sealed class ClientIdentityAndBundleTests
{
    [TestMethod]
    public async Task AHandshakeClientIsNamedFromItsUserAgentOnEveryRequest()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        using var named = LatestProtocolTests.Client(host);
        named.DefaultRequestHeaders.UserAgent.ParseAdd("Codex/0.42.0");
        named.DefaultRequestHeaders.UserAgent.ParseAdd("(Windows)");
        // A legacy-era request: no clientInfo in _meta, as a handshake client's later requests look.
        var reply = await LatestProtocolTests.Send(named, "resources/read", new() { ["uri"] = "nendo://application/manifest" }, legacy: true);
        Assert.IsTrue(reply.TryGetProperty("result", out _), reply.GetRawText());
        var entry = host.GetActivities().Last(item => item.Name == "nendo://application/manifest");
        Assert.AreEqual("Codex 0.42.0", entry.Client, "The User-Agent's first product token names the client.");

        using var anonymous = LatestProtocolTests.Client(host);
        anonymous.DefaultRequestHeaders.UserAgent.Clear();
        await LatestProtocolTests.Send(anonymous, "resources/read", new() { ["uri"] = "nendo://application/health" }, legacy: true);
        Assert.AreEqual("Local agent", host.GetActivities().Last(item => item.Name == "nendo://application/health").Client);

        // A client that names itself in _meta keeps that name; the header does not override it.
        using var modern = LatestProtocolTests.Client(host);
        modern.DefaultRequestHeaders.UserAgent.ParseAdd("Curl/8.0");
        await LatestProtocolTests.Send(modern, "resources/read", new() { ["uri"] = "nendo://application/entities" });
        Assert.AreEqual("wire-probe 1", host.GetActivities().Last(item => item.Name == "nendo://application/entities").Client);
    }

    [TestMethod]
    public async Task OneRecordTypeIsOneSmallReadAndDescribeTakesFacets()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var wholeText = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe");
        var whole = ProtocolResourceTests.Deserialize<NendoMcpDescription>(wholeText);
        CollectionAssert.AreEqual(new[] { "manifest", "limits", "entities", "surfaces", "health", "reads", "extensions", "newFile" }, whole.Included.ToArray());
        Assert.IsNotNull(whole.Surfaces);
        Assert.IsNotNull(whole.Entities);

        var bundleText = await ProtocolResourceTests.ReadTextAsync(client, $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}");
        var bundle = ProtocolResourceTests.Deserialize<NendoMcpEntityBundle>(bundleText);
        Assert.AreEqual(NendoApplicationService.IdeaEntityId, bundle.Schema.EntityId);
        Assert.AreEqual(3, bundle.Schema.RecordCount);
        Assert.IsTrue(bundle.Schema.Fields.Any(field => field.FieldId == NendoApplicationService.IdeaTitleFieldId));
        Assert.IsNotEmpty(bundle.Surfaces, "The type's compiled screens belong in its bundle.");
        Assert.IsTrue(bundle.Surfaces.All(surface => surface.EntityId is null || surface.EntityId == NendoApplicationService.IdeaEntityId));
        Assert.IsTrue(bundle.SurfacesValid);
        Assert.IsLessThan(wholeText.Length / 2, bundleText.Length, $"The bundle is {bundleText.Length} characters against describe's {wholeText.Length}.");

        var facetsText = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=manifest,entities");
        var facets = ProtocolResourceTests.Deserialize<NendoMcpDescription>(facetsText);
        CollectionAssert.AreEqual(new[] { "manifest", "entities" }, facets.Included.ToArray());
        Assert.IsNotNull(facets.Manifest);
        Assert.IsNotNull(facets.Entities);
        Assert.IsNull(facets.Surfaces);
        Assert.IsNull(facets.Health);
        Assert.IsNull(facets.Limits);
        Assert.IsEmpty(facets.Reads);
        Assert.IsLessThan(wholeText.Length / 2, facetsText.Length, $"The facets read is {facetsText.Length} characters against describe's {wholeText.Length}.");

        var unknown = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=manifest,screens"));
        StringAssert.Contains(unknown.Message, "include names screens; the facets are manifest, limits, entities, surfaces, health, reads, extensions, newFile", StringComparison.Ordinal);
    }
}
