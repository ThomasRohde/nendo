namespace Nendo.Engine.Tests;

/// <summary>
/// UX-07 (W-210): History names the record each record operation acts on, by its label, even
/// once the record is deleted, so three deletes of one type no longer read the same.
/// </summary>
[TestClass]
public sealed class HistoryRecordLabelTests
{
    [TestMethod]
    public async Task ARecordOperationCarriesItsRecordsLabelEvenAfterTheRecordIsDeleted()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "idea", "Idea", "idea"),
            new AddFieldOperation("count", "idea", "idea.count", "Count", "count", NendoStorageKind.Integer, false),
            new AddFieldOperation("title", "idea", "idea.title", "Title", "title", NendoStorageKind.Text, false, "singleLine"),
        ]));
        await service.CreateRecordAsync(new("idea", "r1", new Dictionary<string, object?> { ["idea.title"] = "Pocket field notes" }, new("test", "create-r1", "test")));
        var untitled = await service.CreateRecordAsync(new("idea", "r2", new Dictionary<string, object?> { ["idea.count"] = 3L }, new("test", "create-r2", "test")));
        var edited = await service.SetFieldAsync(new("idea", "r1", "idea.count", 1, 4L, new("test", "set-r1", "test")));
        var deleted = await service.DeleteRecordAsync(new("idea", "r1", 2, new("test", "delete-r1", "test")));

        async Task<string?> Label(string revisionId) =>
            (await service.QueryRevisionOperationsAsync(new(revisionId, 10, null))).Items.Single().RecordLabel;
        Assert.AreEqual("Pocket field notes", await Label(edited.RevisionId), "A field set names no record.");
        Assert.AreEqual("Pocket field notes", await Label(deleted.RevisionId),
            "A delete names no record, so three deletes of one type read the same.");
        Assert.IsNull(await Label(untitled.RevisionId), "A record with no title was given one.");
    }
}
