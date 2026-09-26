using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// P6 limit closure, 2026-09-10: `sum`, `min` and `max` are exact over an
/// integer or decimal field. The host folds the stored lexemes itself, because
/// a Decimal column holds exact text behind a `nendo.decimal:` marker that
/// SQLite would coerce to zero.
/// </summary>
[TestClass]
public sealed class ExactAggregateTests
{
    // The premise the earlier refusal rested on, stated as a test: the column is
    // TEXT-backed and exact, not float-backed.
    [TestMethod]
    public async Task ADecimalColumnStoresExactTextRatherThanAFloat()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(Mutation("create", [
            new CreateRecordOperation("c1", "item", "one", new Dictionary<string, object?> { ["amount"] = 48000.00m }),
        ]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT amount_value, typeof(amount_value) FROM items;";
        await using var reader = await command.ExecuteReaderAsync();
        Assert.IsTrue(await reader.ReadAsync());
        Assert.AreEqual("nendo.decimal:48000.00", reader.GetString(0));
        Assert.AreEqual("text", reader.GetString(1), "A SQL SUM over this column would coerce the string to zero.");
    }

    [TestMethod]
    public async Task SumMinAndMaxAreExactOverDecimalsAndKeepScale()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 48000.00m, 22500.50m, 0.05m);

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount"));
        Assert.AreEqual("70500.55", sum.ValueLexeme, "Trailing zeros and every digit survive the fold.");
        Assert.AreEqual(3, sum.ContributingRecords);

        var min = await service.AggregateRecordsAsync(new("item", "min", "amount"));
        Assert.AreEqual("0.05", min.ValueLexeme);

