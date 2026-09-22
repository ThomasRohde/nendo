using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RecordDeletionTests
{
    [TestMethod]
    public async Task DeleteReservesIdentityRestoresExactValuesAtNewVersionAndSurvivesReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        await Code("record-version-conflict", () => service.DeleteRecordAsync(new("target", "t", 2, Context("stale"))));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        var deleted = await service.DeleteRecordAsync(new("target", "t", 1, Context("delete")));
        Assert.IsEmpty((await service.GetSnapshotAsync()).Records);
        await Code("record-id-reserved", () => service.CreateRecordAsync(new("target", "t", new Dictionary<string, object?> { ["label"] = "Overwrite" }, Context("reuse"))));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        Assert.AreEqual(NendoFormat.DeletionMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath));
        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        await service.CompensateRevisionAsync(deleted.RevisionId, "restore");
        var restored = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(2L, restored.RecordVersion);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records.Single().Values), JsonSerializer.Serialize(restored.Values));
        var again = await service.DeleteRecordAsync(new("target", "t", 2, Context("again")));
        await service.CompensateRevisionAsync(again.RevisionId, "restore-again");
        Assert.AreEqual(3L, (await service.GetSnapshotAsync()).Records.Single().RecordVersion);
    }

    [TestMethod]
    public async Task IncomingOptionalAndSelfReferencesBlockDeletionWithoutChanges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "t" }, Context("s"), new Dictionary<string, long> { ["ref"] = 1 }));
        var before = await service.GetSnapshotAsync();
        var blocked = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.DeleteRecordAsync(new("target", "t", 1, Context("blocked"))));
        Assert.AreEqual("record-referenced", blocked.Code);
        // The remedy is to clear the references, which is only a remedy when the
        // refusal says which records hold them.
        StringAssert.Contains(blocked.Message, "1 ");
        StringAssert.Contains(blocked.Message, "(s)");
        StringAssert.Contains(blocked.Message, "still points");
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await service.SetFieldAsync(new("source", "s", "ref", 1, null, Context("clear")));
        await service.DeleteRecordAsync(new("target", "t", 1, Context("delete")));
        Assert.AreEqual("s", (await service.GetSnapshotAsync()).Records.Single().RecordId);
        var definition = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "self-schema", "test", "Self reference", [
            new AddFieldOperation("self-field", "source", "self", "Self", "self_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("self-label", "source", "title", "Title", "title", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("self-bind", "source", "self", "source", "title", definition),
        ]));
        await service.SetFieldAsync(new("source", "s", "self", 2, "s", Context("self"), 2));
        await Code("record-referenced", () => service.DeleteRecordAsync(new("source", "s", 3, Context("delete-self"))));
    }

    [TestMethod]
    public async Task RestorationRejectsMissingOrChangedReferenceTargetAndKeepsDeletedState()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "t" }, Context("s"), new Dictionary<string, long> { ["ref"] = 1 }));
        var deleted = await service.DeleteRecordAsync(new("source", "s", 1, Context("delete-source")));
        await service.SetFieldAsync(new("target", "t", "label", 1, "Changed", Context("change")));
        var before = await service.GetSnapshotAsync();
        await Code("target-version-conflict", () => service.CompensateRevisionAsync(deleted.RevisionId, "stale-restore"));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await service.DeleteRecordAsync(new("target", "t", 2, Context("delete-target")));
        await Code("target-not-found", () => service.CompensateRevisionAsync(deleted.RevisionId, "missing-restore"));
        Assert.IsEmpty((await service.GetSnapshotAsync()).Records);
    }

    [TestMethod]
    public async Task ADeletedRecordRestoresEvenAfterAFieldOfItsTypeIsRetired()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("n-legacy", "notes", "legacy", "Legacy", "legacy", NendoStorageKind.Text, false),
        ]));
        await service.CreateRecordAsync(new("notes", "n",
            new Dictionary<string, object?> { ["title"] = "Keep", ["legacy"] = "Old" }, Context("create")));
        // Retire the second field; the deletion contract retains its stored data regardless.
        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire legacy",
            [new SetRetiredOperation("retire", "notes", "legacy", true, 1)]));
        var deleted = await service.DeleteRecordAsync(new("notes", "n", 1, Context("delete")));
        Assert.IsEmpty((await service.GetSnapshotAsync()).Records);

        // A restore replays every retained value, retired fields included. It must not be
        // refused for a field the caller never touched — a declared-reversible delete was
        // unreversible for the whole record type once any field of it was retired.
        await service.CompensateRevisionAsync(deleted.RevisionId, "restore");
        var restored = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(2L, restored.RecordVersion);
        Assert.AreEqual("Keep", restored.Values["title"].GetString());
    }

    private static async Task Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
        new CreateEntityOperation("target", "target", "Target", "targets"),
        new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
        new CreateEntityOperation("source", "source", "Source", "sources"),
        new AddFieldOperation("ref", "source", "ref", "Reference", "target_id", NendoStorageKind.Reference, false),
        new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", 0),
        ]));
        await coordinator.ApplyAsync(new("test", "target-record", "test", "Target", [new CreateRecordOperation("t", "target", "t", new Dictionary<string, object?> { ["label"] = "  Target 🌱\nlabel  " })]));
    }
    private static NendoRequestContext Context(string key) => new("test", key, "test");
    private static async Task Code(string code, Func<Task> action) => Assert.AreEqual(code,
        (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
