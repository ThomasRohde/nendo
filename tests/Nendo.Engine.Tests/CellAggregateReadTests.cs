using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// The read behind a <c>matrixSurface</c>, ADR-0004 2026-09-17 amendment, slice S6.
/// <para>
/// One rule is worth more than the rest and is asserted first: a cell with nothing in it
/// is still a cell. The cells are the cross product of two option sets, produced before a
/// single row is read, so what a person sees is the shape of the two fields rather than
/// the shape of the data that happens to exist. A grid missing its empty cells looks
/// exactly like a whole grid, which is why this is measured rather than looked at.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class CellAggregateReadTests
{
    [TestMethod]
    public async Task EveryCellOfTheCrossProductIsAnsweredEvenWhereNothingIsInIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        // Two of the six configured pairs carry a record. The other four are the point.
        await AddAsync(service, "a", "open", "high");
        await AddAsync(service, "b", "open", "high");
        await AddAsync(service, "c", "done", "low");

        var result = await service.CellAggregateRecordsAsync(
            new NendoRecordCellAggregateQuery("notes", "status", "priority", "count"));

        // Three statuses and two priorities, each with its unset lane: four by three.
        Assert.HasCount(12, result.Cells);
        Assert.AreEqual(12, result.Cells.Select(cell => (cell.RowKey, cell.ColumnKey)).Distinct().Count(),
            "Every cell of the grid is answered exactly once.");
        CollectionAssert.AreEqual(new[] { "open", "doing", "done" }, result.RowKeys.ToArray());
        CollectionAssert.AreEqual(new[] { "low", "high" }, result.ColumnKeys.ToArray());

        Assert.AreEqual("2", Cell(result, "open", "high").ValueLexeme);
        Assert.AreEqual("1", Cell(result, "done", "low").ValueLexeme);
        // A count answers zero where a sum would answer empty: nothing counted is none of them.
        Assert.AreEqual("0", Cell(result, "doing", "low").ValueLexeme);
        Assert.AreEqual(0, Cell(result, "doing", "low").ContributingRecords);
        Assert.AreEqual(0, result.Unrecognised);
    }

    /// <summary>
    /// Every record is in exactly one cell. A record missing one axis is in that axis's
    /// unset lane; a record missing both is in the corner where the two lanes meet.
    /// </summary>
    [TestMethod]
    public async Task ARecordWithNoValueOnAnAxisIsInThatAxisUnsetLane()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        await AddAsync(service, "a", "open", null);
        await AddAsync(service, "b", null, "high");
        await AddAsync(service, "c", null, null);

        var result = await service.CellAggregateRecordsAsync(
            new NendoRecordCellAggregateQuery("notes", "status", "priority", "count"));

        Assert.AreEqual("1", Cell(result, "open", null).ValueLexeme);
        Assert.AreEqual("1", Cell(result, null, "high").ValueLexeme);
        Assert.AreEqual("1", Cell(result, null, null).ValueLexeme);
        var total = result.Cells.Sum(cell => cell.ContributingRecords);
        Assert.AreEqual(3, total, "Every record is in exactly one cell, so the cells add up to the set.");
    }

    /// <summary>
    /// A stored value that is none of the field's options is counted apart, as it is on a
    /// board and in a breakdown: it is a data issue the renderer states, never a cell
    /// nobody configured.
    /// </summary>
    [TestMethod]
    public async Task AValueOutsideTheOptionsIsCountedApartRatherThanGivenACell()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await AddAsync(service, "a", "open", "high");
        await AddAsync(service, "b", "done", "high");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // Only a direct edit can put a value outside the options in a file; every typed
        // write path refuses one. The read must still say what it found.
        await using (var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE notes SET status = 'archived' WHERE status = 'done';";
            await command.ExecuteNonQueryAsync();
        }

        var reopened = await workspace.OpenAsync();
        var result = await new NendoApplicationService(reopened).CellAggregateRecordsAsync(
            new NendoRecordCellAggregateQuery("notes", "status", "priority", "count"));

        Assert.AreEqual(1, result.Unrecognised);
        Assert.AreEqual("1", Cell(result, "open", "high").ValueLexeme);
        Assert.IsFalse(result.Cells.Any(cell => cell.RowKey == "archived"), "A value nobody configured is not a row.");
    }

    /// <summary>
    /// The clauses narrow which records land in a cell; they are not the grouping, and the
    /// grid is still the whole cross product.
    /// </summary>
    [TestMethod]
    public async Task ClausesNarrowTheRecordsWithoutChangingTheShapeOfTheGrid()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        await AddAsync(service, "a", "open", "high", 10);
        await AddAsync(service, "b", "open", "high", 1);

        var result = await service.CellAggregateRecordsAsync(
            new NendoRecordCellAggregateQuery("notes", "status", "priority", "count")
            {
                Filters = [new NendoRecordFilter("amount", "gt", System.Text.Json.JsonSerializer.SerializeToElement(5))],
            });

        Assert.HasCount(12, result.Cells);
        Assert.AreEqual("1", Cell(result, "open", "high").ValueLexeme);
    }

    /// <summary>
    /// A field against itself is refused by the read as well as by the compiler: it is a
    /// diagonal with empty corners, and no caller should be able to ask for one.
    /// </summary>
    [TestMethod]
    public async Task TheReadRefusesTheSameFieldOnBothAxes()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        var failure = await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.CellAggregateRecordsAsync(new NendoRecordCellAggregateQuery("notes", "status", "status", "count")));

        StringAssert.Contains(failure.Message, "two different fields");
    }

    /// <summary>
    /// Only a field whose values are written down can be an axis, which is the rule a
    /// grouped read already applies to a chart.
    /// </summary>
    [TestMethod]
    public async Task TheReadRefusesAnAxisThatIsNotAClosedGrouping()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        var failure = await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.CellAggregateRecordsAsync(new NendoRecordCellAggregateQuery("notes", "status", "title", "count")));

        StringAssert.Contains(failure.Message, "single-choice or Boolean");
    }

    /// <summary>
    /// The fold is the same for a Boolean axis, whose two values are written false then
    /// true — the order the host publishes and the order a breakdown already uses.
    /// </summary>
    [TestMethod]
    public async Task ABooleanAxisCrossesAsTwoLanesPlusItsUnsetOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        await AddAsync(service, "a", "open", "high", 1, blocked: true);
        await AddAsync(service, "b", "done", "low", 1, blocked: false);

        var result = await service.CellAggregateRecordsAsync(
            new NendoRecordCellAggregateQuery("notes", "status", "blocked", "count"));

        CollectionAssert.AreEqual(new[] { "false", "true" }, result.ColumnKeys.ToArray());
        Assert.HasCount(12, result.Cells);
        Assert.AreEqual("1", Cell(result, "open", "true").ValueLexeme);
        Assert.AreEqual("1", Cell(result, "done", "false").ValueLexeme);
    }

    private static NendoRecordAggregateCell Cell(NendoRecordCellAggregate result, string? row, string? column) =>
        result.Cells.Single(cell => cell.RowKey == row && cell.ColumnKey == column);

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("n-status", "notes", "status", "Status", "status", NendoStorageKind.Text, false,
                presentation: "singleChoice", options: ["open", "doing", "done"]),
            new AddFieldOperation("n-priority", "notes", "priority", "Priority", "priority", NendoStorageKind.Text, false,
                presentation: "singleChoice", options: ["low", "high"]),
            new AddFieldOperation("n-blocked", "notes", "blocked", "Blocked", "blocked", NendoStorageKind.Boolean, false),
            new AddFieldOperation("n-amount", "notes", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
        ]));
        return service;
    }

    private static Task AddAsync(
        NendoApplicationService service, string id, string? status, string? priority, decimal amount = 1, bool? blocked = null) =>
        service.CreateRecordAsync(new("notes", id,
            new Dictionary<string, object?>
            {
                ["title"] = id,
                ["status"] = status,
                ["priority"] = priority,
                ["blocked"] = blocked,
                ["amount"] = amount,
            },
            new NendoRequestContext("test", id, "test")));
}