        var max = await service.AggregateRecordsAsync(new("item", "max", "amount"));
        Assert.AreEqual("48000.00", max.ValueLexeme, "The extreme keeps the scale it was stored with.");
    }

    // Mixed scales align on the largest one, so a total keeps the precision of
    // the most precise value it summed rather than the first.
    [TestMethod]
    public async Task ASumOfMixedScalesKeepsTheLargestScale()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 0.1m, 0.2m, 1.20m);

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount"));
        Assert.AreEqual("1.50", sum.ValueLexeme, "0.1 + 0.2 + 1.20 is 1.50; a float fold reads 1.5000000000000002.");
    }

    // The case a float sum gets wrong. 0.1 + 0.2 is 0.30000000000000004 in
    // binary floating point; the exact fold says 0.3.
    [TestMethod]
    public async Task ASumFloatingPointWouldGetWrongIsExact()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 0.1m, 0.2m);

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount"));
        Assert.AreEqual("0.3", sum.ValueLexeme);
        Assert.AreNotEqual((0.1 + 0.2).ToString(CultureInfo.InvariantCulture), sum.ValueLexeme);
    }

    [TestMethod]
    public async Task ASumBeyondOneValuesRangeStaysExactAcrossManyRecords()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        // Each value is representable; the running total passes far beyond the
        // magnitude of any single one, which is what the scaled accumulator is for.
        var operations = new List<NendoOperation>();
        for (var index = 0; index < 500; index++)
            operations.Add(new CreateRecordOperation($"c{index}", "item", $"r{index}",
                new Dictionary<string, object?> { ["amount"] = 1000000000000000000000.01m }));
        await coordinator.ApplyAsync(Mutation("bulk", operations));

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount"));
        Assert.AreEqual("500000000000000000000005.00", sum.ValueLexeme);
        Assert.AreEqual(500, sum.ContributingRecords);
    }

    // R-016. Mixed scales align on the larger one, so decimal.MaxValue + 0.0 carries
    // a coefficient ten times the largest a decimal holds -- with a trailing zero the
    // answer does not need. The answer is exactly decimal.MaxValue and must not be
    // refused as out of range; a sum that really is out of range still is.
    [TestMethod]
    public void AMixedScaleSumShedsARedundantZeroBeforeRefusingItsRange()
    {
        static string Sum(params decimal[] values)
        {
            var fold = new ExactAggregate("sum", integral: false);
            foreach (var value in values) fold.Add(value);
            return fold.Value()!.Value.GetRawText();
        }

        Assert.AreEqual("79228162514264337593543950335", Sum(decimal.MaxValue, 0.0m));
        Assert.AreEqual("79228162514264337593543950335", Sum(0.0m, decimal.MaxValue));
        Assert.AreEqual("-79228162514264337593543950335", Sum(decimal.MinValue, -0.0m));
        Assert.AreEqual("79228162514264337593543950335", Sum(decimal.MaxValue, 0.0000000000000000000000000000m),
            "Twenty-eight redundant zeros are shed, not one.");
        Assert.AreEqual("79228162514264337593543950335", Sum(decimal.MaxValue - 1m, 1.0m));
        Assert.AreEqual("7922816251426433759354395033.5", Sum(7922816251426433759354395033.5m, 0.00m),
            "Only the zeros the coefficient cannot hold are shed; the scale it can hold stays.");

        foreach (var outOfRange in new[] { new[] { decimal.MaxValue, 1m }, [decimal.MaxValue, 0.1m], [decimal.MaxValue, decimal.MaxValue], [decimal.MinValue, -0.1m] })
        {
            var fold = new ExactAggregate("sum", integral: false);
            foreach (var value in outOfRange) fold.Add(value);
            var refusal = Assert.ThrowsExactly<NendoPreconditionException>(() => fold.Value(),
                $"{string.Join(" + ", outOfRange)} is outside the range and has no zero to shed.");
            Assert.AreEqual("aggregate-not-representable", refusal.Code);
        }
    }

    [TestMethod]
    public async Task AMixedScaleBoundarySumIsAnsweredBySummaryAndGroupedReads()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, decimal.MaxValue, 0.0m);

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount"));
        Assert.AreEqual("79228162514264337593543950335", sum.ValueLexeme);
        Assert.AreEqual(2, sum.ContributingRecords);

        // The grouped fold is the same accumulator; everything lands in the unset group.
        await coordinator.ApplyAsync(Mutation("status", [
            new AddFieldOperation("status", "item", "status", "Status", "status_value", NendoStorageKind.Text, false, "singleChoice", ["open"]),
        ]));
        var grouped = await service.GroupAggregateRecordsAsync(new("item", "status", "sum", "amount"));
        Assert.AreEqual("79228162514264337593543950335", grouped.Groups.Single(group => group.Key is null).ValueLexeme);
    }

    [TestMethod]
    public async Task IntegerAggregatesStayIntegers()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(Mutation("create", [
            new CreateRecordOperation("c1", "item", "one", new Dictionary<string, object?> { ["quantity"] = 7L }),
            new CreateRecordOperation("c2", "item", "two", new Dictionary<string, object?> { ["quantity"] = -3L }),
        ]));

        Assert.AreEqual("4", (await service.AggregateRecordsAsync(new("item", "sum", "quantity"))).ValueLexeme);
        Assert.AreEqual("-3", (await service.AggregateRecordsAsync(new("item", "min", "quantity"))).ValueLexeme);
        Assert.AreEqual("7", (await service.AggregateRecordsAsync(new("item", "max", "quantity"))).ValueLexeme);
    }

    // A tile must describe the whole filtered set, and an empty one says so
    // rather than reporting zero, which would be a real value for a sum.
    [TestMethod]
    public async Task AnEmptySetIsStatedRatherThanReportedAsZero()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 5.00m);

        var none = await service.AggregateRecordsAsync(new("item", "sum", "amount")
        {
            Filters = [new("amount", "gt", JsonSerializer.SerializeToElement(1000m))],
        });
        Assert.IsNull(none.Value);
        Assert.IsNull(none.ValueLexeme);
        Assert.AreEqual(0, none.ContributingRecords);
    }

    // An unset field contributes nothing and never reads as zero.
    [TestMethod]
    public async Task UnsetValuesAreExcludedRatherThanCountedAsZero()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(Mutation("create", [
            new CreateRecordOperation("c1", "item", "one", new Dictionary<string, object?> { ["amount"] = 4.00m }),
            new CreateRecordOperation("c2", "item", "two", new Dictionary<string, object?> { ["label"] = "no amount" }),
        ]));

        var min = await service.AggregateRecordsAsync(new("item", "min", "amount"));
        Assert.AreEqual("4.00", min.ValueLexeme);
        Assert.AreEqual(1, min.ContributingRecords, "The unset record contributes nothing at all.");
    }

    [TestMethod]
    public async Task AnAggregateHonoursTheDeclaredFilter()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(Mutation("create", [
            new CreateRecordOperation("c1", "item", "one", new Dictionary<string, object?> { ["amount"] = 10.00m, ["label"] = "keep" }),
            new CreateRecordOperation("c2", "item", "two", new Dictionary<string, object?> { ["amount"] = 90.00m, ["label"] = "drop" }),
        ]));

        var sum = await service.AggregateRecordsAsync(new("item", "sum", "amount")
        {
            Filters = [new("label", "eq", JsonSerializer.SerializeToElement("keep"))],
        });
        Assert.AreEqual("10.00", sum.ValueLexeme);
    }

    [TestMethod]
    public async Task ANonNumericFieldAndAnUnknownAggregateAreRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 1.00m);

        await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.AggregateRecordsAsync(new("item", "sum", "label")));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.AggregateRecordsAsync(new("item", "avg", "amount")));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => service.AggregateRecordsAsync(new("item", "sum", "absent")));
    }

    // A pre-P5 file can hold a genuine REAL in a decimal column. That value
    // cannot be summed exactly, so the host refuses rather than returning a
    // number that looks exact and is not.
    [TestMethod]
    public async Task ALegacyFloatBackedValueIsRefusedRatherThanAggregatedLossily()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SchemaAsync(coordinator);
        await SeedAsync(coordinator, 0.5m);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // A closed fixture reproduces the pre-P5 NUMERIC representation.
        await using (var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE items SET amount_value = 0.5; UPDATE __nendo_manifest SET minimum_host_version = '1.1.0';";
            await command.ExecuteNonQueryAsync();
        }

        var legacy = await workspace.OpenAsync();
        var service = new NendoApplicationService(legacy);
        var failure = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => service.AggregateRecordsAsync(new("item", "sum", "amount")));
        Assert.AreEqual("aggregate-not-exact", failure.Code);
    }

    /// <summary>
    /// A Date joins the numbers for min and max (ADR-0004 2026-09-14 amendment,
    /// S4), which is what a range tile states. The extremes are chosen by ordinal
    /// comparison over the ISO form, so the answer needs no calendar arithmetic
    /// and no rounding rule — and the dates deliberately span a month boundary
    /// where a shorter form would sort wrongly.
    /// </summary>
    [TestMethod]
    public async Task ADateFieldHasASmallestAndALargestValue()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedDatesAsync(coordinator, "2026-09-14", "2026-01-03", "2026-10-01");

        var min = await service.AggregateRecordsAsync(new("item", "min", "due"));
        Assert.AreEqual("\"2026-01-03\"", min.ValueLexeme);
        Assert.AreEqual(3, min.ContributingRecords);

        var max = await service.AggregateRecordsAsync(new("item", "max", "due"));
        Assert.AreEqual("\"2026-10-01\"", max.ValueLexeme,
            "October sorts after September, which is only true of the fixed-width form.");
    }

    /// <summary>An empty set has no range. It is stated as empty, never as a date.</summary>
    [TestMethod]
    public async Task ADateRangeOverNoRecordsIsEmptyRatherThanADate()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        var min = await service.AggregateRecordsAsync(new("item", "min", "due"));
        Assert.IsNull(min.ValueLexeme);
        Assert.AreEqual(0, min.ContributingRecords);
    }

    /// <summary>
    /// The widening stops at the two extremes. A sum of dates is not a question
    /// with an answer, and it is refused rather than folded into a number.
    /// </summary>
    [TestMethod]
    public async Task ADateFieldHasNoSum()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedDatesAsync(coordinator, "2026-09-14");

        var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.AggregateRecordsAsync(new("item", "sum", "due")));
        StringAssert.Contains(refusal.Message, "smallest and a largest value, not a sum");
    }

    /// <summary>A text field still has no range: the widening named one scalar.</summary>
    [TestMethod]
    public async Task ATextFieldStillHasNoRange()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.AggregateRecordsAsync(new("item", "min", "label")));
        StringAssert.Contains(refusal.Message, "integer, decimal or date");
    }

    private static Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        coordinator.ApplyAsync(Mutation("schema", [
            new CreateEntityOperation("entity", "item", "Item", "items"),
            new AddFieldOperation("amount", "item", "amount", "Amount", "amount_value", NendoStorageKind.Decimal, false),
            new AddFieldOperation("quantity", "item", "quantity", "Quantity", "quantity_value", NendoStorageKind.Integer, false),
            new AddFieldOperation("label", "item", "label", "Label", "label_value", NendoStorageKind.Text, false),
            new AddFieldOperation("due", "item", "due", "Due", "due_value", NendoStorageKind.Date, false),
        ]));

    private static Task SeedDatesAsync(NendoWriteCoordinator coordinator, params string[] dates) =>
        coordinator.ApplyAsync(Mutation("seed-dates", dates
            .Select((due, index) => (NendoOperation)new CreateRecordOperation(
                $"d{index}", "item", $"d{index}", new Dictionary<string, object?> { ["due"] = due }))
            .ToList()));

    private static Task SeedAsync(NendoWriteCoordinator coordinator, params decimal[] amounts) =>
        coordinator.ApplyAsync(Mutation("seed", amounts
            .Select((amount, index) => (NendoOperation)new CreateRecordOperation(
                $"c{index}", "item", $"r{index}", new Dictionary<string, object?> { ["amount"] = amount }))
            .ToList()));

    private static NendoMutation Mutation(string key, IReadOnlyList<NendoOperation> operations) =>
        new("test", key, "test", key, operations);
}
