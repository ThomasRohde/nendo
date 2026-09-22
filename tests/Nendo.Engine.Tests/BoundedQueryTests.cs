using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class BoundedQueryTests
{
    [TestMethod]
    public async Task RecordPagesAreBoundedOrderedAndRejectChangesScopesAndReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator);
        var first = await service.QueryRecordsAsync(new("entity.query", 2));
        CollectionAssert.AreEqual(new[] { "record-001", "record-002" }, first.Items.Select(row => row.RecordId).ToArray());
        Assert.IsNotNull(first.NextCursor);
        var second = await service.QueryRecordsAsync(new("entity.query", 2, first.NextCursor));
        CollectionAssert.AreEqual(new[] { "record-003", "record-004" }, second.Items.Select(row => row.RecordId).ToArray());
        var end = await service.QueryRecordsAsync(new("entity.query", 200, second.NextCursor));
        Assert.HasCount(1, end.Items);
        Assert.IsNull(end.NextCursor);
        await CodeAsync("invalid-cursor", () => service.QueryRecordsAsync(new("entity.other", 2, first.NextCursor)));
        await CodeAsync("invalid-cursor", () => service.QueryHistoryAsync(new(2, first.NextCursor)));
        await CodeAsync("invalid-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, first.NextCursor + "!")));
        await CodeAsync("invalid-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, new string('x', 5000))));
        foreach (var limit in new[] { 0, -1, 201 })
            await CodeAsync("invalid-limit", () => service.QueryRecordsAsync(new("entity.query", limit)));
        await service.CreateRecordAsync(new("entity.query", "000-before", new Dictionary<string, object?> { ["field.query"] = "before" }, new("query", "insert", "test")));
        await CodeAsync("stale-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, first.NextCursor)));
        var beforeEdit = await service.QueryRecordsAsync(new("entity.query", 2));
        await service.SetFieldAsync(new("entity.query", "record-001", "field.query", 1, "edited", new("query", "edit", "test")));
        await CodeAsync("stale-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, beforeEdit.NextCursor)));
        var beforeDefinition = await service.QueryRecordsAsync(new("entity.query", 2));
        await coordinator.ApplyAsync(new("query", "new-definition", "test", "Add type", [new CreateEntityOperation("add-third", "entity.third", "Third", "data_third")]));
        await CodeAsync("stale-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, beforeDefinition.NextCursor)));
        var beforeClose = await service.QueryRecordsAsync(new("entity.query", 2));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        service = new(await workspace.OpenAsync());
        await CodeAsync("invalid-cursor", () => service.QueryRecordsAsync(new("entity.query", 2, beforeClose.NextCursor)));
    }

    [TestMethod]
    public async Task HistorySummariesBoundLargeRevisionsAndRejectAppendOrDirectionChange()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, 250);
        var first = await service.QueryHistoryAsync(new(1));
        Assert.HasCount(1, first.Items);
        Assert.AreEqual(250L, first.Items[0].OperationCount);
        Assert.IsFalse(first.Items[0].CanRequestCompensation);
        Assert.IsLessThan(2048, JsonSerializer.SerializeToUtf8Bytes(first).Length);
        var operations = await service.QueryRevisionOperationsAsync(new(first.Items[0].RevisionId, 50));
        Assert.HasCount(50, operations.Items);
        Assert.IsNotNull(operations.NextCursor);
        var nextOperations = await service.QueryRevisionOperationsAsync(new(first.Items[0].RevisionId, 200, operations.NextCursor));
        Assert.HasCount(200, nextOperations.Items);
        Assert.IsNull(nextOperations.NextCursor);
        Assert.AreEqual(250, operations.Items.Concat(nextOperations.Items).Select(item => item.OperationId).Distinct().Count());
        var second = await service.QueryHistoryAsync(new(1, first.NextCursor));
        Assert.IsLessThan(first.Items[0].ChangeSequence, second.Items[0].ChangeSequence);
        await CodeAsync("invalid-cursor", () => service.QueryHistoryAsync(new(1, first.NextCursor, false)));
        await service.SetFieldAsync(new("entity.query", "record-001", "field.query", 1, "changed", new("query", "edit", "test")));
        await CodeAsync("stale-cursor", () => service.QueryHistoryAsync(new(1, first.NextCursor)));
        await CodeAsync("stale-cursor", () => service.QueryRevisionOperationsAsync(new(first.Items[0].RevisionId, 50, operations.NextCursor)));
        var fresh = await service.QueryHistoryAsync(new(200));
        Assert.IsTrue(fresh.Items[0].CanRequestCompensation);
        Assert.IsNull(fresh.NextCursor);
        var ascending = await service.QueryHistoryAsync(new(200, NewestFirst: false));
        CollectionAssert.AreEqual(fresh.Items.Reverse().Select(row => row.RevisionId).ToArray(), ascending.Items.Select(row => row.RevisionId).ToArray());
    }

    private static async Task SeedAsync(NendoWriteCoordinator coordinator, int count = 5)
    {
        await coordinator.ApplyAsync(new("query", "schema", "test", "Two types", [
            new CreateEntityOperation("create-main", "entity.query", "Main", "data_query"),
            new AddFieldOperation("field-main", "entity.query", "field.query", "Text", "text", NendoStorageKind.Text, true),
            new CreateEntityOperation("create-other", "entity.other", "Other", "data_other"),
            new AddFieldOperation("field-other", "entity.other", "field.other", "Text", "text", NendoStorageKind.Text, true)]));
        await coordinator.ApplyAsync(new("query", "data", "test", "Seed rows",
            Enumerable.Range(1, count).Select(index => (NendoOperation)new CreateRecordOperation($"create-{index}", "entity.query", $"record-{index:D3}",
                new Dictionary<string, object?> { ["field.query"] = new string('x', 1000) })).ToArray()));
    }

    private static async Task CodeAsync(string code, Func<Task> action) =>
        Assert.AreEqual(code, (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
