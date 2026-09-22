using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A step that follows a reference writes to the record the reference names. When
/// the reference is empty it names none: the step writes nothing, the save still
/// commits, and the result reports no generated change. An outside review expected a
/// refusal and got exactly this. It is the rule, now stated in the published
/// catalogue, and this pins the behaviour the catalogue describes.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class ActionTargetTests
{
    [TestMethod]
    public async Task AnEmptyReferenceSelectsNoTargetAndTheSaveCommitsWithoutAnEffect()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Folders and notes", [
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("f-stamp", "folders", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            // Optional on purpose: a note may sit in no folder at all.
            new AddFieldOperation("n-folder", "notes", "folder", "Folder", "folder_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "folder", "folders", "name", 0),
        ]));
        await service.CreateRecordAsync(new("folders", "f1",
            new Dictionary<string, object?> { ["name"] = "Inbox" }, Context("f1")));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Stamp the folder", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "folder.stamp", "Stamp the folder a note lands in",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.Referenced("folder"),
                    new NendoActionAssignment("stamp", "Concat('Stamped ', name)",
                        [NendoBehaviourBinding.SameRecordField("name", "folders", "name", NendoBehaviourScalar.Text, false)],
                        []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the folder when a note is added",
                NendoTriggerEvents.Created, "folder.stamp"), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var history = (await service.GetHistoryAsync()).Count;

        // No folder: the step selects nothing, and the note is still saved.
        var loose = await service.CreateRecordAsync(new("notes", "n-loose",
            new Dictionary<string, object?> { ["label"] = "Loose" }, Context("loose")));
        Assert.IsFalse(loose.IsIdempotentReplay);
        Assert.IsEmpty(loose.GeneratedChanges);
        var revisions = await service.GetHistoryAsync();
        Assert.HasCount(history + 1, revisions);
        Assert.HasCount(1, revisions.Single(entry => entry.RevisionId == loose.RevisionId).Operations);
        var folder = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "f1");
        Assert.AreEqual(JsonValueKind.Null, folder.Values["stamp"].ValueKind);
        Assert.AreEqual(1L, folder.RecordVersion);

        // The same action, with the folder named, reaches it.
        var filed = await service.CreateRecordAsync(new("notes", "n-filed",
            new Dictionary<string, object?> { ["label"] = "Filed", ["folder"] = "f1" },
            Context("filed"), new Dictionary<string, long> { ["folder"] = 1 }));
        var change = filed.GeneratedChanges.Single();
        Assert.AreEqual(("folders", "f1", "updated", 2L), (change.EntityId, change.RecordId, change.Change, change.RecordVersion));
        folder = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "f1");
        Assert.AreEqual("Stamped Inbox", folder.Values["stamp"].GetString());
    }

    /// <summary>
    /// A step that writes a field the record it targets does not have is refused when it
    /// is installed, not when somebody next saves.
    /// </summary>
    /// <remarks>
    /// An action does not know its record type — only the trigger does — so nothing
    /// checked the two together, and the mistake the published catalogue warns about
    /// installed cleanly and failed at the next save (F-003). By then the person writing
    /// the record is not the person who wrote the action.
    /// <para>
    /// Both directions are asserted, because refusing is easy and refusing precisely is
    /// not: the wrong target is refused by name, and the same assignment aimed at the
    /// record that does hold the field still installs. A check that failed the second
    /// would have made every referenced-target action unauthorable.
    /// </para>
    /// </remarks>
    [TestMethod]
    public async Task AStepThatWritesAFieldItsTargetDoesNotHaveIsRefusedAtInstall()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Folders and notes", [
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("f-stamp", "folders", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-folder", "notes", "folder", "Folder", "folder_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "folder", "folders", "name", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        // The mistake: the step writes the record the event was raised on — a note — and
        // assigns `stamp`, which belongs to the folder it points at. A literal, so nothing
        // about the formula or its bindings can be what refuses it.
        NendoActionDefinition Stamp(NendoActionTarget target) => new(
            "folder.stamp", "Stamp the folder a note lands in",
            [NendoActionStep.SetField("10-stamp", target, new NendoActionAssignment("stamp", "\'Seen\'", [], []))]);
        NendoTriggerDefinition Trigger() => new(
            "10-stamp", "notes", "Stamp the folder when a note is added",
            NendoTriggerEvents.Created, "folder.stamp");

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(new("test", "behaviour", "test", "Stamp the wrong record", [
                new SetBehaviourDefinitionOperation("a", Stamp(NendoActionTarget.EventRecord), revision),
                new SetBehaviourDefinitionOperation("t", Trigger(), revision),
            ])));

        // Everything a person needs to find it: which action, which step, which record
        // type the step actually reaches, and which field it has not got.
        StringAssert.Contains(refused.Message, "Stamp the folder a note lands in");
        StringAssert.Contains(refused.Message, "10-stamp");
        StringAssert.Contains(refused.Message, "notes");
        StringAssert.Contains(refused.Message, "stamp");

        Assert.IsEmpty((await service.GetSnapshotAsync()).Records,
            "A refused install must leave the file alone.");
        Assert.AreEqual(revision, (await service.GetSnapshotAsync()).Manifest.DefinitionRevision,
            "The definition revision moved, so something was stored before the pair was checked.");

        // The same assignment, aimed at the record that holds the field, still installs.
        // This is the half a careless check breaks.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Stamp the folder", [
            new SetBehaviourDefinitionOperation("a", Stamp(NendoActionTarget.Referenced("folder")), revision),
            new SetBehaviourDefinitionOperation("t", Trigger(), revision),
        ]));
        Assert.AreEqual(revision + 1, (await service.GetSnapshotAsync()).Manifest.DefinitionRevision,
            "One mutation advances the definition revision once, however many operations it carries.");
    }

    /// <summary>
    /// A step that follows a field the trigger's record type has not got is refused by
    /// name, rather than failing inside the planner with nothing to read.
    /// </summary>
    [TestMethod]
    public async Task AStepThatFollowsAReferenceTheTriggerCannotSeeIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Folders and notes", [
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("f-stamp", "folders", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(new("test", "behaviour", "test", "Follow a field that is not there", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "folder.stamp", "Stamp the folder a note lands in",
                    [NendoActionStep.SetField("10-stamp", NendoActionTarget.Referenced("folder"),
                        new NendoActionAssignment("stamp", "\'Seen\'", [], []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-stamp", "notes", "Stamp the folder when a note is added",
                    NendoTriggerEvents.Created, "folder.stamp"), revision),
            ])));

        StringAssert.Contains(refused.Message, "folder");
        StringAssert.Contains(refused.Message, "notes");
        StringAssert.Contains(refused.Message, "no such field",
            "The planner would have failed on a Single() with nothing a person could read. This says what is missing and where.");
    }

    /// <summary>
    /// A refused behaviour install leaves the open file readable.
    /// </summary>
    /// <remarks>
    /// Whether a file has a behaviour table is remembered per open store, because it is
    /// asked on every read and for most files never changes. The table is created inside
    /// the mutation that installs the first definition, so a refusal later in that same
    /// mutation rolls it away — and the flag did not roll back with it. Every subsequent
    /// read of the open file then asked for a table that was not there and threw a raw
    /// SQLite error: not a refusal a person or an agent could act on, and not fixable
    /// without closing the file (F-070).
    /// <para>
    /// Found while adding the action/trigger pair check, which is one more way to be
    /// refused after the table exists — but the defect is older than that, and this
    /// reaches it through a binding refusal that has been there far longer, so the guard
    /// does not depend on the check that happened to surface it.
    /// </para>
    /// </remarks>
    [TestMethod]
    public async Task ARefusedBehaviourInstallLeavesTheOpenFileReadable()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
        ]));
        await service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "Kept" }, Context("n1")));
        var before = await service.GetSnapshotAsync();

        // Operation one is a valid action and creates the behaviour table. Operation two
        // is refused by a binding naming a field the record type has not got, which is a
        // path that predates the pair check by a long way.
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(new("test", "behaviour", "test", "Refused after the table exists", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "notes.touch", "Touch the note",
                    [NendoActionStep.SetField("10-touch", NendoActionTarget.EventRecord,
                        new NendoActionAssignment("label", "\'Seen\'", [], []))]), before.Manifest.DefinitionRevision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-touch", "notes", "On create", NendoTriggerEvents.Created, "notes.touch",
                    conditionExpression: "missing",
                    conditionBindings: [NendoBehaviourBinding.SameRecordField("missing", "notes", "missing", NendoBehaviourScalar.Boolean, false)]),
                    before.Manifest.DefinitionRevision),
            ])));
        StringAssert.Contains(refused.Message, "missing");

        // The file is exactly as it was, and can still be read. Before this was fixed the
        // read threw SqliteException: 'no such table: __nendo_behaviour'.
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.DefinitionRevision, after.Manifest.DefinitionRevision);
        Assert.AreEqual("Kept", after.Records.Single().Values["label"].GetString());

        // And a correct install still works afterwards, so the recovery is real rather
        // than the store having given up on behaviour for this session.
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Install it properly", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "notes.touch", "Touch the note",
                [NendoActionStep.SetField("10-touch", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("label", "\'Seen\'", [], []))]), after.Manifest.DefinitionRevision),
        ]));
        Assert.AreEqual(after.Manifest.DefinitionRevision + 1,
            (await service.GetSnapshotAsync()).Manifest.DefinitionRevision);
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
