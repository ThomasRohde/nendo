using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008 regression lane D3, plus D2.01 and D2.02: automatic actions inside the
/// initiating transaction.
/// <para>
/// Every case here runs against a real <c>.nendo</c> file through the ordinary
/// coordinator. An in-memory substitute would prove the planner's arithmetic and
/// none of what this lane exists for — that an interrupted chain leaves the file
/// exactly as it was, with no record, no version, no revision and no receipt.
/// </para>
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
public sealed class BehaviourActionTests
{
    [TestMethod]
    public async Task ATwoFieldEditRunsBothTriggersOnceAndCommitsAsASingleCausalRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        var before = await service.GetHistoryAsync();
        var result = await coordinator.ApplyAsync(Edit());

        var project = await Project(service);
        Assert.AreEqual(2L, project.Values["total"].GetInt64());
        Assert.IsTrue(project.Values["complete"].GetBoolean());
        Assert.AreEqual("Finished", (await Task2(service)).Values["title"].GetString());

        // Two initiating operations and two generated ones, in one revision.
        var history = await service.GetHistoryAsync();
        Assert.HasCount(before.Count + 1, history, "The chain committed more than one revision.");
        var revision = history.Single(entry => entry.RevisionId == result.RevisionId);
        Assert.HasCount(4, revision.Operations);
        Assert.AreEqual(2, revision.Operations.Count(operation => operation.OperationId.StartsWith("generated-", StringComparison.Ordinal)));

        // Attribution says why each generated operation exists.
        var attribution = await AttributionAsync(workspace.FilePath);
        Assert.HasCount(2, attribution);
        CollectionAssert.AreEqual(new[] { "10-total", "20-complete" }, attribution.Select(row => row.TriggerId).ToArray());
        Assert.IsTrue(attribution.All(row => row.RootKey == "edit" && row.EventEntityId == "tasks" && row.EventRecordId == "t2"));

        // The same key returns the same receipt and runs nothing again.
        var retry = await coordinator.ApplyAsync(Edit());
        Assert.IsTrue(retry.IsIdempotentReplay);
        Assert.AreEqual(result.RevisionId, retry.RevisionId);
        Assert.AreEqual(result.OperationDigest, retry.OperationDigest);
        Assert.HasCount(before.Count + 1, await service.GetHistoryAsync(), "A retry repeated the actions.");
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task D3_01_ReassignmentUpdatesBothTheFormerAndTheNewParent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        await service.CreateRecordAsync(new("projects", "p2",
            new Dictionary<string, object?> { ["projectName"] = "Second", ["total"] = 0L, ["complete"] = false },
            Context("p2")));

        // t1 is the completed task; moving it must take its contribution with it.
        await service.SetFieldAsync(new("tasks", "t1", "project", 1, "p2", Context("reassign"), 1));

