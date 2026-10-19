using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0004 and ADR-0008: a summary tile, a breakdown and a ranking
/// total a calculated number, and a breakdown groups by a reference. Billable built a custom
/// Financial overview for its unbilled, outstanding, by-client and top-client widgets when each
/// of these was refused. The shapes here are Billable's: clients, and invoices with a calculated
/// outstanding amount.
/// </summary>
[TestClass]
public sealed class CalculatedWidgetTests
{
    [TestMethod]
    public async Task ATileTotalsACalculatedNumberExactlyOverItsFilters()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        async Task<string?> Total(string aggregate, params NendoRecordFilter[] filters) =>
            (await service.AggregateRecordsAsync(new NendoRecordAggregateQuery("invoices", aggregate, "outstanding") { Filters = filters })).ValueLexeme;

        // 100.10 + 0.20 + 250 + 33.333, and i5 has no amount, so its outstanding is empty and adds nothing.
        Assert.AreEqual("383.633", await Total("sum"), "A calculated total is not the exact sum of its records' results.");
        Assert.AreEqual("0.20", await Total("min"));
        Assert.AreEqual("250", await Total("max"));
        Assert.AreEqual("100.30", await Total("sum", Stage("open")), "A stored filter did not narrow the calculated total.");
        Assert.AreEqual("250", await Total("sum", new NendoRecordFilter("outstanding", "gt", JsonSerializer.SerializeToElement(100.10m))),
            "A filter on the calculation itself did not narrow its total.");
        Assert.AreEqual(4, (await service.AggregateRecordsAsync(new NendoRecordAggregateQuery("invoices", "sum", "outstanding"))).ContributingRecords);
    }

    [TestMethod]
    public async Task ATotalOfACalculationThatCouldNotBeWorkedOutIsRefusedWhole()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        // A paid amount larger than the total makes Refuse fire for that one invoice.
        await SetAsync(service, "i2", "paid", 5m);

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.AggregateRecordsAsync(new NendoRecordAggregateQuery("invoices", "sum", "outstanding")));
        Assert.AreEqual("calculated-total-incomplete", refused.Code);
        StringAssert.Contains(refused.Message, "Outstanding", StringComparison.Ordinal);
        StringAssert.Contains(refused.Message, "Paid more than invoiced", StringComparison.Ordinal);
        var grouped = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "sum", "outstanding")));
        Assert.AreEqual("calculated-total-incomplete", grouped.Code);
    }

    [TestMethod]
    public async Task ABreakdownGroupsByAReferenceLabelledAsItsRecords()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        var counted = await service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "count"));
        CollectionAssert.AreEqual(new[] { "c2", "c1", null }, counted.Groups.Select(group => group.Key).ToArray(),
            "The groups are not the clients the invoices point at, by label, then the unset group.");
        CollectionAssert.AreEqual(new[] { "Arbor", "Harbor", null }, counted.Groups.Select(group => group.Label).ToArray());
        CollectionAssert.AreEqual(new[] { "1", "2", "2" }, counted.Groups.Select(group => group.ValueLexeme).ToArray());

        var outstanding = await service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "sum", "outstanding"));
        CollectionAssert.AreEqual(new[] { "250", "100.30", "33.333" }, outstanding.Groups.Select(group => group.ValueLexeme).ToArray(),
            "A calculated total by client is not each client's exact outstanding.");
        var stored = await service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "sum", "amount"));
        CollectionAssert.AreEqual(new[] { "300", "100.30", "33.333" }, stored.Groups.Select(group => group.ValueLexeme).ToArray());

        var byStage = await service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "stage", "sum", "outstanding"));
        CollectionAssert.AreEqual(new[] { "open", "paid", null }, byStage.Groups.Select(group => group.Key).ToArray());
        CollectionAssert.AreEqual(new[] { "100.30", "283.333", null }, byStage.Groups.Select(group => group.ValueLexeme).ToArray());
    }

    [TestMethod]
    public async Task ABreakdownByAReferenceRefusesPastItsGroupsRatherThanAnsweringInPart()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var bound = NendoSemanticVocabulary.MaximumAggregateGroups - 1;
        // The seeded invoices already point at two clients.
        await ManyAsync(coordinator, bound - 2);
        var groups = (await service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "count"))).Groups;
        Assert.HasCount(bound + 1, groups, "The bound's own number of clients, and the unset group, did not answer.");

        await ManyAsync(coordinator, 1, first: bound);
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.GroupAggregateRecordsAsync(new NendoRecordGroupedAggregateQuery("invoices", "client", "count")));
        Assert.AreEqual("aggregate-too-many-groups", refused.Code);
    }

    [TestMethod]
    public async Task ARankingSortsByACalculatedNumberAndReadsItsLargest()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        var page = await service.QueryRecordsAsync(new NendoRecordQuery("invoices", 3)
        {
            SortFieldId = "outstanding",
            Descending = true,
            Filters = [new NendoRecordFilter("outstanding", "isNotNull", default)],
        });
        CollectionAssert.AreEqual(new[] { "i3", "i1", "i4" }, page.Items.Select(record => record.RecordId).ToArray());
        Assert.AreEqual("250", (await service.AggregateRecordsAsync(new NendoRecordAggregateQuery("invoices", "max", "outstanding"))).ValueLexeme);
    }

    [TestMethod]
    public async Task BillablesFrontPageCompilesNatively()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        NendoOperation[] Tile(string id, int position, string aggregate, string fieldId, params (string Property, object Value)[] extra) =>
        [
            new AddUiNodeOperation($"{id}-add", "front", id, "overview", "summaryTile", position),
            new SetUiPropertyOperation($"{id}-entity", "front", id, "entityId", "invoices"),
            new SetUiPropertyOperation($"{id}-aggregate", "front", id, "aggregate", aggregate),
            new SetUiPropertyOperation($"{id}-field", "front", id, "fieldId", fieldId),
            .. extra.Select(pair => (NendoOperation)new SetUiPropertyOperation($"{id}-{pair.Property}", "front", id, pair.Property, pair.Value)),
        ];
        await coordinator.ApplyAsync(new("test", "front", "test", "Financial overview", [
            new AddUiNodeOperation("overview-add", "front", "overview", null, "overviewSurface", 0),
            new SetUiPropertyOperation("overview-version", "front", "overview", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("overview-title", "front", "overview", "title", "Financial overview"),
            .. Tile("outstanding", 0, "sum", "outstanding", ("title", "Outstanding")),
            new AddUiNodeOperation("by-client-add", "front", "by-client", "overview", "breakdownChart", 1),
            new SetUiPropertyOperation("by-client-entity", "front", "by-client", "entityId", "invoices"),
            new SetUiPropertyOperation("by-client-aggregate", "front", "by-client", "aggregate", "sum"),
            new SetUiPropertyOperation("by-client-field", "front", "by-client", "fieldId", "outstanding"),
            new SetUiPropertyOperation("by-client-group", "front", "by-client", "groupByFieldId", "client"),
            new AddUiNodeOperation("top-add", "front", "top", "overview", "rankedList", 2),
            new SetUiPropertyOperation("top-entity", "front", "top", "entityId", "invoices"),
            new SetUiPropertyOperation("top-rank", "front", "top", "rankByFieldId", "outstanding"),
            new AddUiNodeOperation("top-number-add", "front", "top-number", "top", "fieldBinding", 0),
            new SetUiPropertyOperation("top-number-field", "front", "top-number", "fieldId", "number"),
        ]));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code} {d.SemanticId} {d.Message}")));
        Assert.AreEqual(NendoFormat.CalculatedTotalsMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        // A text calculation is still not a number, and a trend still buckets stored values only.
        await coordinator.ApplyAsync(new("test", "text", "test", "Total a label",
            [new SetUiPropertyOperation("outstanding-field-text", "front", "outstanding", "fieldId", "code")]));
        Assert.IsTrue((await service.CompileSemanticUiAsync()).Diagnostics.Any(d => d.Code == "NUI294" && d.SemanticId == "outstanding"),
            "A tile totalling a text calculation compiled.");
    }

    private static NendoRecordFilter Stage(string stage) => new("stage", "eq", JsonSerializer.SerializeToElement(stage));

    /// <summary>
    /// Two clients, Harbor and Arbor, and five invoices: i1 and i2 open for Harbor, i3 paid for
    /// Arbor, i4 paid with no client, i5 with no amount and no stage. Outstanding is the amount
    /// less what was paid, empty without an amount, and refused when more was paid than invoiced.
    /// </summary>
    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Billable", [
            new CreateEntityOperation("clients", "clients", "Clients", "clients"),
            new AddFieldOperation("c-name", "clients", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("invoices", "invoices", "Invoices", "invoices"),
            new AddFieldOperation("i-number", "invoices", "number", "Number", "number", NendoStorageKind.Text, true),
            new AddFieldOperation("i-client", "invoices", "client", "Client", "client", NendoStorageKind.Reference, false),
            new AddFieldOperation("i-amount", "invoices", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
            new AddFieldOperation("i-paid", "invoices", "paid", "Paid", "paid", NendoStorageKind.Decimal, false),
            new AddFieldOperation("i-stage", "invoices", "stage", "Stage", "stage", NendoStorageKind.Text, false, "singleChoice", ["open", "paid"]),
            new ConfigureReferenceOperation("bind", "invoices", "client", "clients", "name", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        NendoBehaviourBinding Field(string id, string field, NendoBehaviourScalar kind) =>
            NendoBehaviourBinding.SameRecordField(id, "invoices", field, kind, true);
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Calculations", [
            new SetBehaviourDefinitionOperation("outstanding", new NendoCalculationDefinition(
                "invoice.outstanding", "invoices", "outstanding", "Outstanding", NendoBehaviourScalar.Decimal, true,
                "IsEmpty(p) ? a : (p > a ? Refuse('Paid more than invoiced.') : a - p)",
                [Field("a", "amount", NendoBehaviourScalar.Decimal), Field("p", "paid", NendoBehaviourScalar.Decimal)]), revision),
            new SetBehaviourDefinitionOperation("code", new NendoCalculationDefinition(
                "invoice.code", "invoices", "code", "Code", NendoBehaviourScalar.Text, false, "Concat('INV-', n)",
                [NendoBehaviourBinding.SameRecordField("n", "invoices", "number", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        await service.CreateRecordsAsync(new("clients",
        [
            new("c1", new Dictionary<string, object?> { ["name"] = "Harbor" }),
            new("c2", new Dictionary<string, object?> { ["name"] = "Arbor" }),
        ], Context("clients")));
        var targets = new Dictionary<string, long> { ["client"] = 1 };
        await service.CreateRecordsAsync(new("invoices",
        [
            new("i1", new Dictionary<string, object?> { ["number"] = "1", ["client"] = "c1", ["amount"] = 100.10m, ["stage"] = "open" }, targets),
            new("i2", new Dictionary<string, object?> { ["number"] = "2", ["client"] = "c1", ["amount"] = 0.20m, ["stage"] = "open" }, targets),
            new("i3", new Dictionary<string, object?> { ["number"] = "3", ["client"] = "c2", ["amount"] = 300m, ["paid"] = 50m, ["stage"] = "paid" }, targets),
            new("i4", new Dictionary<string, object?> { ["number"] = "4", ["amount"] = 33.333m, ["stage"] = "paid" }),
            new("i5", new Dictionary<string, object?> { ["number"] = "5" }),
        ], Context("invoices")));
        return service;
    }

    /// <summary>More clients, each with one invoice, so a breakdown by client has that many more groups.</summary>
    private static async Task ManyAsync(NendoWriteCoordinator coordinator, int count, int first = 0)
    {
        var operations = Enumerable.Range(first, count).SelectMany(index => new NendoOperation[]
        {
            new CreateRecordOperation($"many-client-{index}", "clients", $"m{index}", new Dictionary<string, object?> { ["name"] = $"Client {index:D4}" }),
            new CreateRecordOperation($"many-invoice-{index}", "invoices", $"mi{index}",
                new Dictionary<string, object?> { ["number"] = $"M{index}", ["client"] = $"m{index}", ["amount"] = 1m },
                new Dictionary<string, long> { ["client"] = 1 }),
        }).ToArray();
        foreach (var (chunk, index) in operations.Chunk(1_000).Select((chunk, index) => (chunk, index)))
            await coordinator.ApplyAsync(new("test", $"many-{first}-{index}", "test", "Many clients", chunk));
    }

    private static async Task SetAsync(NendoApplicationService service, string recordId, string fieldId, object? value)
    {
        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId).RecordVersion;
        await service.SetFieldAsync(new NendoSetFieldRequest("invoices", recordId, fieldId, version, value, Context($"set-{recordId}-{fieldId}")));
    }

    private static NendoRequestContext Context(string key) => new("calculated-widget-tests", key, "test");
}
