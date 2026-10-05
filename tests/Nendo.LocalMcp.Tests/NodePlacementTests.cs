using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using static Nendo.LocalMcp.Tests.AppBuilderReviewTests;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-168: an outside author replaced a root screen at a guessed index and it landed a slot late.
/// The surfaces read now says where every node is kept, and ui.addNode and ui.moveNode place a
/// node beside another instead of at a number.
/// </summary>
[TestClass]
public sealed class NodePlacementTests
{
    [TestMethod]
    public async Task TheSurfacesReadSaysWhereEachNodeIsKept()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        await ApplyAsync(client, session, "lists", [.. EntityMutation("notes").Operations, List("a", position: 0), List("b", position: 7)]);

        var roots = await RootsAsync(client);
        Assert.AreEqual("a,b", string.Join(',', roots.Select(root => root.GetProperty("nodeId").GetString())));
        var b = roots[1];
        Assert.AreEqual(7, b.GetProperty("position").GetInt32());
        Assert.AreEqual("b", b.GetProperty("surfaceId").GetString());
        Assert.AreEqual(JsonValueKind.Null, b.GetProperty("parentNodeId").ValueKind);
        var binding = b.GetProperty("children").EnumerateArray().Single();
        Assert.AreEqual("b", binding.GetProperty("parentNodeId").GetString());
        Assert.AreEqual(0, binding.GetProperty("position").GetInt32());
    }

    [TestMethod]
    public async Task ANodePlacedBesideAnotherKeepsThePlaceAPersonExpects()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        await ApplyAsync(client, session, "lists", [.. EntityMutation("notes").Operations, List("a", position: 0), List("b", position: 1), List("c", position: 2)]);

        // The reviewer's case: replace b, and the replacement takes b's place, not one after it.
        await ApplyAsync(client, session, "replace", [Remove("b"), List("b2", before: "c")]);
        Assert.AreEqual("a,b2,c", await OrderAsync(client));

        // No free key between a (0) and b2 (1): the siblings after the slot move up.
        await ApplyAsync(client, session, "squeeze", [List("d", after: "a")]);
        Assert.AreEqual("a,d,b2,c", await OrderAsync(client));

        // A move takes the same anchors, and a node added earlier in the change set is one too.
        await ApplyAsync(client, session, "move", [List("e", after: "c"), Move("e", before: "a"), Move("c", after: "e")]);
        Assert.AreEqual("e,c,a,d,b2", await OrderAsync(client));
    }

    [TestMethod]
    public async Task AnAnchorThatCannotBeResolvedIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        await ApplyAsync(client, session, "lists", [.. EntityMutation("notes").Operations, List("a", position: 0)]);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "Refusals", ["idempotencyKey"] = "begin-refusals" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };

        var missing = await AddAsync(client, scoped, "missing", [List("x", before: "nowhere")]);
        StringAssert.Contains(Text(missing), "nowhere is not a node in this file or earlier in this change set", StringComparison.Ordinal);
        var both = await AddAsync(client, scoped, "both", [Operation("ui.addNode", new { surfaceId = "y", nodeId = "y", kind = "recordList", position = 0, afterNodeId = "a" })]);
        StringAssert.Contains(Text(both), "Give exactly one of position, beforeNodeId and afterNodeId", StringComparison.Ordinal);
        var parent = await AddAsync(client, scoped, "parent", [Operation("ui.addNode", new { surfaceId = "a", nodeId = "z", kind = "fieldBinding", parentNodeId = "a", afterNodeId = "a" })]);
        StringAssert.Contains(Text(parent), "takes its parent, none (a root)", StringComparison.Ordinal);
    }

    private static NendoAgentOperationInput Operation(string type, object payload) => new(type, JsonSerializer.SerializeToElement(payload));

    private static NendoAgentOperationInput List(string nodeId, int? position = null, string? before = null, string? after = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["surfaceId"] = nodeId, ["nodeId"] = nodeId, ["kind"] = "recordList",
            ["properties"] = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "notes", ["title"] = nodeId.ToUpperInvariant() },
        };
        if (position is not null) { payload["parentNodeId"] = null; payload["position"] = position; }
        if (before is not null) payload["beforeNodeId"] = before;
        if (after is not null) payload["afterNodeId"] = after;
        return new("ui.addNode", JsonSerializer.SerializeToElement(payload));
    }

    private static NendoAgentOperationInput Binding(string listId) => Operation("ui.addNode", new
    {
        surfaceId = listId, nodeId = $"{listId}-label", parentNodeId = listId, kind = "fieldBinding", position = 0,
        properties = new { fieldId = "notes.label" },
    });

    private static NendoAgentOperationInput Move(string nodeId, string? before = null, string? after = null) =>
        before is not null
            ? Operation("ui.moveNode", new { surfaceId = nodeId, nodeId, beforeNodeId = before })
            : Operation("ui.moveNode", new { surfaceId = nodeId, nodeId, afterNodeId = after });

    private static NendoAgentOperationInput Remove(string nodeId) => Operation("ui.removeNode", new { surfaceId = nodeId, nodeId });

    private static async Task ApplyAsync(McpClient client, Dictionary<string, object?> session, string key, NendoAgentOperationInput[] operations)
    {
        // Every list gets its one column, so each screen compiles.
        var withBindings = operations.SelectMany(operation =>
            operation.OperationType == "ui.addNode" && operation.Payload.Element.GetProperty("kind").GetString() == "recordList"
                ? new[] { operation, Binding(operation.Payload.Element.GetProperty("nodeId").GetString()!) }
                : [operation]).ToArray();
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = key, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        var schema = withBindings.Where(operation => operation.OperationType.StartsWith("schema.", StringComparison.Ordinal)).ToArray();
        var ui = withBindings.Where(operation => !operation.OperationType.StartsWith("schema.", StringComparison.Ordinal)).ToArray();
        var mutations = new List<NendoAgentMutationInput>();
        if (schema.Length > 0) mutations.Add(new("Schema", schema));
        mutations.Add(new("Screens", ui));
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped) { ["mutations"] = mutations, ["idempotencyKey"] = $"add-{key}" });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.IsTrue(validated.IsValid, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(scoped) { ["idempotencyKey"] = $"accept-{key}" });
        Assert.IsTrue(accepted.Applied, accepted.Message);
    }

    private static Task<CallToolResult> AddAsync(McpClient client, Dictionary<string, object?> scoped, string key, NendoAgentOperationInput[] operations) =>
        client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput("Screens", operations) }, ["idempotencyKey"] = $"add-{key}",
        }).AsTask();

    private static async Task<JsonElement[]> RootsAsync(McpClient client)
    {
        var text = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/surfaces");
        return JsonDocument.Parse(text).RootElement.GetProperty("applications").EnumerateArray()
            .SelectMany(app => app.GetProperty("surfaces").EnumerateArray()).ToArray();
    }

    private static async Task<string> OrderAsync(McpClient client) =>
        string.Join(',', (await RootsAsync(client)).Select(root => root.GetProperty("nodeId").GetString()));
}
