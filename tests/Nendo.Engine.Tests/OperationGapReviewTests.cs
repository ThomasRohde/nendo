using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Gaps that needed a new operation, a formula function or a format change.
/// </summary>
[TestClass]
public sealed class OperationGapReviewTests
{
    [TestMethod]
    [DataRow(NendoStorageKind.Integer, "longText")]
    [DataRow(NendoStorageKind.Boolean, "singleLine")]
    [DataRow(NendoStorageKind.Date, "longText")]
    [DataRow(NendoStorageKind.Decimal, "singleLine")]
    [DataRow(NendoStorageKind.Reference, "longText")]
    public void ESM10_ATextPresentationOnAFieldThatIsNotTextIsRefused(NendoStorageKind kind, string presentation)
    {
        var refused = Assert.ThrowsExactly<ArgumentException>(
            () => new AddFieldOperation("f", "e", "e.f", "F", "f", kind, false, presentation),
            $"A {kind} field drawn as {presentation} was accepted, and nothing could change it afterwards.");
        StringAssert.Contains(refused.Message, $"The {presentation} presentation requires Text storage.", StringComparison.Ordinal);
        _ = new AddFieldOperation("t", "e", "e.t", "T", "t", NendoStorageKind.Text, false, presentation);
    }

    [TestMethod]
    public async Task ESM10_AStoredTextPresentationOnANumberIsReadAsNone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "e", "E", "e"),
            new AddFieldOperation("e-title", "e", "e.title", "Title", "title", NendoStorageKind.Text, true, "longText"),
            new AddFieldOperation("e-count", "e", "e.count", "Count", "count", NendoStorageKind.Integer, false),
        ]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        // What an older host stored before schema.addField refused it.
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_field SET presentation = 'longText' WHERE field_id = 'e.count';";
            await command.ExecuteNonQueryAsync();
        }

        var reopened = await workspace.OpenAsync();
        var fields = (await new NendoApplicationService(reopened).GetSnapshotAsync()).Entities.Single().Fields;
        Assert.IsNull(fields.Single(field => field.FieldId == "e.count").Presentation,
            "A number stored as long text still reads as long text, so the form draws a text box over it.");
        Assert.AreEqual("longText", fields.Single(field => field.FieldId == "e.title").Presentation, "A Text field keeps its presentation.");
        Assert.AreEqual(NendoOpenClassification.NormalWritable, reopened.Inspection!.Classification);

        var service = new NendoApplicationService(reopened);
        await reopened.ApplyAsync(new("test", "unique", "test", "Unique count", [new SetFieldUniqueOperation("unique", "e", "e.count", true,
            (await service.GetSnapshotAsync()).Manifest.DefinitionRevision)]));
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single().Fields.Single(field => field.FieldId == "e.count").Unique,
            "The snapshot offers Count as a plain number, and making it unique was refused on its stored presentation.");
    }

    [TestMethod]
    public async Task ESM11_AnOptionalPropertyCanBeClearedAndItsFirstValueUndone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "e", "E", "e"),
            new AddFieldOperation("e-title", "e", "e.title", "Title", "title", NendoStorageKind.Text, true, "singleLine"),
            new AddFieldOperation("e-rank", "e", "e.rank", "Rank", "rank", NendoStorageKind.Integer, false),
        ]));
        await coordinator.ApplyAsync(new("test", "list", "test", "List", [
            new AddUiNodeOperation("list", "s", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-v", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("list-e", "s", "list", "entityId", "e"),
            new SetUiPropertyOperation("list-t", "s", "list", "title", "All"),
            new AddUiNodeOperation("bind", "s", "bind", "list", "fieldBinding", 0),
            new SetUiPropertyOperation("bind-f", "s", "bind", "fieldId", "e.title"),
        ]));
        async Task<IReadOnlyDictionary<string, JsonElement>> List() => (await service.GetSnapshotAsync()).UiNodes.Single(node => node.NodeId == "list").Properties;

        // The first value a property ever took is offered for undo, and the undo clears it.
        var ordered = await coordinator.ApplyAsync(new("test", "order", "test", "Order", [new SetUiPropertyOperation("order", "s", "list", "orderByFieldId", "e.rank")]));
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation,
            "History offers no undo for the first value a property took.");
        await service.CompensateRevisionAsync(ordered.RevisionId, "undo-order");
        Assert.IsFalse((await List()).ContainsKey("orderByFieldId"), "The undo of a first-time property left it on the node.");

        // Given again, it can be cleared; the screen compiles without it, and the clear is undone in turn.
        await coordinator.ApplyAsync(new("test", "order-again", "test", "Order", [new SetUiPropertyOperation("order-again", "s", "list", "orderByFieldId", "e.rank")]));
        var cleared = await coordinator.ApplyAsync(new("test", "clear", "test", "Clear the order",
            [new RemoveUiPropertyOperation("clear", "s", "list", "orderByFieldId")]));
        Assert.IsFalse((await List()).ContainsKey("orderByFieldId"), "ui.removeProperty left the property on the node.");
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);
        Assert.AreEqual(NendoFormat.UiPropertyRemovalMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation, "History offers no undo for a cleared property.");
        await service.CompensateRevisionAsync(cleared.RevisionId, "undo-clear");
        Assert.AreEqual("e.rank", (await List())["orderByFieldId"].GetString(), "Undoing the clear did not give the property back.");

        var clearedAgain = await coordinator.ApplyAsync(new("test", "clear-again", "test", "Clear the order",
            [new RemoveUiPropertyOperation("clear-again", "s", "list", "orderByFieldId")]));
        await coordinator.ApplyAsync(new("test", "order-title", "test", "Order", [new SetUiPropertyOperation("order-title", "s", "list", "orderByFieldId", "e.title")]));
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(clearedAgain.RevisionId, "undo-clear-again"),
            "Undoing a clear overwrote the value given since.");

        var absent = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "clear-subtitle", "test", "Clear",
            [new RemoveUiPropertyOperation("clear-subtitle", "s", "list", "subtitleFieldId")])));
        Assert.AreEqual("ui-property-absent", absent.Code);
        NendoCanonicalOperations.Check("ui.removeProperty", JsonDocument.Parse("""{"surfaceId":"s","nodeId":"list","propertyName":"title"}""").RootElement.Clone());
    }

    [TestMethod]
    public async Task ESS09_RetiringAFieldABoundReferenceUsesAsItsLabelIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, false),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        async Task<NendoApplyResult> Retire(string fieldId) => await coordinator.ApplyAsync(new("test", $"retire-{Guid.NewGuid():N}", "test", "Retire",
            [new SetRetiredOperation($"retire-{Guid.NewGuid():N}", "projects", fieldId, true, (await service.GetSnapshotAsync()).Manifest.DefinitionRevision)]));

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Retire("name"),
            "The label of a bound reference was retired, so every project created afterwards shows as a bare ID.");
        Assert.AreEqual("reference-label-in-use", refused.Code);
        StringAssert.Contains(refused.Message, "Tasks.Project shows Projects by Name", StringComparison.Ordinal);
        await Retire("code");
    }

    [TestMethod]
    public async Task R2AAV05_ANumberOrADateIsWrittenAsTextWithToText()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Invoices", [
            new CreateEntityOperation("invoices", "invoices", "Invoices", "invoices"),
            new AddFieldOperation("i-number", "invoices", "number", "Number", "number", NendoStorageKind.Integer, true),
            new AddFieldOperation("i-amount", "invoices", "amount", "Amount", "amount", NendoStorageKind.Decimal, true),
            new AddFieldOperation("i-due", "invoices", "due", "Due", "due", NendoStorageKind.Date, true),
            new AddFieldOperation("i-paid", "invoices", "paid", "Paid", "paid", NendoStorageKind.Boolean, true),
        ]));
        await service.CreateRecordAsync(new("invoices", "r1",
            new Dictionary<string, object?> { ["number"] = 42L, ["amount"] = 12.5m, ["due"] = "2026-10-13", ["paid"] = false }, new("test", "create-r1", "test")));
        NendoBehaviourBinding Bind(string field, NendoBehaviourScalar kind) => NendoBehaviourBinding.SameRecordField(field, "invoices", field, kind, false);
        NendoCalculationDefinition Calculation(string id, string expression, params NendoBehaviourBinding[] bindings) =>
            new($"invoices.{id}", "invoices", id, id, NendoBehaviourScalar.Text, false, expression, bindings);
        async Task Install(params NendoCalculationDefinition[] calculations)
        {
            var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("test", $"behaviour-{Guid.NewGuid():N}", "test", "Calculations", calculations
                .Select(calculation => (NendoOperation)new SetBehaviourDefinitionOperation($"set-{calculation.FieldId}-{Guid.NewGuid():N}", calculation, revision)).ToArray()));
        }

        await Install(
            Calculation("code", "Concat('INV-', ToText(number))", Bind("number", NendoBehaviourScalar.Integer)),
            Calculation("total", "ToText(amount)", Bind("amount", NendoBehaviourScalar.Decimal)),
            Calculation("dueText", "ToText(due)", Bind("due", NendoBehaviourScalar.Date)));
        var record = (await service.GetSnapshotAsync()).Records.Single();
        string Text(string fieldId)
        {
            var result = record.Calculations.Single(calculation => calculation.FieldId == fieldId);
            Assert.AreEqual(NendoCalculationState.Value, result.State, $"{fieldId}: {result.ErrorCode} {result.ErrorMessage}");
            return result.Value.GetString()!;
        }
        Assert.AreEqual("INV-42", Text("code"), "A display code cannot be written: nothing turns a number into text.");
        Assert.AreEqual("12.5", Text("total"));
        Assert.AreEqual("2026-10-13", Text("dueText"));
        Assert.AreEqual(NendoFormat.ToTextMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        var yesNo = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => Install(
            Calculation("paidText", "ToText(paid)", Bind("paid", NendoBehaviourScalar.Boolean))));
        StringAssert.Contains(yesNo.Message, "x ? 'Yes' : 'No'", StringComparison.Ordinal);
        var joined = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => Install(
            Calculation("bare", "Concat('INV-', number)", Bind("number", NendoBehaviourScalar.Integer))));
        StringAssert.Contains(joined.Message, "ToText", StringComparison.Ordinal);
    }

    /// <summary>Billable's due date, issue date plus terms, as a formula rather than view code.</summary>
    [TestMethod]
    public async Task W248_ADueDateIsTheIssueDatePlusItsTerms()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Invoices", [
            new CreateEntityOperation("invoices", "invoices", "Invoices", "invoices"),
            new AddFieldOperation("i-issued", "invoices", "issued", "Issued", "issued", NendoStorageKind.Date, false),
            new AddFieldOperation("i-terms", "invoices", "terms", "Terms", "terms", NendoStorageKind.Integer, false),
        ]));
        await service.CreateRecordsAsync(new("invoices",
        [
            new("r1", new Dictionary<string, object?> { ["issued"] = "2026-10-18", ["terms"] = 30L }),
            new("r2", new Dictionary<string, object?> { ["issued"] = "2028-02-20", ["terms"] = 10L }),
            new("r3", new Dictionary<string, object?> { ["issued"] = "2026-10-18", ["terms"] = -18L }),
            new("r4", new Dictionary<string, object?> { ["terms"] = 30L }),
            new("r5", new Dictionary<string, object?> { ["issued"] = "9999-12-25", ["terms"] = 30L }),
        ], new("test", "create", "test")));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "due", "test", "Due date", [
            new SetBehaviourDefinitionOperation("set-due", new NendoCalculationDefinition("invoices.due", "invoices", "due", "Due",
                NendoBehaviourScalar.Date, true, "AddDays(i, t)",
                [NendoBehaviourBinding.SameRecordField("i", "invoices", "issued", NendoBehaviourScalar.Date, true),
                 NendoBehaviourBinding.SameRecordField("t", "invoices", "terms", NendoBehaviourScalar.Integer, true)]), revision),
        ]));

        var records = (await service.GetSnapshotAsync()).Records.ToDictionary(record => record.RecordId, record => record.Calculations.Single());
        Assert.AreEqual("2026-11-17", records["r1"].Value.GetString());
        Assert.AreEqual("2028-03-01", records["r2"].Value.GetString(), "A leap February was not counted.");
        Assert.AreEqual("2026-09-30", records["r3"].Value.GetString(), "A negative number of days did not count back.");
        Assert.AreEqual(NendoCalculationState.Empty, records["r4"].State, "A due date with no issue date was not empty.");
        Assert.AreEqual(NendoCalculationState.Error, records["r5"].State);
        Assert.AreEqual(NendoCalculationCodes.InvalidDate, records["r5"].ErrorCode);
        Assert.AreEqual(NendoFormat.DatePeriodsMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        var badRevision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new("test", "bad", "test", "Due", [
            new SetBehaviourDefinitionOperation("set-bad", new NendoCalculationDefinition("invoices.bad", "invoices", "bad", "Bad",
                NendoBehaviourScalar.Date, true, "AddDays(t, i)",
                [NendoBehaviourBinding.SameRecordField("i", "invoices", "issued", NendoBehaviourScalar.Date, true),
                 NendoBehaviourBinding.SameRecordField("t", "invoices", "terms", NendoBehaviourScalar.Integer, true)]),
                badRevision),
        ])));
        StringAssert.Contains(refused.Message, "AddDays", StringComparison.Ordinal);
    }

    [TestMethod]
    public void R2AAV05_EveryFunctionTheCatalogueNamesExists()
    {
        // A published sentence that sends an author to a function the closed catalogue lacks is
        // how Concat's "convert those first" pointed at nothing.
        var names = NendoBehaviourCatalogue.Names.ToHashSet(StringComparer.Ordinal);
        Assert.Contains("ToText", names, "Concat sends authors to a conversion the catalogue does not have.");
        var named = NendoBehaviourCatalogue.Describe()
            .SelectMany(function => System.Text.RegularExpressions.Regex.Matches(function.Summary, @"\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b")
                .Select(match => (function.Name, Called: match.Value)))
            .ToArray();
        Assert.IsTrue(named.Contains(("Concat", "ToText")), "Concat's summary names no conversion function.");
        var missing = named.Where(item => !names.Contains(item.Called)).Select(item => $"{item.Name} names {item.Called}").ToArray();
        Assert.IsEmpty(missing, string.Join("; ", missing));
    }

    [TestMethod]
    public void R2SMA13_PartsTogetherHoldEveryRecordOnce()
    {
        var entity = new NendoEntitySnapshot("table", "Table", [new("text", "Text", NendoStorageKind.Text, false, null, [])]);
        NendoRecordSnapshot Record(string id, object value) => new("table", id, 1,
            new Dictionary<string, JsonElement> { ["text"] = JsonSerializer.SerializeToElement(value) });
        // r03 cannot be written at all; the part that meets it must still move past it.
        var records = Enumerable.Range(1, 7).Select(index => index == 3 ? Record("r03", new { not = "scalar" }) : Record($"r{index:D2}", $"value {index}")).ToArray();

        var written = new List<string>();
        string? after = null;
        var parts = 0;
        do
        {
            var csv = RecoveryCsvWriter.Create(entity, records, CancellationToken.None, maximumRows: 2, afterRecordId: after);
            written.AddRange(Encoding.UTF8.GetString(csv.Bytes[3..]).Split("\r\n", StringSplitOptions.RemoveEmptyEntries).Skip(1)
                .Select(line => line.Split(',')[0].Trim('"')));
            Assert.AreEqual(records.Length, csv.SourceRows);
            after = csv.ContinueAfter;
            if (after is not null) Assert.IsTrue(csv.Findings.Any(finding => finding.Code == "csv-limit" && finding.Message.Contains("next part", StringComparison.Ordinal)));
            Assert.IsLessThan(10, ++parts, "The parts never reach the end of the table.");
        }
        while (after is not null);

        Assert.AreEqual("r01 r02 r04 r05 r06 r07", string.Join(' ', written),
            "The parts repeat or skip records: a second export started from the first record again.");
        Assert.AreEqual(3, parts, "A part ended without the limit, or a full part offered an empty next one.");
    }

    [TestMethod]
    public async Task R2SMA13_PartsContinueOneSnapshotAndCountWhatEarlierPartsLeftOut()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        foreach (var (id, title) in new[] { ("r1", new string('x', 1500)), ("r2", "two"), ("r3", "three"), ("r4", "four") })
            await service.CreateIdeaRecordAsync(id, title, $"create-{id}");
        source.RecoveryExportRowLimit = 2;
        source.RecoveryExportByteLimit = 1000;
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        async Task<NendoRecoveryExportPlan> Part(int part, string? after) => await service.PrepareRecoveryExportAsync(
            NendoApplicationService.IdeaEntityId, Path.Combine(folder, $"part-{part}-{Guid.NewGuid():N}.csv"), $"part-{part}-{Guid.NewGuid():N}", after);

        // No part can hold r1, so part 1 moves past it and writes r2 and r3; part 2 writes r4 alone.
        var first = await Part(1, null);
        Assert.AreEqual(2, first.ExportedRecordCount);
        Assert.AreEqual("r3", first.NextAfterRecordId);
        Assert.IsTrue(first.Findings.Any(finding => finding.Code == "csv-oversize-rows"), string.Join("; ", first.Findings.Select(finding => finding.Code)));
        var second = await Part(2, first.NextAfterRecordId);
        Assert.AreEqual(2, second.PrecedingRecordCount);
        Assert.AreEqual(1, second.ExportedRecordCount);
        Assert.IsNull(second.NextAfterRecordId);
        Assert.AreEqual(1, second.OmittedRecordCount, "The parts claim to hold a record no part wrote.");
        Assert.IsTrue(second.IsPartial, "The last part reads as complete although r1 is in no part.");

        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Part(9, "r2"), "A part that continues no earlier part was prepared.");
        var again = await Part(1, null);
        await service.CreateIdeaRecordAsync("r0", "added before the cursor", "create-r0");
        var changed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Part(2, again.NextAfterRecordId),
            "A next part read a later snapshot, and r0, added before its cursor, is in no part.");
        Assert.AreEqual("export-source-changed", changed.Code);
    }

    [TestMethod]
    public async Task R2SMA13_ASavedPartNoLongerCountsAgainstTheSession()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("record-1", "One", "record");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        for (var part = 1; part <= 40; part++)
        {
            var plan = await service.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId,
                Path.Combine(folder, $"part-{part}.csv"), $"export-{part}");
            await service.CreateRecoveryExportAsync(plan.PlanId, false);
        }
        Assert.IsTrue(File.Exists(Path.Combine(folder, "part-40.csv")), "The session refused a part after 32 saved exports.");
    }
}
