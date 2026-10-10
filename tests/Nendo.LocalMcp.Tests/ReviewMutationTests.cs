using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ReviewMutationTests
{
    [TestMethod]
    public async Task AGeneratedWriteToTheSameIdInAnotherTypeDoesNotReplaceTheReturnedVersion()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await ApplyAsync(workspace, "schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new AddFieldOperation("project", "notes", "project", "Project", "project", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "project", "projects", "name", 0)
        ]);
        await workspace.Service.CreateRecordAsync(new("projects", "shared", new Dictionary<string, object?>
            { ["name"] = "Project", ["total"] = 0L }, new("test", "project", "test")));
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await ApplyAsync(workspace, "actions", [
            new SetBehaviourDefinitionOperation("act", new NendoActionDefinition("stamp", "Stamp", [
                NendoActionStep.SetField("one", NendoActionTarget.Referenced("project"), new NendoActionAssignment("total", "1")),
                NendoActionStep.SetField("two", NendoActionTarget.Referenced("project"), new NendoActionAssignment("total", "2"))]), revision),
            new SetBehaviourDefinitionOperation("trig", new NendoTriggerDefinition("stamp-trigger", "notes", "Stamp project",
                NendoTriggerEvents.Created, "stamp"), revision)
        ]);
        workspace.ApproveBehaviour(new ApprovingAuthority());
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var result = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", new()
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "notes", ["recordId"] = "shared", ["idempotencyKey"] = "create-shared",
            ["values"] = new { label = "Note", project = "shared" },
            ["expectedTargetVersions"] = new Dictionary<string, long> { ["project"] = 1 }
        });
        var actual = (await workspace.Service.QueryRecordsAsync(new("notes") { RecordId = "shared" })).Items.Single();
        Assert.AreEqual(actual.RecordVersion, result.RecordVersion,
            "The returned version must belong to notes/shared, not projects/shared.");
        Assert.AreEqual(1L, result.RecordVersion);
        Assert.AreEqual(3L, (await workspace.Service.QueryRecordsAsync(new("projects") { RecordId = "shared" })).Items.Single().RecordVersion);

        // The revision's operations say which automatic action made each generated one, and
        // nothing on the agent's own create (2026-10-10; written since actions were, never read).
        using var operations = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/revision/{Uri.EscapeDataString(result.RevisionId)}/operations"));
        var items = operations.RootElement.GetProperty("items").EnumerateArray().ToArray();
        Assert.HasCount(3, items);
        Assert.AreEqual(JsonValueKind.Null, items[0].GetProperty("attribution").ValueKind);
        foreach (var (item, step) in items.Skip(1).Zip(new[] { "one", "two" }))
        {
            var attribution = item.GetProperty("attribution");
            Assert.AreEqual("stamp-trigger", attribution.GetProperty("triggerId").GetString());
            Assert.AreEqual("Stamp project", attribution.GetProperty("triggerName").GetString());
            Assert.AreEqual("Stamp", attribution.GetProperty("actionName").GetString());
            Assert.AreEqual(step, attribution.GetProperty("stepId").GetString());
            Assert.AreEqual("created", attribution.GetProperty("eventKind").GetString());
            Assert.AreEqual("shared", attribution.GetProperty("eventRecordId").GetString());
        }
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ExecuteCommandReportsItsOwnFinalVersionAfterGeneratedWritesOrDeletion(bool deleteCommandRecord)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await ApplyAsync(workspace, "command-schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("done", "notes", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new AddFieldOperation("project", "notes", "project", "Project", "project", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "project", "projects", "name", 0)
        ]);
        await workspace.Service.CreateRecordAsync(new("projects", "shared", new Dictionary<string, object?>
            { ["name"] = "Project", ["total"] = 0L }, new("test", "command-project", "test")));
        await workspace.Service.CreateRecordAsync(new("notes", "shared", new Dictionary<string, object?>
            { ["label"] = "Note", ["done"] = false, ["project"] = "shared" }, new("test", "command-note", "test"),
            new Dictionary<string, long> { ["project"] = 1 }));
        await ApplyAsync(workspace, "command-surface", [
            new AddUiNodeOperation("form-add", "notes-surface", "notesForm", null, "recordForm", 0),
            new SetUiPropertyOperation("form-version", "notes-surface", "notesForm", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("form-entity", "notes-surface", "notesForm", "entityId", "notes"),
            new AddUiNodeOperation("label-add", "notes-surface", "notesLabel", "notesForm", "fieldBinding", 0),
            new SetUiPropertyOperation("label-field", "notes-surface", "notesLabel", "fieldId", "label"),
            new AddUiNodeOperation("command-add", "notes-surface", "finishNote", null, "recordCommand", 1),
            new SetUiPropertyOperation("command-version", "notes-surface", "finishNote", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("command-entity", "notes-surface", "finishNote", "entityId", "notes"),
            new SetUiPropertyOperation("command-label", "notes-surface", "finishNote", "label", "Finish"),
            new AddUiNodeOperation("step-add", "notes-surface", "finishStep", "finishNote", "commandStep", 0),
            new SetUiPropertyOperation("step-field", "notes-surface", "finishStep", "fieldId", "done"),
            new SetUiPropertyOperation("step-kind", "notes-surface", "finishStep", "valueKind", "literal"),
            new SetUiPropertyOperation("step-value", "notes-surface", "finishStep", "value", true)
        ]);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var steps = new List<NendoActionStep>
        {
            NendoActionStep.SetField("note", NendoActionTarget.EventRecord, new NendoActionAssignment("label", "'Stamped'")),
            NendoActionStep.SetField("project-one", NendoActionTarget.Referenced("project"), new NendoActionAssignment("total", "1")),
            NendoActionStep.SetField("project-two", NendoActionTarget.Referenced("project"), new NendoActionAssignment("total", "2")),
            NendoActionStep.SetField("project-three", NendoActionTarget.Referenced("project"), new NendoActionAssignment("total", "3"))
        };
        if (deleteCommandRecord) steps.Add(NendoActionStep.DeleteRecord("delete-note", NendoActionTarget.EventRecord));
        await ApplyAsync(workspace, "command-actions", [
            new SetBehaviourDefinitionOperation("act", new NendoActionDefinition("finish-effects", "Finish effects", steps), revision),
            new SetBehaviourDefinitionOperation("trig", new NendoTriggerDefinition("finish-trigger", "notes", "Finish note",
                NendoTriggerEvents.Updated, "finish-effects", ["done"]), revision)
        ]);
        workspace.ApproveBehaviour(new ApprovingAuthority());
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var arguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["commandId"] = "finishNote", ["recordId"] = "shared", ["expectedRecordVersion"] = 1L,
            ["idempotencyKey"] = "finish-shared"
        };
        var result = await CallAsync<NendoDataApplyResult>(client, "nendo.data.execute_command", arguments);
        var note = (await workspace.Service.QueryRecordsAsync(new("notes") { RecordId = "shared" })).Items.SingleOrDefault();
        var project = (await workspace.Service.QueryRecordsAsync(new("projects") { RecordId = "shared" })).Items.Single();
        Assert.AreEqual(4L, project.RecordVersion, "The same-ID project fixture must reach a different final version.");
        Assert.AreEqual(deleteCommandRecord ? null : 3L, note?.RecordVersion);
        Assert.AreEqual(note?.RecordVersion, result.RecordVersion,
            deleteCommandRecord
                ? "R02-019 execute_command reported a version for the record its generated action deleted."
                : "R02-019 execute_command must report notes/shared's generated final version, not command arithmetic or projects/shared's version.");
        Assert.AreEqual(4L, result.AlsoChanged.Last(change => change.EntityId == "projects" && change.RecordId == "shared").RecordVersion);
        Assert.AreEqual(note?.RecordVersion, result.AlsoChanged.Last(change => change.EntityId == "notes" && change.RecordId == "shared").RecordVersion);

        var historyCount = (await workspace.Service.GetHistoryAsync()).Count;
        var replay = await CallAsync<NendoDataApplyResult>(client, "nendo.data.execute_command", arguments);
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.IsNull(replay.RecordVersion, "An exact command retry must not present an old version as current.");
        Assert.HasCount(historyCount, await workspace.Service.GetHistoryAsync());
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task JsonImportKeepsExplicitRetentionOverridesAcrossBatchesAndRetries(bool defaultKept)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await ApplyAsync(workspace, "schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            .. defaultKept ? new NendoOperation[] { new SetKeptInNewFilesDefaultOperation("keep", "notes", true, 0) } : []
        ]);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var records = Enumerable.Range(0, 51).Select(index => new NendoRecordInput($"row-{index:D2}",
            JsonSerializer.SerializeToElement(new { label = $"Row {index}" }))
            { KeptInNewFiles = index % 3 == 0 ? null : index % 3 == 1 }).ToArray();
        var arguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "notes", ["format"] = "json", ["records"] = records, ["idempotencyKey"] = "retained-import"
        };
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var result = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", arguments);
            Assert.AreEqual(51, result.Committed);
            var stored = (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items.ToDictionary(row => row.RecordId);
            Assert.HasCount(51, stored);
            foreach (var sent in records)
                Assert.AreEqual(sent.KeptInNewFiles, stored[sent.RecordId].KeptInNewFiles,
                    $"JSON import dropped the explicit retention mark on {sent.RecordId}.");
        }
        records[0] = records[0] with { KeptInNewFiles = !defaultKept };
        var conflict = await client.CallToolAsync("nendo.data.import_records", arguments);
        Assert.IsTrue(conflict.IsError, "Changing a retention mark under the same import key must conflict.");
        StringAssert.Contains(JsonSerializer.Serialize(conflict), "NENDO_IDEMPOTENCY_CONFLICT");
    }

    private static async Task ApplyAsync(LocalMcpTestWorkspace workspace, string key, NendoOperation[] operations)
    {
        var preview = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", key,
            "test", new([new("test", key, "test", key, operations)])));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, JsonSerializer.Serialize(preview.Diagnostics));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)!;
    }

    private sealed class ApprovingAuthority : INendoBehaviourAuthority, IApprovesWhatTheFileAsks
    {
        private NendoBehaviourGrant? _grant;
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoBehaviourGrant required) => required == _grant;
        public void Approve(NendoBehaviourGrant required) => _grant = required;
    }
}
