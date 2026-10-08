using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// What two GitHub Copilot CLI agents had to guess while building an app from the authoring
/// vocabulary (2026-10-08): what a surfaceId is, where a field's uniqueness is declared, and
/// how to read the vocabulary without taking all sixty kilobytes of it at once.
/// </summary>
[TestClass]
public sealed class AuthoringVocabularyTests
{
    [TestMethod]
    public async Task TheVocabularySaysWhatASurfaceIdIsAndTheExamplesGiveEachScreenItsOwn()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        using var vocabulary = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        var rule = vocabulary.RootElement.GetProperty("authoringRules").EnumerateArray()
            .Select(value => value.GetString()!).SingleOrDefault(value => value.StartsWith("surfaceId", StringComparison.Ordinal));
        Assert.IsNotNull(rule, "No authoring rule says what a surfaceId is.");
        StringAssert.Contains(rule, "give each root its own");
        StringAssert.Contains(rule, "NUI016");
        StringAssert.Contains(Summary(vocabulary, "ui.addNode"), "surfaceId names the screen the node belongs to");

        // Every screen of every example under a surfaceId of its own, and every node beneath a
        // root under its root's. They all shared "example", so copying them taught nothing.
        using var examples = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/examples"));
        var roots = 0;
        foreach (var example in examples.RootElement.GetProperty("examples").EnumerateArray())
        {
            var surfaceOf = new Dictionary<string, string>(StringComparer.Ordinal);
            var name = example.GetProperty("name").GetString();
            foreach (var operation in example.GetProperty("mutations").EnumerateArray()
                         .SelectMany(mutation => mutation.GetProperty("operations").EnumerateArray())
                         .Where(operation => operation.GetProperty("operationType").GetString()!.StartsWith("ui.", StringComparison.Ordinal)))
            {
                var payload = operation.GetProperty("payload");
                var nodeId = payload.GetProperty("nodeId").GetString()!;
                var surfaceId = payload.GetProperty("surfaceId").GetString()!;
                if (operation.GetProperty("operationType").GetString() == "ui.addNode")
                {
                    var parent = payload.TryGetProperty("parentNodeId", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                    var anchored = payload.TryGetProperty("beforeNodeId", out _) || payload.TryGetProperty("afterNodeId", out _);
                    if (parent is null && !anchored)
                    {
                        roots++;
                        Assert.AreEqual(nodeId, surfaceId, $"{name}: the screen {nodeId} is under the surfaceId {surfaceId}, not its own.");
                    }
                    else if (parent is not null)
                    {
                        Assert.AreEqual(surfaceOf[parent], surfaceId, $"{name}: {nodeId} is under another surfaceId than its parent {parent}.");
                    }
                    surfaceOf[nodeId] = surfaceId;
                }
                else if (surfaceOf.TryGetValue(nodeId, out var added))
                {
                    Assert.AreEqual(added, surfaceId, $"{name}: {operation.GetProperty("operationType").GetString()} names {nodeId} under another surfaceId than it was added under.");
                }
            }
        }
        Assert.IsGreaterThan(15, roots, "The examples no longer add the screens this check was written for.");
    }

    [TestMethod]
    public async Task AFieldIsMadeUniqueBySetFieldUniqueAndTheRefusalOfUniqueOnAddFieldSaysSo()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        using var vocabulary = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        StringAssert.Contains(Summary(vocabulary, "schema.addField"), "schema.setFieldUnique makes a field unique");

        var grant = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value.Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        var begun = (await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session) { ["title"] = "Genres", ["idempotencyKey"] = "begin" }))
            .StructuredContent!.Value.Deserialize<NendoChangeSetBeginResult>(NendoMcpJson.Options)!;
        var refused = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(session)
        {
            ["changeSetId"] = begun.ChangeSetId,
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create genres",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "genre", displayName = "Genre" })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new
                    {
                        entityId = "genre", fieldId = "genreName", displayName = "Name", storageKind = "Text", required = true, unique = true,
                    })),
                ]),
            },
            ["idempotencyKey"] = "add",
        });
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        var text = string.Join(' ', refused.Content.OfType<TextContentBlock>().Select(block => block.Text));
        StringAssert.Contains(text, "schema.addField does not take unique");
        StringAssert.Contains(text, "A field is made unique by schema.setFieldUnique");
    }

    [TestMethod]
    public async Task TheVocabularyIsReadASectionAtATime()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var whole = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary");
        var part = await client.ReadResourceAsync("nendo://application/vocabulary?include=operations,authoringRules,limits");
        var text = ((TextResourceContents)part.Contents.Single()).Text;
        using var document = JsonDocument.Parse(text);
        CollectionAssert.AreEquivalent(
            new[] { "contractVersion", "included", "operations", "authoringRules", "limits" },
            document.RootElement.EnumerateObject().Select(property => property.Name).ToArray());
        using var wholeDocument = JsonDocument.Parse(whole);
        Assert.AreEqual(wholeDocument.RootElement.GetProperty("operations").GetRawText(), document.RootElement.GetProperty("operations").GetRawText());
        Assert.IsLessThan(whole.Length / 2, text.Length, $"Three sections are {text.Length} characters of the whole's {whole.Length}.");
        Assert.AreEqual(NendoMcpResources.StaticTimeToLive, part.TimeToLive, "A section describes the build as the whole does.");

        var unknown = await Assert.ThrowsAsync<ModelContextProtocol.McpProtocolException>(async () =>
            await client.ReadResourceAsync("nendo://application/vocabulary?include=operations,nodeKinds"));
        StringAssert.Contains(unknown.Message, "include names nodeKinds; the vocabulary's sections are");
        StringAssert.Contains(unknown.Message, "kinds");
    }

    private static string Summary(JsonDocument vocabulary, string operationType) =>
        vocabulary.RootElement.GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("operationType").GetString() == operationType)
            .GetProperty("summary").GetString()!;
}
