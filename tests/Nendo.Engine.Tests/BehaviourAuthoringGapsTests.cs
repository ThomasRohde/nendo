using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008, 2026-10-10 amendment: what an agent building a studio manager in a new file could
/// not express (workspace/Agent.nendo). A created record could not point back at the record that
/// caused it, a formula could not ask whether a value was there, a total could not add up a
/// calculated field, and the shapes of an action, a trigger and a calculation had to be learnt
/// from refusals. Each case runs against a real file through the ordinary coordinator.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourAuthoringGapsTests
{
    /// <summary>The agent's kickoff task: a project's creation makes a task that names the project.</summary>
    [TestMethod]
    public async Task ACreatedRecordLinksBackToTheRecordThatRaisedTheEvent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var kickoff = new NendoActionDefinition("project.kickoff", "Create the kickoff task",
        [
            NendoActionStep.CreateRecord("kickoff", "tasks", [new NendoActionAssignment("taskTitle", "'Kickoff call'")],
                [new NendoActionLink("taskProject", NendoActionTarget.EventRecord)]),
        ]);
        var created = new NendoTriggerDefinition("project.created", "projects", "When a project is created",
            NendoTriggerEvents.Created, "project.kickoff");
        await InstallAsync(coordinator, service, kickoff, created);
        Assert.AreEqual(NendoFormat.BehaviourLinksMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "A file whose action links a record does not say it needs a host that reads links.");
        TestBehaviourAuthority.Approving(coordinator);

        await CreateAsync(service, new("clients", "c1", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c1")));
        await CreateAsync(service, new("projects", "p1",
            new Dictionary<string, object?> { ["projectTitle"] = "Rebrand", ["projectClient"] = "c1", ["projectStatus"] = "Active" }, Context("p1")));

        var task = (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "tasks");
        Assert.AreEqual("Kickoff call", task.Values["taskTitle"].GetString());
        Assert.AreEqual("p1", task.Values["taskProject"].GetString(), "The kickoff task does not name the project that caused it.");

        // Stored canonically, and a step without links keeps the body it had before links existed.
        StringAssert.Contains(kickoff.CanonicalBody(), "\"links\":[{\"fieldId\":\"taskProject\",\"target\":{\"kind\":\"EventRecord\"}}]");
        var plain = new NendoActionDefinition("plain", "Plain", [NendoActionStep.CreateRecord("s", "tasks", [new NendoActionAssignment("taskTitle", "'x'")])]);
        Assert.IsFalse(plain.CanonicalBody().Contains("links", StringComparison.Ordinal), "A step with no links changed its stored body.");
    }

    [TestMethod]
    public async Task ALinkThatCannotHoldIsRefusedAtInstallByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        async Task<string> RefusedAsync(NendoActionLink link, NendoTriggerEvents events = NendoTriggerEvents.Created)
        {
            var action = new NendoActionDefinition("bad", "Bad", [NendoActionStep.CreateRecord("s", "tasks", [], [link])]);
            var trigger = new NendoTriggerDefinition("bad.on", "projects", "Bad trigger", events, "bad");
            var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => InstallAsync(coordinator, service, action, trigger));
            Assert.AreEqual("action-target-mismatch", refused.Code);
            return refused.Message;
        }

        StringAssert.Contains(await RefusedAsync(new("taskTitle", NendoActionTarget.EventRecord)), "is not a reference");
        StringAssert.Contains(await RefusedAsync(new("taskProject", NendoActionTarget.Referenced("projectClient"))), "points at 'projects'");
        StringAssert.Contains(await RefusedAsync(new("taskProject", NendoActionTarget.EventRecord), NendoTriggerEvents.Created | NendoTriggerEvents.Deleted),
            "no record to link to");
        // One field set two ways in one step is refused before anything else is looked at.
        Assert.ThrowsExactly<NendoValidationException>(() => new NendoActionDefinition("twice", "Twice", [NendoActionStep.CreateRecord("s", "tasks",
            [new NendoActionAssignment("taskProject", "'x'")], [new NendoActionLink("taskProject", NendoActionTarget.EventRecord)])]).Validate());
    }

    /// <summary>The agent's default: a time entry saved with Billable left empty becomes billable.</summary>
    [TestMethod]
    public async Task IsEmptyLetsAFormulaGiveAnEmptyValueADefault()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var billable = NendoBehaviourBinding.SameRecordField("billable", "entries", "entryBillable", NendoBehaviourScalar.Boolean, true);
        var hours = NendoBehaviourBinding.SameRecordField("hours", "entries", "entryHours", NendoBehaviourScalar.Decimal, false);
        var state = new NendoCalculationDefinition("entry.state", "entries", "entryState", "Billable said", NendoBehaviourScalar.Text, false,
            "IsEmpty(billable) ? 'not said' : (billable ? 'billable' : 'not billable')", [billable]);
        var emptyProduct = new NendoCalculationDefinition("entry.noProduct", "entries", "entryNoProduct", "No billable hours yet", NendoBehaviourScalar.Boolean, false,
            "IsEmpty(billable ? hours : 0)", [billable, hours]);
        var setDefault = new NendoActionDefinition("entry.default", "Default billable",
            [NendoActionStep.SetField("s", NendoActionTarget.EventRecord, new NendoActionAssignment("entryBillable", "true"))]);
        var whenEmpty = new NendoTriggerDefinition("entry.created", "entries", "When billable is left empty", NendoTriggerEvents.Created,
            "entry.default", conditionExpression: "IsEmpty(billable)", conditionBindings: [billable]);
        await InstallAsync(coordinator, service, state, emptyProduct, setDefault, whenEmpty);
        Assert.AreEqual(NendoFormat.BehaviourLinksMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        TestBehaviourAuthority.Approving(coordinator);

        await CreateAsync(service, new("clients", "c1", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c1")));
        await CreateAsync(service, new("projects", "p1",
            new Dictionary<string, object?> { ["projectTitle"] = "Rebrand", ["projectClient"] = "c1", ["projectStatus"] = "Active" }, Context("p1")));
        await CreateAsync(service, new("entries", "e1",
            new Dictionary<string, object?> { ["entryProject"] = "p1", ["entryHours"] = 2m }, Context("e1")));
        await CreateAsync(service, new("entries", "e2",
            new Dictionary<string, object?> { ["entryProject"] = "p1", ["entryHours"] = 3m, ["entryBillable"] = false }, Context("e2")));

        var records = (await service.GetSnapshotAsync()).Records;
        var defaulted = records.Single(record => record.RecordId == "e1");
        Assert.AreEqual(JsonValueKind.True, defaulted.Values["entryBillable"].ValueKind, "An entry saved with Billable empty was not given the default.");
        Assert.AreEqual("billable", Calculated(defaulted, "entryState").GetString());
        var kept = records.Single(record => record.RecordId == "e2");
        Assert.IsFalse(kept.Values["entryBillable"].GetBoolean(), "An entry the person said was not billable was overwritten.");
        Assert.AreEqual("not billable", Calculated(kept, "entryState").GetString());

        // On an empty value directly, and on a value an empty input stopped.
        await service.SetFieldAsync(new("entries", "e2", "entryBillable", (await Version(service, "e2")), null, Context("clear-e2")));
        var cleared = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "e2");
        Assert.AreEqual("not said", Calculated(cleared, "entryState").GetString(), "IsEmpty did not see an empty Billable.");
        Assert.IsTrue(Calculated(cleared, "entryNoProduct").GetBoolean(), "IsEmpty did not see a value an empty input stopped.");
        Assert.IsFalse(Calculated(defaulted, "entryNoProduct").GetBoolean());
    }

    /// <summary>The agent's invoice total, client totals and active-project count, over calculated fields.</summary>
    [TestMethod]
    public async Task ASumAndAFilteredCountReadACalculatedFieldOfEachMember()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await InstallAsync(coordinator, service, Totals());
        Assert.AreEqual(NendoFormat.BehaviourLinksMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await CreateAsync(service, new("clients", "c1", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c1")));
        foreach (var (id, status) in new[] { ("p1", "Active"), ("p2", "Done"), ("p3", "Active") })
            await CreateAsync(service, new("projects", id,
                new Dictionary<string, object?> { ["projectTitle"] = id, ["projectClient"] = "c1", ["projectStatus"] = status }, Context(id)));
        foreach (var invoice in new[] { "i1", "i2" })
            await CreateAsync(service, new("invoices", invoice, new Dictionary<string, object?> { ["invoiceNumber"] = invoice, ["invoiceClient"] = "c1" }, Context(invoice)));
        foreach (var (id, invoice, quantity, price) in new[] { ("l1", "i1", 2m, 10.50m), ("l2", "i1", 1m, 4m), ("l3", "i2", 3m, 100m) })
            await CreateAsync(service, new("lines", id,
                new Dictionary<string, object?> { ["lineInvoice"] = invoice, ["lineQuantity"] = quantity, ["linePrice"] = price }, Context(id)));

        var records = (await service.GetSnapshotAsync()).Records;
        Assert.AreEqual(25.00m, Calculated(records.Single(record => record.RecordId == "i1"), "invoiceTotal").GetDecimal(),
            "An invoice did not total its lines' calculated totals.");
        Assert.AreEqual(300m, Calculated(records.Single(record => record.RecordId == "i2"), "invoiceTotal").GetDecimal());
        var client = records.Single(record => record.RecordId == "c1");
        Assert.AreEqual(325.00m, Calculated(client, "clientInvoiced").GetDecimal(), "A total of totals did not add up.");
        Assert.AreEqual(2L, Calculated(client, "clientActive").GetInt64(), "A filtered count did not test each project's calculated flag.");

        // A line whose total cannot be worked out makes the invoice's total an error, never a part.
        await CreateAsync(service, new("lines", "l4",
            new Dictionary<string, object?> { ["lineInvoice"] = "i2", ["lineQuantity"] = -1m, ["linePrice"] = 1m }, Context("l4")));
        var broken = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "i2")
            .Calculations.Single(calculation => calculation.FieldId == "invoiceTotal");
        Assert.AreEqual(NendoCalculationState.Error, broken.State, "A total was shown although one of its lines could not be worked out.");
        StringAssert.Contains(broken.ErrorMessage, "line.total");
    }

    /// <summary>The same total inside a save's chain, where an action writes it to a stored field.</summary>
    [TestMethod]
    public async Task AnActionWritesATotalOfCalculatedFieldsInsideTheSave()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var total = NendoBehaviourBinding.RelatedSum("total", "invoices", "lines", "lineInvoice", null, NendoBehaviourScalar.Decimal)
            .WithMemberCalculation("line.total");
        var keep = new NendoActionDefinition("invoice.keepTotal", "Keep the stored total",
            [NendoActionStep.SetField("s", NendoActionTarget.Referenced("lineInvoice"), new NendoActionAssignment("invoiceStoredTotal", "total", [total], []))]);
        var onLine = new NendoTriggerDefinition("line.changed", "lines", "When a line changes",
            NendoTriggerEvents.Created | NendoTriggerEvents.Updated, "invoice.keepTotal");
        await InstallAsync(coordinator, service, [LineTotal(), keep, onLine]);
        TestBehaviourAuthority.Approving(coordinator);

        await CreateAsync(service, new("clients", "c1", new Dictionary<string, object?> { ["clientName"] = "Harbor" }, Context("c1")));
        await CreateAsync(service, new("invoices", "i1", new Dictionary<string, object?> { ["invoiceNumber"] = "i1", ["invoiceClient"] = "c1" }, Context("i1")));
        await CreateAsync(service, new("lines", "l1",
            new Dictionary<string, object?> { ["lineInvoice"] = "i1", ["lineQuantity"] = 2m, ["linePrice"] = 7.25m }, Context("l1")));
        await CreateAsync(service, new("lines", "l2",
            new Dictionary<string, object?> { ["lineInvoice"] = "i1", ["lineQuantity"] = 1m, ["linePrice"] = 0.50m }, Context("l2")));

        var invoice = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "i1");
        Assert.AreEqual(15.00m, invoice.Values["invoiceStoredTotal"].GetDecimal(), "The action did not total the lines' calculated values in the save.");
    }

    [TestMethod]
    public async Task ACalculatedMemberThatCannotHoldIsRefusedAtInstallByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        // Named as a field, the way the agent first tried it: the refusal says how to name it.
        var asField = new NendoCalculationDefinition("invoice.total", "invoices", "invoiceTotal", "Total", NendoBehaviourScalar.Decimal, false, "total",
            [NendoBehaviourBinding.RelatedSum("total", "invoices", "lines", "lineInvoice", "lineTotal", NendoBehaviourScalar.Decimal)]);
        var named = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => InstallAsync(coordinator, service, LineTotal(), asField));
        StringAssert.Contains(named.Message, "valueCalculationId");

        var wrongType = new NendoCalculationDefinition("client.active", "clients", "clientActive", "Active", NendoBehaviourScalar.Integer, false, "active",
            [NendoBehaviourBinding.RelatedFilteredCount("active", "clients", "invoices", "invoiceClient", null).WithMemberCalculation("line.total")]);
        var mismatch = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service, LineTotal(), wrongType));
        StringAssert.Contains(mismatch.Message, "belongs to 'lines'");

        var notBoolean = new NendoCalculationDefinition("invoice.anyLine", "invoices", "invoiceAnyLine", "Any", NendoBehaviourScalar.Integer, false, "n",
            [NendoBehaviourBinding.RelatedFilteredCount("n", "invoices", "lines", "lineInvoice", null).WithMemberCalculation("line.total")]);
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service, LineTotal(), notBoolean))).Message,
            "needs boolean");

        Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourBinding.RelatedSum("total", "invoices", "lines", "lineInvoice", null, NendoBehaviourScalar.Decimal).Validate());
    }

    /// <summary>
    /// The published shapes are the ones the codec reads: every example body is accepted as it
    /// stands, a list left out is an empty list, and a trigger's events may be a list.
    /// </summary>
    [TestMethod]
    public void EveryPublishedBodyShapeIsReadAsPublished()
    {
        var bodies = NendoBehaviourVocabulary.Description().Bodies;
        CollectionAssert.AreEquivalent(
            new[] { "Calculation body", "Function body", "Action body", "Trigger body", "step", "assignment", "link", "target", "parameter", "call alias" },
            bodies.Select(shape => shape.Name).ToArray());
        foreach (var (name, kind) in new[] { ("Calculation body", NendoBehaviourKind.Calculation), ("Function body", NendoBehaviourKind.Function),
                     ("Action body", NendoBehaviourKind.Action), ("Trigger body", NendoBehaviourKind.Trigger) })
        {
            var shape = bodies.Single(candidate => candidate.Name == name);
            Assert.IsNotNull(shape.Example, $"{name} has no example an author can start from.");
            var read = NendoBehaviourCodec.Read("example", kind, NendoBehaviourContract.Version, shape.Example, NendoBehaviourBodySource.Authored);
            using var example = JsonDocument.Parse(shape.Example);
            foreach (var key in example.RootElement.EnumerateObject().Select(property => property.Name))
                Assert.IsTrue(shape.Keys.Contains(key), $"{name}'s example uses '{key}', which its shape does not publish.");
            foreach (var key in shape.RequiredKeys)
                Assert.IsTrue(example.RootElement.TryGetProperty(key, out _), $"{name}'s example leaves out the required '{key}'.");
            Assert.AreEqual(kind, read.Kind);
        }

        // An unknown key is refused naming every key the published shape takes.
        var refused = Assert.ThrowsExactly<NendoValidationException>(() => NendoBehaviourCodec.Read("probe", NendoBehaviourKind.Action,
            NendoBehaviourContract.Version, """{"displayName":"x","steps":[{"stepId":"s","kind":"DeleteRecord","target":{"kind":"EventRecord"},"zzz":1}]}""",
            NendoBehaviourBodySource.Authored)).Message;
        foreach (var key in bodies.Single(shape => shape.Name == "step").Keys) StringAssert.Contains(refused, key);

        var trigger = (NendoTriggerDefinition)NendoBehaviourCodec.Read("t", NendoBehaviourKind.Trigger, NendoBehaviourContract.Version,
            """{"entityId":"projects","displayName":"On save","events":["Created","Updated"],"actionId":"a"}""", NendoBehaviourBodySource.Authored);
        Assert.AreEqual(NendoTriggerEvents.Created | NendoTriggerEvents.Updated, trigger.Events);
        Assert.IsEmpty(trigger.RelevantFieldIds);
    }

    private static NendoBehaviourDefinition LineTotal() =>
        new NendoCalculationDefinition("line.total", "lines", "lineTotal", "Line total", NendoBehaviourScalar.Decimal, false,
            "quantity > 0 ? quantity * price : Refuse('A quantity is more than zero.')",
            [
                NendoBehaviourBinding.SameRecordField("quantity", "lines", "lineQuantity", NendoBehaviourScalar.Decimal, false),
                NendoBehaviourBinding.SameRecordField("price", "lines", "linePrice", NendoBehaviourScalar.Decimal, false),
            ]);

    private static NendoBehaviourDefinition[] Totals() =>
    [
        LineTotal(),
        new NendoCalculationDefinition("invoice.total", "invoices", "invoiceTotal", "Total", NendoBehaviourScalar.Decimal, false, "total",
            [NendoBehaviourBinding.RelatedSum("total", "invoices", "lines", "lineInvoice", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("line.total")]),
        new NendoCalculationDefinition("client.invoiced", "clients", "clientInvoiced", "Invoiced", NendoBehaviourScalar.Decimal, false, "invoiced",
            [NendoBehaviourBinding.RelatedSum("invoiced", "clients", "invoices", "invoiceClient", null, NendoBehaviourScalar.Decimal).WithMemberCalculation("invoice.total")]),
        new NendoCalculationDefinition("project.active", "projects", "projectActive", "Active", NendoBehaviourScalar.Boolean, false, "status == 'Active'",
            [NendoBehaviourBinding.SameRecordField("status", "projects", "projectStatus", NendoBehaviourScalar.Text, false)]),
        new NendoCalculationDefinition("client.active", "clients", "clientActive", "Active projects", NendoBehaviourScalar.Integer, false, "active",
            [NendoBehaviourBinding.RelatedFilteredCount("active", "clients", "projects", "projectClient", null).WithMemberCalculation("project.active")]),
    ];

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "A studio", [
            new CreateEntityOperation("clients", "clients", "Clients", "clients"),
            new AddFieldOperation("c-name", "clients", "clientName", "Name", "client_name", NendoStorageKind.Text, true),
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-title", "projects", "projectTitle", "Title", "project_title", NendoStorageKind.Text, true),
            new AddFieldOperation("p-client", "projects", "projectClient", "Client", "project_client", NendoStorageKind.Reference, true),
            new AddFieldOperation("p-status", "projects", "projectStatus", "Status", "project_status", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("p-bind", "projects", "projectClient", "clients", "clientName", 0),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "taskTitle", "Title", "task_title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-project", "tasks", "taskProject", "Project", "task_project", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("t-bind", "tasks", "taskProject", "projects", "projectTitle", 0),
            new CreateEntityOperation("entries", "entries", "Time entries", "entries"),
            new AddFieldOperation("e-project", "entries", "entryProject", "Project", "entry_project", NendoStorageKind.Reference, true),
            new AddFieldOperation("e-hours", "entries", "entryHours", "Hours", "entry_hours", NendoStorageKind.Decimal, true),
            new AddFieldOperation("e-billable", "entries", "entryBillable", "Billable", "entry_billable", NendoStorageKind.Boolean, false),
            new ConfigureReferenceOperation("e-bind", "entries", "entryProject", "projects", "projectTitle", 0),
            new CreateEntityOperation("invoices", "invoices", "Invoices", "invoices"),
            new AddFieldOperation("i-number", "invoices", "invoiceNumber", "Number", "invoice_number", NendoStorageKind.Text, true),
            new AddFieldOperation("i-client", "invoices", "invoiceClient", "Client", "invoice_client", NendoStorageKind.Reference, true),
            new AddFieldOperation("i-stored", "invoices", "invoiceStoredTotal", "Stored total", "invoice_stored_total", NendoStorageKind.Decimal, false),
            new ConfigureReferenceOperation("i-bind", "invoices", "invoiceClient", "clients", "clientName", 0),
            new CreateEntityOperation("lines", "lines", "Invoice lines", "lines"),
            new AddFieldOperation("l-invoice", "lines", "lineInvoice", "Invoice", "line_invoice", NendoStorageKind.Reference, true),
            new AddFieldOperation("l-quantity", "lines", "lineQuantity", "Quantity", "line_quantity", NendoStorageKind.Decimal, true),
            new AddFieldOperation("l-price", "lines", "linePrice", "Price", "line_price", NendoStorageKind.Decimal, true),
            new ConfigureReferenceOperation("l-bind", "lines", "lineInvoice", "invoices", "invoiceNumber", 0),
        ]));
    }

    private static async Task InstallAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, params NendoBehaviourDefinition[] definitions)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", $"install-{Guid.NewGuid():N}", "test", "Behaviour",
            [.. definitions.Select((definition, index) => (NendoOperation)new SetBehaviourDefinitionOperation($"b{index}", definition, revision))]));
    }

    private static JsonElement Calculated(NendoRecordSnapshot record, string fieldId)
    {
        var result = record.Calculations.Single(calculation => calculation.FieldId == fieldId);
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{fieldId}: {result.ErrorCode} {result.ErrorMessage}");
        return result.Value;
    }

    private static async Task<long> Version(NendoApplicationService service, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId).RecordVersion;

    private static NendoRequestContext Context(string key) => new("authoring-gaps-tests", key, "test");

    private static readonly string[] References = ["projectClient", "taskProject", "entryProject", "invoiceClient", "lineInvoice"];

    /// <summary>A create through the service, naming the current version of every record it references, as a form does.</summary>
    private static async Task CreateAsync(NendoApplicationService service, NendoCreateRecordRequest request)
    {
        var records = (await service.GetSnapshotAsync()).Records;
        var targets = request.Values
            .Where(pair => References.Contains(pair.Key) && pair.Value is string)
            .ToDictionary(pair => pair.Key, pair => records.Single(record => record.RecordId == (string)pair.Value!).RecordVersion);
        await service.CreateRecordAsync(request with { ExpectedTargetVersions = targets });
    }
}
