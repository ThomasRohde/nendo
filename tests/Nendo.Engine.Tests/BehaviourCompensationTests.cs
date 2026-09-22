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
