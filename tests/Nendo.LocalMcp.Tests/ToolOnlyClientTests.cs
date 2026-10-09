using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// What an agent needs in a client that calls tools and cannot read resources. An outside review
/// on 2026-10-08 ran one: it could read nothing through Nendo, so it opened the file's storage.
/// Every read is now a tool, the instructions say so before a client's cut, and the lease grant
/// carries the limits and the first reads.
/// </summary>
[TestClass]
public sealed class ToolOnlyClientTests
{
    [TestMethod]
    public async Task AtInspectTheReadToolAnswersEveryAddressAsResourcesReadDoes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var records = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records";
        foreach (var uri in new[]
                 {
                     "nendo://application/manifest",
                     "nendo://application/describe",
                     "nendo://application/vocabulary",
                     $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}",
                     records + "?limit=2",
                     "nendo://application/history?newestFirst=true&limit=3",
                     "skill://nendo-authoring/SKILL.md",
                 })
        {
            var expected = await ProtocolResourceTests.ReadTextAsync(client, uri);
            var result = await ReadAsync(client, uri);
            Assert.AreNotEqual(true, result.IsError, $"{uri}: {JsonSerializer.Serialize(result)}");
            Assert.AreEqual(expected, Text(result), $"{uri} read through the tool is not what resources/read returns.");
            // Nothing beside the text that a client could read instead of it (2026-10-09).
            Assert.IsNull(result.StructuredContent, $"{uri}: the read carries structuredContent a client may take in place of the text.");
        }

        // A query in another order is the same read, as it is for resources/read.
        var fields = $"fields={NendoApplicationService.IdeaTitleFieldId}";
        Assert.AreEqual(
            await ProtocolResourceTests.ReadTextAsync(client, $"{records}?limit=2&{fields}"),
            Text(await ReadAsync(client, $"{records}?{fields}&limit=2")));

        // A refusal comes back as a refused tool result carrying the resource's code, not as a
        // protocol error a tool-only client may report as a broken call.
        var refused = await ReadAsync(client, "nendo://application/entity/no-such-type/records");
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        StringAssert.Contains(Text(refused), "NENDO_");
        var nowhere = await ReadAsync(client, "nendo://nowhere");
        Assert.IsTrue(nowhere.IsError);
        StringAssert.Contains(Text(nowhere), "nendo.read.list names every address");

        // The list names the templated reads resources/list leaves out, and the host's skill.
        var listed = await client.CallToolAsync("nendo.read.list");
        Assert.AreNotEqual(true, listed.IsError, JsonSerializer.Serialize(listed));
        var list = listed.StructuredContent!.Value.Deserialize<NendoReadList>(NendoMcpJson.Options)!;
        Assert.IsTrue(list.Reads.Any(read => read.Templated && read.Uri.StartsWith("nendo://application/entity/{entityId}/records", StringComparison.Ordinal)));
        Assert.HasCount(NendoMcpReadIndex.All.Count, list.Reads);
        Assert.AreEqual("skill://nendo-authoring/SKILL.md", list.Skills.Single().Uri);
        Assert.IsFalse(list.Skills.Single().FromFile);
    }

    [TestMethod]
    public async Task TheGrantStatesTheWriteLimitsAndTheReadsToMakeFirst()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var acquired = await client.CallToolAsync("nendo.lease.acquire");
        Assert.AreNotEqual(true, acquired.IsError, JsonSerializer.Serialize(acquired));
        var grant = acquired.StructuredContent!.Value.Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        Assert.IsNotNull(grant.Limits, "The grant carries no limits.");
        Assert.AreEqual(NendoLeaseLimits.From(NendoAuthoringLimits.Current), grant.Limits);

        // The same numbers the vocabulary publishes, the in-flight bound among them.
        using var vocabulary = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        var limits = vocabulary.RootElement.GetProperty("limits");
        Assert.AreEqual(limits.GetProperty("recordWritesPerCall").GetInt32(), grant.Limits.RecordWritesPerCall);
        Assert.AreEqual(limits.GetProperty("fieldsPerRecordUpdate").GetInt32(), grant.Limits.FieldsPerRecordUpdate);
        Assert.AreEqual(limits.GetProperty("requestsInFlight").GetInt32(), grant.Limits.RequestsInFlight);
        Assert.AreEqual(NendoRequestGate.DefaultMaximum, grant.Limits.RequestsInFlight);

        Assert.IsNotNull(grant.Reads, "The grant names no reads.");
        CollectionAssert.IsSubsetOf(
            new[] { "nendo.application.describe", "nendo.application.entity.records", "nendo.application.vocabulary", "nendo.host.skill" },
            grant.Reads.Select(read => read.Name).ToArray());
    }

    private static Task<CallToolResult> ReadAsync(McpClient client, string uri) =>
        client.CallToolAsync("nendo.read.resource", new Dictionary<string, object?> { ["uri"] = uri }).AsTask();

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));
}
