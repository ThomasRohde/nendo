using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A rating scale authored from outside, ADR-0004 2026-09-14 amendment, slice S2. The
/// bounds are ordinary payload keys on the field operation, published where an agent
/// reads the rules, read back on the schema resource, and refused by name off a rating.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class RatingProtocolTests
{
    [TestMethod]
    public async Task ARatingScaleIsAuthoredThroughClosedMcpAndPublishedOnTheSchema()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var before = await workspace.Service.GetSnapshotAsync();
        var entity = before.Entities.Single();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };

        // The rules first: an agent must be able to read that a rating takes bounds
        // before it guesses at them.
        var vocabulary = await client.ReadResourceAsync("nendo://application/vocabulary");
        using var described = JsonDocument.Parse(((TextResourceContents)vocabulary.Contents[0]).Text);
        var addField = described.RootElement.GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("operationType").GetString() == "schema.addField");
        var optional = addField.GetProperty("optionalPayload").EnumerateArray().Select(value => value.GetString()).ToArray();
        CollectionAssert.Contains(optional, "min");
        CollectionAssert.Contains(optional, "max");
        StringAssert.Contains(addField.GetProperty("summary").GetString(), "rating");
        Assert.IsTrue(described.RootElement.GetProperty("propertyNotes").TryGetProperty("min", out _));
        Assert.IsTrue(described.RootElement.GetProperty("propertyNotes").TryGetProperty("max", out _));

        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(owned) {
            ["title"] = "Rate the entries", ["idempotencyKey"] = "begin",
        }));
        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(owned) {
            ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add",
            ["mutations"] = new[] { new NendoAgentMutationInput("Rate the entries", [new("schema.addField",
                JsonSerializer.SerializeToElement(new { entityId = entity.EntityId, fieldId = "field.confidence", displayName = "Confidence",
                    storageKind = "integer", required = false, presentation = "rating", min = 1, max = 5 }))]) },
        });
        Assert.IsFalse(added.IsError ?? false, JsonSerializer.Serialize(added.Content));
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(owned) {
            ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "validate",
        }));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        // Nothing reaches the active file until a person accepts.
        Assert.AreEqual(JsonSerializer.Serialize(before.Entities), JsonSerializer.Serialize((await workspace.Service.GetSnapshotAsync()).Entities));
        await client.CallToolAsync("nendo.lease.release", owned);
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);

        var resource = await client.ReadResourceAsync($"nendo://application/entity/{entity.EntityId}/schema");
        using var json = JsonDocument.Parse(((TextResourceContents)resource.Contents[0]).Text);
        var rated = json.RootElement.GetProperty("fields").EnumerateArray()
            .Single(field => field.GetProperty("fieldId").GetString() == "field.confidence");
        Assert.AreEqual("rating", rated.GetProperty("presentation").GetString());
        Assert.AreEqual(1, rated.GetProperty("scale").GetProperty("min").GetInt64());
        Assert.AreEqual(5, rated.GetProperty("scale").GetProperty("max").GetInt64());
        // Every other field reads back without a scale, so nothing carries a bound
        // nobody set.
        Assert.IsTrue(json.RootElement.GetProperty("fields").EnumerateArray()
            .Where(field => field.GetProperty("fieldId").GetString() != "field.confidence")
            .All(field => field.GetProperty("scale").ValueKind == JsonValueKind.Null));
    }

    [TestMethod]
    public async Task ABoundOnAFieldThatIsNotARatingIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var entity = (await workspace.Service.GetSnapshotAsync()).Entities.Single();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(owned) {
            ["title"] = "A bounded name", ["idempotencyKey"] = "begin",
        }));

        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(owned) {
            ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add",
            ["mutations"] = new[] { new NendoAgentMutationInput("A bounded name", [new("schema.addField",
                JsonSerializer.SerializeToElement(new { entityId = entity.EntityId, fieldId = "field.label", displayName = "Label",
                    storageKind = "text", required = false, presentation = "singleLine", min = 1, max = 5 }))]) },
        });

        Assert.IsTrue(added.IsError ?? false, "A scale on a field nobody rates must be refused.");
        StringAssert.Contains(JsonSerializer.Serialize(added.Content), "Only rating fields can declare a scale");
        await client.CallToolAsync("nendo.lease.release", owned);
    }

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
