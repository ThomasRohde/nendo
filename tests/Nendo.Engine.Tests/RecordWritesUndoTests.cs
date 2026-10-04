using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// A view undoes and redoes the batches it wrote (ADR-0023, W-103): each step is a compensation
/// of the one before, creates and restores are answered by a delete, a deleted record comes back
/// under its own ID, and a record changed or pointed at since refuses the whole step.
/// </summary>
[TestClass]
public sealed class RecordWritesUndoTests
{
    private const string View = "extension:demo.view";

    [TestMethod]
    public async Task ABatchIsUndoneRedoneAndUndoneAgainValueForValue()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        var before = await StateAsync(service);

        var batch = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
        [
            new(NendoRecordWriteKind.Update, "folders", "f0", Values("name", "Renamed"), 1),
            new(NendoRecordWriteKind.Create, "folders", "f1", Values("name", "Archive")),
            new(NendoRecordWriteKind.Create, "notes", "n1", Values("label", "New", "folder", "f1")),
            new(NendoRecordWriteKind.Delete, "notes", "n9", ExpectedRecordVersion: 1),
        ], Context("batch"), "Tidy the notes"));
        var after = await StateAsync(service);

        var undo = await service.UndoRecordWritesAsync(new(batch.Applied.RevisionId, Context("undo"), Redo: false));
        Assert.AreEqual(before, await StateAsync(service), "Undo did not put the file back as it was before the batch.");
        await AnswersAreCurrentAsync(service, undo);
        var undone = await RevisionAsync(service, undo.Applied.RevisionId);
        Assert.AreEqual(batch.Applied.RevisionId, undone.CompensationOfRevisionId, "The undo is not linked to the batch.");
        Assert.AreEqual("Undo Tidy the notes", undone.Description);
        Assert.AreEqual(View, undone.Origin, "The undo is not the view's own revision.");
        Assert.IsTrue(undone.CanRequestCompensation, "History does not offer to compensate the undo.");

        var redo = await service.UndoRecordWritesAsync(new(undo.Applied.RevisionId, Context("redo"), Redo: true));
        Assert.AreEqual(after, await StateAsync(service), "Redo did not put the batch back.");
        await AnswersAreCurrentAsync(service, redo);
        Assert.AreEqual("Redo Tidy the notes", (await RevisionAsync(service, redo.Applied.RevisionId)).Description);

        var again = await service.UndoRecordWritesAsync(new(redo.Applied.RevisionId, Context("again"), Redo: false));
        Assert.AreEqual(before, await StateAsync(service), "Undoing the redo did not put the file back.");
        await AnswersAreCurrentAsync(service, again);
        Assert.AreEqual("Undo Tidy the notes", (await RevisionAsync(service, again.Applied.RevisionId)).Description);

        // A step is taken once: the batch already has its undo.
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.UndoRecordWritesAsync(new(batch.Applied.RevisionId, Context("twice"), Redo: false)));
    }

    /// <summary>
    /// A record made by one gesture and moved by the next: once the move is undone, the record is as
    /// the first gesture left it, though at a later version, so the first gesture is undone too and
    /// both are redone in order. The lane found this refused (W-103).
    /// </summary>
    [TestMethod]
    public async Task AGestureIsUndoneAfterALaterGestureOnTheSameRecordWasUndone()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        var start = await StateAsync(service);

        var make = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Create, "notes", "n5", Values("label", "Made"))], Context("make"), "Make n5"));
        var made = await StateAsync(service);
        var move = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Update, "notes", "n5", Values("label", "Moved", "folder", "f0"), 1,
                new Dictionary<string, long> { ["folder"] = 1 })], Context("move"), "Move n5"));
        var moved = await StateAsync(service);

        var unmove = await service.UndoRecordWritesAsync(new(move.Applied.RevisionId, Context("unmove"), Redo: false));
        Assert.AreEqual(made, await StateAsync(service));
        var unmake = await service.UndoRecordWritesAsync(new(make.Applied.RevisionId, Context("unmake"), Redo: false));
        Assert.AreEqual(start, await StateAsync(service), "The create was not undone after the move's undo.");
        var remake = await service.UndoRecordWritesAsync(new(unmake.Applied.RevisionId, Context("remake"), Redo: true));
        Assert.AreEqual(made, await StateAsync(service));
        await AnswersAreCurrentAsync(service, remake);
        await service.UndoRecordWritesAsync(new(unmove.Applied.RevisionId, Context("remove"), Redo: true));
        Assert.AreEqual(moved, await StateAsync(service), "The move was not redone after the create's redo.");

        // A change by somebody else in between is not taken back, and still refuses.
        var other = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Create, "notes", "n6", Values("label", "Other"))], Context("other")));
        var touch = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Update, "notes", "n6", Values("label", "Touched"), 1)], Context("touch")));
        await service.SetFieldsAsync(new NendoSetFieldsRequest("notes", "n6", 2, Values("label", "Theirs"),
            new NendoRequestContext("batch-tests", "theirs-n6", "surface")));
        await service.SetFieldsAsync(new NendoSetFieldsRequest("notes", "n6", 3, Values("label", "Touched"),
            new NendoRequestContext("batch-tests", "back-n6", "surface")));
        _ = touch;
        await RefusedAsync(service, other.Applied.RevisionId, "record-version-conflict");
    }

    [TestMethod]
    public async Task AStepWhoseRecordsChangedOrWerePointedAtSinceIsRefusedWhole()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);

        var rename = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "Mine"), 1)], Context("rename")));
        await service.SetFieldsAsync(new NendoSetFieldsRequest("notes", "n0", 2, Values("label", "Theirs"),
            new NendoRequestContext("batch-tests", "theirs", "surface")));
        await RefusedAsync(service, rename.Applied.RevisionId, "record-version-conflict");

        var create = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
        [
            new(NendoRecordWriteKind.Create, "folders", "f1", Values("name", "Archive")),
            new(NendoRecordWriteKind.Update, "folders", "f0", Values("name", "Renamed"), 1),
        ], Context("create")));
        await service.CreateRecordAsync(new("notes", "n2", Values("label", "Filed", "folder", "f1"),
            new NendoRequestContext("batch-tests", "filed", "surface"), new Dictionary<string, long> { ["folder"] = 1 }));
        await RefusedAsync(service, create.Applied.RevisionId, "record-referenced");
        Assert.AreEqual("Renamed", (await RecordsAsync(service, "folders"))["f0"].Values["name"].GetString(),
            "The refused undo put back the update before the delete it could not make.");
    }

    [TestMethod]
    public async Task AViewUndoesOnlyItsOwnRecordRevisionsAndRedoesOnlyAnUndo()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);

        var person = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "Typed"), 1)],
            new NendoRequestContext("batch-tests", "person", "surface")));
        var notYours = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.UndoRecordWritesAsync(new(person.Applied.RevisionId, Context("not-yours"), Redo: false)));
        Assert.AreEqual("revision-not-yours", notYours.Code);

        var own = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Update, "notes", "n0", Values("label", "Mine"), 2)], Context("own")));
        var notUndo = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.UndoRecordWritesAsync(new(own.Applied.RevisionId, Context("redo-first"), Redo: true)));
        Assert.AreEqual("not-an-undo", notUndo.Code);

        var labelled = await service.UndoRecordWritesAsync(new(own.Applied.RevisionId, Context("labelled"), Redo: false, "Undo Rename n0"));
        Assert.AreEqual("Undo Rename n0", (await RevisionAsync(service, labelled.Applied.RevisionId)).Description);
        CollectionAssert.AreEqual(new long?[] { 4 }, labelled.Records.Select(record => record.RecordVersion).ToArray());
    }

    [TestMethod]
    public async Task HistoryCompensatesACreateByDeletingItAndStillRefusesToUndoADefinitionCompensation()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);

        var created = await service.CreateRecordAsync(new("folders", "f5", Values("name", "Later"), Context("f5")));
        Assert.IsTrue((await RevisionAsync(service, created.RevisionId)).CanRequestCompensation, "History does not offer to compensate a create.");
        await service.CompensateRevisionAsync(created.RevisionId, "undo-f5");
        Assert.IsFalse((await RecordsAsync(service, "folders")).ContainsKey("f5"), "Compensating the create did not delete the record.");
        var reserved = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CreateRecordAsync(new("folders", "f5", Values("name", "Again"), Context("f5-again"))));
        Assert.AreEqual("record-id-reserved", reserved.Code, "A compensated create freed its record ID.");

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var renamed = await coordinator.ApplyAsync(new NendoMutation("batch-tests", "rename", "test", "Rename notes",
            [new RenameEntityOperation("rename-notes", "notes", "Jottings", revision)]));
        var compensation = await service.CompensateRevisionAsync(renamed.RevisionId, "undo-rename");
        Assert.IsFalse((await RevisionAsync(service, compensation.RevisionId)).CanRequestCompensation,
            "History offers to compensate a definition compensation.");
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.CompensateRevisionAsync(compensation.RevisionId, "redo-rename"));
    }

    private static async Task RefusedAsync(NendoApplicationService service, string revisionId, string code)
    {
        var sequence = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.UndoRecordWritesAsync(new(revisionId, Context($"refused-{code}"), Redo: false)));
        Assert.AreEqual(code, refused.Code, refused.Message);
        Assert.AreEqual(sequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence, "The refused undo changed the file.");
    }

    /// <summary>Every answered version is the one the record holds, and a deleted record is answered null.</summary>
    private static async Task AnswersAreCurrentAsync(NendoApplicationService service, NendoRecordWritesResult result)
    {
        foreach (var answer in result.Records)
        {
            var records = await RecordsAsync(service, answer.EntityId);
            Assert.AreEqual(records.TryGetValue(answer.RecordId, out var record) ? record.RecordVersion : null, answer.RecordVersion,
                $"The answer for {answer.RecordId} is not the version it holds.");
        }
    }

    /// <summary>Every record of both types with its values, so two states compare as text.</summary>
    private static async Task<string> StateAsync(NendoApplicationService service)
    {
        var lines = new List<string>();
        foreach (var entity in new[] { "folders", "notes" })
        foreach (var record in (await RecordsAsync(service, entity)).Values.OrderBy(record => record.RecordId, StringComparer.Ordinal))
            lines.Add($"{entity}/{record.RecordId}: " + string.Join(", ", record.Values.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => $"{pair.Key}={pair.Value}")));
        return string.Join("\n", lines);
    }

    private static async Task<Dictionary<string, NendoRecordSnapshot>> RecordsAsync(NendoApplicationService service, string entityId) =>
        (await service.QueryRecordsAsync(new(entityId, 50))).Items.ToDictionary(record => record.RecordId);

    private static async Task<NendoRevisionSummary> RevisionAsync(NendoApplicationService service, string revisionId) =>
        (await service.QueryHistoryAsync(new(50))).Items.Single(revision => revision.RevisionId == revisionId);

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
        // A view writes in its package's name only while the file carries the package.
        await coordinator.ApplyAsync(new NendoMutation("batch-tests", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", "demo.view", "Demo", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("index", "demo.view", "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>"))]));
        var person = new NendoRequestContext("batch-tests", "seed", "surface");
        await service.CreateRecordAsync(new("folders", "f0", Values("name", "Inbox"), person with { IdempotencyKey = "f0" }));
        await service.CreateRecordAsync(new("notes", "n0", Values("label", "First"), person with { IdempotencyKey = "n0" }));
        await service.CreateRecordAsync(new("notes", "n9", Values("label", "Gone"), person with { IdempotencyKey = "n9" }));
        return (coordinator, service);
    }

    private static Dictionary<string, object?> Values(params string[] pairs) =>
        Enumerable.Range(0, pairs.Length / 2).ToDictionary(index => pairs[index * 2], index => (object?)pairs[index * 2 + 1]);

    private static NendoRequestContext Context(string key) => new("batch-tests", key, View);
}
