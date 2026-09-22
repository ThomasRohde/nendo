namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S8 of ADR-0008, obligation P4: every production write route goes through
/// the same staging, the same triggers and the same budget.
/// <para>
/// The risk this lane exists for is not that the planner is wrong — that is S4's —
/// but that one route quietly misses it. A paste that skipped triggers, or an import
/// that reset the budget per row, would leave a file whose stored fields are right
/// only where the edit happened to come from the form.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourWriteRouteTests
{
    [TestMethod]
    public async Task EveryRouteFiresTheSameTriggerAndCommitsOneCausalRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // One record edit.
        var before = (await service.GetHistoryAsync()).Count;
        var tasks = await VersionsAsync(service, "tasks");
        await service.SetFieldAsync(new("tasks", "t1", "done", tasks["t1"], true, Context("edit")));
        Assert.AreEqual(1L, await TotalAsync(service), "A single field edit did not reach the trigger.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync(), "A single field edit committed more than one revision.");

        // A multi-field form, which is several stored versions but one logical change.
        tasks = await VersionsAsync(service, "tasks");
        before = (await service.GetHistoryAsync()).Count;
        await service.SetFieldsAsync(new("tasks", "t2", tasks["t2"],
            new Dictionary<string, object?> { ["done"] = true, ["title"] = "Renamed" }, Context("form")));
        Assert.AreEqual(2L, await TotalAsync(service), "A multi-field form did not reach the trigger.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync(), "A form edit committed more than one revision.");

        // One new record. The project's version has moved twice by now, because the
        // action has been writing to it — which is itself the thing under test.
        before = (await service.GetHistoryAsync()).Count;
        await service.CreateRecordAsync(new("tasks", "t4",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Created" },
            Context("create"), new Dictionary<string, long> { ["project"] = await ProjectVersionAsync(service) }));
        Assert.AreEqual(3L, await TotalAsync(service), "Creating a record did not reach the trigger.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync());

        // A declared command, which is a surface button rather than a typed edit.
        var current = await VersionsAsync(service, "tasks");
        before = (await service.GetHistoryAsync()).Count;
        await service.ExecuteCommandAsync(new("finishTask", "t3", current["t3"], Context("command")));
        Assert.AreEqual(4L, await TotalAsync(service), "A declared command did not reach the trigger.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync());

        // Deleting one.
        current = await VersionsAsync(service, "tasks");
        before = (await service.GetHistoryAsync()).Count;
        await service.DeleteRecordAsync(new("tasks", "t4", current["t4"], Context("delete")));
        Assert.AreEqual(3L, await TotalAsync(service), "Deleting a record did not reach the trigger.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync());
    }

    [TestMethod]
    public async Task ABoundedPasteIsOneTransactionSharingOneBudget()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var before = (await service.GetHistoryAsync()).Count;
        var projectVersion = await ProjectVersionAsync(service);
        await service.CreateRecordsAsync(new("tasks",
        [
            new("b1", new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "One" },
                new Dictionary<string, long> { ["project"] = projectVersion }),
            new("b2", new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Two" },
                new Dictionary<string, long> { ["project"] = projectVersion }),
            new("b3", new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Three" },
                new Dictionary<string, long> { ["project"] = projectVersion }),
        ], Context("paste")));

        Assert.AreEqual(3L, await TotalAsync(service), "A pasted batch did not reach the trigger for every row.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync(),
            "A bounded paste became several transactions, so a failure could commit part of it.");
    }

    [TestMethod]
    public async Task APastedBatchSpendsOneBudgetRatherThanOnePerRow()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["name"] = "Second", ["total"] = 0L }, Context("p2")));

        // One row per project, so the paste generates two changes rather than one.
        // A budget reset per row would give each row its own allowance of one and let
        // an import of any size through; one budget for the whole causal transaction
        // refuses it, and refuses all of it.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = 1 };
        var before = (await service.GetHistoryAsync()).Count;
        var beforeTotals = await TotalsAsync(service);
        var versions = await VersionsAsync(service, "projects");

        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => service.CreateRecordsAsync(new("tasks",
        [
            new("b1", new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "One" },
                new Dictionary<string, long> { ["project"] = versions["p1"] }),
            new("b2", new Dictionary<string, object?> { ["project"] = "p2", ["done"] = true, ["title"] = "Two" },
                new Dictionary<string, long> { ["project"] = versions["p2"] }),
        ], Context("over-budget"))));

        Assert.AreEqual(NendoCalculationCodes.LimitReached, refused.Code);
        CollectionAssert.AreEqual(beforeTotals, await TotalsAsync(service), "A refused paste left part of its work behind.");
        Assert.HasCount(before, await service.GetHistoryAsync(), "A refused paste raised a revision.");
        Assert.IsEmpty((await service.GetSnapshotAsync()).Records
            .Where(record => record.RecordId.StartsWith('b')).ToArray(),
            "A refused paste created records.");

        // The same paste under the shipped ceiling commits, so the refusal above was
        // the budget and not the paste.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default;
        await service.CreateRecordsAsync(new("tasks",
        [
            new("b1", new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "One" },
                new Dictionary<string, long> { ["project"] = versions["p1"] }),
            new("b2", new Dictionary<string, object?> { ["project"] = "p2", ["done"] = true, ["title"] = "Two" },
                new Dictionary<string, long> { ["project"] = versions["p2"] }),
        ], Context("within-budget")));
        Assert.HasCount(before + 1, await service.GetHistoryAsync());
    }

    private static async Task<long[]> TotalsAsync(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records
            .Where(record => record.EntityId == "projects")
            .OrderBy(record => record.RecordId, StringComparer.Ordinal)
            .Select(record => record.Values["total"].GetInt64())
            .ToArray();

    private static async Task<long> ProjectVersionAsync(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1").RecordVersion;

    private static async Task<long> TotalAsync(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1").Values["total"].GetInt64();

    private static async Task<Dictionary<string, long>> VersionsAsync(NendoApplicationService service, string entityId) =>
        (await service.GetSnapshotAsync()).Records
            .Where(record => record.EntityId == entityId)
            .ToDictionary(record => record.RecordId, record => record.RecordVersion, StringComparer.Ordinal);

    private static async Task SeedAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Finished", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project", ["total"] = 0L }, Context("p1")));
        foreach (var id in new[] { "t1", "t2", "t3" })
        {
            await service.CreateRecordAsync(new("tasks", id,
                new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false, ["title"] = id },
                Context(id), new Dictionary<string, long> { ["project"] = 1 }));
        }

        // One declared command, so the surface route is a real button rather than a
        // second name for a field edit.
        await coordinator.ApplyAsync(new("test", "surface", "test", "A task page and a command", [
            new AddUiNodeOperation("form-add", "task-surface", "taskForm", null, "recordForm", 0),
            new SetUiPropertyOperation("form-version", "task-surface", "taskForm", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("form-entity", "task-surface", "taskForm", "entityId", "tasks"),
            new AddUiNodeOperation("title-add", "task-surface", "taskTitle", "taskForm", "fieldBinding", 0),
            new SetUiPropertyOperation("title-field", "task-surface", "taskTitle", "fieldId", "title"),
            new AddUiNodeOperation("command-add", "task-surface", "finishTask", null, "recordCommand", 1),
            new SetUiPropertyOperation("command-version", "task-surface", "finishTask", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("command-entity", "task-surface", "finishTask", "entityId", "tasks"),
            new SetUiPropertyOperation("command-label", "task-surface", "finishTask", "label", "Finish"),
            new AddUiNodeOperation("step-add", "task-surface", "finishStep", "finishTask", "commandStep", 0),
            new SetUiPropertyOperation("step-field", "task-surface", "finishStep", "fieldId", "done"),
            new SetUiPropertyOperation("step-kind", "task-surface", "finishStep", "valueKind", "literal"),
            new SetUiPropertyOperation("step-value", "task-surface", "finishStep", "value", true),
        ]));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Keep the finished count current", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.count", "Count finished tasks",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")],
                        []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-total", "tasks", "Keep the finished count current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
                "project.count", ["done", "project"]), revision),
        ]));

        // The cases here are about what the routes do, not about consent; the cases
        // about consent itself live in BehaviourGrantTests.
        TestBehaviourAuthority.Approving(coordinator);
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
