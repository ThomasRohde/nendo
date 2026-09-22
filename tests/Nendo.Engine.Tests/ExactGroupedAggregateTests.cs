using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// The exact grouped aggregate, ADR-0004 2026-09-14 amendment, slice S1: one number
/// per group of a closed grouping in one read, the groups in configured order with
/// the unset group last, a value outside the options counted apart, and every
/// number exact or absent. The grouping is not a filter.
/// </summary>
[TestClass]
public sealed class ExactGroupedAggregateTests
{
    [TestMethod]
    public async Task CountsAndSumsPerGroupAreExactOrderedAndEndWithTheUnsetGroup()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, ("open", 10.50m), ("open", 0.25m), ("done", 3.00m), (null, 1.00m));

        var counts = await service.GroupAggregateRecordsAsync(new("item", "status", "count"));
        CollectionAssert.AreEqual(new string?[] { "open", "done", "paused", null }, counts.Groups.Select(group => group.Key).ToArray(),
            "Groups come in the field's configured order, then the unset group; an empty group is still stated.");
        CollectionAssert.AreEqual(new[] { "2", "1", "0", "1" }, counts.Groups.Select(group => group.ValueLexeme).ToArray());
        Assert.AreEqual(0, counts.Unrecognised);

        var sums = await service.GroupAggregateRecordsAsync(new("item", "status", "sum", "amount"));
        CollectionAssert.AreEqual(new[] { "10.75", "3.00", null, "1.00" }, sums.Groups.Select(group => group.ValueLexeme).ToArray(),
            "Every digit and trailing zero survives; a group that contributed nothing is empty, never zero.");
        Assert.AreEqual(2, sums.Groups[0].ContributingRecords);
        Assert.AreEqual(0, sums.Groups[2].ContributingRecords);

        var max = await service.GroupAggregateRecordsAsync(new("item", "status", "max", "amount"));
        Assert.AreEqual("10.50", max.Groups[0].ValueLexeme);
    }

    [TestMethod]
    public async Task ABooleanGroupsIntoFalseTrueAndUnset()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(Mutation("seed", [
            new CreateRecordOperation("c0", "item", "r0", new Dictionary<string, object?> { ["flag"] = true, ["quantity"] = 4L }),
            new CreateRecordOperation("c1", "item", "r1", new Dictionary<string, object?> { ["flag"] = true, ["quantity"] = 6L }),
            new CreateRecordOperation("c2", "item", "r2", new Dictionary<string, object?> { ["flag"] = false }),
            new CreateRecordOperation("c3", "item", "r3", new Dictionary<string, object?> { ["quantity"] = 1L }),
        ]));

        var counts = await service.GroupAggregateRecordsAsync(new("item", "flag", "count"));
        CollectionAssert.AreEqual(new string?[] { "false", "true", null }, counts.Groups.Select(group => group.Key).ToArray());
        CollectionAssert.AreEqual(new[] { "1", "2", "1" }, counts.Groups.Select(group => group.ValueLexeme).ToArray());

        var sums = await service.GroupAggregateRecordsAsync(new("item", "flag", "sum", "quantity"));
        CollectionAssert.AreEqual(new[] { null, "10", "1" }, sums.Groups.Select(group => group.ValueLexeme).ToArray(),
            "An integer sum stays an integer, and a group whose records carry no value is empty.");
    }

    [TestMethod]
    public async Task AStoredValueOutsideTheOptionsIsCountedApartNotFoldedIntoAGroup()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, ("open", 1.00m), ("done", 2.00m));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // Only a direct edit can put a value outside the options in a file; the
        // typed write paths refuse one. The read must still say what it found.
        await using (var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE items SET status_value = 'weird' WHERE status_value = 'done';";
            await command.ExecuteNonQueryAsync();
        }

        var reopened = await workspace.OpenAsync();
        var service = new NendoApplicationService(reopened);
        var counts = await service.GroupAggregateRecordsAsync(new("item", "status", "count"));
        CollectionAssert.AreEqual(new[] { "1", "0", "0", "0" }, counts.Groups.Select(group => group.ValueLexeme).ToArray());
        Assert.AreEqual(1, counts.Unrecognised, "The stray value is neither a group nor unset.");
    }

    [TestMethod]
    public async Task ADeclaredFilterNarrowsEveryGroupAndTheGroupingSpendsNoFilter()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, ("open", 10.50m), ("open", 0.25m), ("done", 3.00m), (null, 1.00m));

        var narrowed = await service.GroupAggregateRecordsAsync(new("item", "status", "count")
        {
            Filters = [new("amount", "gt", System.Text.Json.JsonSerializer.SerializeToElement(1))],
        });
        CollectionAssert.AreEqual(new[] { "1", "1", "0", "0" }, narrowed.Groups.Select(group => group.ValueLexeme).ToArray());

        // Eight filters are the ceiling, and the grouping is not one of them.
        var eight = Enumerable.Range(0, 8).Select(_ => new NendoRecordFilter("amount", "gt", System.Text.Json.JsonSerializer.SerializeToElement(0))).ToArray();
        var full = await service.GroupAggregateRecordsAsync(new("item", "status", "count") { Filters = eight });
        Assert.AreEqual("2", full.Groups[0].ValueLexeme);
        var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            service.GroupAggregateRecordsAsync(new("item", "status", "count") { Filters = [.. eight, eight[0]] }));
        StringAssert.Contains(refusal.Message, "at most 8");
    }

    [TestMethod]
    public async Task TheWrongShapeIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, ("open", 1.00m));

        await Refuses<NendoValidationException>("single-choice or Boolean", () => service.GroupAggregateRecordsAsync(new("item", "label", "count")));
        await Refuses<NendoValidationException>("not supported", () => service.GroupAggregateRecordsAsync(new("item", "status", "median", "amount")));
        await Refuses<NendoValidationException>("refused by this host", () => service.GroupAggregateRecordsAsync(new("item", "status", "avg", "amount")));
        await Refuses<NendoValidationException>("does not read a field", () => service.GroupAggregateRecordsAsync(new("item", "status", "count", "amount")));
        await Refuses<NendoValidationException>("needs the field", () => service.GroupAggregateRecordsAsync(new("item", "status", "sum")));
        await Refuses<NendoValidationException>("integer or decimal", () => service.GroupAggregateRecordsAsync(new("item", "status", "sum", "label")));
        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.GroupAggregateRecordsAsync(new("item", "nowhere", "count")));
        Assert.AreEqual("field-not-found", missing.Code);
    }

    private static async Task Refuses<TException>(string reason, Func<Task> action) where TException : Exception
    {
        var failure = await Assert.ThrowsExactlyAsync<TException>(action);
        StringAssert.Contains(failure.Message, reason);
    }

    private static Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        coordinator.ApplyAsync(Mutation("schema", [
            new CreateEntityOperation("entity", "item", "Item", "items"),
            new AddFieldOperation("status", "item", "status", "Status", "status_value", NendoStorageKind.Text, false, "singleChoice", ["open", "done", "paused"]),
            new AddFieldOperation("flag", "item", "flag", "Flag", "flag_value", NendoStorageKind.Boolean, false),
            new AddFieldOperation("amount", "item", "amount", "Amount", "amount_value", NendoStorageKind.Decimal, false),
            new AddFieldOperation("quantity", "item", "quantity", "Quantity", "quantity_value", NendoStorageKind.Integer, false),
            new AddFieldOperation("label", "item", "label", "Label", "label_value", NendoStorageKind.Text, false),
        ]));

    private static Task SeedAsync(NendoWriteCoordinator coordinator, params (string? Status, decimal Amount)[] rows) =>
        coordinator.ApplyAsync(Mutation("seed", rows
            .Select((row, index) => (NendoOperation)new CreateRecordOperation(
                $"c{index}", "item", $"r{index}", new Dictionary<string, object?> { ["status"] = row.Status, ["amount"] = row.Amount }))
            .ToList()));

    private static NendoMutation Mutation(string key, IReadOnlyList<NendoOperation> operations) =>
        new("test", key, "test", key, operations);
}
