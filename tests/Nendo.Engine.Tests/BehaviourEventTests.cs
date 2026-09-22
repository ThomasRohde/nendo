namespace Nendo.Engine.Tests;

/// <summary>
/// What a generated write raises, and what it does not.
/// <para>
/// An action's own write is an event like any other, so it must say which fields it
/// changed. Saying "all of them" makes a field subscription meaningless the moment a
/// chain starts, and turns an action that writes to the record it was triggered by
/// into a loop that only the budget stops — containment doing a correctness bug's job.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourEventTests
{
    [TestMethod]
    public async Task AnActionThatWritesToItsOwnRecordSettlesInsteadOfSpendingTheBudget()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").RecordVersion;
        var applied = await service.SetFieldAsync(new("notes", "n1", "label", version, "Renamed", Context("rename")));

        var note = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1");
        Assert.AreEqual("Seen Renamed", note.Values["stamp"].GetString(),
            "The action did not write the stamp its trigger asked for.");

        // One edit and one generated write. Before the event carried only what the
        // step actually changed, the stamp write re-raised an event claiming the label
        // had changed too, and the chain ran until the function-call ceiling stopped it.
        var revision = (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == applied.RevisionId);
        Assert.HasCount(2, revision.Operations);

        // The result says what the action wrote and the version it left the record
        // at, so a caller does not read the record back to learn its own save moved it.
        var generated = applied.GeneratedChanges.Single();
        Assert.AreEqual(("notes", "n1", "updated", version + 2), (generated.EntityId, generated.RecordId, generated.Change, generated.RecordVersion));
        Assert.AreEqual(note.RecordVersion, generated.RecordVersion);

        // Editing the label again moves the stamp again, so the trigger is still live
        // — it settled rather than being switched off.
        version = note.RecordVersion;
        await service.SetFieldAsync(new("notes", "n1", "label", version, "Renamed twice", Context("rename-again")));
        Assert.AreEqual("Seen Renamed twice",
            (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").Values["stamp"].GetString());
    }

    [TestMethod]
    public async Task AStepThatChangesNothingRaisesNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // Bring the stamp to the value the action would write, then edit another field
        // the trigger also subscribes to. The action runs, decides nothing needs
        // changing, and the revision carries only the edit.
        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").RecordVersion;
        await service.SetFieldAsync(new("notes", "n1", "label", version, "Settled", Context("settle")));

        var note = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1");
        Assert.AreEqual("Seen Settled", note.Values["stamp"].GetString());

        var applied = await service.SetFieldAsync(new("notes", "n1", "label", note.RecordVersion, "Settled", Context("same-again")));
        var revision = (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == applied.RevisionId);
        Assert.HasCount(1, revision.Operations,
            "A step that changed nothing still produced a generated operation.");
        Assert.IsEmpty(applied.GeneratedChanges);
    }

    /// <summary>
    /// The write result says what the action changed; a receipt read back after a lost
    /// response, and an exact replay, used to say nothing, so a client recovering an
    /// outcome had to re-read every record to learn the side effect. Both now name the
    /// record and the kind of change, without a version: the file may have moved since,
    /// and a number here would be read as current.
    /// </summary>
    [TestMethod]
    public async Task AReceiptAndAReplayNameWhatTheActionChanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").RecordVersion;
        var applied = await service.SetFieldAsync(new("notes", "n1", "label", version, "Recovered", Context("recover")));
        var written = applied.GeneratedChanges.Single();
        Assert.AreEqual(("notes", "n1", "updated", version + 2), (written.EntityId, written.RecordId, written.Change, written.RecordVersion));

        var receipt = await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "recover"));
        Assert.IsNotNull(receipt);
        Assert.AreEqual(applied.RevisionId, receipt.RevisionId);
        var recovered = receipt.GeneratedChanges.Single();
        Assert.AreEqual(("notes", "n1", "updated", (long?)null), (recovered.EntityId, recovered.RecordId, recovered.Change, recovered.RecordVersion));

        var replay = await service.SetFieldAsync(new("notes", "n1", "label", version, "Recovered", Context("recover")));
        Assert.IsTrue(replay.IsIdempotentReplay);
        var replayed = replay.GeneratedChanges.Single();
        Assert.AreEqual(("notes", "n1", "updated", (long?)null), (replayed.EntityId, replayed.RecordId, replayed.Change, replayed.RecordVersion));

        // A write no action followed has nothing to name, on the receipt as on the result.
        var quiet = await service.SetFieldAsync(new("notes", "n1", "stamp", version + 2, "By hand", Context("quiet")));
        Assert.IsEmpty(quiet.GeneratedChanges);
        var quietReceipt = await service.GetMutationReceiptAsync(new NendoOperationIdentity("test", "quiet"));
        Assert.IsNotNull(quietReceipt);
        Assert.IsEmpty(quietReceipt.GeneratedChanges);
    }

    [TestMethod]
    public async Task ARecordOfAFieldlessTypeCommitsWhileTheFileHoldsATrigger()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "A trigger plus a fieldless type", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("empty", "empty", "Empty", "empty"),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Any trigger", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "note.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("label", "Concat(label, '!')",
                        [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the label", NendoTriggerEvents.Created, "note.stamp", []), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        // Creating a record of the fieldless type once built `SELECT  FROM …` in the
        // planner's record read and aborted the save with a raw SqliteException above the
        // storage boundary. It must commit, treating the fieldless record as no event.
        await service.CreateRecordAsync(new("empty", "e1", new Dictionary<string, object?>(), Context("empty")));
        Assert.IsTrue((await service.GetSnapshotAsync()).Records
            .Any(record => record.EntityId == "empty" && record.RecordId == "e1"),
            "A record of a fieldless type did not commit while the file held a trigger.");
    }

    private static async Task SeedAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        await service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" }, Context("n1")));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Stamp the label", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "note.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                        [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)],
                        []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the label",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
