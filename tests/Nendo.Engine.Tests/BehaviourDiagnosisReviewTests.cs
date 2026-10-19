using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Smaller guards on automatic actions and calculations: refusals that did not say where, definitions that installed and then
/// did nothing, and reads and undos that disagreed with the rest of the file. Each case runs a
/// real <c>.nendo</c> file through the ordinary coordinator unless it is about one formula.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourDiagnosisReviewTests
{
    [TestMethod]
    public async Task EBH05_ACreateStepRefusedByItsOwnWriteNamesTheActionTheStepAndTheField()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // Text may fill a date field, so this installs; the value is refused when it is written.
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs",
                [new NendoActionAssignment("text", "'kickoff'"), new NendoActionAssignment("due", "'not a date'")])),
            TaskTrigger("log", NendoTriggerEvents.Updated));
        TestBehaviourAuthority.Approving(coordinator);
        var direct = await Assert.ThrowsAsync<NendoException>(() => service.CreateRecordAsync(new("logs", "direct",
            new Dictionary<string, object?> { ["text"] = "typed", ["due"] = "not a date" }, Context("direct"))));

        var refused = await Assert.ThrowsAsync<NendoException>(() => Edit(service, "t1", 3L));

        StringAssert.Contains(refused.Message,
            "The automatic action 'Action log' (run by 'Run log') could not create a 'Logs' record (step 10-log):", StringComparison.Ordinal,
            "A create step's refused write named neither the action nor the step, only a field the person never saw.");
        StringAssert.Contains(refused.Message, direct.Message, StringComparison.Ordinal);
        StringAssert.EndsWith(refused.Message, "The save was refused, so nothing changed.", StringComparison.Ordinal);
        Assert.AreEqual((direct.GetType(), Code(direct)), (refused.GetType(), Code(refused)),
            "Naming the action changed the refusal's type or code, so a surface would map it differently.");
        Assert.AreEqual(2L, (await Record(service, "t1")).Values["hours"].GetInt64());

        // A formula that fails names the field it was filling, by its display name.
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "ToText(h / 0)",
                [NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false)], [])])));
        TestBehaviourAuthority.Approving(coordinator);
        var formula = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => Edit(service, "t1", 3L));
        StringAssert.Contains(formula.Message, "could not create a 'Logs' record with 'Text' (step 10-log): This calculation divides by zero.",
            StringComparison.Ordinal, "The refusal named the record type and the field by their IDs, not as the person sees them.");
    }

    [TestMethod]
    public async Task EBH05_ADeleteStepBlockedByReferencesNamesTheActionNotJustTheRecord()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("prune", NendoActionStep.DeleteRecord("10-prune", NendoActionTarget.Referenced("project"))),
            TaskTrigger("prune", NendoTriggerEvents.Updated));
        TestBehaviourAuthority.Approving(coordinator);
        var project = await Record(service, "p1");
        var direct = await Assert.ThrowsAsync<NendoException>(() => coordinator.ApplyAsync(new("test", "direct-delete", "test", "Delete",
            [new DeleteRecordOperation("direct-delete", "projects", "p1", project.RecordVersion)])));

        var refused = await Assert.ThrowsAsync<NendoException>(() => Edit(service, "t1", 3L));

        StringAssert.Contains(refused.Message,
            "The automatic action 'Action prune' (run by 'Run prune') could not delete a 'Projects' record (step 10-prune):", StringComparison.Ordinal,
            "A delete step blocked by references reported a refusal about a record the person did not delete, naming no action.");
        Assert.AreEqual((direct.GetType(), Code(direct)), (refused.GetType(), Code(refused)));
        Assert.AreEqual(((NendoPreconditionException)direct).RecordId, ((NendoPreconditionException)refused).RecordId,
            "The record a refusal is about was lost when the action was named.");
    }

    [TestMethod]
    public async Task EBH05_EBH20_AnActionThatStartsItselfReachesTheChangeLimitAndSaysWhichActionRan()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // Every log a person creates makes another log, which makes another.
        await InstallAsync(coordinator, service,
            Stamp("echo", NendoActionStep.CreateRecord("10-echo", "logs", [new NendoActionAssignment("text", "'echo'")])),
            new NendoTriggerDefinition("echo.trigger", "logs", "Echo every log", NendoTriggerEvents.Created, "echo"));
        TestBehaviourAuthority.Approving(coordinator);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = 3 };

        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => service.CreateRecordAsync(new("logs", "first",
            new Dictionary<string, object?> { ["text"] = "typed" }, Context("first"))));

        Assert.AreEqual(NendoCalculationCodes.LimitReached, refused.Code);
        StringAssert.Contains(refused.Message, "'Action echo' (run by 'Echo every log')", StringComparison.Ordinal,
            "An action that re-triggered itself failed every create with a limit refusal naming no trigger and no action.");
        StringAssert.Contains(refused.Message, "starts itself again", StringComparison.Ordinal);
        Assert.IsFalse(refused.Message.Contains("Simplify the formula", StringComparison.Ordinal),
            "The change limit told the person to simplify a formula, which is not what ran out.");
    }

    [TestMethod]
    public void EBH20_ALimitReachedOnAReadOrACheckDoesNotClaimASave()
    {
        var limits = NendoBehaviourLimits.Default with { WorkUnits = 1 };
        var read = Assert.ThrowsExactly<NendoCalculationException>(() => new BehaviourBudget(limits, default, BehaviourBudgetUse.Read).SpendWork(2));
        var check = Assert.ThrowsExactly<NendoCalculationException>(() => new BehaviourBudget(limits, default, BehaviourBudgetUse.Check).SpendWork(2));
        var save = Assert.ThrowsExactly<NendoCalculationException>(() => new BehaviourBudget(limits).SpendWork(2));

        Assert.IsFalse(read.Message.Contains("save", StringComparison.Ordinal),
            $"A list read past its ceiling claimed a save: {read.Message}");
        StringAssert.Contains(read.Message, "for one record", StringComparison.Ordinal);
        Assert.IsFalse(check.Message.Contains("save", StringComparison.Ordinal), $"Checking a formula claimed a save: {check.Message}");
        StringAssert.Contains(save.Message, "for a single save", StringComparison.Ordinal);
        Assert.IsTrue(read.ExhaustedBudget && check.ExhaustedBudget && save.ExhaustedBudget);
    }

    [TestMethod]
    public async Task EBH20_ARecordPageNamesAFailedDependencyAndAnEmptyInputAsThePersonSeesThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // Doubled allows an empty result, and is empty on t1, whose estimate is not set. Padded
        // needs a value from it; Spread divides by zero, and Share reads Spread.
        await InstallAsync(coordinator, service,
            new NendoCalculationDefinition("calc.doubled", "tasks", "doubled", "Doubled estimate", NendoBehaviourScalar.Integer, true,
                "estimate * 2", [NendoBehaviourBinding.SameRecordField("estimate", "tasks", "estimate", NendoBehaviourScalar.Integer, true)]),
            new NendoCalculationDefinition("calc.padded", "tasks", "padded", "Padded estimate", NendoBehaviourScalar.Integer, false,
                "gpt + 1", [NendoBehaviourBinding.SameRecordCalculation("gpt", "tasks", "calc.doubled", NendoBehaviourScalar.Integer, false)]),
            new NendoCalculationDefinition("calc.spread", "tasks", "spread", "Hours spread", NendoBehaviourScalar.Decimal, false,
                "h / 0", [NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false)]),
            new NendoCalculationDefinition("calc.share", "tasks", "share", "Share", NendoBehaviourScalar.Decimal, false,
                "s * 2", [NendoBehaviourBinding.SameRecordCalculation("s", "tasks", "calc.spread", NendoBehaviourScalar.Decimal, false)]));

        var calculations = (await Record(service, "t1")).Calculations!;
        var padded = calculations.Single(result => result.CalculationId == "calc.padded");
        var share = calculations.Single(result => result.CalculationId == "calc.share");

        Assert.AreEqual(NendoCalculationCodes.MissingInput, padded.ErrorCode);
        Assert.AreEqual("'Doubled estimate' is empty, and this formula needs a value for it.", padded.ErrorMessage,
            "An empty input was named by the author's alias, which means nothing to a person reading the record.");
        Assert.AreEqual(NendoCalculationCodes.DependencyFailed, share.ErrorCode);
        Assert.AreEqual("This depends on 'Hours spread', which could not be calculated.", share.ErrorMessage,
            "A failed dependency was named by its definition ID.");
    }

    [TestMethod]
    public async Task EBH07_ATraversalOverAnOptionalReferenceMustAcceptAnEmptyValue()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        NendoCalculationDefinition Sponsor(bool nullable) => new("calc.sponsor", "tasks", "sponsorName", "Sponsor", NendoBehaviourScalar.Text, false,
            "IsEmpty(sponsor) ? 'none' : sponsor",
            [NendoBehaviourBinding.ReferenceTraversal("sponsor", "tasks", "sponsor", "projects", "projectName", NendoBehaviourScalar.Text, nullable)]);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service, Sponsor(false)),
            "A traversal over an optional reference installed without accepting an empty value, and every record without the reference showed an error.");
        StringAssert.Contains(refused.Message, "'sponsor' is optional", StringComparison.Ordinal);

        await InstallAsync(coordinator, service, Sponsor(true));
        var sponsor = (await Record(service, "t1")).Calculations!.Single(result => result.CalculationId == "calc.sponsor");
        Assert.AreEqual("none", sponsor.Value.GetString(), "IsEmpty did not supply the default for a task with no sponsor.");

        // The other side: the reference a non-nullable traversal follows cannot become optional.
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("calc.owner", "tasks", "ownerName", "Owner",
            NendoBehaviourScalar.Text, false, "owner",
            [NendoBehaviourBinding.ReferenceTraversal("owner", "tasks", "project", "projects", "projectName", NendoBehaviourScalar.Text, false)]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var optional = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "optional", "test",
            "Project optional", [new SetFieldRequiredOperation("optional", "tasks", "project", false, revision)])),
            "The reference a traversal counts on became optional.");
        Assert.AreEqual("field-requirement-in-use", optional.Code);
    }

    [TestMethod]
    public async Task EBH08_ARelevantFieldTheTriggerCanNeverSeeChangeIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            new NendoCalculationDefinition("calc.total", "tasks", "taskTotal", "Total", NendoBehaviourScalar.Integer, false,
                "h * 2", [NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false)]),
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))));
        NendoTriggerDefinition Narrowed(string fieldId) =>
            new("stamp.trigger", "tasks", "Stamp on change", NendoTriggerEvents.Updated, "stamp", [fieldId]);

        var unknown = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => InstallAsync(coordinator, service, Narrowed("hoursx")),
            "A misspelled relevant field installed a trigger that never ran on an update.");
        Assert.AreEqual("field-not-found", unknown.Code);
        var calculated = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => InstallAsync(coordinator, service, Narrowed("taskTotal")),
            "A calculated relevant field installed a trigger that never ran on an update.");
        Assert.AreEqual("field-calculated", calculated.Code);
        StringAssert.Contains(calculated.Message, "List the stored fields its formula reads instead: 'hours'.", StringComparison.Ordinal);

        await InstallAsync(coordinator, service, Narrowed("done"));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var retired = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "retire", "test",
            "Retire done", [new SetRetiredOperation("retire", "tasks", "done", true, revision)])),
            "A trigger's only relevant field was retired, and the trigger silently stopped running on updates.");
        Assert.AreEqual("retired-binding", retired.Code);
    }

    [TestMethod]
    public async Task EBH11_HistoryUndoStillWorksAfterApprovalOfTheActionsIsWithdrawn()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))),
            TaskTrigger("stamp", NendoTriggerEvents.Updated));
        var authority = TestBehaviourAuthority.Approving(coordinator);
        var applied = await Edit(service, "t1", 3L);
        Assert.AreEqual("Stamped", (await Record(service, "t1")).Values["title"].GetString());
        authority.RevokeAll();
        var ordinary = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Edit(service, "t1", 4L));
        Assert.AreEqual("behaviour-not-approved", ordinary.Code);

        // The rule: an undo runs no action, so it is allowed.
        await Succeeds(() => service.CompensateRevisionAsync(applied.RevisionId, "undo-after-withdrawal"),
            "History's Undo was refused once approval of the actions was withdrawn, the one way back from what the action did.");

        var task = await Record(service, "t1");
        Assert.AreEqual((2L, "First"), (task.Values["hours"].GetInt64(), task.Values["title"].GetString()),
            "History's Undo was refused once approval of the actions was withdrawn, the one way back from what the action did.");
    }

    [TestMethod]
    public async Task EBH11_AnAgentsUndoOfItsOwnRevisionStillWorksAfterApprovalIsWithdrawn()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))),
            TaskTrigger("stamp", NendoTriggerEvents.Updated));
        var authority = TestBehaviourAuthority.Approving(coordinator);
        var applied = await Edit(service, "t1", 3L);
        authority.RevokeAll();

        await Succeeds(() => service.UndoRecordWritesAsync(new(applied.RevisionId, Context("agent-undo"), Redo: false)),
            "nendo.data.undo_revision was refused once approval of the actions was withdrawn.");

        Assert.AreEqual("First", (await Record(service, "t1")).Values["title"].GetString(),
            "nendo.data.undo_revision was refused once approval of the actions was withdrawn.");
    }

    [TestMethod]
    public async Task EBH12_AnUndoFindsRecordsByTypeAndIdWhenTwoTypesShareARecordId()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-hours", "tasks", "hours", "Hours", "hours", NendoStorageKind.Integer, true),
            new ConfigureReferenceOperation("t-bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "1", new Dictionary<string, object?> { ["projectName"] = "One" }, Context("p1")));
        await service.CreateRecordAsync(new("projects", "2", new Dictionary<string, object?> { ["projectName"] = "Two" }, Context("p2")));
        await service.CreateRecordAsync(new("tasks", "1", new Dictionary<string, object?> { ["project"] = "1", ["hours"] = 2L },
            Context("t1"), new Dictionary<string, long> { ["project"] = 1 }));

        // Task '1' moves from project '1' to project '2'; its undo points it back at project '1',
        // which the move never touched and which is still at version 1.
        var moved = await service.SetFieldAsync(new("tasks", "1", "project", 1, "2", Context("move"), 1));
        await Succeeds(() => service.CompensateRevisionAsync(moved.RevisionId, "undo-move"),
            "The undo took task '1' for project '1' and was refused as a conflict although nothing had changed.");
        Assert.AreEqual("1", (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "tasks").Values["project"].GetString(),
            "The undo took task '1' for project '1' and was refused as a conflict although nothing had changed.");

        // A change and its undo on project '1' leave it as it was; they say nothing about task '1'.
        var hours = await service.SetFieldAsync(new("tasks", "1", "hours", 3, 5L, Context("hours")));
        var renamed = await service.SetFieldAsync(new("projects", "1", "projectName", 1, "Uno", Context("rename")));
        await service.CompensateRevisionAsync(renamed.RevisionId, "undo-rename");
        await Succeeds(() => service.CompensateRevisionAsync(hours.RevisionId, "undo-hours"),
            "Project '1''s undone change was carried onto task '1', and a valid undo was refused.");
        Assert.AreEqual(2L, (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "tasks").Values["hours"].GetInt64(),
            "Project '1''s undone change was carried onto task '1', and a valid undo was refused.");
    }

    [TestMethod]
    public void EBH13_ABindingKindOrAggregateOutsideTheContractIsRefusedByName()
    {
        string Body(string kind, string extra = "") =>
            $$"""{"displayName":"x","resultType":"Integer","resultNullable":false,"entityId":"tasks","fieldId":"total","expression":"v","bindings":[{"bindingId":"v","kind":"{{kind}}","entityId":"tasks"{{extra}}}]}""";
        NendoValidationException Refused(string body, string defect) => Assert.ThrowsExactly<NendoValidationException>(
            () => NendoBehaviourCodec.Read("calc", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, body, NendoBehaviourBodySource.Authored),
            defect);

        StringAssert.Contains(Refused(Body("9"), "A binding kind of \"9\" escaped as an internal error.").Message, "Use one of:", StringComparison.Ordinal);
        Refused(Body("0", ""","fieldId":"hours","resultType":"Integer","nullable":false"""), "A binding kind of \"0\" was read as SameRecordField.");
        Refused(Body("RelatedAggregate", ""","aggregate":"5","relatedEntityId":"notes","relatedReferenceFieldId":"noteTask","resultType":"Integer","nullable":false"""),
            "An aggregate of \"5\" escaped as an internal error.");
        Refused(Body("SameRecordField, ReferenceTraversal", ""","fieldId":"hours","resultType":"Integer","nullable":false"""),
            "Two binding kinds joined by a comma were read as one.");
        Assert.ThrowsExactly<NendoValidationException>(() => NendoBehaviourCodec.Read("t", NendoBehaviourKind.Trigger, NendoBehaviourContract.Version,
            """{"entityId":"tasks","displayName":"On save","events":["1"],"actionId":"a"}""", NendoBehaviourBodySource.Authored),
            "An event of \"1\" was read as Created.");
        var trigger = (NendoTriggerDefinition)NendoBehaviourCodec.Read("t", NendoBehaviourKind.Trigger, NendoBehaviourContract.Version,
            """{"entityId":"tasks","displayName":"On save","events":"Created, Updated","actionId":"a"}""", NendoBehaviourBodySource.Authored);
        Assert.AreEqual(NendoTriggerEvents.Created | NendoTriggerEvents.Updated, trigger.Events, "The canonical events text stopped reading.");
    }

    [TestMethod]
    public void EBH14_AConditionThatIsNotTextIsRefusedRatherThanDropped()
    {
        NendoBehaviourDefinition Read(string condition) => NendoBehaviourCodec.Read("t", NendoBehaviourKind.Trigger, NendoBehaviourContract.Version,
            $$"""{"entityId":"tasks","displayName":"Disabled?","events":"Updated","actionId":"a","conditionExpression":{{condition}}}""",
            NendoBehaviourBodySource.Authored);

        foreach (var condition in new[] { "false", "0", "{}" })
        {
            var refused = Assert.ThrowsExactly<NendoValidationException>(() => Read(condition),
                $"A conditionExpression of {condition} was stored as a trigger with no condition, which runs its action on every event.");
            StringAssert.Contains(refused.Message, "conditionExpression", StringComparison.Ordinal);
        }
        Assert.IsNull(((NendoTriggerDefinition)Read("null")).ConditionExpression, "A null condition stopped meaning no condition.");
    }

    [TestMethod]
    public async Task EBH15_AFormulaRefusalNamesTheAssignmentAndThePosition()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var hours = NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service,
            new NendoActionDefinition("set", "Set", [NendoActionStep.SetFields("10-set", NendoActionTarget.EventRecord, [
                new NendoActionAssignment("title", "'ok'"),
                new NendoActionAssignment("hours", "h * (h + 1", [hours], []),
            ])]),
            TaskTrigger("set", NendoTriggerEvents.Created)));

        StringAssert.Contains(refused.Message, "The formula for 'hours' in step '10-set' of action 'set': ", StringComparison.Ordinal,
            "A formula refusal did not say which assignment of the action it was about.");
        StringAssert.Contains(refused.Message, "at line 1, character", StringComparison.Ordinal,
            "A formula refusal dropped the position the parser reported.");
    }

    [TestMethod]
    public async Task EBH16_ANameAFormulaReadsMayHoldOnlyLettersDigitsAndUnderscore()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        NendoCalculationDefinition Doubled(string alias, string expression) => new("calc.doubled", "tasks", "doubled", "Doubled",
            NendoBehaviourScalar.Integer, false, expression,
            [NendoBehaviourBinding.SameRecordField(alias, "tasks", "hours", NendoBehaviourScalar.Integer, false)]);

        foreach (var (alias, expression) in new[] { ("work-hours", "[work-hours] * 2"), ("line.total", "[line.total] * 2"), ("2h", "[2h] * 2") })
        {
            var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service, Doubled(alias, expression)),
                $"The binding alias '{alias}' installed, and a formula naming it reads something else or nothing.");
            StringAssert.Contains(refused.Message, $"'{alias}' is a binding alias a formula reads", StringComparison.Ordinal);
        }
        var parameter = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => InstallAsync(coordinator, service,
            new NendoFunctionDefinition("fn.twice", "Twice", [new NendoFunctionParameter("unit-price", "Unit price", NendoBehaviourScalar.Integer, false)],
                NendoBehaviourScalar.Integer, false, "[unit-price] * 2")),
            "A function parameter named 'unit-price' installed.");
        StringAssert.Contains(parameter.Message, "'unit-price' is a parameter a formula reads", StringComparison.Ordinal);

        // A file written before the rule still opens and calculates, and History can put such a
        // definition back; only installing or changing one is held to the rule.
        await InstallAsync(coordinator, service, Doubled("hours", "hours * 2"));
        (coordinator, service) = await PlaceStoredAliasAsync(workspace, coordinator, "calc.doubled", "work-hours", "[work-hours] * 2");
        Assert.AreEqual(4L, (await Record(service, "t1")).Calculations!.Single(result => result.CalculationId == "calc.doubled").Value.GetInt64(),
            "A stored definition from before the rule stopped calculating.");
        var renamed = await InstallAsync(coordinator, service, Doubled("work_hours", "work_hours * 2"));
        await Succeeds(() => service.CompensateRevisionAsync(renamed.RevisionId, "undo-rename"),
            "History could not put back a definition recorded before the naming rule, so the undo was refused.");
    }

    [TestMethod]
    public async Task HistoryPutsBackADefinitionRecordedBeforeALaterInstallRule()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        var hours = NendoBehaviourBinding.SameRecordField("h", "tasks", "hours", NendoBehaviourScalar.Integer, false);
        NendoCalculationDefinition Sponsor(string name) => new("calc.sponsor", "tasks", "sponsorName", name, NendoBehaviourScalar.Text, false,
            "IsEmpty(sponsor) ? 'none' : sponsor",
            [NendoBehaviourBinding.ReferenceTraversal("sponsor", "tasks", "sponsor", "projects", "projectName", NendoBehaviourScalar.Text, true)]);
        NendoTriggerDefinition Narrowed(string name) => new("stamp.trigger", "tasks", name, NendoTriggerEvents.Updated, "stamp", ["done"]);
        NendoActionDefinition Log(string text) => new("log", "Log", [NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", text)])]);
        NendoActionDefinition Note(string name) => new("note", name, [NendoActionStep.SetField("10-note", NendoActionTarget.EventRecord,
            new NendoActionAssignment("title", "n", [NendoBehaviourBinding.SameRecordField("n", "tasks", "title", NendoBehaviourScalar.Text, false)], []))]);
        NendoActionDefinition Fit(string text) => new("fit", "Fit", [NendoActionStep.SetField("10-fit", NendoActionTarget.EventRecord,
            new NendoActionAssignment("title", text))]);
        NendoCalculationDefinition Second(string name) => new("calc.second", "contacts", "second", name, NendoBehaviourScalar.Integer, false, "2", []);
        await InstallAsync(coordinator, service,
            Sponsor("Sponsor"),
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'Stamped'"))),
            Narrowed("Stamp on done"),
            Log("'2026-10-13'"), TaskTrigger("log", NendoTriggerEvents.Created),
            Note("Note"), TaskTrigger("note", NendoTriggerEvents.Created),
            Fit("'x'"), TaskTrigger("fit", NendoTriggerEvents.Created),
            new NendoCalculationDefinition("calc.first", "contacts", "first", "First", NendoBehaviourScalar.Integer, false, "1", []),
            Second("Second"));

        // What an older host could leave in the file, each now refused when installed.
        (coordinator, service) = await PlaceStoredAsync(workspace, coordinator,
            ("calc.sponsor", "$.bindings[0].nullable", "false"),
            ("stamp.trigger", "$.relevantFieldIds", "[\"hoursx\"]"),
            ("log", "$.steps[0].assignments[0].fieldId", "\"due\""),
            ("note", "$.steps[0].assignments[0].bindings[0].entityId", "\"projects\""),
            ("note", "$.steps[0].assignments[0].bindings[0].fieldId", "\"projectName\""),
            ("fit", "$.steps[0].assignments[0].expression", "\"1\""),
            ("calc.second", "$.fieldId", "\"first\""));

        foreach (var (edit, defect) in new (NendoBehaviourDefinition, string)[]
        {
            (Sponsor("Sponsor name"), "a non-nullable traversal over an optional reference"),
            (Narrowed("Stamp when done"), "a relevant field that is not a stored field"),
            (Log("'kickoff'"), "a create step that leaves a required field empty"),
            (Note("Copy the title"), "a binding that starts from another record type"),
            (Fit("'y'"), "an assignment whose result its field cannot store"),
            (Second("Second value"), "a second calculation of one field"),
        })
        {
            var edited = await InstallAsync(coordinator, service, edit);
            await Succeeds(() => service.CompensateRevisionAsync(edited.RevisionId, $"undo-{edit.DefinitionId}"),
                $"History could not undo an edit of a definition recorded before a later install rule, {defect}.");
        }
    }

    [TestMethod]
    public async Task EBH17_AConditionReadsAFailedDependencyAsTheRecordPageDoes()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // Doubled needs a value and t1 has no estimate; Spare allows an empty result and reads it.
        await InstallAsync(coordinator, service,
            new NendoCalculationDefinition("calc.doubled", "tasks", "doubled", "Doubled", NendoBehaviourScalar.Integer, false,
                "estimate * 2", [NendoBehaviourBinding.SameRecordField("estimate", "tasks", "estimate", NendoBehaviourScalar.Integer, true)]),
            new NendoCalculationDefinition("calc.spare", "tasks", "spare", "Spare", NendoBehaviourScalar.Integer, true,
                "d + 1", [NendoBehaviourBinding.SameRecordCalculation("d", "tasks", "calc.doubled", NendoBehaviourScalar.Integer, false)]),
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("title", "'No spare'"))),
            new NendoTriggerDefinition("stamp.trigger", "tasks", "Mark tasks with no spare", NendoTriggerEvents.Updated, "stamp", ["hours"],
                "IsEmpty(spare)", [NendoBehaviourBinding.SameRecordCalculation("spare", "tasks", "calc.spare", NendoBehaviourScalar.Integer, true)]));
        TestBehaviourAuthority.Approving(coordinator);
        var page = (await Record(service, "t1")).Calculations!.Single(result => result.CalculationId == "calc.spare");
        Assert.AreEqual(NendoCalculationCodes.DependencyFailed, page.ErrorCode);

        var applied = await Edit(service, "t1", 3L);

        Assert.AreEqual("First", (await Record(service, "t1")).Values["title"].GetString(),
            "A condition read a failed dependency as an empty value where the record page shows an error, and its action ran.");
        Assert.AreEqual(NendoCalculationCodes.DependencyFailed, applied.BlockedConditions.Single().Code);
    }

    [TestMethod]
    public async Task EBH18_ADecimalTotalThatNeedsMoreDigitsThanADecimalHoldsIsRefusedNotRounded()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("calc.amount", "projects", "amountTotal", "Amount",
            NendoBehaviourScalar.Decimal, false, "a",
            [NendoBehaviourBinding.RelatedSum("a", "projects", "lines", "lineProject", "amount", NendoBehaviourScalar.Decimal)]));
        await service.CreateRecordAsync(new("lines", "l1", new Dictionary<string, object?> { ["lineProject"] = "p1", ["amount"] = 100000000000000000000m },
            Context("l1"), new Dictionary<string, long> { ["lineProject"] = 1 }));
        await service.CreateRecordAsync(new("lines", "l2", new Dictionary<string, object?> { ["lineProject"] = "p1", ["amount"] = 0.0000000001m },
            Context("l2"), new Dictionary<string, long> { ["lineProject"] = 1 }));

        var total = (await Record(service, "p1")).Calculations!.Single(result => result.CalculationId == "calc.amount");

        Assert.AreEqual(NendoCalculationState.Error, total.State,
            $"A calculated total rounded to {total.Value} where the contract promises the exact total.");
        Assert.AreEqual(NendoCalculationCodes.Overflow, total.ErrorCode);
    }

    [TestMethod]
    public void EBH19_TextLengthSaysItCountsUtf16CodeUnitsAndDoes()
    {
        Assert.IsTrue(NendoBehaviourCatalogue.TryGet("TextLength", out var entry));
        StringAssert.Contains(entry.Summary, "UTF-16 code units", StringComparison.Ordinal,
            "TextLength promised characters while counting a character outside the Basic Multilingual Plane as two.");
        var adapter = new NendoExpressionAdapter();
        var budget = new BehaviourBudget(NendoBehaviourLimits.Default);
        var star = adapter.Validate(new BehaviourFormula("star", "TextLength('\U0001F31F')", [], new Dictionary<string, ValidatedExpression>()), budget);
        Assert.AreEqual(2L, adapter.Calculate(star, new Dictionary<string, BehaviourValue>(), budget).Boxed);
    }

    [TestMethod]
    public async Task EBH21_UntriggeredRecordsInOneSaveDoNotSpendTheRelatedRowAllowance()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await InstallAsync(coordinator, service,
            Stamp("stamp", NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment("note", "'Touched'"))),
            new NendoTriggerDefinition("stamp.trigger", "projects", "Stamp projects", NendoTriggerEvents.Updated, "stamp", ["projectName"]));
        TestBehaviourAuthority.Approving(coordinator);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = 5 };

        await Succeeds(() => coordinator.ApplyAsync(new("test", "contacts", "test", "Eight contacts", Enumerable.Range(1, 8)
            .Select(index => (NendoOperation)new CreateRecordOperation($"c{index}", "contacts", $"c{index}",
                new Dictionary<string, object?> { ["contactName"] = $"Contact {index}" }))
            .ToArray())),
            "Records no trigger listens to spent the save's related-row allowance, and a batch of them was refused.");

        Assert.AreEqual(8, (await service.GetSnapshotAsync()).Records.Count(record => record.EntityId == "contacts"),
            "Records no trigger listens to spent the save's related-row allowance, and a batch of them was refused.");
    }

    [TestMethod]
    public async Task EBH22_ASaveChargesTheSameWhetherOrNotItsFormulasAreStillCached()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        await coordinator.ApplyAsync(new("test", "notes", "test", "A hundred notes", Enumerable.Range(1, 100)
            .Select(index => (NendoOperation)new CreateRecordOperation($"n{index}", "notes", $"n{index}",
                new Dictionary<string, object?> { ["noteTask"] = "t1" }, new Dictionary<string, long> { ["noteTask"] = 1 }))
            .ToArray()));
        // A condition about 620 characters long: checking it costs about that much work, and the
        // save reads a hundred notes. The trigger compiles before the action, so a one-entry cache
        // holds the action's formula, never the condition, when the save runs.
        var condition = $"n >= 0 or '{new string('x', 600)}' = ''";
        await InstallAsync(coordinator, service,
            new NendoActionDefinition("z.stamp", "Stamp", [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                new NendoActionAssignment("title", "'Stamped'"))]),
            new NendoTriggerDefinition("a.trigger", "tasks", "Stamp tasks with notes", NendoTriggerEvents.Updated, "z.stamp", ["hours"],
                condition, [NendoBehaviourBinding.RelatedCount("n", "tasks", "notes", "noteTask")]));
        TestBehaviourAuthority.Approving(coordinator);
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { WorkUnits = 700, CacheEntries = 1 };

        await Succeeds(() => Edit(service, "t1", 3L),
            "A save near the work ceiling was refused because its condition had fallen out of the expression cache.");

        Assert.AreEqual("Stamped", (await Record(service, "t1")).Values["title"].GetString(),
            "A save near the work ceiling was refused because its condition had fallen out of the expression cache.");
    }

    [TestMethod]
    public async Task EBH23_AReviewedPlanRecordsTheRecordsItsFormulasActuallyRead()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SchemaAsync(workspace);
        // A log that shares the task's record ID, which the plan must not mistake for a read.
        await service.CreateRecordAsync(new("logs", "t1", new Dictionary<string, object?> { ["text"] = "Unrelated" }, Context("log-t1")));
        await InstallAsync(coordinator, service,
            Stamp("log", NendoActionStep.CreateRecord("10-log", "logs", [new NendoActionAssignment("text", "title",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)], [])])),
            new NendoTriggerDefinition("log.trigger", "tasks", "Log named projects", NendoTriggerEvents.Updated, "log", ["hours"],
                "name != ''", [NendoBehaviourBinding.ReferenceTraversal("name", "tasks", "project", "projects", "projectName", NendoBehaviourScalar.Text, false)]));
        TestBehaviourAuthority.Approving(coordinator);
        var proposalId = "proposal-" + Guid.NewGuid().ToString("N");

        await coordinator.BeginProposalAsync(proposalId, "Edit hours", "test", new NendoChangeSet([
            new NendoMutation("test", "proposal-edit", "test", "Edit hours", [new SetFieldOperation("edit", "tasks", "t1", "hours", 1, 3L)]),
        ]));

        var plan = PreparedBehaviourPlan.Deserialize(await File.ReadAllTextAsync(Path.Combine(coordinator.ProposalRoot, proposalId, "behaviour-plan.json")));
        var read = plan.ReadSet.Select(entry => (entry.EntityId, entry.RecordId)).ToHashSet();
        Assert.Contains(("projects", "p1"), read, "The project a condition read across a reference is missing from the reviewed plan's read set.");
        // The task itself is read too, but the edit writes it, and a plan keeps only the records it does not write.
        Assert.DoesNotContain(("logs", "t1"), read, "A create step's read was recorded as the created type's record with the event record's ID.");
    }

    /// <summary>
    /// Projects, tasks under them (a task may name a sponsor project and an estimate), notes and
    /// logs on tasks, contacts nothing listens to, and lines with an amount on projects. One
    /// project and one task. A log's code is required and numbered by a sequence.
    /// </summary>
    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> SchemaAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-note", "projects", "note", "Note", "note", NendoStorageKind.Text, false),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-sponsor", "tasks", "sponsor", "Sponsor", "sponsor_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("t-hours", "tasks", "hours", "Hours", "hours", NendoStorageKind.Integer, true),
            new AddFieldOperation("t-estimate", "tasks", "estimate", "Estimate", "estimate", NendoStorageKind.Integer, false),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, false),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("t-bind", "tasks", "project", "projects", "projectName", 0),
            new ConfigureReferenceOperation("t-bind-sponsor", "tasks", "sponsor", "projects", "projectName", 0),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-task", "notes", "noteTask", "Task", "task_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("n-bind", "notes", "noteTask", "tasks", "title", 0),
            new CreateEntityOperation("logs", "logs", "Logs", "logs"),
            new AddFieldOperation("l-task", "logs", "logTask", "Task", "task_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("l-text", "logs", "text", "Text", "text", NendoStorageKind.Text, true),
            new AddFieldOperation("l-code", "logs", "code", "Code", "code", NendoStorageKind.Text, true),
            new AddFieldOperation("l-due", "logs", "due", "Due", "due", NendoStorageKind.Date, false),
            new ConfigureReferenceOperation("l-bind", "logs", "logTask", "tasks", "title", 0),
            new CreateEntityOperation("contacts", "contacts", "Contacts", "contacts"),
            new AddFieldOperation("c-name", "contacts", "contactName", "Name", "contact_name", NendoStorageKind.Text, true),
            new CreateEntityOperation("lines", "lines", "Lines", "lines"),
            new AddFieldOperation("li-project", "lines", "lineProject", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("li-amount", "lines", "amount", "Amount", "amount", NendoStorageKind.Decimal, true),
            new ConfigureReferenceOperation("li-bind", "lines", "lineProject", "projects", "projectName", 0),
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

    /// <summary>Changes stored definition bodies as an older host could have left them, each a JSON path and a JSON value.</summary>
    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> PlaceStoredAsync(
        EngineTestWorkspace workspace, NendoWriteCoordinator coordinator, params (string DefinitionId, string Path, string Json)[] changes)
    {
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            foreach (var (definitionId, path, json) in changes)
            {
                await using var command = connection.CreateCommand();
                command.CommandText = "UPDATE __nendo_behaviour SET body_json = json_set(body_json, @path, json(@json)) WHERE definition_id = @id;";
                command.Parameters.AddWithValue("@path", path);
                command.Parameters.AddWithValue("@json", json);
                command.Parameters.AddWithValue("@id", definitionId);
                Assert.AreEqual(1, await command.ExecuteNonQueryAsync(), $"The stored definition '{definitionId}' was not found.");
            }
        }
        var reopened = await workspace.OpenAsync();
        return (reopened, new NendoApplicationService(reopened));
    }

    /// <summary>Renames a stored calculation's first binding as a host before the naming rule could have left it.</summary>
    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> PlaceStoredAliasAsync(
        EngineTestWorkspace workspace, NendoWriteCoordinator coordinator, string definitionId, string alias, string expression)
    {
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_behaviour SET body_json = json_set(body_json, '$.bindings[0].bindingId', @alias, '$.expression', @expression) WHERE definition_id = @id;";
            command.Parameters.AddWithValue("@alias", alias);
            command.Parameters.AddWithValue("@expression", expression);
            command.Parameters.AddWithValue("@id", definitionId);
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync(), "The stored calculation was not found to rename its binding.");
        }
        var reopened = await workspace.OpenAsync();
        return (reopened, new NendoApplicationService(reopened));
    }

    private static NendoActionDefinition Stamp(string actionId, NendoActionStep step) => new(actionId, $"Action {actionId}", [step]);

    private static NendoTriggerDefinition TaskTrigger(string actionId, NendoTriggerEvents events) =>
        new($"{actionId}.trigger", "tasks", $"Run {actionId}", events, actionId);

    private static async Task<NendoApplyResult> InstallAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, params NendoBehaviourDefinition[] definitions)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var key = $"install-{Guid.NewGuid():N}";
        return await coordinator.ApplyAsync(new("test", key, "test", "Install behaviour",
            definitions.Select((definition, index) => (NendoOperation)new SetBehaviourDefinitionOperation($"{key}-{index}", definition, revision)).ToArray()));
    }

    private static async Task<NendoApplyResult> Edit(NendoApplicationService service, string recordId, long hours)
    {
        var version = (await Record(service, recordId)).RecordVersion;
        return await service.SetFieldAsync(new("tasks", recordId, "hours", version, hours, Context($"edit-{Guid.NewGuid():N}")));
    }

    /// <summary>Runs a step the defect refused, and fails with the defect's own sentence rather than the refusal.</summary>
    private static async Task<T> Succeeds<T>(Func<Task<T>> action, string defect)
    {
        try
        {
            return await action();
        }
        catch (NendoException exception)
        {
            throw new AssertFailedException($"{defect} ({exception.GetType().Name}: {exception.Message})", exception);
        }
    }

    private static string? Code(NendoException exception) => exception switch
    {
        NendoPreconditionException precondition => precondition.Code,
        NendoCalculationException calculation => calculation.Code,
        _ => null,
    };

    private static async Task<NendoRecordSnapshot> Record(NendoApplicationService service, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    private static NendoRequestContext Context(string key) => new("diagnosis", key, "test");
}
