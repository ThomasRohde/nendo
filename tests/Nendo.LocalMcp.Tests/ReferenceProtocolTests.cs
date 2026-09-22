using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ReferenceProtocolTests
{
    [TestMethod]
    public async Task LegacyConversionUsesClosedMcpAuthoringAndAtomicHostAcceptance()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Unbound references", "test",
            new([new("test", "legacy-schema", "test", "Unbound schema", [
                new CreateEntityOperation("target", "target", "Targets", "targets"),
                new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
                new CreateEntityOperation("source", "source", "Sources", "sources"),
                new AddFieldOperation("ref", "source", "ref", "Reference", "legacy_ref", NendoStorageKind.Reference, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?>(), new("test", "s", "test")));
        await workspace.Service.CreateRecordAsync(new("target", "t", new Dictionary<string, object?> { ["label"] = "Selected target" }, new("test", "t", "test")));
        var before = await workspace.Service.GetSnapshotAsync();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        static T Result<T>(CallToolResult result)
        {
            Assert.IsFalse(result.IsError ?? false, JsonSerializer.Serialize(result));
            return JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
        }
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Convert legacy reference", ["idempotencyKey"] = "begin-conversion" }));
        var rows = new[] { new { recordId = "s", expectedRecordVersion = 1, targetRecordId = "t", expectedTargetRecordVersion = 1 } };
        var reviewed = new[] { new { recordId = "s", expectedRecordVersion = 2, targetRecordId = "t", expectedTargetRecordVersion = 1 } };
        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add-conversion",
            ["mutations"] = new object[] {
                new { description = "Convert explicit values", operations = new[] { new { operationType = "data.convertLegacyReference",
                    payload = new { entityId = "source", fieldId = "ref", targetEntityId = "target", labelFieldId = "label", expectedDefinitionRevision = before.Manifest.DefinitionRevision, records = rows } } } },
                new { description = "Bind converted reference", operations = new[] { new { operationType = "schema.configureReference",
                    payload = new { entityId = "source", fieldId = "ref", targetEntityId = "target", labelFieldId = "label", expectedDefinitionRevision = before.Manifest.DefinitionRevision, reviewedRecords = reviewed } } } },
            },
        });
        Assert.IsFalse(added.IsError ?? false);
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "validate-conversion" }));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await workspace.Service.GetSnapshotAsync()));
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);
        var after = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual("t", after.Records.Single(row => row.EntityId == "source").Values["ref"].GetString());
        Assert.AreEqual(before.Manifest.DataRevision + 1, after.Manifest.DataRevision);
        Assert.AreEqual(before.Manifest.DefinitionRevision + 1, after.Manifest.DefinitionRevision);
    }

    [TestMethod]
    public async Task ReferenceSchemaAndAssignmentUseTheSameTargetVersionGuardOverMcp()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposal = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "References", "test",
            new([new("test", "schema", "test", "Reference schema", [
                new CreateEntityOperation("target", "target", "Target", "targets"),
                new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
                new CreateEntityOperation("source", "source", "Source", "sources"),
                new AddFieldOperation("ref", "source", "ref", "Reference", "target_id", NendoStorageKind.Reference, true),
                new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", 0),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await client.CallToolAsync("nendo.lease.acquire");
        var lease = JsonSerializer.Deserialize<NendoLeaseGrant>(grant.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
        var schema = await client.ReadResourceAsync("nendo://application/entity/source/schema");
        using var schemaJson = JsonDocument.Parse(((TextResourceContents)schema.Contents[0]).Text);
        Assert.AreEqual("target", schemaJson.RootElement.GetProperty("fields")[0].GetProperty("reference").GetProperty("targetEntityId").GetString());
        Assert.IsFalse((await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "target", ["recordId"] = "t", ["idempotencyKey"] = "target",
            ["values"] = new { label = "Target" },
        })).IsError ?? false);
        var create = new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "source", ["recordId"] = "s", ["idempotencyKey"] = "source",
            ["values"] = new Dictionary<string, object?> { ["ref"] = "t" },
        };
        Assert.IsTrue((await client.CallToolAsync("nendo.data.create_record", create)).IsError ?? false);
        create["expectedTargetVersions"] = new Dictionary<string, long> { ["ref"] = 1 };
        create["idempotencyKey"] = "source-valid";
        var created = await client.CallToolAsync("nendo.data.create_record", create);
        Assert.IsFalse(created.IsError ?? false, JsonSerializer.Serialize(created.Content));
        var edit = new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "source", ["recordId"] = "s", ["fieldId"] = "ref",
            ["expectedRecordVersion"] = 1, ["value"] = "t", ["idempotencyKey"] = "edit", ["expectedTargetRecordVersion"] = 2,
        };
        Assert.IsTrue((await client.CallToolAsync("nendo.data.set_field", edit)).IsError ?? false);
        edit["expectedTargetRecordVersion"] = 1;
        edit["idempotencyKey"] = "edit-valid";
        Assert.IsFalse((await client.CallToolAsync("nendo.data.set_field", edit)).IsError ?? false);
        Assert.AreEqual(2L, (await workspace.Service.GetSnapshotAsync()).Records.Single(r => r.EntityId == "source").RecordVersion);
        var rows = await client.ReadResourceAsync("nendo://application/entity/source/records");
        using var rowJson = JsonDocument.Parse(((TextResourceContents)rows.Contents[0]).Text);
        Assert.AreEqual("Target", rowJson.RootElement.GetProperty("items")[0].GetProperty("referenceLabels").GetProperty("ref").GetString());
        var delete = new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "target", ["recordId"] = "t", ["expectedRecordVersion"] = 1, ["idempotencyKey"] = "blocked-delete",
        };
        Assert.IsTrue((await client.CallToolAsync("nendo.data.delete_record", delete)).IsError ?? false);
        delete["entityId"] = "source"; delete["recordId"] = "s"; delete["idempotencyKey"] = "stale-delete";
        Assert.IsTrue((await client.CallToolAsync("nendo.data.delete_record", delete)).IsError ?? false);
        delete["expectedRecordVersion"] = 2; delete["idempotencyKey"] = "delete-source";
        var deleted = await client.CallToolAsync("nendo.data.delete_record", delete);
        Assert.IsFalse(deleted.IsError ?? false);
        var retry = await client.CallToolAsync("nendo.data.delete_record", delete);
        Assert.IsFalse(retry.IsError ?? false);
        Assert.AreEqual(deleted.StructuredContent!.Value.GetProperty("revisionId").GetString(), retry.StructuredContent!.Value.GetProperty("revisionId").GetString());
        Assert.HasCount(1, (await workspace.Service.GetSnapshotAsync()).Records);
        await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        await workspace.Service.CompensateRevisionAsync(deleted.StructuredContent!.Value.GetProperty("revisionId").GetString()!, "host-restore");
        Assert.AreEqual(3L, (await workspace.Service.GetSnapshotAsync()).Records.Single(r => r.EntityId == "source").RecordVersion);
    }
}
