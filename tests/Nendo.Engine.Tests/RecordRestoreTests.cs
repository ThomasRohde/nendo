namespace Nendo.Engine.Tests;

/// <summary>
/// Restoring deleted records that point at each other. Archi's editor commits "delete a box
/// from the view" as one revision: the connections on the box first, then the box, because a
/// record still pointed at cannot be deleted. Undoing it put the box back first, at its next
/// version, and then refused its connections as pointing at a target that had changed
/// (owner-reported, 2026-10-01).
/// </summary>
[TestClass]
public sealed class RecordRestoreTests
{
    [TestMethod]
    public async Task UndoingTheDeletionOfABoxAndItsLineInOneRevisionRestoresBoth()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var deleted = await coordinator.ApplyAsync(new("test", "delete-both", "test", "Delete the box from the view", [
            new DeleteRecordOperation("delete-line", "lines", "l1", 1),
            new DeleteRecordOperation("delete-box", "boxes", "b1", 1),
        ]));

        await service.CompensateRevisionAsync(deleted.RevisionId, "undo-both");

        var line = await Record(service, "lines", "l1");
        Assert.IsNotNull(line, "The line was not restored with its box.");
        Assert.AreEqual("b1", line.Values["source"].GetString());
        Assert.AreEqual(2L, (await Record(service, "boxes", "b1"))!.RecordVersion);
    }

    [TestMethod]
    public async Task ARestoredTargetEditedSinceStillRefusesTheReferenceToIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var lineGone = await coordinator.ApplyAsync(new("test", "delete-line", "test", "Delete the line",
            [new DeleteRecordOperation("delete-line", "lines", "l1", 1)]));
        var boxGone = await coordinator.ApplyAsync(new("test", "delete-box", "test", "Delete the box",
            [new DeleteRecordOperation("delete-box", "boxes", "b1", 1)]));
        await service.CompensateRevisionAsync(boxGone.RevisionId, "undo-box");
        await service.SetFieldAsync(new("boxes", "b1", "name", 2, "Renamed", new("test", "rename", "test")));

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => service.CompensateRevisionAsync(lineGone.RevisionId, "undo-line"));
        Assert.AreEqual("target-version-conflict", refused.Code,
            "A line was restored onto a box that changed after the line was deleted.");
    }

    [TestMethod]
    public async Task ARestoredTargetUnchangedSinceTakesTheReferenceBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var lineGone = await coordinator.ApplyAsync(new("test", "delete-line", "test", "Delete the line",
            [new DeleteRecordOperation("delete-line", "lines", "l1", 1)]));
        var boxGone = await coordinator.ApplyAsync(new("test", "delete-box", "test", "Delete the box",
            [new DeleteRecordOperation("delete-box", "boxes", "b1", 1)]));
        await service.CompensateRevisionAsync(boxGone.RevisionId, "undo-box");

        await service.CompensateRevisionAsync(lineGone.RevisionId, "undo-line");
        Assert.IsNotNull(await Record(service, "lines", "l1"),
            "The box holds exactly what it held when the line was deleted, so the line belongs back on it.");
    }

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Boxes and lines", [
            new CreateEntityOperation("e-box", "boxes", "Boxes", "boxes"),
            new AddFieldOperation("b-name", "boxes", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("e-line", "lines", "Lines", "lines"),
            new AddFieldOperation("l-source", "lines", "source", "Source", "source_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("l-bind", "lines", "source", "boxes", "name", 0),
        ]));
        await service.CreateRecordAsync(new("boxes", "b1", new Dictionary<string, object?> { ["name"] = "Box" }, new("test", "b1", "test")));
        await service.CreateRecordAsync(new("lines", "l1", new Dictionary<string, object?> { ["source"] = "b1" },
            new("test", "l1", "test"), new Dictionary<string, long> { ["source"] = 1 }));
        return service;
    }

    private static async Task<NendoRecordSnapshot?> Record(NendoApplicationService service, string entityId, string recordId) =>
        (await service.QueryRecordsAsync(new NendoRecordQuery(entityId) { RecordId = recordId })).Items.SingleOrDefault();
}
