using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S7 of ADR-0008: a calculated field on a custom surface. Studio is not the
/// only place a calculation may be read — obligation P1 requires Studio, a custom
/// surface and MCP to agree — so a binding must resolve one, and every place that
/// would make the database sort, filter, group or write by one must refuse instead.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourSurfaceTests
{
    [TestMethod]
    public async Task AFormBindsACalculatedFieldBesideAStoredOneAndCarriesItsResult()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. FormRoot(),
            .. Binding("name-binding", "project-root", "name", 0),
            .. Binding("count-binding", "project-root", "taskCount", 1),
        ]);

        var compiled = await service.CompileSemanticUiAsync();
        AssertValid(compiled);
        var application = compiled.Applications.Single(plan => plan.Entity.SemanticId == "projects");

        var derived = application.Entity.DerivedFields.Single();
        Assert.AreEqual("taskCount", derived.SemanticId);
        Assert.AreEqual("Tasks", derived.DisplayName);
        Assert.AreEqual("count", derived.Expression, "A surface must be able to show what the field is calculated from.");

        CollectionAssert.AreEqual(
            new[] { "name", "taskCount" },
            application.Surfaces.Single().Children.Select(child => child.Properties["fieldId"].GetString()).ToArray(),
            "A calculated binding keeps the position it was authored at.");

        var record = application.Records.Single(item => item.SemanticId == "p1");
        Assert.IsFalse(record.Values.ContainsKey("taskCount"), "A calculated field must not arrive as a stored value.");
        var result = record.Calculations["taskCount"];
        Assert.AreEqual(NendoCalculationState.Value, result.State);
        Assert.AreEqual(2L, result.Value.GetInt64());
    }

    [TestMethod]
    public async Task AFailedCalculationDoesNotMakeTheSurfaceUnreadable()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. FormRoot(),
            .. Binding("name-binding", "project-root", "name", 0),
            .. Binding("ratio-binding", "project-root", "ratio", 1),
        ]);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // Divides by the task count, so the project with no tasks cannot be calculated.
        await coordinator.ApplyAsync(new("test", "ratio", "test", "A calculation that can fail", [
            new SetBehaviourDefinitionOperation("ratio", new NendoCalculationDefinition(
                "project.ratio", "projects", "ratio", "Ratio",
                NendoBehaviourScalar.Decimal, false, "100 / total",
                [NendoBehaviourBinding.SameRecordCalculation("total", "projects", "project.taskCount", NendoBehaviourScalar.Integer, false)]), revision),
        ]));
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["name"] = "Empty", ["stage"] = "open" }, Context("p2")));

        // The digest serializes every record the plan carries, results included. A
        // failed result that cannot be written would take the whole surface down with
        // it, and the file would refuse to open at all.
        var compiled = await service.CompileSemanticUiAsync();
        AssertValid(compiled);
        var failed = compiled.Applications.Single(plan => plan.Entity.SemanticId == "projects")
            .Records.Single(record => record.SemanticId == "p2").Calculations["ratio"];
        Assert.AreEqual(NendoCalculationState.Error, failed.State);
        Assert.AreEqual(NendoCalculationCodes.DivideByZero, failed.ErrorCode);
        Assert.AreEqual(JsonValueKind.Null, failed.Value.ValueKind,
            "A result with no value must still be a value JSON can write.");

        // And the file still opens, which is the property a reader actually depends on.
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using var reopened = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.IsNotNull(await new NendoApplicationService(reopened).GetSnapshotAsync());
    }

    [TestMethod]
    public async Task ARelatedListBindsTheRelatedRecordTypesCalculatedField()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. FormRoot(),
            .. Binding("name-binding", "project-root", "name", 0),
            new AddUiNodeOperation("section-add", "project-surface", "project-section", "project-root", "section", 1),
            new SetUiPropertyOperation("section-title", "project-surface", "project-section", "title", "Work"),
            new AddUiNodeOperation("related-add", "project-surface", "project-tasks", "project-section", "relatedList", 0),
            new SetUiPropertyOperation("related-target", "project-surface", "project-tasks", "targetEntityId", "tasks"),
            new SetUiPropertyOperation("related-via", "project-surface", "project-tasks", "viaFieldId", "project"),
            .. Binding("task-title-binding", "project-tasks", "title", 0),
            .. Binding("task-label-binding", "project-tasks", "label", 1),
        ]);

        var compiled = await service.CompileSemanticUiAsync();
        AssertValid(compiled);
        var related = compiled.Applications.Single(plan => plan.Entity.SemanticId == "projects")
            .Surfaces.Single()
            .Children.Single(child => child.Kind == "section")
            .Children.Single(child => child.Kind == "relatedList");
        CollectionAssert.AreEqual(
            new[] { "title", "label" },
            related.Children.Select(child => child.Properties["fieldId"].GetString()).ToArray(),
            "A related list resolves the related record type's calculated fields, not this one's.");
    }

    [TestMethod]
    public async Task AListShowsACalculatedColumnButCannotSortByOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. ListRoot(),
            .. Binding("list-name", "project-list", "name", 0),
            .. Binding("list-count", "project-list", "taskCount", 1),
        ]);
        AssertValid(await service.CompileSemanticUiAsync());

        await coordinator.ApplyAsync(new("test", "sort", "test", "Sort by the calculation", [
            new SetUiPropertyOperation("order-by", "project-surface", "project-list", "orderByFieldId", "taskCount"),
        ]));
        var refused = await service.CompileSemanticUiAsync();
        var diagnostic = AssertRefused(refused, "orderByFieldId");
        StringAssert.Contains(diagnostic.Message, "sort by it", StringComparison.Ordinal);
        StringAssert.Contains(diagnostic.Hint, "for display", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AFilterATotalAGroupingACalendarAndACommandAllRefuseACalculatedField()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        await ApplyUiAsync(coordinator, [
            .. ListRoot(),
            .. Binding("list-name", "project-list", "name", 0),
            new AddUiNodeOperation("filter-add", "project-surface", "project-filter", "project-list", "filterClause", 1),
            new SetUiPropertyOperation("filter-field", "project-surface", "project-filter", "fieldId", "taskCount"),
            new SetUiPropertyOperation("filter-operator", "project-surface", "project-filter", "operator", "isNotNull"),
        ]);
        AssertRefused(await service.CompileSemanticUiAsync(), "fieldId");

        await coordinator.ApplyAsync(new("test", "drop-filter", "test", "Remove the filter",
            [new RemoveUiNodeOperation("filter-remove", "project-surface", "project-filter")]));
        await coordinator.ApplyAsync(new("test", "tile", "test", "Total the calculation", [
            new AddUiNodeOperation("tile-add", "project-surface", "project-tile", "project-list", "summaryTile", 2),
            new SetUiPropertyOperation("tile-aggregate", "project-surface", "project-tile", "aggregate", "sum"),
            new SetUiPropertyOperation("tile-field", "project-surface", "project-tile", "fieldId", "taskCount"),
        ]));
        AssertRefused(await service.CompileSemanticUiAsync(), "fieldId");
        await coordinator.ApplyAsync(new("test", "drop-tile", "test", "Remove the tile",
            [new RemoveUiNodeOperation("tile-remove", "project-surface", "project-tile")]));

        await coordinator.ApplyAsync(new("test", "board", "test", "Group by the calculation", [
            new AddUiNodeOperation("board-add", "project-surface", "project-board", null, "boardSurface", 1),
            new SetUiPropertyOperation("board-version", "project-surface", "project-board", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("board-entity", "project-surface", "project-board", "entityId", "projects"),
            new SetUiPropertyOperation("board-group", "project-surface", "project-board", "groupByFieldId", "taskCount"),
            .. Binding("board-name", "project-board", "name", 0),
        ]));
        var board = AssertRefused(await service.CompileSemanticUiAsync(), "groupByFieldId");
        StringAssert.Contains(board.Message, "group by it", StringComparison.Ordinal);
        Assert.IsFalse((await service.CompileSemanticUiAsync()).Diagnostics.Any(item => item.Code == "NUI236"),
            "A calculated grouping must be refused once, for what it is, not also as a missing choice field.");
        await coordinator.ApplyAsync(new("test", "drop-board", "test", "Remove the board",
            [new RemoveUiNodeOperation("board-remove", "project-surface", "project-board")]));

        await coordinator.ApplyAsync(new("test", "calendar", "test", "Date by the calculation", [
            new AddUiNodeOperation("calendar-add", "project-surface", "project-calendar", null, "calendarSurface", 2),
            new SetUiPropertyOperation("calendar-version", "project-surface", "project-calendar", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("calendar-entity", "project-surface", "project-calendar", "entityId", "projects"),
            new SetUiPropertyOperation("calendar-date", "project-surface", "project-calendar", "dateFieldId", "taskCount"),
            .. Binding("calendar-name", "project-calendar", "name", 0),
        ]));
        AssertRefused(await service.CompileSemanticUiAsync(), "dateFieldId");
        await coordinator.ApplyAsync(new("test", "drop-calendar", "test", "Remove the calendar",
            [new RemoveUiNodeOperation("calendar-remove", "project-surface", "project-calendar")]));

        await coordinator.ApplyAsync(new("test", "timeline", "test", "Place by the calculation", [
            new AddUiNodeOperation("timeline-add", "project-surface", "project-timeline", null, "timelineSurface", 2),
            new SetUiPropertyOperation("timeline-version", "project-surface", "project-timeline", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("timeline-entity", "project-surface", "project-timeline", "entityId", "projects"),
            new SetUiPropertyOperation("timeline-date", "project-surface", "project-timeline", "dateFieldId", "taskCount"),
            .. Binding("timeline-name", "project-timeline", "name", 0),
        ]));
        AssertRefused(await service.CompileSemanticUiAsync(), "dateFieldId");
        // The end of a span is a bound of the same query as its start, so it is
        // refused by the same rule.
        await coordinator.ApplyAsync(new("test", "timeline-due", "test", "A stored start date",
            [new AddFieldOperation("p-due", "projects", "due", "Due", "due", NendoStorageKind.Date, false, "date")]));
        await coordinator.ApplyAsync(new("test", "timeline-end", "test", "End the span by the calculation", [
            new SetUiPropertyOperation("timeline-date-stored", "project-surface", "project-timeline", "dateFieldId", "due"),
            new SetUiPropertyOperation("timeline-end", "project-surface", "project-timeline", "endDateFieldId", "taskCount"),
        ]));
        AssertRefused(await service.CompileSemanticUiAsync(), "endDateFieldId");
        await coordinator.ApplyAsync(new("test", "drop-timeline", "test", "Remove the timeline",
            [new RemoveUiNodeOperation("timeline-remove", "project-surface", "project-timeline")]));

        // A gallery's card order is the database's order, so it refuses a calculated
        // field as a list does. Its title and accent are display roles refused by their
        // own codes, which the gallery's own tests cover.
        await coordinator.ApplyAsync(new("test", "gallery", "test", "Order cards by the calculation", [
            new AddUiNodeOperation("gallery-add", "project-surface", "project-gallery", null, "gallerySurface", 2),
            new SetUiPropertyOperation("gallery-version", "project-surface", "project-gallery", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("gallery-entity", "project-surface", "project-gallery", "entityId", "projects"),
            new SetUiPropertyOperation("gallery-order", "project-surface", "project-gallery", "orderByFieldId", "taskCount"),
            .. Binding("gallery-name", "project-gallery", "name", 0),
        ]));
        AssertRefused(await service.CompileSemanticUiAsync(), "orderByFieldId");
        await coordinator.ApplyAsync(new("test", "drop-gallery", "test", "Remove the gallery",
            [new RemoveUiNodeOperation("gallery-remove", "project-surface", "project-gallery")]));

        await coordinator.ApplyAsync(new("test", "command", "test", "Assign the calculation", [
            new AddUiNodeOperation("command-add", "project-surface", "project-command", null, "recordCommand", 3),
            new SetUiPropertyOperation("command-version", "project-surface", "project-command", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("command-entity", "project-surface", "project-command", "entityId", "projects"),
            new SetUiPropertyOperation("command-label", "project-surface", "project-command", "label", "Recount"),
            new AddUiNodeOperation("step-add", "project-surface", "project-step", "project-command", "commandStep", 0),
            new SetUiPropertyOperation("step-field", "project-surface", "project-step", "fieldId", "taskCount"),
            new SetUiPropertyOperation("step-kind", "project-surface", "project-step", "valueKind", "literal"),
            new SetUiPropertyOperation("step-value", "project-surface", "project-step", "value", 1L),
        ]));
        var step = AssertRefused(await service.CompileSemanticUiAsync(), "fieldId");
        StringAssert.Contains(step.Message, "assign to it", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AFormOfOnlyCalculatedFieldsIsRefusedBecauseNothingCanBeTypedIntoIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. FormRoot(),
            .. Binding("count-binding", "project-root", "taskCount", 0),
        ]);

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid);
        var diagnostic = compiled.Diagnostics.Single(item => item.Code == "NUI215");
        StringAssert.Contains(diagnostic.Message, "nothing to fill in", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task ABindingToANameThatIsNeitherStoredNorCalculatedStillRefuses()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. FormRoot(),
            .. Binding("name-binding", "project-root", "name", 0),
            .. Binding("ghost-binding", "project-root", "taskCountt", 1),
        ]);

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(item => item.Code == "NUI213"),
            "A near miss must still be a missing field, not a silently dropped binding.");
    }

    [TestMethod]
    public async Task HistoryDoesNotOfferCompensationForAUiRemoval()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [
            .. ListRoot(),
            .. Binding("list-name", "project-list", "name", 0),
            new AddUiNodeOperation("filter-add", "project-surface", "project-filter", "project-list", "filterClause", 1),
            new SetUiPropertyOperation("filter-field", "project-surface", "project-filter", "fieldId", "name"),
            new SetUiPropertyOperation("filter-operator", "project-surface", "project-filter", "operator", "isNotNull"),
        ]);

        // A single ui.removeNode revision. It is ReversibleWithRetainedState, but the
        // compensation engine has no inverse for it, so the paged history flag must not
        // offer a Compensate button the engine will refuse.
        var removal = await coordinator.ApplyAsync(new("test", "drop-filter", "test", "Remove the filter",
            [new RemoveUiNodeOperation("filter-remove", "project-surface", "project-filter")]));
        var history = await service.QueryHistoryAsync(new(1));
        Assert.AreEqual(removal.RevisionId, history.Items[0].RevisionId);
        Assert.IsFalse(history.Items[0].CanRequestCompensation,
            "History offered compensation for a ui.removeNode the engine refuses.");
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(removal.RevisionId, "undo-remove"));
    }

    [TestMethod]
    public async Task CompensatingACreatedUiPropertyIsRefusedNotMisreportedAsInvalidJson()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await ApplyUiAsync(coordinator, [.. ListRoot(), .. Binding("list-name", "project-list", "name", 0)]);

        // Set a property the node does not yet carry: its first value, so there is no
        // prior row. The retained evidence must record that there was no prior value.
        var created = await coordinator.ApplyAsync(new("test", "set-title", "test", "Name the list",
            [new SetUiPropertyOperation("list-title", "project-surface", "project-list", "title", "Projects")]));
        Assert.IsFalse(await PreviousValuePresentAsync(workspace.FilePath, created.RevisionId),
            "A created UI property recorded a prior value that never existed.");

        // Compensating it is genuinely unsupported — nothing removes a UI property row —
        // so it must refuse with the typed exception, not throw JsonException on the empty
        // string Convert.ToString produced for the absent prior value.
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(created.RevisionId, "undo-title"));

        // And history must not offer what the engine refuses. The flag listed every
        // ui.setProperty as compensable; it has to read the same retained evidence the
        // inverse does. A second value for the same property does retain a prior one,
        // so that revision is offered — the gate is the evidence, not the type.
        var history = await service.QueryHistoryAsync(new(1));
        Assert.AreEqual(created.RevisionId, history.Items[0].RevisionId);
        Assert.IsFalse(history.Items[0].CanRequestCompensation,
            "History offered compensation for a property's first value, which the engine refuses.");
        var renamed = await coordinator.ApplyAsync(new("test", "rename-title", "test", "Rename the list",
            [new SetUiPropertyOperation("list-title-2", "project-surface", "project-list", "title", "All projects")]));
        history = await service.QueryHistoryAsync(new(1));
        Assert.AreEqual(renamed.RevisionId, history.Items[0].RevisionId);
        Assert.IsTrue(history.Items[0].CanRequestCompensation,
            "History withheld compensation for a property change that retained its prior value.");
    }

    private static async Task<bool> PreviousValuePresentAsync(string path, string revisionId)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT inverse_evidence_json FROM __nendo_operation " +
            "WHERE revision_id = @revision AND operation_type = 'ui.setProperty' ORDER BY ordinal LIMIT 1;";
        command.Parameters.AddWithValue("@revision", revisionId);
        var json = (string)(await command.ExecuteScalarAsync())!;
        using var document = JsonDocument.Parse(json);
        return document.RootElement.GetProperty("previousValuePresent").GetBoolean();
    }

    private static void AssertValid(NendoCompileResult compiled) =>
        Assert.IsTrue(compiled.IsValid,
            string.Join("; ", compiled.Diagnostics.Select(item => item.Code + ": " + item.Message)));

    private static NendoCompilerDiagnostic AssertRefused(NendoCompileResult compiled, string property)
    {
        Assert.IsFalse(compiled.IsValid, "A bounded query over a calculated field was accepted.");
        var diagnostic = compiled.Diagnostics.Single(item => item.Code == "NUI214" && item.PropertyPath == property);
        StringAssert.Contains(diagnostic.Message, "is calculated", StringComparison.Ordinal);
        return diagnostic;
    }

    private static NendoOperation[] Binding(string nodeId, string parentNodeId, string fieldId, int position) =>
    [
        new AddUiNodeOperation(nodeId + "-add", "project-surface", nodeId, parentNodeId, "fieldBinding", position),
        new SetUiPropertyOperation(nodeId + "-field", "project-surface", nodeId, "fieldId", fieldId),
    ];

    private static NendoOperation[] FormRoot() =>
    [
        new AddUiNodeOperation("root-add", "project-surface", "project-root", null, "recordForm", 0),
        new SetUiPropertyOperation("root-version", "project-surface", "project-root", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation("root-entity", "project-surface", "project-root", "entityId", "projects"),
    ];

    private static NendoOperation[] ListRoot() =>
    [
        new AddUiNodeOperation("list-add", "project-surface", "project-list", null, "recordList", 0),
        new SetUiPropertyOperation("list-version", "project-surface", "project-list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation("list-entity", "project-surface", "project-list", "entityId", "projects"),
    ];

    private static Task ApplyUiAsync(NendoWriteCoordinator coordinator, NendoOperation[] operations) =>
        coordinator.ApplyAsync(new("test", "ui", "test", "Surfaces", operations));

    /// <summary>
    /// Two record types, one calculated field on each, and two real records — so a
    /// surface has something to bind and a result to show.
    /// </summary>
    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-stage", "projects", "stage", "Stage", "stage", NendoStorageKind.Text, true, "singleChoice", ["open", "done"]),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Calculations", [
            new SetBehaviourDefinitionOperation("count", new NendoCalculationDefinition(
                "project.taskCount", "projects", "taskCount", "Tasks",
                NendoBehaviourScalar.Integer, false, "count",
                [NendoBehaviourBinding.RelatedCount("count", "projects", "tasks", "project")]), revision),
            new SetBehaviourDefinitionOperation("label", new NendoCalculationDefinition(
                "task.label", "tasks", "label", "Label",
                NendoBehaviourScalar.Text, false, "Concat(title, ' (task)')",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project", ["stage"] = "open" }, Context("p1")));
        foreach (var (id, title) in new[] { ("t1", "First"), ("t2", "Second") })
        {
            await service.CreateRecordAsync(new("tasks", id,
                new Dictionary<string, object?> { ["project"] = "p1", ["title"] = title },
                Context(id), new Dictionary<string, long> { ["project"] = 1 }));
        }
        return service;
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
