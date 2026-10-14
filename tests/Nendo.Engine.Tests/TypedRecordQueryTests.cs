using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class TypedRecordQueryTests
{
    [TestMethod]
    public async Task RecordWindowsSeekLocateAndBindTheCompleteQueryAndRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var query = new NendoRecordQuery("items") { SortFieldId = "amount" };
        var first = await service.QueryRecordWindowAsync(new(query, 0, 2));
        CollectionAssert.AreEqual(new[] { "a", "d" }, first.Items.Select(row => row.RecordId).ToArray());
        Assert.IsTrue(first.HasMore);
        var distant = await service.QueryRecordWindowAsync(new(query, 4, 2, first.QueryToken));
        CollectionAssert.AreEqual(new[] { "c" }, distant.Items.Select(row => row.RecordId).ToArray());
        Assert.IsFalse(distant.HasMore);
        Assert.AreEqual(4, distant.Start);
        var located = await service.QueryRecordWindowAsync(new(query, 0, 2, first.QueryToken, "b"));
        Assert.AreEqual(3, located.LocatedIndex);
        Assert.AreEqual(2, located.Start);
        CollectionAssert.AreEqual(new[] { "e", "b" }, located.Items.Select(row => row.RecordId).ToArray());
        var filtered = query with { Filters = [Filter("amount", "lt", 0m)] };
        var negative = await service.QueryRecordWindowAsync(new(filtered, 0, 2));
        CollectionAssert.AreEqual(new[] { "d", "e" }, negative.Items.Select(row => row.RecordId).ToArray());
        Assert.IsFalse(negative.HasMore, "An exact block must signal its end without an extra read.");
        var removed = await service.QueryRecordWindowAsync(new(filtered, 900, 2, negative.QueryToken, "b"));
        Assert.IsNull(removed.LocatedIndex);
        Assert.AreEqual(0, removed.Start, "A missing anchor must return to the first block.");
        Assert.HasCount(2, removed.Items);
        await Code("invalid-cursor", () => service.QueryRecordWindowAsync(new(filtered, 0, 2, first.QueryToken)));
        await Code("invalid-cursor", () => service.QueryRecordWindowAsync(new(query with { Descending = true }, 0, 2, first.QueryToken)));
        await Code("invalid-cursor", () => service.QueryRecordsAsync(query with { Cursor = first.QueryToken }));
        await Code("invalid-limit", () => service.QueryRecordWindowAsync(new(query, 0, 201)));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.QueryRecordWindowAsync(new(query, -1)));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.QueryRecordWindowAsync(new(query, int.MaxValue)));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.QueryRecordWindowAsync(new(query with { Cursor = "cursor" })));
        await service.SetFieldAsync(new("items", "c", "title", 1, "changed", new("test", "window-edit", "test")));
        await Code("stale-cursor", () => service.QueryRecordWindowAsync(new(query, 2, 2, first.QueryToken)));
        var fresh = await service.QueryRecordWindowAsync(new(query));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        service = new(await workspace.OpenAsync());
        await Code("invalid-cursor", () => service.QueryRecordWindowAsync(new(query, QueryToken: fresh.QueryToken)));
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var snapshot = new NendoApplicationService(readOnly);
        var safe = await snapshot.QueryRecordWindowAsync(new(query, 2, 2, LocateRecordId: "b"));
        CollectionAssert.AreEqual(new[] { "e", "b" }, safe.Items.Select(row => row.RecordId).ToArray());
        Assert.AreEqual(3, safe.LocatedIndex);
        var absent = await snapshot.QueryRecordWindowAsync(new(filtered, 900, 2, LocateRecordId: "b"));
        Assert.AreEqual(0, absent.Start);
        Assert.HasCount(2, absent.Items);
        var descending = await snapshot.QueryRecordWindowAsync(new(query with { Descending = true }, 0, 2));
        CollectionAssert.AreEqual(new[] { "c", "b" }, descending.Items.Select(row => row.RecordId).ToArray());
    }

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

    /// <summary>
    /// PERF-02: a related list reads its child records by one equality on the reference, the read
    /// ADR-0003's reference index exists for. Every filter was a host function over the column, which
    /// no index can serve, so the read asked the function about every row of the child type. An
    /// equality SQLite answers the same way now sits beside it, and the read seeks the index.
    /// Counted as rows the function is asked about, not timed.
    /// </summary>
    [TestMethod]
    public async Task ARelatedListSeeksTheReferenceIndexRatherThanAskingAboutEveryRow()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Folders and notes", [
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-folder", "notes", "folder", "Folder", "folder_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "folder", "folders", "name", 0),
        ]));
        await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Create, "folders", "small", new Dictionary<string, object?> { ["name"] = "Small" }),
             new(NendoRecordWriteKind.Create, "folders", "large", new Dictionary<string, object?> { ["name"] = "Large" })],
            new("test", "folders", "test")));
        for (var batch = 0; batch < 4; batch++)
            await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
                Enumerable.Range(0, 150).Select(index => new NendoRecordWrite(NendoRecordWriteKind.Create, "notes", $"n-{batch}-{index}",
                    new Dictionary<string, object?> { ["label"] = $"Note {batch}-{index}", ["folder"] = batch == 0 && index < 3 ? "small" : "large" },
                    ExpectedTargetVersions: new Dictionary<string, long> { ["folder"] = 1 })).ToList(),
                new("test", $"notes-{batch}", "test")));

        var before = coordinator.FilterCallbacks;
        var related = await service.QueryRecordsAsync(new("notes") { Filters = [Filter("folder", "eq", "small")] });
        var asked = coordinator.FilterCallbacks - before;
        CollectionAssert.AreEqual(new[] { "n-0-0", "n-0-1", "n-0-2" }, related.Items.Select(record => record.RecordId).Order(StringComparer.Ordinal).ToArray());
        Assert.IsLessThanOrEqualTo(20L, asked, $"The related list asked its filter about {asked} rows of 600 to find 3: it scanned the child type instead of seeking the reference index.");

        before = coordinator.FilterCallbacks;
        var loose = await service.QueryRecordsAsync(new("notes") { Filters = [new NendoRecordFilter("folder", "isNull")] });
        Assert.IsEmpty(loose.Items);
        Assert.IsLessThanOrEqualTo(20L, coordinator.FilterCallbacks - before, "A filter for a missing reference scanned the child type.");
    }

    /// <summary>
    /// PERF-08: the check before every commit counts each table once. The record tables are among
    /// the tables it counts, and they were counted a second time for the bound on records, on every
    /// one-field edit.
    /// </summary>
    [TestMethod]
    public async Task ACommitCountsEachTableOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        await coordinator.ApplyAsync(new("test", "more", "test", "Two more types", [
            new CreateEntityOperation("people", "people", "People", "people"),
            new AddFieldOperation("p-name", "people", "people-name", "Name", "name", NendoStorageKind.Text, false),
            new CreateEntityOperation("places", "places", "Places", "places"),
            new AddFieldOperation("pl-name", "places", "places-name", "Name", "name", NendoStorageKind.Text, false),
        ]));
        var before = coordinator.CommitTableCounts;
        await service.SetFieldAsync(new("items", "c", "title", 1, "changed", new("test", "edit-once", "test")));
        var counted = coordinator.CommitTableCounts - before;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await using var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={workspace.FilePath};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM sqlite_schema WHERE type = 'table';";
        var tables = Convert.ToInt64(await command.ExecuteScalarAsync());
        Assert.AreEqual(tables, counted, $"A one-field edit counted {counted} tables in a file of {tables}: the record tables were counted twice.");
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
