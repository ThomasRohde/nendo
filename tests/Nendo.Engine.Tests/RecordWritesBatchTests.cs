namespace Nendo.Engine.Tests;

/// <summary>
/// Several record writes as one revision (W-102): creates, updates and deletes across record
/// types commit together or not at all, History shows one entry, and a reference to a record
/// written earlier in the batch is checked against the version that write leaves.
/// </summary>
[TestClass]
public sealed class RecordWritesBatchTests
{
    [TestMethod]
    public async Task ABatchAcrossRecordTypesCommitsAsOneRevisionAndAnswersEachVersion()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        var historyBefore = (await service.GetHistoryAsync()).Count;

        var result = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
        [
            new(NendoRecordWriteKind.Update, "folders", "f0", Values("name", "Renamed"), 1),
            new(NendoRecordWriteKind.Create, "folders", "f1", Values("name", "Archive")),
            // No target versions: both folders are written earlier in this batch.
            new(NendoRecordWriteKind.Create, "notes", "n1", Values("label", "New", "folder", "f1")),
            new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "Moved", "folder", "f0"), 1,
                new Dictionary<string, long> { ["folder"] = 1 }),
            new(NendoRecordWriteKind.Delete, "notes", "n9", ExpectedRecordVersion: 1),
        ], Context("one"), "Tidy the notes"));

        CollectionAssert.AreEqual(
            new long?[] { 2, 1, 1, 3, null },
            result.Records.Select(record => record.RecordVersion).ToArray(),
            "The batch did not answer the version each record now holds.");
        var history = await service.GetHistoryAsync();
        Assert.HasCount(historyBefore + 1, history, "The batch was not one revision.");
        Assert.IsTrue(history.Any(revision => revision.Description == "Tidy the notes" && revision.RevisionId == result.Applied.RevisionId),
            "History does not name the batch by its label.");

        var notes = (await service.QueryRecordsAsync(new("notes", 10))).Items.ToDictionary(record => record.RecordId);
        Assert.IsFalse(notes.ContainsKey("n9"), "The deleted note is still there.");
        Assert.AreEqual("f1", notes["n1"].Values["folder"].GetString());
        Assert.AreEqual(3, notes["n0"].RecordVersion);
        Assert.AreEqual("f0", notes["n0"].Values["folder"].GetString());
        var folders = (await service.QueryRecordsAsync(new("folders", 10))).Items.ToDictionary(record => record.RecordId);
        Assert.AreEqual("Renamed", folders["f0"].Values["name"].GetString());
        Assert.AreEqual(1, folders["f1"].RecordVersion);
        _ = coordinator;
    }

    [TestMethod]
    public async Task ARefusalAnywhereInTheBatchWritesNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        var before = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ApplyRecordWritesAsync(
            new NendoRecordWritesRequest(
            [
                new(NendoRecordWriteKind.Create, "folders", "f1", Values("name", "Archive")),
                new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "Stale"), 7),
            ], Context("stale"))));

        Assert.AreEqual("record-version-conflict", refused.Code, refused.Message);
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest.ChangeSequence, "The refused batch changed the file.");
        Assert.HasCount(1, (await service.QueryRecordsAsync(new("folders", 10))).Items, "The create before the refusal committed.");
    }

    [TestMethod]
    public async Task ABatchIsRefusedWhenItWritesARecordTwiceIsEmptyTooLongOrLeavesOutAVersion()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);

        await Refused("twice",
        [
            new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "a"), 1),
            new(NendoRecordWriteKind.Delete, "notes", "n0", ExpectedRecordVersion: 2),
        ], "written twice");
        await Refused("empty", [], "1-200");
        await Refused("long", [.. Enumerable.Range(0, NendoApplicationService.MaximumRecordWrites + 1)
            .Select(index => new NendoRecordWrite(NendoRecordWriteKind.Create, "notes", $"x{index}", Values("label", "x")))], "1-200");
        await Refused("versionless", [new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "a"))], "version");
        await Refused("valued-delete", [new(NendoRecordWriteKind.Delete, "notes", "n0", Values("label", "a"), 1)], "no values");

        async Task Refused(string key, NendoRecordWrite[] writes, string expected)
        {
            var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
                service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(writes, Context(key))));
            Assert.Contains(expected, refusal.Message);
        }
    }

    [TestMethod]
    public async Task AReplayAnswersItsRecordsWithoutVersions()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        var request = new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Create, "folders", "f1", Values("name", "Archive"))], Context("replay"));

        var first = await service.ApplyRecordWritesAsync(request);
        var replay = await service.ApplyRecordWritesAsync(request);

        Assert.IsTrue(replay.Applied.IsIdempotentReplay);
        Assert.AreEqual(first.Applied.RevisionId, replay.Applied.RevisionId);
        Assert.IsNull(replay.Records.Single().RecordVersion, "A replay stated a version the record may no longer hold.");
    }

    [TestMethod]
    public async Task ReferenceVersionsUseTheTargetTypeWhenRecordIdsCollide()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        await service.CreateRecordAsync(new("folders", "shared", Values("name", "Target"), Context("shared-folder")));
        await service.CreateRecordAsync(new("notes", "shared", Values("label", "Other type"), Context("shared-note")));

        var result = await service.ApplyRecordWritesAsync(new(
        [
            new(NendoRecordWriteKind.Update, "notes", "shared", Values("label", "Edited"), 1),
            new(NendoRecordWriteKind.Create, "notes", "child", Values("label", "Child", "folder", "shared"),
                ExpectedTargetVersions: new Dictionary<string, long> { ["folder"] = 1 }),
        ], Context("colliding-target")));

        Assert.AreEqual(2, result.Records[0].RecordVersion);
        var child = (await service.QueryRecordsAsync(new("notes", 1) { RecordId = "child" })).Items.Single();
        Assert.AreEqual("shared", child.Values["folder"].GetString());
        Assert.AreEqual(1, (await service.QueryRecordsAsync(new("folders", 1) { RecordId = "shared" })).Items.Single().RecordVersion);
    }

    [TestMethod]
    public async Task ABatchMayWriteTheSameRecordIdInDifferentTypes()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        var result = await service.ApplyRecordWritesAsync(new(
        [
            new(NendoRecordWriteKind.Create, "folders", "shared", Values("name", "Folder")),
            new(NendoRecordWriteKind.Create, "notes", "shared", Values("label", "Note", "folder", "shared")),
        ], Context("colliding-writes")));

        CollectionAssert.AreEqual(new long?[] { 1, 1 }, result.Records.Select(record => record.RecordVersion).ToArray());
        Assert.AreEqual("shared", (await service.QueryRecordsAsync(new("notes", 1) { RecordId = "shared" })).Items.Single().Values["folder"].GetString());
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ABatchReportsNoVersionWhenAnActionDeletesItsRecord(bool update)
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("batch-tests", "delete-action", "test", "Delete the edited note", [
            new SetBehaviourDefinitionOperation("action", new NendoActionDefinition("delete", "Delete",
                [NendoActionStep.DeleteRecord("step", NendoActionTarget.EventRecord)]), revision),
            new SetBehaviourDefinitionOperation("trigger", new NendoTriggerDefinition("trigger", "notes", "Delete",
                update ? NendoTriggerEvents.Updated : NendoTriggerEvents.Created, "delete"), revision)
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var id = update ? "n0" : "created";
        var result = await service.ApplyRecordWritesAsync(new([
            new(update ? NendoRecordWriteKind.Update : NendoRecordWriteKind.Create, "notes", id,
                Values("label", "Gone"), update ? 1 : null)
        ], Context("deleted-by-action")));
        Assert.IsEmpty((await service.QueryRecordsAsync(new("notes") { RecordId = id })).Items);
        Assert.IsNull(result.Records.Single().RecordVersion,
            "A record deleted by an automatic action must have no returned version.");
    }

    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> SeedAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("batch-tests", "schema", "test", "Notes and folders", [
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-folder", "notes", "folder", "Folder", "folder_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "notes", "folder", "folders", "name", 0),
        ]));
        await service.CreateRecordAsync(new("folders", "f0", Values("name", "Inbox"), Context("f0")));
        await service.CreateRecordAsync(new("notes", "n0", Values("label", "First"), Context("n0")));
        await service.CreateRecordAsync(new("notes", "n9", Values("label", "Gone"), Context("n9")));
        return (coordinator, service);
    }

    private static Dictionary<string, object?> Values(params string[] pairs) =>
        Enumerable.Range(0, pairs.Length / 2).ToDictionary(index => pairs[index * 2], index => (object?)pairs[index * 2 + 1]);

    private static NendoRequestContext Context(string key) => new("batch-tests", key, "surface");
}
