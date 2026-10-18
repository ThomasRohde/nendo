namespace Nendo.Engine.Tests;

/// <summary>
/// W-247 (ADR-0008 amendment of 2026-10-18): the budgets are sized for a business app's rollups and
/// batches. Billable's client rollup failed at 32 entries, its batch of defaulted entries at 20 and
/// its invoice chain at nine definitions. The shapes here are Billable's: clients, projects, time
/// entries and invoices, with its defensive formulas and missing inputs. Each limit still refuses
/// whole at its new boundary.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourBudgetSizingTests
{
    public TestContext TestContext { get; set; } = null!;

    [TestMethod]
    [DataRow(60)]
    [DataRow(500)]
    public async Task ABillableSizedRollupTotalsEveryEntryWithMissingInputs(int entries)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, EntryAmount(), EntryBillable(),
            ProjectSum("project.amount", "projectAmount", "entry.amount"), ProjectSum("project.billable", "projectBillable", "entry.billable"),
            ClientSum("client.amount", "clientAmount", "project.amount"), ClientSum("client.billable", "clientBillable", "project.billable"));
        var expected = await SeedAsync(service, entries);

        var records = (await service.GetSnapshotAsync()).Records;
        foreach (var client in records.Where(record => record.EntityId == "clients"))
        {
            Assert.AreEqual(expected.Amount[client.RecordId], Value(client, "clientAmount"), $"{client.RecordId} amount over {entries} entries");
            Assert.AreEqual(expected.Billable[client.RecordId], Value(client, "clientBillable"), $"{client.RecordId} billable over {entries} entries");
        }
    }

    /// <summary>A second sum over the same members works none of them out again.</summary>
    [TestMethod]
    public async Task TwoSumsOverTheSameMembersWorkEachMemberOutOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, EntryAmount(),
            ProjectSum("project.amount", "projectAmount", "entry.amount"), ClientSum("client.amount", "clientAmount", "project.amount"));
        await SeedAsync(service, 60);
        var one = await MinimumWorkUnitsAsync(coordinator, service);

        await InstallAsync(coordinator, service, ClientSum("client.again", "clientAgain", "project.amount"));
        var two = await MinimumWorkUnitsAsync(coordinator, service);
        TestContext.WriteLine($"Client c0, 60 entries: one sum {one} work units, two sums {two}.");

        // Without the memo the second sum worked both projects and their 24 entries out again,
        // which doubled the work; with it the second sum costs its two rows and a little more.
        Assert.IsLessThan(one + 40, two, $"One sum spent {one} work units and two spent {two}.");
    }

    /// <summary>A member's calculation has its own function calls, as its own read would.</summary>
    [TestMethod]
    public async Task EachMemberHasItsOwnFunctionCallsAndRefusesPastThemByPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Entry("entry.amount", "RoundAway(RoundAway(h * r, 2), 2)"),
            ProjectSum("project.amount", "projectAmount", "entry.amount"));
        await SeedAsync(service, 0);
        await EntriesAsync(service, "p0", 0, 5);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { FunctionCalls = 2 };

        // Five entries of two calls each: ten calls in all, two per entry.
        var within = Calculation(await RecordAsync(service, "p0"), "projectAmount");
        Assert.AreEqual(NendoCalculationState.Value, within.State, $"A member's calls came out of the project's allowance: {within.ErrorMessage}");

        coordinator.BehaviourLimits = NendoBehaviourLimits.Default;
        await InstallAsync(coordinator, service, Entry("entry.amount", "RoundAway(RoundAway(RoundAway(h * r, 2), 2), 2)"));
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { FunctionCalls = 2 };
        var refused = Calculation(await RecordAsync(service, "p0"), "projectAmount");
        Assert.AreEqual(NendoCalculationState.Error, refused.State);
        StringAssert.Contains(refused.ErrorMessage, "reached the function call limit for one record");
        StringAssert.Contains(refused.ErrorMessage, "It ran out inside entry.amount of record e0.");
    }

    /// <summary>A related record's own fields are work; the related records it is one of still bound the total.</summary>
    [TestMethod]
    public async Task OneAggregateReadsAtMostTheRelatedRecordLimit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, EntryAmount(), ProjectSum("project.amount", "projectAmount", "entry.amount"));
        await SeedAsync(service, 0);
        await EntriesAsync(service, "p0", 0, 256);
        await EntriesAsync(service, "p1", 1000, 257);

        Assert.AreEqual(NendoCalculationState.Value, Calculation(await RecordAsync(service, "p0"), "projectAmount").State,
            "256 entries, each reading two of its own fields, did not fit 256 related records.");
        var past = Calculation(await RecordAsync(service, "p1"), "projectAmount");
        Assert.AreEqual(NendoCalculationState.Error, past.State);
        StringAssert.Contains(past.ErrorMessage, "More than 256 related records contribute to this calculation");
    }

    /// <summary>
    /// A batch's related records are several records' worth, but no total an action writes reads
    /// more of them than one record may, so a save never writes a total that a read refuses.
    /// </summary>
    [TestMethod]
    public async Task ABatchsActionReadsNoWiderATotalThanARead()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SeedAsync(service, 0);
        await EntriesAsync(service, "p0", 0, 255);
        await InstallAsync(coordinator, service,
            new NendoActionDefinition("project.hours", "Project hours",
            [
                NendoActionStep.SetField("total", NendoActionTarget.Referenced("entryProject"), new NendoActionAssignment("projectHours", "v",
                    [NendoBehaviourBinding.RelatedCount("v", "projects", "entries", "entryProject")], [])),
            ]),
            new NendoTriggerDefinition("entry.added", "entries", "When an entry is added", NendoTriggerEvents.Created, "project.hours"));
        TestBehaviourAuthority.Approving(coordinator);

        // A batch of two, one entry for each of two projects, so the batch has 512 related records.
        async Task PairAsync(int index)
        {
            var records = (await service.GetSnapshotAsync()).Records;
            long Version(string id) => records.Single(record => record.RecordId == id).RecordVersion;
            await service.CreateRecordsAsync(new("entries",
            [
                new($"e{index}", new Dictionary<string, object?> { ["entryProject"] = "p0" }, new Dictionary<string, long> { ["entryProject"] = Version("p0") }),
                new($"x{index}", new Dictionary<string, object?> { ["entryProject"] = "p1" }, new Dictionary<string, long> { ["entryProject"] = Version("p1") }),
            ], Context($"pair-{index}")));
        }

        // p0 then has 256 entries, one record's related records, so its total is written.
        await PairAsync(255);
        Assert.AreEqual(256m, (await RecordAsync(service, "p0")).Values["projectHours"].GetDecimal());

        // One more is 257: past one record's 256, though the batch has 512.
        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => PairAsync(256));
        StringAssert.Contains(refused.Message, "More than 256 related records contribute to this calculation");
    }

    /// <summary>Billable's batch: three defaulting steps on each of 50 created entries.</summary>
    [TestMethod]
    public async Task AFiftyRecordBatchWithThreeDefaultingStepsCommits()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Defaults(), Created());
        TestBehaviourAuthority.Approving(coordinator);
        await SeedAsync(service, 0);

        await BatchAsync(service, 50, "fifty");

        var created = (await service.GetSnapshotAsync()).Records.Where(record => record.RecordId.StartsWith("b", StringComparison.Ordinal)).ToArray();
        Assert.HasCount(50, created);
        Assert.IsTrue(created.All(record => record.Values["entryRate"].GetDecimal() == 120m && record.Values["entryBillable"].GetBoolean()
            && record.Values["entryHours"].GetDecimal() == 1m), "A default was not written.");
    }

    /// <summary>Each record a save names brings its own automatic changes, and no more.</summary>
    [TestMethod]
    public async Task ASavesChangesAreItsRecordsOwnAndRefuseWholePastThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Defaults(), Created());
        TestBehaviourAuthority.Approving(coordinator);
        await SeedAsync(service, 0);

        // Four entries of three changes each: twelve, exactly four records' allowance of three.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = 3 };
        await BatchAsync(service, 4, "exact");

        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = 2 };
        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => BatchAsync(service, 4, "past", first: 10));
        StringAssert.Contains(refused.Message, "reached the automatic change limit");
        StringAssert.Contains(refused.Message, "8 of 8 automatic changes");
        Assert.IsEmpty((await service.GetSnapshotAsync()).Records.Where(record => record.RecordId is "b10" or "b11" or "b12" or "b13").ToArray(),
            "A refused batch created records.");
    }

    /// <summary>Reading the records a save names, and the ones it made, is work rather than a related record.</summary>
    [TestMethod]
    public async Task ASavesOwnRecordsAreNotItsRelatedRecords()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Defaults(), Created());
        TestBehaviourAuthority.Approving(coordinator);
        await SeedAsync(service, 0);

        // Each entry reads one related record, its project's rate, and re-reads itself about a
        // dozen times; one related record per entry is enough.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 1 };
        await BatchAsync(service, 4, "own");
        Assert.HasCount(4, (await service.GetSnapshotAsync()).Records.Where(record => record.RecordId.StartsWith("b", StringComparison.Ordinal)).ToArray());
    }

    /// <summary>The work units are the save's whatever its size, and a refusal names the step that spent most.</summary>
    [TestMethod]
    public async Task AWorkRefusalNamesTheStepThatSpentMost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Defaults(), Created());
        TestBehaviourAuthority.Approving(coordinator);
        await SeedAsync(service, 0);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { WorkUnits = 300 };

        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => BatchAsync(service, 50, "work"));
        TestContext.WriteLine(refused.Message);
        StringAssert.Contains(refused.Message, "reached the work limit for a single save");
        StringAssert.Contains(refused.Message, "of 300 work units");
        StringAssert.Matches(refused.Message, new System.Text.RegularExpressions.Regex(
            @"The step that spent most was step (rate|billable|hours) of action 'Entry defaults', with \d+ work units\."));
        Assert.AreEqual("work", refused.Spend?.Allowance);
        Assert.IsNotNull(refused.Spend?.HeaviestStep);
        StringAssert.Contains(refused.Message, "while the 300 work units are the save's whatever its size");
    }

    /// <summary>Billable's invoice: nine calculations deep, refused at eight before W-247.</summary>
    [TestMethod]
    public async Task TheNineDeepInvoiceChainInstallsAndTotals()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "invoice-schema", "test", "Invoices", [
            new CreateEntityOperation("clients", "clients", "Clients", "clients"),
            new AddFieldOperation("c-name", "clients", "clientName", "Name", "client_name", NendoStorageKind.Text, true),
            new CreateEntityOperation("invoices", "invoices", "Invoices", "invoices"),
            new AddFieldOperation("i-no", "invoices", "invoiceNumber", "Number", "invoice_number", NendoStorageKind.Text, true),
            new AddFieldOperation("i-client", "invoices", "invoiceClient", "Client", "invoice_client", NendoStorageKind.Reference, true),
            new AddFieldOperation("i-paid", "invoices", "invoicePaid", "Paid", "invoice_paid", NendoStorageKind.Decimal, false),
            new ConfigureReferenceOperation("i-bind", "invoices", "invoiceClient", "clients", "clientName", 0),
            new CreateEntityOperation("lines", "lines", "Lines", "lines"),
            new AddFieldOperation("l-invoice", "lines", "lineInvoice", "Invoice", "line_invoice", NendoStorageKind.Reference, true),
            new AddFieldOperation("l-qty", "lines", "lineQuantity", "Quantity", "line_quantity", NendoStorageKind.Decimal, false),
            new AddFieldOperation("l-price", "lines", "linePrice", "Price", "line_price", NendoStorageKind.Decimal, false),
            new ConfigureReferenceOperation("l-bind", "lines", "lineInvoice", "invoices", "invoiceNumber", 0),
        ]));
        NendoBehaviourBinding Own(string id, string calculation) =>
            NendoBehaviourBinding.SameRecordCalculation(id, "invoices", calculation, NendoBehaviourScalar.Decimal, false);
        NendoCalculationDefinition Invoice(string id, string field, string formula, params NendoBehaviourBinding[] bindings) =>
            new(id, "invoices", field, field, NendoBehaviourScalar.Decimal, false, formula, bindings);
        var paid = NendoBehaviourBinding.SameRecordField("p", "invoices", "invoicePaid", NendoBehaviourScalar.Decimal, true);
        await InstallAsync(coordinator, service,
            new NendoCalculationDefinition("line.amount", "lines", "lineAmount", "Amount", NendoBehaviourScalar.Decimal, false,
                "IsEmpty(q) or IsEmpty(u) ? 0 : RoundAway(q * u, 2)",
                [NendoBehaviourBinding.SameRecordField("q", "lines", "lineQuantity", NendoBehaviourScalar.Decimal, true),
                 NendoBehaviourBinding.SameRecordField("u", "lines", "linePrice", NendoBehaviourScalar.Decimal, true)]),
            Invoice("invoice.subtotal", "subtotal", "v",
                NendoBehaviourBinding.RelatedSum("v", "invoices", "lines", "lineInvoice", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("line.amount")),
            Invoice("invoice.discount", "discount", "RoundAway(s * 0.1, 2)", Own("s", "invoice.subtotal")),
            Invoice("invoice.taxable", "taxable", "s - d", Own("s", "invoice.subtotal"), Own("d", "invoice.discount")),
            Invoice("invoice.tax", "tax", "RoundAway(t * 0.25, 2)", Own("t", "invoice.taxable")),
            Invoice("invoice.total", "total", "t + x", Own("t", "invoice.taxable"), Own("x", "invoice.tax")),
            Invoice("invoice.balance", "balance", "IsEmpty(p) ? t : t - p", Own("t", "invoice.total"), paid),
            Invoice("invoice.outstanding", "outstanding", "b > 0 ? b : 0", Own("b", "invoice.balance")),
            new NendoCalculationDefinition("client.outstanding", "clients", "clientOutstanding", "Outstanding", NendoBehaviourScalar.Decimal, false, "v",
                [NendoBehaviourBinding.RelatedSum("v", "clients", "invoices", "invoiceClient", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("invoice.outstanding")]));

        await service.CreateRecordAsync(new("clients", "c0", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c0")));
        var client = (await RecordAsync(service, "c0")).RecordVersion;
        await service.CreateRecordsAsync(new("invoices",
        [
            new("i0", new Dictionary<string, object?> { ["invoiceNumber"] = "INV-1", ["invoiceClient"] = "c0", ["invoicePaid"] = 100m },
                new Dictionary<string, long> { ["invoiceClient"] = client }),
            new("i1", new Dictionary<string, object?> { ["invoiceNumber"] = "INV-2", ["invoiceClient"] = "c0" },
                new Dictionary<string, long> { ["invoiceClient"] = client }),
        ], Context("invoices")));
        foreach (var invoice in new[] { "i0", "i1" })
        {
            var version = (await RecordAsync(service, invoice)).RecordVersion;
            await service.CreateRecordsAsync(new("lines", [.. Enumerable.Range(0, 3).Select(index => new NendoCreateRecordEntry($"{invoice}l{index}",
                new Dictionary<string, object?> { ["lineInvoice"] = invoice, ["lineQuantity"] = 2m, ["linePrice"] = 50m },
                new Dictionary<string, long> { ["lineInvoice"] = version }))], Context($"lines-{invoice}")));
        }

        // Each invoice: 300 subtotal, 30 discount, 270 taxable, 67.5 tax, 337.5 total; i0 paid 100.
        Assert.AreEqual(237.5m + 337.5m, Value(await RecordAsync(service, "c0"), "clientOutstanding"));
    }

    private static NendoBehaviourBinding Hours => NendoBehaviourBinding.SameRecordField("h", "entries", "entryHours", NendoBehaviourScalar.Decimal, true);
    private static NendoBehaviourBinding Rate => NendoBehaviourBinding.SameRecordField("r", "entries", "entryRate", NendoBehaviourScalar.Decimal, true);

    private static NendoCalculationDefinition Entry(string id, string formula) =>
        new(id, "entries", "entryAmount", "Amount", NendoBehaviourScalar.Decimal, false, formula, [Hours, Rate]);

    /// <summary>Billable's defensive amount: nothing where an input is missing.</summary>
    private static NendoCalculationDefinition EntryAmount() => Entry("entry.amount", "IsEmpty(h) or IsEmpty(r) ? 0 : RoundAway(h * r, 2)");

    private static NendoCalculationDefinition EntryBillable() =>
        new("entry.billable", "entries", "entryBillableAmount", "Billable amount", NendoBehaviourScalar.Decimal, false,
            "IsEmpty(b) ? 0 : (b ? a : 0)",
            [NendoBehaviourBinding.SameRecordField("b", "entries", "entryBillable", NendoBehaviourScalar.Boolean, true),
             NendoBehaviourBinding.SameRecordCalculation("a", "entries", "entry.amount", NendoBehaviourScalar.Decimal, false)]);

    private static NendoCalculationDefinition ProjectSum(string id, string field, string member) =>
        new(id, "projects", field, field, NendoBehaviourScalar.Decimal, false, "v",
            [NendoBehaviourBinding.RelatedSum("v", "projects", "entries", "entryProject", null, NendoBehaviourScalar.Decimal).WithMemberCalculation(member)]);

    private static NendoCalculationDefinition ClientSum(string id, string field, string member) =>
        new(id, "clients", field, field, NendoBehaviourScalar.Decimal, false, "v",
            [NendoBehaviourBinding.RelatedSum("v", "clients", "projects", "projectClient", null, NendoBehaviourScalar.Decimal).WithMemberCalculation(member)]);

    private static NendoActionDefinition Defaults()
    {
        var projectRate = NendoBehaviourBinding.ReferenceTraversal("pr", "entries", "entryProject", "projects", "projectRate", NendoBehaviourScalar.Decimal, true);
        var billable = NendoBehaviourBinding.SameRecordField("b", "entries", "entryBillable", NendoBehaviourScalar.Boolean, true);
        return new("entry.defaults", "Entry defaults",
        [
            NendoActionStep.SetField("rate", NendoActionTarget.EventRecord, new NendoActionAssignment("entryRate", "IsEmpty(r) ? pr : r", [Rate, projectRate], [])),
            NendoActionStep.SetField("billable", NendoActionTarget.EventRecord, new NendoActionAssignment("entryBillable", "IsEmpty(b) ? true : b", [billable], [])),
            NendoActionStep.SetField("hours", NendoActionTarget.EventRecord, new NendoActionAssignment("entryHours", "IsEmpty(h) ? 1 : h", [Hours], [])),
        ]);
    }

    private static NendoTriggerDefinition Created() =>
        new("entry.created", "entries", "When an entry is created", NendoTriggerEvents.Created, "entry.defaults");

    private static async Task BatchAsync(NendoApplicationService service, int count, string key, int first = 0)
    {
        var version = (await RecordAsync(service, "p0")).RecordVersion;
        await service.CreateRecordsAsync(new("entries",
            [.. Enumerable.Range(first, count).Select(index => new NendoCreateRecordEntry($"b{index}",
                new Dictionary<string, object?> { ["entryProject"] = "p0" }, new Dictionary<string, long> { ["entryProject"] = version }))],
            Context(key)));
    }

    private sealed record Expected(Dictionary<string, decimal> Amount, Dictionary<string, decimal> Billable);

    /// <summary>
    /// Three clients and five projects (c0: p0 p1, c1: p2 p3, c2: p4), and entries dealt round the
    /// projects: every seventh has no hours, every eleventh no rate, and every third is not billable,
    /// every thirteenth not marked at all.
    /// </summary>
    private static async Task<Expected> SeedAsync(NendoApplicationService service, int entries)
    {
        var owners = new[] { "c0", "c0", "c1", "c1", "c2" };
        foreach (var client in owners.Distinct())
            await service.CreateRecordAsync(new("clients", client, new Dictionary<string, object?> { ["clientName"] = client }, Context(client)));
        for (var p = 0; p < owners.Length; p++)
        {
            var version = (await RecordAsync(service, owners[p])).RecordVersion;
            await service.CreateRecordAsync(new("projects", $"p{p}",
                new Dictionary<string, object?> { ["projectTitle"] = $"P{p}", ["projectClient"] = owners[p], ["projectRate"] = 120m }, Context($"p{p}"))
            { ExpectedTargetVersions = new Dictionary<string, long> { ["projectClient"] = version } });
        }
        var expected = new Expected(owners.Distinct().ToDictionary(id => id, _ => 0m), owners.Distinct().ToDictionary(id => id, _ => 0m));
        for (var p = 0; p < owners.Length; p++)
        {
            var version = (await RecordAsync(service, $"p{p}")).RecordVersion;
            var batch = new List<NendoCreateRecordEntry>();
            for (var index = p; index < entries; index += owners.Length)
            {
                decimal? hours = index % 7 == 3 ? null : 0.25m * (1 + index % 9);
                decimal? rate = index % 11 == 5 ? null : 95m + index % 4 * 12.5m;
                bool? billable = index % 13 == 6 ? null : index % 3 != 0;
                var amount = hours is null || rate is null ? 0m : decimal.Round(hours.Value * rate.Value, 2, MidpointRounding.AwayFromZero);
                expected.Amount[owners[p]] += amount;
                if (billable == true) expected.Billable[owners[p]] += amount;
                batch.Add(new($"e{index}", new Dictionary<string, object?>
                    { ["entryProject"] = $"p{p}", ["entryHours"] = hours, ["entryRate"] = rate, ["entryBillable"] = billable },
                    new Dictionary<string, long> { ["entryProject"] = version }));
            }
            foreach (var chunk in batch.Chunk(50))
            {
                version = (await RecordAsync(service, $"p{p}")).RecordVersion;
                await service.CreateRecordsAsync(new("entries",
                    [.. chunk.Select(entry => entry with { ExpectedTargetVersions = new Dictionary<string, long> { ["entryProject"] = version } })],
                    Context($"entries-{p}-{chunk[0].RecordId}")));
            }
        }
        return expected;
    }

    private static async Task EntriesAsync(NendoApplicationService service, string project, int first, int count)
    {
        foreach (var chunk in Enumerable.Range(first, count).Chunk(50))
        {
            var version = (await RecordAsync(service, project)).RecordVersion;
            await service.CreateRecordsAsync(new("entries", [.. chunk.Select(index => new NendoCreateRecordEntry($"e{index}",
                new Dictionary<string, object?> { ["entryProject"] = project, ["entryHours"] = 1.5m, ["entryRate"] = 100m },
                new Dictionary<string, long> { ["entryProject"] = version }))], Context($"bulk-{project}-{chunk[0]}")));
        }
    }

    /// <summary>The fewest work units every calculation of c0 is worked out under, found by halving.</summary>
    private static async Task<int> MinimumWorkUnitsAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        int low = 1, high = NendoBehaviourLimits.Default.WorkUnits;
        while (low < high)
        {
            var middle = (low + high) / 2;
            coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { WorkUnits = middle };
            if ((await RecordAsync(service, "c0")).Calculations.All(calculation => calculation.State == NendoCalculationState.Value)) high = middle;
            else low = middle + 1;
        }
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default;
        return low;
    }

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    private static NendoCalculationResult Calculation(NendoRecordSnapshot record, string field) =>
        record.Calculations.Single(calculation => calculation.FieldId == field);

    private static decimal Value(NendoRecordSnapshot record, string field)
    {
        var result = Calculation(record, field);
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{record.RecordId}.{field}: {result.ErrorMessage}");
        return result.Value.GetDecimal();
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Billable", [
            new CreateEntityOperation("clients", "clients", "Clients", "clients"),
            new AddFieldOperation("c-name", "clients", "clientName", "Name", "client_name", NendoStorageKind.Text, true),
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-title", "projects", "projectTitle", "Title", "project_title", NendoStorageKind.Text, true),
            new AddFieldOperation("p-client", "projects", "projectClient", "Client", "project_client", NendoStorageKind.Reference, true),
            new AddFieldOperation("p-rate", "projects", "projectRate", "Rate", "project_rate", NendoStorageKind.Decimal, false),
            new AddFieldOperation("p-hours", "projects", "projectHours", "Hours", "project_hours", NendoStorageKind.Decimal, false),
            new ConfigureReferenceOperation("p-bind", "projects", "projectClient", "clients", "clientName", 0),
            new CreateEntityOperation("entries", "entries", "Time entries", "entries"),
            new AddFieldOperation("e-project", "entries", "entryProject", "Project", "entry_project", NendoStorageKind.Reference, true),
            new AddFieldOperation("e-hours", "entries", "entryHours", "Hours", "entry_hours", NendoStorageKind.Decimal, false),
            new AddFieldOperation("e-rate", "entries", "entryRate", "Rate", "entry_rate", NendoStorageKind.Decimal, false),
            new AddFieldOperation("e-billable", "entries", "entryBillable", "Billable", "entry_billable", NendoStorageKind.Boolean, false),
            new ConfigureReferenceOperation("e-bind", "entries", "entryProject", "projects", "projectTitle", 0),
        ]));
    }

    private static async Task InstallAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, params NendoBehaviourDefinition[] definitions)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", $"install-{Guid.NewGuid():N}", "test", "Behaviour",
            [.. definitions.Select((definition, index) => (NendoOperation)new SetBehaviourDefinitionOperation($"b{index}-{Guid.NewGuid():N}", definition, revision))]));
    }

    private static NendoRequestContext Context(string key) => new("budget-sizing-tests", key, "test");
}