        Assert.AreEqual(0L, (await Project(service)).Values["total"].GetInt64(), "The former parent kept a total it no longer earns.");
        var moved = await Project(service, "p2");
        Assert.AreEqual(1L, moved.Values["total"].GetInt64());
        Assert.IsTrue(moved.Values["complete"].GetBoolean());
    }

    [TestMethod]
    public async Task D3_02_CreationAndDeletionOfRelatedRecordsMoveTheParent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        await service.CreateRecordAsync(new("tasks", "t3",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Third" },
            Context("create-t3"), new Dictionary<string, long> { ["project"] = 1 }));
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());
        Assert.IsFalse((await Project(service)).Values["complete"].GetBoolean(), "Two of three tasks are done.");

        var t2 = await Task2(service);
        await service.DeleteRecordAsync(new("tasks", "t2", t2.RecordVersion, Context("delete-t2")));
        var project = await Project(service);
        Assert.AreEqual(2L, project.Values["total"].GetInt64());
        Assert.IsTrue(project.Values["complete"].GetBoolean(), "Every remaining task is done.");
    }

    [TestMethod]
    [DataRow(1)]
    [DataRow(2)]
    public async Task D3_03_04_AFailureAfterAnyActionLeavesTheFileExactlyAsItWas(int failAfter)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        var history = await service.GetHistoryAsync();

        var applied = 0;
        coordinator.GeneratedOperationCheckpoint = count =>
        {
            applied = count;
            if (count == failAfter) throw new InvalidOperationException("injected failure");
        };
        await Assert.ThrowsExactlyAsync<InvalidOperationException>(() => coordinator.ApplyAsync(Edit()));
        coordinator.GeneratedOperationCheckpoint = null;

        Assert.AreEqual(failAfter, applied, "The failure was not injected at the intended point.");
        Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
            "A rolled-back chain left a record, a value or a version behind.");
        Assert.HasCount(history.Count, await service.GetHistoryAsync(), "A rolled-back chain left a revision behind.");
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")),
            "A rolled-back chain left a success receipt behind.");
        Assert.IsEmpty(await AttributionAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task D3_06_SettingAValueItAlreadyHoldsRaisesNothingAndRunsNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var project = await Project(service);

        // t1 is already done. Saying so again is not a change.
        await service.SetFieldAsync(new("tasks", "t1", "done", 1, true, Context("noop")));

        var after = await Project(service);
        Assert.AreEqual(project.RecordVersion, after.RecordVersion,
            "A no-op edit still generated a write to the parent.");
        Assert.AreEqual(project.Values["total"].GetInt64(), after.Values["total"].GetInt64());
        Assert.IsEmpty(await AttributionAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task D3_07_AConditionThatCannotBeEvaluatedBlocksItsActionAndKeepsTheEdit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service, conditionExpression: "1 / 0 = 1.0");
        var history = await service.GetHistoryAsync();

        await coordinator.ApplyAsync(Edit());

        // The edit itself is valid and committed.
        var t2 = await Task2(service);
        Assert.IsTrue(t2.Values["done"].GetBoolean());
        Assert.AreEqual("Finished", t2.Values["title"].GetString());
        Assert.HasCount(history.Count + 1, await service.GetHistoryAsync());

        // The blocked trigger is the one that keeps the total, so the total stands
        // still at its old value — visibly stale rather than silently wrong. The other
        // trigger carries no condition and runs normally.
        var project = await Project(service);
        Assert.AreEqual(1L, project.Values["total"].GetInt64(), "A blocked condition ran its action anyway.");
        Assert.IsTrue(project.Values["complete"].GetBoolean(), "The unblocked trigger should still run.");
        var attribution = await AttributionAsync(workspace.FilePath);
        Assert.HasCount(1, attribution);
        Assert.AreEqual("20-complete", attribution.Single().TriggerId);
    }

    [TestMethod]
    public async Task D3_08_AFailingActionInputRollsBackTheWholeEditIncludingEarlierSteps()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        // The second trigger's action divides by zero while computing what to write.
        await Fixture(coordinator, service, completeExpression: "(1 / 0) = 1.0");
        var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        var history = await service.GetHistoryAsync();

        await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => coordinator.ApplyAsync(Edit()));

        Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
            "A failed action input left the first action's write, or the edit, behind.");
        Assert.HasCount(history.Count, await service.GetHistoryAsync());
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
    }

    [TestMethod]
    public async Task D3_10_CancellationBeforeCommitRollsTheWholeChainBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        var history = await service.GetHistoryAsync();

        using var cancellation = new CancellationTokenSource();
        coordinator.GeneratedOperationCheckpoint = _ => cancellation.Cancel();
        await Assert.ThrowsExactlyAsync<OperationCanceledException>(
            () => coordinator.ApplyAsync(Edit(), cancellation.Token));
        coordinator.GeneratedOperationCheckpoint = null;

        Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.HasCount(history.Count, await service.GetHistoryAsync());
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
    }

    [TestMethod]
    public async Task D3_12_ALostResponseAfterCommitResolvesFromTheDurableReceiptWithoutRepeatingEffects()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var committed = await coordinator.ApplyAsync(Edit());
        // Records rather than the whole snapshot: storage health carries session-local
        // detail such as the write-owner sidecar, which legitimately differs across a
        // close and reopen and says nothing about whether the data changed.
        var afterCommit = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);
        var history = await service.GetHistoryAsync();

        // The caller never saw the answer. Close the file and ask again.
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync();
        var reopenedService = new NendoApplicationService(reopened);

        var receipt = await reopenedService.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit"));
        Assert.IsNotNull(receipt, "The committed chain left no durable receipt.");
        Assert.AreEqual(committed.RevisionId, receipt.RevisionId);

        var replay = await reopened.ApplyAsync(Edit());
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(committed.RevisionId, replay.RevisionId);
        Assert.AreEqual(afterCommit, JsonSerializer.Serialize((await reopenedService.GetSnapshotAsync()).Records),
            "A retry after a lost response changed the file again.");
        Assert.HasCount(history.Count, await reopenedService.GetHistoryAsync());
    }

    [TestMethod]
    public async Task D2_02_TheGeneratedChangeCeilingRefusesAndRollsBackTheWholeChain()
    {
        foreach (var (ceiling, allowed) in new[] { (1, false), (2, true), (3, true) })
        {
            await using var workspace = new EngineTestWorkspace();
            var coordinator = await workspace.CreateAsync();
            var service = new NendoApplicationService(coordinator);
            await Fixture(coordinator, service);
            var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
            coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = ceiling };

            if (allowed)
            {
                await coordinator.ApplyAsync(Edit());
                Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64(), $"ceiling {ceiling}");
                Assert.HasCount(2, await AttributionAsync(workspace.FilePath), $"ceiling {ceiling}");
            }
            else
            {
                var exception = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => coordinator.ApplyAsync(Edit()));
                Assert.AreEqual(NendoCalculationCodes.LimitReached, exception.Code);
                Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
                    "Reaching the change ceiling left part of the chain behind.");
                Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
            }
        }
    }

    [TestMethod]
    public async Task D2_01_TheRelatedScanCeilingRefusesAndRollsBackTheWholeChain()
    {
        foreach (var (ceiling, allowed) in new[] { (3, false), (64, true) })
        {
            await using var workspace = new EngineTestWorkspace();
            var coordinator = await workspace.CreateAsync();
            var service = new NendoApplicationService(coordinator);
            await Fixture(coordinator, service);
            var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
            coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { RelatedRows = ceiling };

            if (allowed)
            {
                await coordinator.ApplyAsync(Edit());
                Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64(), $"ceiling {ceiling}");
            }
            else
            {
                var exception = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => coordinator.ApplyAsync(Edit()));
                Assert.AreEqual(NendoCalculationCodes.LimitReached, exception.Code);
                Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
                    "Reaching the scan ceiling left part of the chain behind.");
                Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
            }
        }
    }

    [TestMethod]
    public async Task D3_11_ASelfSustainingChainIsStoppedByTheCeilingAndRollsEverythingBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        // A trigger on projects that flips `complete` every time projects change: it
        // feeds itself, so only the ceiling ends it.
        await coordinator.ApplyAsync(new("test", "loop", "test", "Self-sustaining trigger", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.toggle", "Toggle",
                [NendoActionStep.SetField("30-toggle", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("complete", "not current",
                        [NendoBehaviourBinding.SameRecordField("current", "projects", "complete", NendoBehaviourScalar.Boolean, false)],
                        []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "30-toggle", "projects", "Toggle completion",
                NendoTriggerEvents.Updated, "project.toggle", ["complete"]), revision),
        ]));

        // Adding a trigger changed what this file's actions do, so the approval the
        // fixture gave no longer covers it. Re-approving is the owner deciding again,
        // which is the point; BehaviourGrantTests asserts the refusal directly.
        TestBehaviourAuthority.Approving(coordinator);

        var snapshot = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        coordinator.BehaviourLimits = NendoBehaviourLimits.Default with { GeneratedChanges = 4 };
        var exception = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => coordinator.ApplyAsync(Edit()));
        Assert.AreEqual(NendoCalculationCodes.LimitReached, exception.Code);
        Assert.AreEqual(snapshot, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
            "A chain stopped by the ceiling left its earlier writes behind.");
        Assert.IsNull(await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "edit")));
    }

    [TestMethod]
    public async Task D3_15_AFalseConditionOnADeletionDoesNotRunTheAction()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-flag", "projects", "flag", "Flag", "flag", NendoStorageKind.Boolean, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["flag"] = false }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1" }, Context("t1"),
            new Dictionary<string, long> { ["project"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // A trigger on deletion whose condition is a constant false, with a step that would
        // flag the parent. The condition must be judged, not waved through.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Flag on delete", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.flagIt", "Flag the project",
                [NendoActionStep.SetField("10-flag", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("flag", "true", [], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-flag", "tasks", "Flag on task delete",
                NendoTriggerEvents.Deleted, "project.flagIt", [], "1 = 2", []), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        await service.DeleteRecordAsync(new("tasks", "t1", 1, Context("delete")));

        // The condition is false, so the action must not run. Before the fix a deletion
        // returned true unconditionally and the referenced parent was flagged on every
        // delete, whatever the author's condition said.
        Assert.IsFalse((await Project(service)).Values["flag"].GetBoolean(),
            "A false condition on a deletion still ran its action.");
    }

    [TestMethod]
    public async Task D3_16_AnActionThatClearsAReferenceUpdatesTheFormerParent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("t-clear", "tasks", "clear", "Clear", "clear", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-blank", "tasks", "blank", "Blank", "blank", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 1L }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["clear"] = false }, Context("t1"),
            new Dictionary<string, long> { ["project"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // One action clears the task's project (an action may only set a reference to
        // empty); a second, on the same record's project change, recounts the parent.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Clear then recount", [
            new SetBehaviourDefinitionOperation("a1", new NendoActionDefinition(
                "task.unassign", "Unassign the task",
                [NendoActionStep.SetField("10-clear", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("project", "blank",
                        [NendoBehaviourBinding.SameRecordField("blank", "tasks", "blank", NendoBehaviourScalar.Text, true)], []))]), revision),
            new SetBehaviourDefinitionOperation("t1", new NendoTriggerDefinition(
                "10-clear", "tasks", "Unassign when asked",
                NendoTriggerEvents.Updated, "task.unassign", ["clear"]), revision),
            new SetBehaviourDefinitionOperation("a2", new NendoActionDefinition(
                "project.recount", "Recount the project",
                [NendoActionStep.SetField("20-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "taskCount",
                        [NendoBehaviourBinding.RelatedCount("taskCount", "projects", "tasks", "project")], []))]), revision),
            new SetBehaviourDefinitionOperation("t2", new NendoTriggerDefinition(
                "20-total", "tasks", "Recount on reassignment",
                NendoTriggerEvents.Updated, "project.recount", ["project"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        await service.SetFieldAsync(new("tasks", "t1", "clear", 1, true, Context("unassign")));

        // The clearing write raises an event whose before-state still names p1, so the
        // recount reaches p1 and drops its total to 0. Passing the post-clear state as
        // both sides lost p1 entirely, leaving it with a total it no longer earns.
        Assert.AreEqual(0L, (await Project(service)).Values["total"].GetInt64(),
            "The former parent kept a total it no longer earns after an action cleared the reference.");
    }

    [TestMethod]
    public async Task D3_17_AnActionAssigningAMismatchedTypeRefusesWithATypedError()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 1L }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false }, Context("t1"),
            new Dictionary<string, long> { ["project"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // An action that assigns a Text result to an Integer field. Nothing at install
        // time compares the assignment's type to the field's storage kind.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Mismatched action", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "Concat('a', 'b')", [], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-total", "tasks", "Set the total", NendoTriggerEvents.Updated, "project.setTotal", ["done"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        // p1.total already holds the number 1, so the no-op guard reaches its numeric arm
        // with a Text value. That must surface a typed storage-kind refusal, not an
        // InvalidCastException escaping the save.
        await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.SetFieldAsync(new("tasks", "t1", "done", 1, true, Context("edit"))));
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task D3_18_AnIntegerResultAgainstATextFieldHoldingTheSameDigitsIsStillRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "5", ["total"] = 1L }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false }, Context("t1"),
            new Dictionary<string, long> { ["project"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // An action that assigns an Integer result to a Text field.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Mismatched action", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.setName", "Number the project",
                [NendoActionStep.SetField("10-name", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("projectName", "2 + 3", [], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-name", "tasks", "Number the project", NendoTriggerEvents.Updated, "project.setName", ["done"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        // p1.projectName already holds the text "5" and the action produces the integer
        // 5. Their renderings agree, so the no-op guard skipped the write as "already
        // what it should be" — while the same action against a project named anything
        // else was refused. Whether the wrong type is reported cannot depend on what the
        // record happens to hold.
        await Assert.ThrowsExactlyAsync<NendoValidationException>(
            () => service.SetFieldAsync(new("tasks", "t1", "done", 1, true, Context("edit"))));
        Assert.AreEqual("5", (await Project(service)).Values["projectName"].GetString());
    }

    /// <summary>
    /// The regression fixture: two projects' worth of schema, one project, two tasks,
    /// and the two triggers that keep the project's total and completion current.
    /// </summary>
    private static async Task Fixture(
        NendoWriteCoordinator coordinator,
        NendoApplicationService service,
        string? conditionExpression = null,
        string completeExpression = "doneCount = taskCount")
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
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 1L, ["complete"] = false },
            Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "First" },
            Context("t1"), new Dictionary<string, long> { ["project"] = 1 }));
        await service.CreateRecordAsync(new("tasks", "t2",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false, ["title"] = "Second" },
            Context("t2"), new Dictionary<string, long> { ["project"] = 1 }));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var events = NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted;
        var done = NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done");
        var all = NendoBehaviourBinding.RelatedCount("taskCount", "projects", "tasks", "project");
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Totals and completion", [
            new SetBehaviourDefinitionOperation("a1", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount", [done], []))]), revision),
            new SetBehaviourDefinitionOperation("t1", new NendoTriggerDefinition(
                "10-total", "tasks", "Keep the project total current",
                events, "project.setTotal", ["done", "project"], conditionExpression,
                conditionExpression is null ? null : []), revision),
            new SetBehaviourDefinitionOperation("a2", new NendoActionDefinition(
                "project.setComplete", "Set project completion",
                [NendoActionStep.SetField("20-complete", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("complete", completeExpression, [done, all], []))]), revision),
            new SetBehaviourDefinitionOperation("t2", new NendoTriggerDefinition(
                "20-complete", "tasks", "Keep project completion current",
                events, "project.setComplete", ["done", "project"]), revision),
        ]));

        // A file that carries triggers cannot be edited until this device says its
        // actions may run. Every case below is about what the actions do, so they
        // start from consent already given; the cases about consent itself live in
        // BehaviourGrantTests.
        TestBehaviourAuthority.Approving(coordinator);
    }

    /// <summary>The initiating request: two fields of one task, under one stable key.</summary>
    private static NendoMutation Edit() => new("test", "edit", "test", "Finish the second task", [
        new SetFieldOperation("edit-done", "tasks", "t2", "done", 1, true),
        new SetFieldOperation("edit-title", "tasks", "t2", "title", 2, "Finished"),
    ]);

    private static async Task<NendoRecordSnapshot> Project(NendoApplicationService service, string recordId = "p1") =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == recordId);

    private static async Task<NendoRecordSnapshot> Task2(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "t2");

    private static NendoRequestContext Context(string key) => new("test", key, "test");

    private static async Task<IReadOnlyList<(string TriggerId, string ActionId, string StepId, string RootKey, string EventEntityId, string EventRecordId)>>
        AttributionAsync(string path)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var exists = connection.CreateCommand();
        exists.CommandText = "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = '__nendo_attribution';";
        if (Convert.ToInt64(await exists.ExecuteScalarAsync()) == 0) return [];
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT trigger_id, action_id, step_id, root_key, event_entity_id, event_record_id FROM __nendo_attribution ORDER BY revision_id, ordinal;";
        var rows = new List<(string, string, string, string, string, string)>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.GetString(3), reader.GetString(4), reader.GetString(5)));
        }
        return rows;
    }
}
