using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S3 of ADR-0008: calculated fields over real records, their dependencies and
/// their error semantics, against a real SQLite file through the ordinary services.
/// </summary>
/// <remarks>
/// Not parallelized. Each case here creates a real <c>.nendo</c> file and drives it
/// through the ordinary coordinator, which is the point — but running dozens of them
/// at once saturates the disk and starves the timing-sensitive process lanes in the
/// other test assemblies. Running them one at a time costs a few seconds and keeps
/// the rest of the suite honest.
/// </remarks>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourCalculationTests
{
    [TestMethod]
    public async Task DependentCalculationsAndAReusableFunctionAllFollowAnEdit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);

        var project = await Project(service);
        Assert.AreEqual(3L, Number(project, "taskCount"));
        Assert.AreEqual(1L, Number(project, "doneCount"));
        Assert.AreEqual(2L, Number(project, "remaining"));
        // One third, rounded to two places by the reusable function, in the decimal
        // domain rather than a binary approximation of it.
        Assert.AreEqual(33.33m, Decimal(project, "completion"));

        // Editing one stored input moves every calculation that reads it, directly or
        // through another calculation.
        var tasks = await Tasks(service);
        await service.SetFieldAsync(new("tasks", "t2", "done", tasks["t2"], true, Context("finish-t2")));

        project = await Project(service);
        Assert.AreEqual(3L, Number(project, "taskCount"));
        Assert.AreEqual(2L, Number(project, "doneCount"));
        Assert.AreEqual(1L, Number(project, "remaining"));
        Assert.AreEqual(66.67m, Decimal(project, "completion"));
    }

    [TestMethod]
    public async Task RenamingAndReopeningPreserveBindingsAndResults()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);
        var before = await Project(service);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("rename-entity", new RenameEntityOperation("re", "tasks", "Work items", revision)));
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("rename-field", new RenameFieldOperation("rf", "tasks", "done", "Finished", revision)));

        var afterRename = await Project(service);
        Assert.AreEqual(
            JsonSerializer.Serialize(before.Calculations),
            JsonSerializer.Serialize(afterRename.Calculations),
            "A display rename changed what a calculation produced.");

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync();
        var afterReopen = await Project(new NendoApplicationService(reopened));
        Assert.AreEqual(
            JsonSerializer.Serialize(before.Calculations),
            JsonSerializer.Serialize(afterReopen.Calculations),
            "Reopening the file changed what a calculation produced.");
    }

    [TestMethod]
    public async Task AZeroDenominatorKeepsValidInputShowsAnErrorAndRecoversWhenCorrected()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);

        // A project with no tasks divides by zero. The record is still perfectly valid.
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["projectName"] = "Empty", ["total"] = 0L, ["complete"] = false },
            Context("empty-project")));

        var empty = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p2");
        Assert.AreEqual("Empty", empty.Values["projectName"].GetString(), "A calculation error damaged stored input.");
        Assert.AreEqual(0L, Number(empty, "taskCount"));

        var completion = Result(empty, "completion");
        Assert.AreEqual(NendoCalculationState.Error, completion.State);
        Assert.AreEqual(NendoCalculationCodes.DivideByZero, completion.ErrorCode);

        // Everything that does not divide is unaffected: one broken calculation is not
        // a broken record.
        Assert.AreEqual(NendoCalculationState.Value, Result(empty, "remaining").State);
        Assert.AreEqual(0L, Number(empty, "remaining"));

        // Correcting the input recovers, with no repair step of any kind.
        await service.CreateRecordAsync(new("tasks", "t4",
            new Dictionary<string, object?> { ["project"] = "p2", ["done"] = true, ["title"] = "First", ["effort"] = 0L },
            Context("fix"), new Dictionary<string, long> { ["project"] = 1 }));
        var fixedProject = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p2");
        Assert.AreEqual(NendoCalculationState.Value, Result(fixedProject, "completion").State);
        Assert.AreEqual(100m, Decimal(fixedProject, "completion"));
    }

    [TestMethod]
    public async Task ACalculationWhoseInputFailedReportsTheDependencyRatherThanAStaleValue()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        // A calculation that reads `completion`, which divides by zero for an empty project.
        await coordinator.ApplyAsync(Mutation("dependant", new SetBehaviourDefinitionOperation("d",
            new NendoCalculationDefinition("project.reported", "projects", "reported", "Reported",
                NendoBehaviourScalar.Decimal, false, "completion + 0.0",
                [NendoBehaviourBinding.SameRecordCalculation("completion", "projects", "project.completion", NendoBehaviourScalar.Decimal, false)]),
            revision)));
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["projectName"] = "Empty", ["total"] = 0L, ["complete"] = false },
            Context("empty-project")));

        var empty = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p2");
        var reported = Result(empty, "reported");
        Assert.AreEqual(NendoCalculationState.Error, reported.State);
        Assert.AreEqual(NendoCalculationCodes.DependencyFailed, reported.ErrorCode,
            "A dependant showed its own value beside an input that could not be calculated.");
    }

    [TestMethod]
    public async Task RelatedCreateDeleteAndReassignmentMoveBothParents()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["projectName"] = "Second", ["total"] = 0L, ["complete"] = false },
            Context("p2")));

        Assert.AreEqual(3L, Number(await Project(service), "taskCount"));
        Assert.AreEqual(0L, Number(await Project(service, "p2"), "taskCount"));

        // Reassignment: both the former and the new parent must be current.
        var tasks = await Tasks(service);
        await service.SetFieldAsync(new("tasks", "t1", "project", tasks["t1"], "p2", Context("move"), 1));
        Assert.AreEqual(2L, Number(await Project(service), "taskCount"));
        Assert.AreEqual(0L, Number(await Project(service), "doneCount"), "The completed task left, so the old parent's count must fall.");
        Assert.AreEqual(1L, Number(await Project(service, "p2"), "taskCount"));
        Assert.AreEqual(1L, Number(await Project(service, "p2"), "doneCount"));

        // Creation.
        await service.CreateRecordAsync(new("tasks", "t4",
            new Dictionary<string, object?> { ["project"] = "p2", ["done"] = false, ["title"] = "Added", ["effort"] = 0L },
            Context("create"), new Dictionary<string, long> { ["project"] = 1 }));
        Assert.AreEqual(2L, Number(await Project(service, "p2"), "taskCount"));

        // Deletion.
        tasks = await Tasks(service);
        await service.DeleteRecordAsync(new("tasks", "t4", tasks["t4"], Context("delete")));
        Assert.AreEqual(1L, Number(await Project(service, "p2"), "taskCount"));
    }

    [TestMethod]
    public async Task AggregatesFollowTheirDocumentedRulesForEmptyOverflowAndMissingValues()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("sum", new SetBehaviourDefinitionOperation("s",
            new NendoCalculationDefinition("project.effort", "projects", "effort", "Effort",
                NendoBehaviourScalar.Integer, false, "effortSum",
                [NendoBehaviourBinding.RelatedSum("effortSum", "projects", "tasks", "project", "effort", NendoBehaviourScalar.Integer)]),
            revision)));

        // Three tasks, each carrying the largest whole number the field can hold.
        var tasks = await Tasks(service);
        foreach (var (id, version) in tasks)
        {
            await service.SetFieldAsync(new("tasks", id, "effort", version, long.MaxValue, Context($"effort-{id}")));
        }
        var overflowed = Result(await Project(service), "effort");
        Assert.AreEqual(NendoCalculationState.Error, overflowed.State);
        Assert.AreEqual(NendoCalculationCodes.Overflow, overflowed.ErrorCode,
            "A total beyond the range was reported as a number rather than refused.");

        // An empty collection totals zero — a real answer, not a missing one.
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["projectName"] = "Empty", ["total"] = 0L, ["complete"] = false },
            Context("p2")));
        var empty = Result(await Project(service, "p2"), "effort");
        Assert.AreEqual(NendoCalculationState.Value, empty.State);
        Assert.AreEqual(0L, empty.Value.GetInt64());
    }

    [TestMethod]
    public async Task ACollectionLargerThanTheScanCeilingRefusesRatherThanTotallingPartOfIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("count", new SetBehaviourDefinitionOperation("c",
            new NendoCalculationDefinition("project.taskCount", "projects", "taskCount", "Tasks",
                NendoBehaviourScalar.Integer, false, "count",
                [NendoBehaviourBinding.RelatedCount("count", "projects", "tasks", "project")]),
            revision)));

        // The fixture holds three tasks. Lowering the host's ceiling reaches the exact
        // boundary without building a file the size of the ceiling; the ceiling is the
        // host's to set and never the file's.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 3 };
        Assert.AreEqual(3L, Number(await Project(service), "taskCount"));

        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 2 };
        var refused = Result(await Project(service), "taskCount");
        Assert.AreEqual(NendoCalculationState.Error, refused.State,
            "A collection past the scan ceiling produced a total of the part that was read.");
        Assert.AreEqual(NendoCalculationCodes.LimitReached, refused.ErrorCode);

        coordinator.BehaviourLimits = NendoBehaviourLimits.Default;
        Assert.AreEqual(3L, Number(await Project(service), "taskCount"));
    }

    [TestMethod]
    public async Task EveryReadRouteAgreesAndNoReadEverWritesToTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, service);
        await InstallBehaviour(coordinator, service);

        var snapshot = await Project(service);
        var page = await service.QueryRecordsAsync(new NendoRecordQuery("projects", 10) { RecordId = "p1" });
        Assert.AreEqual(
            JsonSerializer.Serialize(snapshot.Calculations),
            JsonSerializer.Serialize(page.Items.Single().Calculations),
            "A bounded query and a full snapshot disagreed about a calculated field.");

        var beforeRevisions = await service.GetHistoryAsync();
        var beforeManifest = (await service.GetSnapshotAsync()).Manifest;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath))
        {
            var readOnly = await new NendoApplicationService(reader).QueryRecordsAsync(
                new NendoRecordQuery("projects", 10) { RecordId = "p1" });
            Assert.AreEqual(
                JsonSerializer.Serialize(snapshot.Calculations),
                JsonSerializer.Serialize(readOnly.Items.Single().Calculations),
                "A read-only open disagreed about a calculated field.");
        }
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath),
            "Calculating while reading wrote to the file.");

        var after = await workspace.OpenAsync();
        var afterService = new NendoApplicationService(after);
        Assert.HasCount(beforeRevisions.Count, await afterService.GetHistoryAsync(),
            "Calculating raised a revision.");
        Assert.AreEqual(beforeManifest.DataRevision, (await afterService.GetSnapshotAsync()).Manifest.DataRevision);
        Assert.AreEqual(beforeManifest.ChangeSequence, (await afterService.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    private static async Task<NendoRecordSnapshot> Project(NendoApplicationService service, string recordId = "p1") =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    private static async Task<Dictionary<string, long>> Tasks(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records
            .Where(record => record.EntityId == "tasks")
            .ToDictionary(record => record.RecordId, record => record.RecordVersion, StringComparer.Ordinal);

    private static NendoCalculationResult Result(NendoRecordSnapshot record, string fieldId) =>
        record.Calculations.Single(calculation => calculation.FieldId == fieldId);

    private static long Number(NendoRecordSnapshot record, string fieldId)
    {
        var result = Result(record, fieldId);
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{fieldId}: {result.ErrorCode} {result.ErrorMessage}");
        return result.Value.GetInt64();
    }

    private static decimal Decimal(NendoRecordSnapshot record, string fieldId)
    {
        var result = Result(record, fieldId);
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{fieldId}: {result.ErrorCode} {result.ErrorMessage}");
        return result.Value.GetDecimal();
    }

    private static async Task InstallBehaviour(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Install calculations", [
            new SetBehaviourDefinitionOperation("f", new NendoFunctionDefinition(
                "fn.percent", "Percent",
                [new NendoFunctionParameter("part", "Part", NendoBehaviourScalar.Decimal, false),
                 new NendoFunctionParameter("whole", "Whole", NendoBehaviourScalar.Decimal, false)],
                NendoBehaviourScalar.Decimal, false, "RoundEven(part / whole * 100, 2)"), revision),
            new SetBehaviourDefinitionOperation("c1", new NendoCalculationDefinition(
                "project.taskCount", "projects", "taskCount", "Tasks",
                NendoBehaviourScalar.Integer, false, "count",
                [NendoBehaviourBinding.RelatedCount("count", "projects", "tasks", "project")]), revision),
            new SetBehaviourDefinitionOperation("c2", new NendoCalculationDefinition(
                "project.doneCount", "projects", "doneCount", "Done",
                NendoBehaviourScalar.Integer, false, "done",
                [NendoBehaviourBinding.RelatedFilteredCount("done", "projects", "tasks", "project", "done")]), revision),
            // Reads two other calculations rather than counting again.
            new SetBehaviourDefinitionOperation("c3", new NendoCalculationDefinition(
                "project.remaining", "projects", "remaining", "Remaining",
                NendoBehaviourScalar.Integer, false, "total - done",
                [NendoBehaviourBinding.SameRecordCalculation("total", "projects", "project.taskCount", NendoBehaviourScalar.Integer, false),
                 NendoBehaviourBinding.SameRecordCalculation("done", "projects", "project.doneCount", NendoBehaviourScalar.Integer, false)]), revision),
            // Reads two calculations and calls the reusable function.
            new SetBehaviourDefinitionOperation("c4", new NendoCalculationDefinition(
                "project.completion", "projects", "completion", "Completion",
                NendoBehaviourScalar.Decimal, false, "Percent(done, total)",
                [NendoBehaviourBinding.SameRecordCalculation("total", "projects", "project.taskCount", NendoBehaviourScalar.Integer, false),
                 NendoBehaviourBinding.SameRecordCalculation("done", "projects", "project.doneCount", NendoBehaviourScalar.Integer, false)],
                [new NendoFunctionCallAlias("Percent", "fn.percent")]), revision),
        ]));
    }

    private static async Task Seed(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new AddFieldOperation("p-complete", "projects", "complete", "Complete", "complete", NendoStorageKind.Boolean, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-effort", "tasks", "effort", "Effort", "effort", NendoStorageKind.Integer, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 0L, ["complete"] = false },
            Context("p1")));
        foreach (var (id, done, title) in new[] { ("t1", true, "First"), ("t2", false, "Second"), ("t3", false, "Third") })
        {
            await service.CreateRecordAsync(new("tasks", id,
                new Dictionary<string, object?> { ["project"] = "p1", ["done"] = done, ["title"] = title, ["effort"] = 0L },
                Context(id), new Dictionary<string, long> { ["project"] = 1 }));
        }
    }

    private static NendoMutation Mutation(string key, NendoOperation operation) => new("test", key, "test", key, [operation]);

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
