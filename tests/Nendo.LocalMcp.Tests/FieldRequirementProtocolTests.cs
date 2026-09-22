using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class FieldRequirementProtocolTests
{
    [TestMethod]
    public async Task ClosedAuthoringBackfillsRetiredDataAndChangesRequirementOnlyAfterHostReview()
    {
        await using var workspace = new LocalMcpTestWorkspace(); await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Schema", "test", new([
            new("test", "schema", "test", "Schema", [new CreateEntityOperation("e", "e", "Entry", "entries"),
                new AddFieldOperation("f", "e", "f", "Title", "title", NendoStorageKind.Text, true)]),
            new("test", "retire", "test", "Retire", [new SetRetiredOperation("retire", "e", "f", true, 1)]),
        ])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("e", "r", new Dictionary<string, object?>(), new("test", "r", "test")));
        var before = await workspace.Service.GetSnapshotAsync();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Backfill and reactivate", ["idempotencyKey"] = "begin",
        }));
        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add",
            ["mutations"] = new[] {
                new NendoAgentMutationInput("Explicit backfill", [new("data.backfillRetiredField", JsonSerializer.SerializeToElement(new {
                    entityId = "e", fieldId = "f", recordId = "r", expectedRecordVersion = 1, value = "Explicit SDK value" }))]),
                new NendoAgentMutationInput("Reactivate", [new("schema.setRetired", JsonSerializer.SerializeToElement(new {
                    entityId = "e", fieldId = "f", retired = false, expectedDefinitionRevision = before.Manifest.DefinitionRevision }))]),
                new NendoAgentMutationInput("Make optional", [new("schema.setFieldRequired", JsonSerializer.SerializeToElement(new {
                    entityId = "e", fieldId = "f", required = false, expectedDefinitionRevision = before.Manifest.DefinitionRevision + 1 }))]),
            },
        });
        Assert.IsFalse(added.IsError ?? false, JsonSerializer.Serialize(added.Content));
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "validate",
        }));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await workspace.Service.GetSnapshotAsync()));
        await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);
        var after = await workspace.Service.GetSnapshotAsync();
        Assert.IsFalse(after.Entities.Single().Fields.Single().Retired);
        Assert.IsFalse(after.Entities.Single().Fields.Single().Required);
        Assert.AreEqual("Explicit SDK value", after.Records.Single().Values["f"].GetString());
        Assert.AreEqual(2L, after.Records.Single().RecordVersion);
        Assert.AreEqual(before.Manifest.DefinitionRevision + 2, after.Manifest.DefinitionRevision);
        var resource = await client.ReadResourceAsync("nendo://application/entity/e/schema");
        using var json = JsonDocument.Parse(((TextResourceContents)resource.Contents[0]).Text);
        Assert.IsFalse(json.RootElement.GetProperty("fields")[0].GetProperty("retired").GetBoolean());
    }

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
