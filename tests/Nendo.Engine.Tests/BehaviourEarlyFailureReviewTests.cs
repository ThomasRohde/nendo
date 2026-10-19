using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Automatic actions and calculations that must not install and then fail every save, or
/// skip silently. Each case runs a
/// real <c>.nendo</c> file through the ordinary coordinator.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourEarlyFailureReviewTests
{
    [TestMethod]
    public async Task EBH01_ASaveWhoseConditionCannotBeWorkedOutSaysWhichActionDidNotRun()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // Done was never set on t1, and the condition does not accept an empty value.
        await InstallAsync(coordinator, service,
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))),
            new NendoTriggerDefinition("stamp.trigger", "tasks", "Stamp finished tasks", NendoTriggerEvents.Updated, "stamp", ["hours"],
                "done = true", [NendoBehaviourBinding.SameRecordField("done", "tasks", "done", NendoBehaviourScalar.Boolean, true)]));
        TestBehaviourAuthority.Approving(coordinator);

        var applied = await service.SetFieldAsync(new("tasks", "t1", "hours", 1, 3L, Context("edit")));

        var blocked = applied.BlockedConditions.SingleOrDefault();
        Assert.IsNotNull(blocked, "The save committed with an action skipped by an undecidable condition and reported plain success.");
        Assert.AreEqual(("stamp.trigger", "Stamp finished tasks", "tasks", "t1", NendoCalculationCodes.MissingInput),
            (blocked.TriggerId, blocked.DisplayName, blocked.EntityId, blocked.RecordId, blocked.Code));
        Assert.AreEqual("First", (await Record(service, "t1")).Values["title"].GetString(), "A blocked condition ran its action anyway.");
        Assert.AreEqual(3L, (await Record(service, "t1")).Values["hours"].GetInt64(), "The person's own edit must still commit.");
    }

    [TestMethod]
    public async Task EBH02_ACeilingReachedInsideATriggerConditionAbortsTheSave()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        for (var index = 1; index <= 3; index++)
        {
            await service.CreateRecordAsync(new("notes", $"n{index}", new Dictionary<string, object?> { ["noteTask"] = "t1" },
                Context($"n{index}"), new Dictionary<string, long> { ["noteTask"] = 1 }));
        }
        await InstallAsync(coordinator, service,
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))),
            new NendoTriggerDefinition("stamp.trigger", "tasks", "Stamp tasks with few notes", NendoTriggerEvents.Updated, "stamp", ["hours"],
                "noteCount < 500", [NendoBehaviourBinding.RelatedCount("noteCount", "tasks", "notes", "noteTask")]));
        TestBehaviourAuthority.Approving(coordinator);
        var version = (await Record(service, "t1")).RecordVersion;
        // Three notes, and room to read two: the condition reaches the related-row ceiling.
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 2 };

        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(
            () => service.SetFieldAsync(new("tasks", "t1", "hours", version, 3L, Context("edit"))),
            "A ceiling reached inside a trigger condition was swallowed as a blocked condition, and the save committed without the action.");
        Assert.AreEqual(NendoCalculationCodes.LimitReached, refused.Code);
        Assert.AreEqual(2L, (await Record(service, "t1")).Values["hours"].GetInt64());
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("early-failure", "edit")));
    }

    [TestMethod]
    public async Task EBH03_ASetStepBindingThatStartsFromAnotherRecordTypeIsRefusedAtInstall()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // The step writes the project, and the binding reads the task's title by the project's ID.
        var refused = await RefusedAsync(coordinator, service,
            "A set step whose binding starts from the event record, not the record it writes, installed and then failed every save.",
            Stamp("note", NendoActionStep.SetField("10-note", NendoActionTarget.Referenced("project"), new NendoActionAssignment("note", "title",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)], []))),
            TaskTrigger("note", NendoTriggerEvents.Updated));
        Assert.AreEqual("action-target-mismatch", refused.Code);
        StringAssert.Contains(refused.Message, "starting from a 'tasks' record, but that step reads from the record it writes, a 'projects' record.", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task EBH03_ACreateStepBindingMustStartFromTheEventRecordAndNotReadADeletedOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var fromProject = await RefusedAsync(coordinator, service,
            "A create step binding that starts from another record type installed.",
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "name",
                [NendoBehaviourBinding.SameRecordField("name", "projects", "projectName", NendoBehaviourScalar.Text, false)], [])])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        Assert.AreEqual("action-target-mismatch", fromProject.Code);
        StringAssert.Contains(fromProject.Message, "a create step reads from the record that raised the event, a 'tasks' record.", StringComparison.Ordinal);

        var onDelete = await RefusedAsync(coordinator, service,
            "A create step that reads the deleted record installed, and every delete of that type was refused.",
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "title",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)], [])])),
            TaskTrigger("log", NendoTriggerEvents.Created | NendoTriggerEvents.Deleted));
        Assert.AreEqual("action-target-mismatch", onDelete.Code);
        StringAssert.Contains(onDelete.Message, "also runs it when a record is deleted, when there is no record to read.", StringComparison.Ordinal);

        // A total of related records still reads on a deletion, so it is not refused.
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "n > 0 ? 'had notes' : 'no notes'",
                [NendoBehaviourBinding.RelatedCount("n", "tasks", "notes", "noteTask")], [])])),
            TaskTrigger("log", NendoTriggerEvents.Created | NendoTriggerEvents.Deleted));
    }

    [TestMethod]
    public async Task EBH04_AnAssignmentWhoseResultCanNeverBeStoredIsRefusedAtInstall()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var hours = NendoBehaviourBinding.RelatedSum("h", "projects", "tasks", "project", "hours", NendoBehaviourScalar.Integer);
        NendoActionDefinition Set(string fieldId, string expression) =>
            Stamp("set", NendoActionStep.SetField("10-set", NendoActionTarget.Referenced("project"), new NendoActionAssignment(fieldId, expression, [hours], [])));

        var average = await RefusedAsync(coordinator, service,
            "An action dividing into a whole-number field installed, and every save with a fractional result was refused.",
            Set("average", "h / 2"), TaskTrigger("set", NendoTriggerEvents.Updated));
        Assert.AreEqual("action-target-mismatch", average.Code);
        StringAssert.Contains(average.Message, "writes a decimal value to 'average'", StringComparison.Ordinal);
        StringAssert.Contains(average.Message, "RoundAway(..., 0)", StringComparison.Ordinal);

        var flag = await RefusedAsync(coordinator, service, "An action writing true/false to a whole-number field installed.",
            Set("average", "h > 1"), TaskTrigger("set", NendoTriggerEvents.Updated));
        Assert.AreEqual("action-target-mismatch", flag.Code);

        // What can be stored installs: a rounding to 0 digits, a whole number into a decimal,
        // and text into a date, which is checked per value when the step runs.
        await InstallAsync(coordinator, service, Set("average", "RoundAway(h / 2, 0)"), TaskTrigger("set", NendoTriggerEvents.Updated));
        await InstallAsync(coordinator, service, Set("share", "h"), TaskTrigger("set", NendoTriggerEvents.Updated));
        await InstallAsync(coordinator, service, Set("due", "'2026-10-13'"), TaskTrigger("set", NendoTriggerEvents.Updated));
    }

    [TestMethod]
    public async Task EBH04_ACreateStepThatLeavesARequiredFieldEmptyIsRefusedAtInstall()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var refused = await RefusedAsync(coordinator, service,
            "A create step without a required field installed, and every save that ran it was refused.",
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("detail", "'kickoff'")])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        Assert.AreEqual("action-target-mismatch", refused.Code);
        StringAssert.Contains(refused.Message, "without a value for the required field 'text'", StringComparison.Ordinal);

        // Code is required too, and a sequence numbers it, so the step need not.
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "'kickoff'")])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        TestBehaviourAuthority.Approving(coordinator);
        await service.CreateRecordAsync(new("tasks", "t2", new Dictionary<string, object?> { ["project"] = "p1", ["hours"] = 1L, ["title"] = "Second" },
            Context("t2"), new Dictionary<string, long> { ["project"] = 1 }));
        Assert.AreEqual("L-001", (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "logs").Values["code"].GetString());
    }

    [TestMethod]
    public async Task EBH06_TwoCalculationsOfOneFieldOnOneRecordTypeAreRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        NendoCalculationDefinition Score(string id, string expression) =>
            new(id, "projects", "score", $"Score {id}", NendoBehaviourScalar.Integer, false, expression, []);

        var together = await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => InstallAsync(coordinator, service, Score("score.a", "1"), Score("score.b", "2")),
            "Two calculations of one field installed, and every record query over the type then threw a duplicate-key exception.");
        StringAssert.Contains(together.Message, "both calculate the field 'score' of 'projects'", StringComparison.Ordinal);

        await InstallAsync(coordinator, service, Score("score.a", "1"));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service, Score("score.b", "2")),
            "A second calculation of a field already calculated installed.");
        var added = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new("test", "add", "test", "Add score",
                [new AddFieldOperation("add", "projects", "score", "Stored score", "stored_score", NendoStorageKind.Integer, false)])),
            "schema.addField reused a calculated field's ID, leaving a stored and a calculated field under one ID.");
        StringAssert.Contains(added.Message, "already the calculated field of 'score.a'", StringComparison.Ordinal);

        Assert.HasCount(1, (await service.QueryRecordsAsync(new("projects", 10))).Items, "The record query over the type still reads.");
    }

    /// <summary>
    /// The duplicate check belongs to install. In the graph
    /// that every open compiles, a file that already held two calculations of one field lost
    /// every calculation it had, where before only reads of that one record type failed.
    /// </summary>
    [TestMethod]
    public async Task EBH06_AFileThatAlreadyHoldsADuplicateKeepsItsOtherCalculations()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            new NendoCalculationDefinition("score.a", "projects", "score", "Score", NendoBehaviourScalar.Integer, false, "1", []),
            new NendoCalculationDefinition("task.double", "tasks", "double", "Double", NendoBehaviourScalar.Integer, false, "h * 2",
                [NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false)]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        // As a host before the check could leave it: a second calculation of the project's score.
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO __nendo_behaviour(definition_id, definition_kind, contract_version, owning_entity_id, body_json) " +
                "SELECT 'score.b', definition_kind, contract_version, owning_entity_id, body_json FROM __nendo_behaviour WHERE definition_id = 'score.a';";
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);

        var doubled = (await service.QueryRecordsAsync(new("tasks", 10))).Items.Single().Calculations.SingleOrDefault(result => result.FieldId == "double");
        Assert.IsNotNull(doubled, "A duplicate on one record type took every calculation in the file with it: the task's own calculation is gone.");
        Assert.AreEqual(NendoCalculationState.Value, doubled.State,
            $"A duplicate on one record type took every calculation in the file with it: {doubled.ErrorCode} {doubled.ErrorMessage}");
        Assert.AreEqual(4L, doubled.Value.GetInt64());
    }

    [TestMethod]
    public async Task EBH09_AFieldATotalReadsCannotBecomeOptionalUnlessTheSameChangeRewiresIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("project.hours", "projects", "totalHours", "Total hours",
            NendoBehaviourScalar.Integer, false, "h", [NendoBehaviourBinding.RelatedSum("h", "projects", "tasks", "project", "hours", NendoBehaviourScalar.Integer)]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "optional", "test", "Hours optional", [new SetFieldRequiredOperation("optional", "tasks", "hours", false, revision)])),
            "A field an installed total reads became optional, and the first task saved without it broke the total.");
        Assert.AreEqual("field-requirement-in-use", refused.Code);
        StringAssert.Contains(refused.Message, "'project.hours' reads 'hours'", StringComparison.Ordinal);

        await coordinator.ApplyAsync(new("test", "rewire", "test", "Drop the total, then hours optional", [
            new SetFieldRequiredOperation("optional", "tasks", "hours", false, revision),
            new RemoveBehaviourDefinitionOperation("drop", "project.hours", NendoBehaviourKind.Calculation, revision),
        ]));
        Assert.IsFalse((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "tasks").Fields.Single(field => field.FieldId == "hours").Required);
    }

    [TestMethod]
    public async Task EBH09_AFieldACreateStepLeavesEmptyCannotBecomeRequired()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "'kickoff'")])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "required", "test", "Detail required", [new SetFieldRequiredOperation("required", "logs", "detail", true, revision)])),
            "A field an installed create step leaves empty became required, and every save that ran the step was refused.");
        Assert.AreEqual("field-requirement-in-use", refused.Code);
        StringAssert.Contains(refused.Message, "without a value for 'detail'", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task EBH09_RetiringAReferenceOnlyACreateStepLinksIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "'kickoff'")],
                [new NendoActionLink("logTask", NendoActionTarget.EventRecord), new NendoActionLink("logProject", NendoActionTarget.Referenced("project"))])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "retire", "test", "Retire the log's task", [new SetRetiredOperation("retire", "logs", "logTask", true, revision)])),
            "A reference only a create step's link uses was retired, and the next create was refused with field-retired.");
        Assert.AreEqual("retired-binding", refused.Code);

        // The reference a link follows from the event record is a use too: without it the link has no target.
        var followed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "retire-followed", "test", "Retire the task's project", [new SetRetiredOperation("retire-followed", "tasks", "project", true, revision)])),
            "A reference a create step's link follows was retired, and the next create was refused.");
        Assert.AreEqual("retired-binding", followed.Code);
        StringAssert.Contains(followed.Message, "still uses project", StringComparison.Ordinal);
    }

    /// <summary>
    /// Install exempts a retired field and a numbered one from
    /// what a create step must fill, so making such a field active again, or removing its
    /// sequence, can leave the step short of a required value just as a new requirement can.
    /// </summary>
    [TestMethod]
    public async Task EBH09_ReactivatingOrUnnumberingAFieldACreateStepLeavesEmptyIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "detail-required", "test", "Detail required", [new SetFieldRequiredOperation("required", "logs", "detail", true, revision)]));
        await coordinator.ApplyAsync(new("test", "detail-retired", "test", "Detail retired", [new SetRetiredOperation("retire", "logs", "detail", true, revision + 1)]));
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "'kickoff'")])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var reactivated = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "reactivate", "test", "Detail active again", [new SetRetiredOperation("reactivate", "logs", "detail", false, revision)])),
            "A required field an installed create step leaves empty was made active again, and every save that ran the step was refused.");
        Assert.AreEqual("field-requirement-in-use", reactivated.Code);
        StringAssert.Contains(reactivated.Message, "without a value for 'detail'", StringComparison.Ordinal);

        var unnumbered = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "unnumber", "test", "Stop numbering logs", [new SetFieldSequenceOperation("unnumber", "logs", "code", null, null, revision)])),
            "A required field an installed create step leaves to its sequence lost the sequence, and every save that ran the step was refused.");
        Assert.AreEqual("field-requirement-in-use", unnumbered.Code);
        StringAssert.Contains(unnumbered.Message, "without a value for 'code'", StringComparison.Ordinal);
    }

    /// <summary>
    /// The check compares every required field a create step leaves empty with the change, not
    /// only the first: a step a host installed before that check may already leave one empty, and
    /// that one must not hide the field the change makes required.
    /// </summary>
    [TestMethod]
    public async Task EBH09_AStepAlreadyShortOfOneFieldDoesNotHideTheFieldAChangeRequires()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "'kickoff'")])),
            TaskTrigger("log", NendoTriggerEvents.Created));
        // As an older host left it: the step writes detail and leaves the required text empty.
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_behaviour SET body_json = json_set(body_json, '$.steps[0].assignments[0].fieldId', 'detail') WHERE definition_id = 'log';";
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(new("test", "summary", "test", "Summary required", [new SetFieldRequiredOperation("required", "logs", "summary", true, revision)])),
            "A field the step leaves empty became required because another empty field came first.");
        Assert.AreEqual("field-requirement-in-use", refused.Code);
        StringAssert.Contains(refused.Message, "without a value for 'summary'", StringComparison.Ordinal);
    }

    /// <summary>
    /// Projects, tasks under them, notes and logs on tasks, one project and one task. A log's
    /// code is required and numbered by a sequence.
    /// </summary>
    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> SchemaAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-note", "projects", "note", "Note", "note", NendoStorageKind.Text, false),
            new AddFieldOperation("p-average", "projects", "average", "Average", "average", NendoStorageKind.Integer, false),
            new AddFieldOperation("p-share", "projects", "share", "Share", "share", NendoStorageKind.Decimal, false),
            new AddFieldOperation("p-due", "projects", "due", "Due", "due", NendoStorageKind.Date, false),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-hours", "tasks", "hours", "Hours", "hours", NendoStorageKind.Integer, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, false),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("t-bind", "tasks", "project", "projects", "projectName", 0),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-task", "notes", "noteTask", "Task", "task_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("n-bind", "notes", "noteTask", "tasks", "title", 0),
            new CreateEntityOperation("logs", "logs", "Logs", "logs"),
            new AddFieldOperation("l-task", "logs", "logTask", "Task", "task_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("l-text", "logs", "text", "Text", "text", NendoStorageKind.Text, true),
            new AddFieldOperation("l-code", "logs", "code", "Code", "code", NendoStorageKind.Text, true),
            new AddFieldOperation("l-detail", "logs", "detail", "Detail", "detail", NendoStorageKind.Text, false),
            new AddFieldOperation("l-project", "logs", "logProject", "Project", "project_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("l-summary", "logs", "summary", "Summary", "summary", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("l-bind", "logs", "logTask", "tasks", "title", 0),
            new ConfigureReferenceOperation("l-bind-project", "logs", "logProject", "projects", "projectName", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "unique", "test", "Unique code", [new SetFieldUniqueOperation("unique", "logs", "code", true, revision)]));
        await coordinator.ApplyAsync(new("test", "sequence", "test", "Number the logs",
            [new SetFieldSequenceOperation("sequence", "logs", "code", "L-", 3, revision + 1)]));
        await service.CreateRecordAsync(new("projects", "p1", new Dictionary<string, object?> { ["projectName"] = "Project" }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1", new Dictionary<string, object?> { ["project"] = "p1", ["hours"] = 2L, ["title"] = "First" },
            Context("t1"), new Dictionary<string, long> { ["project"] = 1 }));
        return (coordinator, service);
    }

    private static NendoActionDefinition Stamp(string actionId, NendoActionStep step) => new(actionId, $"Action {actionId}", [step]);

    private static NendoTriggerDefinition TaskTrigger(string actionId, NendoTriggerEvents events) =>
        new($"{actionId}.trigger", "tasks", $"Run {actionId}", events, actionId);

    private static async Task InstallAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, params NendoBehaviourDefinition[] definitions)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var key = $"install-{Guid.NewGuid():N}";
        await coordinator.ApplyAsync(new("test", key, "test", "Install behaviour",
            definitions.Select((definition, index) => (NendoOperation)new SetBehaviourDefinitionOperation($"{key}-{index}", definition, revision)).ToArray()));
    }

    private static async Task<NendoPreconditionException> RefusedAsync(
        NendoWriteCoordinator coordinator, NendoApplicationService service, string defect, params NendoBehaviourDefinition[] definitions) =>
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => InstallAsync(coordinator, service, definitions), defect);

    private static async Task<NendoRecordSnapshot> Record(NendoApplicationService service, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    private static NendoRequestContext Context(string key) => new("early-failure", key, "test");
}
