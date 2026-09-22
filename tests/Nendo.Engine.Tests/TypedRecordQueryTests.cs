using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class TypedRecordQueryTests
{
    [TestMethod]
    public async Task ExactDecimalOrderingPagesAcrossNullsAndTiesInBothDirections()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var query = new NendoRecordQuery("items", 2) { SortFieldId = "amount" };
        CollectionAssert.AreEqual(new[] { "a", "d", "e", "b", "c" }, await ReadAll(service, query));
        CollectionAssert.AreEqual(new[] { "c", "b", "d", "e", "a" }, await ReadAll(service, query with { Descending = true }));
        var first = await service.QueryRecordsAsync(query);
        await Code("invalid-cursor", () => service.QueryRecordsAsync(query with { Cursor = first.NextCursor, Descending = true }));
        await Code("invalid-cursor", () => service.QueryRecordsAsync(query with { Cursor = first.NextCursor, Filters = [Filter("title", "contains", "x")] }));
        await Code("invalid-cursor", () => service.QueryRecordsAsync(query with { Cursor = first.NextCursor, EntityId = "other" }));
        await service.SetFieldAsync(new("items", "c", "title", 1, "changed", new("test", "edit", "test")));
        await Code("stale-cursor", () => service.QueryRecordsAsync(query with { Cursor = first.NextCursor }));
    }

    [TestMethod]
    public async Task FiltersAreTypedLiteralAndDistinguishNullFromEmpty()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        async Task<string[]> Find(params NendoRecordFilter[] filters) =>
            (await service.QueryRecordsAsync(new("items") { Filters = filters })).Items.Select(r => r.RecordId).ToArray();
        CollectionAssert.AreEqual(new[] { "b" }, await Find(Filter("amount", "eq", 0.1234567890123456789012345678m)));
        CollectionAssert.AreEqual(new[] { "c" }, await Find(Filter("amount", "gt", 0.1234567890123456789012345678m)));
        CollectionAssert.AreEqual(new[] { "a" }, await Find(new NendoRecordFilter("amount", "isNull")));
        CollectionAssert.AreEqual(new[] { "a" }, await Find(Filter("title", "eq", "")));
        CollectionAssert.AreEqual(new[] { "b" }, await Find(Filter("title", "contains", "%_")));
        CollectionAssert.AreEqual(new[] { "c" }, await Find(Filter("title", "contains", "ÆØÅ")));
        CollectionAssert.AreEqual(new[] { "d", "e" }, await Find(Filter("amount", "lt", 0m), new("title", "isNotNull")));
        CollectionAssert.AreEqual(new[] { "a", "b", "c", "d", "e" }, await ReadAll(service, new("items", 1)));
        foreach (var query in new NendoRecordQuery[] {
            new("items") { SortFieldId = "other-field" },
            new("items") { Filters = [Filter("amount", "contains", "0")] },
            new("items") { Filters = [Filter("amount", "eq", "0.1")] },
            new("items") { Filters = [Filter("title", "eq", (string?)null)] },
            new("items") { Filters = [Filter("title", "injected SQL", "x")] },
            new("items") { Filters = Enumerable.Repeat(new NendoRecordFilter("title", "isNull"), 9).ToArray() },
        }) await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.QueryRecordsAsync(query));
    }

    private static NendoRecordFilter Filter<T>(string field, string op, T value) => new(field, op, JsonSerializer.SerializeToElement(value));
    private static async Task<string[]> ReadAll(NendoApplicationService service, NendoRecordQuery query)
    {
        var ids = new List<string>();
        do {
            var page = await service.QueryRecordsAsync(query);
            Assert.IsLessThanOrEqualTo(query.Limit, page.Items.Count);
            ids.AddRange(page.Items.Select(r => r.RecordId));
            query = query with { Cursor = page.NextCursor };
        } while (query.Cursor is not null);
        Assert.AreEqual(ids.Count, ids.Distinct().Count());
        return ids.ToArray();
    }
    private static async Task Code(string code, Func<Task> action) =>
        Assert.AreEqual(code, (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);

    private static async Task Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("query", "schema", "test", "Query fixture", [
            new CreateEntityOperation("type", "items", "Items", "data_items"),
            new AddFieldOperation("title", "items", "title", "Title", "title", NendoStorageKind.Text, false),
            new AddFieldOperation("amount", "items", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
            new CreateEntityOperation("other", "other", "Other", "data_other"),
            new AddFieldOperation("other-field", "other", "other-field", "Other", "other", NendoStorageKind.Text, false),
        ]));
        (string id, string title, decimal? amount)[] rows = [
            ("a", "", null), ("b", "Literal %_ value", 0.1234567890123456789012345678m),
            ("c", "æøå", 0.1234567890123456789012345679m), ("d", "duplicate", -10m), ("e", "duplicate", -10m),
        ];
        await coordinator.ApplyAsync(new("query", "data", "test", "Seed query values", rows.Select(r =>
            (NendoOperation)new CreateRecordOperation("create-" + r.id, "items", r.id,
                new Dictionary<string, object?> { ["title"] = r.title, ["amount"] = r.amount })).ToArray()));
    }
}
