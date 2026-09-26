namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S8 of ADR-0008, obligation P6: compensating a causal revision reverses the
/// whole of it.
/// <para>
/// The edit a person made and the writes its actions produced committed together, so
/// undoing only the typed half would leave a stored field an action maintained holding
/// a number nothing now explains — and the next unrelated edit would quietly correct
/// it, hiding the gap rather than closing it.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourCompensationTests
{
    [TestMethod]
    public async Task CompensatingReversesTheEditAndEverythingItsActionsWrote()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var tasks = await VersionsAsync(service, "tasks");
        var applied = await service.SetFieldAsync(new("tasks", "t1", "done", tasks["t1"], true, Context("finish")));
        Assert.AreEqual(1L, await TotalAsync(service), "The action did not run, so there is nothing to compensate.");

        var revision = (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == applied.RevisionId);
        Assert.HasCount(2, revision.Operations, "The revision should carry the edit and the write its action made.");

        await service.CompensateRevisionAsync(applied.RevisionId, "undo-finish");

        var reversed = (await service.GetSnapshotAsync()).Records;
        Assert.IsFalse(reversed.Single(record => record.RecordId == "t1").Values["done"].GetBoolean(),
            "The typed edit was not reversed.");
        Assert.AreEqual(0L, await TotalAsync(service),
            "The stored field the action maintained was left behind, so the file now disagrees with itself.");
    }

    [TestMethod]
    public async Task CompensatingDoesNotRunTheActionsAgainOverTheReversal()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var tasks = await VersionsAsync(service, "tasks");
        var applied = await service.SetFieldAsync(new("tasks", "t1", "done", tasks["t1"], true, Context("finish")));
        var before = (await service.GetHistoryAsync()).Count;

        var compensation = await service.CompensateRevisionAsync(applied.RevisionId, "undo-finish");

        // Exactly the two inverses, and nothing an action added on top of them. A
        // re-expansion would show a third operation here, computing the total again
        // from the state the reversal was still in the middle of producing.
        var revision = (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == compensation.RevisionId);
        Assert.HasCount(2, revision.Operations);
        Assert.IsFalse(revision.Operations.Any(operation => operation.OperationId.StartsWith("generated-", StringComparison.Ordinal)),
            "Compensation ran the actions again over the operations it was reversing.");
        Assert.HasCount(before + 1, await service.GetHistoryAsync());

        // And the same request twice is still one compensation.
        var replay = await service.CompensateRevisionAsync(applied.RevisionId, "undo-finish");
        Assert.AreEqual(compensation.RevisionId, replay.RevisionId);
        Assert.IsTrue(replay.IsIdempotentReplay);
    }

    [TestMethod]
    public async Task ACausalRevisionThatCreatedARecordIsRefusedBecauseACreateDeclaresItselfIrreversible()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var project = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");
        var applied = await service.CreateRecordAsync(new("tasks", "t4",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Added" },
            Context("add"), new Dictionary<string, long> { ["project"] = project.RecordVersion }));
        Assert.AreEqual(1L, await TotalAsync(service));

        // A created record is declared irreversible, and that declaration is not
        // weakened by the record also appearing inside a causal revision. Reversing
        // only the action's half would leave a file that contradicts itself, so the
        // whole revision is refused and the refusal says what it is refusing.
        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(applied.RevisionId, "undo-add"));
        StringAssert.Contains(refused.Message, "data.createRecord");

        var records = (await service.GetSnapshotAsync()).Records;
        Assert.IsTrue(records.Any(record => record.RecordId == "t4"), "A refused compensation changed the file.");
        Assert.AreEqual(1L, await TotalAsync(service));
    }

    [TestMethod]
    public async Task ARevisionCarryingSomethingWithNoProvenInverseIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // A definition mutation and a rename in one revision: reversible individually,
        // but not something this host claims to reverse as a set.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var applied = await coordinator.ApplyAsync(new("test", "rename-pair", "test", "Rename both record types", [
            new RenameEntityOperation("r1", "projects", "Programmes", revision),
            new RenameEntityOperation("r2", "tasks", "Items", revision),
        ]));

        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(applied.RevisionId, "undo-renames"));
        StringAssert.Contains(refused.Message, "schema.renameEntity",
            "A refusal must name what it cannot reverse rather than say 'unsupported'.");

        // Nothing was attempted: the names are still the new ones.
        var entities = (await service.GetSnapshotAsync()).Entities;
        Assert.AreEqual("Programmes", entities.Single(entity => entity.EntityId == "projects").DisplayName);
    }

    [TestMethod]
    public async Task ReversingADefinitionAsksForConsentAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // Change what the action writes. That is a different set of rules, so the
        // approval the fixture gave no longer covers it and is given again.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var changed = await coordinator.ApplyAsync(new("test", "retarget", "test", "Count differently", [
            new SetBehaviourDefinitionOperation("retarget-action", new NendoActionDefinition(
                "project.count", "Count every task",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "taskCount",
                        [NendoBehaviourBinding.RelatedCount("taskCount", "projects", "tasks", "project")],
                        []))]), revision),
        ]));
        var authority = TestBehaviourAuthority.Approving(coordinator);
        var tasks = await VersionsAsync(service, "tasks");
        await service.SetFieldAsync(new("tasks", "t1", "done", tasks["t1"], true, Context("under-new-rules")));
        Assert.AreEqual(3L, await TotalAsync(service), "The replacement action did not take effect.");

        // Reversing that definition puts the old rules back, and the device is asked
        // about them rather than being assumed to still agree.
        await service.CompensateRevisionAsync(changed.RevisionId, "undo-retarget");
        authority.RevokeAll();

        tasks = await VersionsAsync(service, "tasks");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldAsync(new("tasks", "t2", "done", tasks["t2"], true, Context("after-undo"))));
        Assert.AreEqual("behaviour-not-approved", refused.Code,
            "Restoring different rules left the old consent standing.");
    }

    // R-015. A reference move whose action also updated both parents: the inverse that puts
    // the reference back must expect the former parent at the version its own reversal
    // leaves, not the version it had before the move.
    [TestMethod]
    public async Task ImmediatelyReversingAReferenceMoveThatUpdatedBothParentsSucceedsAndReplaysExactly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await MoveFixtureAsync(coordinator, service);

        var moved = await service.SetFieldAsync(new("children", "c1", "parent", 1, "p2", Context("move"), 1));
        Assert.HasCount(3, (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == moved.RevisionId).Operations,
            "The move should carry the reference and a count on each parent.");
        Assert.AreEqual("0/1", await ParentTotalsAsync(service));

        var undone = await service.CompensateRevisionAsync(moved.RevisionId, "undo-move");
        var records = (await service.GetSnapshotAsync()).Records;
        Assert.AreEqual("p1", records.Single(record => record.RecordId == "c1").Values["parent"].GetString());
        Assert.AreEqual("1/0", await ParentTotalsAsync(service));

        var retry = await service.CompensateRevisionAsync(moved.RevisionId, "undo-move");
        Assert.IsTrue(retry.IsIdempotentReplay, "An exact retry reversed the move a second time.");
        Assert.AreEqual(undone.RevisionId, retry.RevisionId);
        Assert.AreEqual("1/0", await ParentTotalsAsync(service));
    }

    [TestMethod]
    public async Task ReversingAReferenceMoveStillRefusesAParentEditedSince()
    {
        foreach (var edited in new[] { "p1", "p2" })
        {
            await using var workspace = new EngineTestWorkspace();
            var coordinator = await workspace.CreateAsync();
            var service = new NendoApplicationService(coordinator);
            await MoveFixtureAsync(coordinator, service);
            var moved = await service.SetFieldAsync(new("children", "c1", "parent", 1, "p2", Context("move"), 1));

            var version = (await VersionsAsync(service, "parents"))[edited];
            await service.SetFieldAsync(new("parents", edited, "parentName", version, "Renamed", Context("outside")));
            var before = System.Text.Json.JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);

            var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
                () => service.CompensateRevisionAsync(moved.RevisionId, "undo-move"), $"{edited} was edited after the move");
            StringAssert.Contains(refusal.Code, "conflict", $"{edited}: {refusal.Code}");
            Assert.AreEqual(before, System.Text.Json.JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records),
                "A refused reversal left part of itself behind.");
        }
    }

    private static async Task<string> ParentTotalsAsync(NendoApplicationService service)
    {
        var records = (await service.GetSnapshotAsync()).Records;
        long Total(string id) => records.Single(record => record.RecordId == id).Values["total"].GetInt64();
        return $"{Total("p1")}/{Total("p2")}";
    }

    private static async Task MoveFixtureAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Parents and children", [
            new CreateEntityOperation("parents", "parents", "Parents", "parents"),
            new AddFieldOperation("p-name", "parents", "parentName", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "parents", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("children", "children", "Children", "children"),
            new AddFieldOperation("c-parent", "children", "parent", "Parent", "parent", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("configure", "children", "parent", "parents", "parentName", 0),
        ]));
        await service.CreateRecordAsync(new("parents", "p1",
            new Dictionary<string, object?> { ["parentName"] = "First", ["total"] = 1L }, Context("p1")));
        await service.CreateRecordAsync(new("parents", "p2",
            new Dictionary<string, object?> { ["parentName"] = "Second", ["total"] = 0L }, Context("p2")));
        await service.CreateRecordAsync(new("children", "c1",
            new Dictionary<string, object?> { ["parent"] = "p1" }, Context("c1"), new Dictionary<string, long> { ["parent"] = 1 }));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Keep parent counts", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition("count", "Count children",
                [NendoActionStep.SetField("count", NendoActionTarget.Referenced("parent"),
                    new NendoActionAssignment("total", "count",
                        [NendoBehaviourBinding.RelatedCount("count", "parents", "children", "parent")], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition("count.trigger", "children", "Keep parent counts",
                NendoTriggerEvents.Updated, "count", ["parent"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
    }

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
        TestBehaviourAuthority.Approving(coordinator);
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
