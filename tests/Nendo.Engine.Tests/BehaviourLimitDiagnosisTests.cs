using System.Text.RegularExpressions;

namespace Nendo.Engine.Tests;

/// <summary>
/// W-246: a ceiling says what it had spent and where. The Billable author met the function-call
/// limit in a client's rollup and could not tell which member's formula spent it, and read a
/// batch refused on related records as a function-call problem, because a refusal named only
/// the allowance. The shapes here are Billable's: client, projects, time entries.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed partial class BehaviourLimitDiagnosisTests
{
    [TestMethod]
    public void EveryCeilingSaysWhatItHadSpentOfEachAllowance()
    {
        foreach (var use in new[] { BehaviourBudgetUse.Read, BehaviourBudgetUse.Check, BehaviourBudgetUse.Save })
        {
            var budget = new BehaviourBudget(new NendoBehaviourLimits(), use: use);
            budget.SpendScan(3);
            for (var call = 0; call < 64; call++) budget.SpendCall();
            // The refused call has already paid its one work unit, as a refused scan does (D2_14).
            var refused = Assert.ThrowsExactly<NendoCalculationException>(() => budget.SpendCall());

            Assert.AreEqual(NendoCalculationCodes.LimitReached, refused.Code);
            StringAssert.Contains(refused.Message,
                "It had spent 64 of 64 function calls, 3 of 256 related records, 0 of 64 automatic changes and 68 of 16,384 work units.", use.ToString());
            Assert.AreEqual(new NendoBudgetSpend("function call", 64, 64, 3, 256, 0, 64, 68, 16384), refused.Spend);
            Assert.IsEmpty(refused.Path);
        }
    }

    /// <summary>
    /// A client's total of its projects' totals of their entries: the path names the project and the
    /// entry. Since W-247 each entry has its own calls, so the entry's formula is the one past them.
    /// </summary>
    [TestMethod]
    public async Task ARollupThatRunsOutNamesTheRelatedCalculationsItRanOutInside()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, EntryAmount(), ProjectAmount(), ClientAmount());
        await SeedAsync(service, projects: 2, entriesPerProject: 33);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { FunctionCalls = 1 };
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("entry.amount", "entries", "entryAmount", "Amount",
            NendoBehaviourScalar.Decimal, false, "RoundAway(RoundAway(h * r, 2), 2)", [Hours, Rate]));

        var records = (await service.GetSnapshotAsync()).Records;
        var client = records.Single(record => record.RecordId == "c1").Calculations.Single(calculation => calculation.FieldId == "clientAmount");
        Assert.AreEqual(NendoCalculationState.Error, client.State);
        StringAssert.Contains(client.ErrorMessage, "This calculation reached the function call limit for one record.");
        StringAssert.Contains(client.ErrorMessage, "It had spent 1 of 1 function calls");
        StringAssert.Matches(client.ErrorMessage, InsideProjectAndEntry());
    }

    /// <summary>
    /// Billable's batch: three defaulting steps on each created entry, refused at 20 on related
    /// records before W-247. Each record now brings its own allowance, so one record's related
    /// records are made to run out here.
    /// </summary>
    [TestMethod]
    public async Task ABatchThatRunsOutSaysWhichAllowanceAndHowManyRecordsItCarried()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var projectRate = NendoBehaviourBinding.ReferenceTraversal("pr", "entries", "entryProject", "projects", "projectRate", NendoBehaviourScalar.Decimal, true);
        var billable = NendoBehaviourBinding.SameRecordField("b", "entries", "entryBillable", NendoBehaviourScalar.Boolean, true);
        var defaults = new NendoActionDefinition("entry.defaults", "Entry defaults",
        [
            NendoActionStep.SetField("rate", NendoActionTarget.EventRecord, new NendoActionAssignment("entryRate", "IsEmpty(r) ? (IsEmpty(pr) ? q : pr) : r",
                [Rate, projectRate, NendoBehaviourBinding.ReferenceTraversal("q", "entries", "entryProject", "projects", "projectRate", NendoBehaviourScalar.Decimal, true)], [])),
            NendoActionStep.SetField("billable", NendoActionTarget.EventRecord, new NendoActionAssignment("entryBillable", "IsEmpty(b) ? true : b", [billable], [])),
            NendoActionStep.SetField("hours", NendoActionTarget.EventRecord, new NendoActionAssignment("entryHours", "IsEmpty(h) ? 1 : h", [Hours], [])),
        ]);
        var created = new NendoTriggerDefinition("entry.created", "entries", "When an entry is created", NendoTriggerEvents.Created, "entry.defaults");
        await InstallAsync(coordinator, service, defaults, created);
        TestBehaviourAuthority.Approving(coordinator);
        await SeedAsync(service, projects: 1, entriesPerProject: 0);
        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p0").RecordVersion;
        // Each entry reads two related records, its project's rate twice, and one per entry is allowed.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 1 };

        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => service.CreateRecordsAsync(new("entries",
            [.. Enumerable.Range(0, 20).Select(index => new NendoCreateRecordEntry($"e{index}",
                new Dictionary<string, object?> { ["entryProject"] = "p0" }, new Dictionary<string, long> { ["entryProject"] = version }))],
            Context("batch"))));

        StringAssert.Contains(refused.Message, "reached the related record limit for a single save");
        StringAssert.Matches(refused.Message, new Regex(@"It had spent \d+ of 1,280 function calls, 20 of 20 related records"));
        StringAssert.Contains(refused.Message, "One budget covers the whole save, and this save carried 20 records: each brings its own function calls, related records and automatic changes, while the 16,384 work units are the save's whatever its size.");
        StringAssert.Matches(refused.Message, new Regex(@"The step that spent most was step \w+ of action 'Entry defaults'"));
        Assert.AreEqual("related record", refused.Spend?.Allowance);
        Assert.AreEqual(20, refused.Spend?.RelatedRecordLimit);
    }

    [GeneratedRegex(@"It ran out inside project\.amount of record p\d, inside entry\.amount of record p\de\d+\.")]
    private static partial Regex InsideProjectAndEntry();

    private static readonly NendoBehaviourBinding Hours = NendoBehaviourBinding.SameRecordField("h", "entries", "entryHours", NendoBehaviourScalar.Decimal, true);
    private static readonly NendoBehaviourBinding Rate = NendoBehaviourBinding.SameRecordField("r", "entries", "entryRate", NendoBehaviourScalar.Decimal, true);

    private static NendoBehaviourDefinition EntryAmount() =>
        new NendoCalculationDefinition("entry.amount", "entries", "entryAmount", "Amount", NendoBehaviourScalar.Decimal, false, "RoundAway(h * r, 2)", [Hours, Rate]);

    private static NendoBehaviourDefinition ProjectAmount() =>
        new NendoCalculationDefinition("project.amount", "projects", "projectAmount", "Amount", NendoBehaviourScalar.Decimal, false, "v",
            [NendoBehaviourBinding.RelatedSum("v", "projects", "entries", "entryProject", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("entry.amount")]);

    private static NendoBehaviourDefinition ClientAmount() =>
        new NendoCalculationDefinition("client.amount", "clients", "clientAmount", "Amount", NendoBehaviourScalar.Decimal, false, "v",
            [NendoBehaviourBinding.RelatedSum("v", "clients", "projects", "projectClient", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("project.amount")]);

    private static async Task SeedAsync(NendoApplicationService service, int projects, int entriesPerProject)
    {
        await service.CreateRecordAsync(new("clients", "c1", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c1")));
        for (var p = 0; p < projects; p++)
        {
            var client = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "c1").RecordVersion;
            await service.CreateRecordAsync(new("projects", $"p{p}",
                new Dictionary<string, object?> { ["projectTitle"] = $"P{p}", ["projectClient"] = "c1", ["projectRate"] = 120m }, Context($"p{p}"))
            { ExpectedTargetVersions = new Dictionary<string, long> { ["projectClient"] = client } });
            if (entriesPerProject == 0) continue;
            var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == $"p{p}").RecordVersion;
            await service.CreateRecordsAsync(new("entries", [.. Enumerable.Range(0, entriesPerProject).Select(index => new NendoCreateRecordEntry($"p{p}e{index}",
                new Dictionary<string, object?> { ["entryProject"] = $"p{p}", ["entryHours"] = 1.25m, ["entryRate"] = 120m },
                new Dictionary<string, long> { ["entryProject"] = version }))], Context($"entries-{p}")));
        }
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

    private static NendoRequestContext Context(string key) => new("limit-diagnosis-tests", key, "test");
}
