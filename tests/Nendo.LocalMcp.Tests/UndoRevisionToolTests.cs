using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-153: an agent at Edit data undoes a record revision its own session committed, as one
/// compensation revision; a foreign revision, a definition revision and an unknown one are
/// refused by name, and the undo of a create deletes the record it made.
/// </summary>
[TestClass]
public sealed class UndoRevisionToolTests
{
    [TestMethod]
    public async Task AnOwnWriteIsUndoneAsOneCompensationRevisionAndTheRestAreRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        var written = await CallAsync<NendoDataApplyResult>(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId, ["recordId"] = "idea-001",
            ["fieldId"] = NendoApplicationService.IdeaTitleFieldId, ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Changed"), ["idempotencyKey"] = "own-write",
        });
        var before = (await workspace.Service.GetHistoryAsync()).Count;
        var undone = await CallAsync<NendoDataWritesResult>(client, "nendo.data.undo_revision", new(session)
        {
            ["revisionId"] = written.RevisionId, ["idempotencyKey"] = "undo-own-write", ["label"] = "Take it back",
        });
        Assert.AreEqual(("entity.idea", "idea-001", (long?)3), (undone.Records.Single().EntityId, undone.Records.Single().RecordId, undone.Records.Single().RecordVersion));
        var record = (await workspace.Service.QueryRecordsAsync(new(NendoApplicationService.IdeaEntityId, 1) { RecordId = "idea-001" })).Items.Single();
        Assert.AreEqual("Idea 01", record.Values[NendoApplicationService.IdeaTitleFieldId].GetString(), "The undo did not put the value back.");
        Assert.AreEqual(3L, record.RecordVersion);
        var history = await workspace.Service.GetHistoryAsync();
        Assert.HasCount(before + 1, history, "An undo is one linked revision, and the write it reverses stays.");
        Assert.AreEqual(written.RevisionId, history[^1].CompensationOfRevisionId);
        StringAssert.Contains(history[^1].Description, "Take it back", StringComparison.Ordinal);

        // The same key again: the original outcome, nothing written twice.
        var replayed = await CallAsync<NendoDataWritesResult>(client, "nendo.data.undo_revision", new(session)
        {
            ["revisionId"] = written.RevisionId, ["idempotencyKey"] = "undo-own-write", ["label"] = "Take it back",
        });
        Assert.IsTrue(replayed.IsIdempotentReplay);
        Assert.AreEqual(undone.RevisionId, replayed.RevisionId);

        // The person's own write is not the agent's to undo.
        var theirs = await workspace.Service.SetFieldAsync(new NendoSetFieldRequest(
            NendoApplicationService.IdeaEntityId, "idea-002", NendoApplicationService.IdeaTitleFieldId, 1, "Theirs", new("workbench", "their-write", "workbench")));
        var foreign = await client.CallToolAsync("nendo.data.undo_revision", new Dictionary<string, object?>(session)
        {
            ["revisionId"] = theirs.RevisionId, ["idempotencyKey"] = "undo-theirs",
        });
        Assert.IsTrue(foreign.IsError);
        StringAssert.Contains(Text(foreign), "NENDO_REVISION_NOT_YOURS", StringComparison.Ordinal);

        // A revision that does not exist, and one that is not a record revision.
        var unknown = await client.CallToolAsync("nendo.data.undo_revision", new Dictionary<string, object?>(session)
        {
            ["revisionId"] = $"revision-{new string('0', 32)}", ["idempotencyKey"] = "undo-unknown",
        });
        StringAssert.Contains(Text(unknown), "NENDO_REVISION_NOT_FOUND", StringComparison.Ordinal);
        var definition = history.First(entry => entry.Lane == NendoRevisionLane.Definition);
        var shaped = await client.CallToolAsync("nendo.data.undo_revision", new Dictionary<string, object?>(session)
        {
            ["revisionId"] = definition.RevisionId, ["idempotencyKey"] = "undo-definition",
        });
        Assert.IsTrue(shaped.IsError, "A definition revision is not a record revision to undo.");
        StringAssert.Contains(Text(shaped), "NENDO_", StringComparison.Ordinal);
        Assert.HasCount(before + 2, await workspace.Service.GetHistoryAsync(), "The refusals committed nothing.");

        // The undo of a create deletes the record it made, and that undo can be undone (redo).
        var created = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId, ["recordId"] = "idea-new",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "New", [NendoApplicationService.IdeaStatusFieldId] = "Idea", [NendoApplicationService.IdeaEnergyFieldId] = "Low",
            }),
            ["idempotencyKey"] = "create-new",
        });
        var removed = await CallAsync<NendoDataWritesResult>(client, "nendo.data.undo_revision", new(session) { ["revisionId"] = created.RevisionId, ["idempotencyKey"] = "undo-create" });
        Assert.IsNull(removed.Records.Single().RecordVersion, "A deleted record has no version.");
        Assert.IsEmpty((await workspace.Service.QueryRecordsAsync(new(NendoApplicationService.IdeaEntityId, 1) { RecordId = "idea-new" })).Items);
        var redone = await CallAsync<NendoDataWritesResult>(client, "nendo.data.undo_revision", new(session) { ["revisionId"] = removed.RevisionId, ["idempotencyKey"] = "redo-create" });
        Assert.IsNotNull(redone.Records.Single().RecordVersion);
        Assert.HasCount(1, (await workspace.Service.QueryRecordsAsync(new(NendoApplicationService.IdeaEntityId, 1) { RecordId = "idea-new" })).Items);
    }

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
