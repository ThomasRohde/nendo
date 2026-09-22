using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ChoiceEvolutionTests
{
    [TestMethod]
    public async Task RenameAndRetirePreserveValuesRejectNewAssignmentsAndCompensate()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        await service.CreateRecordAsync(new("entry", "r", new Dictionary<string, object?> { ["status"] = "new" }, Context("create")));
        var original = await service.GetSnapshotAsync();
        var rename = await coordinator.ApplyAsync(Mutation("rename", new("rename", "entry", "status", "new", "Fresh 🌱", false, original.Manifest.DefinitionRevision)));
        var renamed = await service.GetSnapshotAsync();
        Assert.AreEqual("new", renamed.Records.Single().Values["status"].GetString());
        Assert.AreEqual(1L, renamed.Records.Single().RecordVersion);
        Assert.AreEqual("Fresh 🌱", renamed.Entities.Single().Fields.Single().Choices.Single(c => c.Id == "new").DisplayName);
        await service.CompensateRevisionAsync(rename.RevisionId, "undo-rename");
        var afterUndo = await service.GetSnapshotAsync();
        Assert.AreEqual("new", afterUndo.Entities.Single().Fields.Single().Choices.Single(c => c.Id == "new").DisplayName);
        await coordinator.ApplyAsync(Mutation("retire", new("retire", "entry", "status", "new", "Retained", true, afterUndo.Manifest.DefinitionRevision)));
        await Code("choice-retired", () => service.CreateRecordAsync(new("entry", "invalid", new Dictionary<string, object?> { ["status"] = "new" }, Context("invalid"))));
        await service.SetFieldAsync(new("entry", "r", "status", 1, "new", Context("unchanged")));
        await service.SetFieldAsync(new("entry", "r", "status", 2, "done", Context("done")));
        await Code("choice-retired", () => service.SetFieldAsync(new("entry", "r", "status", 3, "new", Context("retired"))));
        var final = await service.GetSnapshotAsync();
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        Assert.AreEqual(JsonSerializer.Serialize(final.Entities), JsonSerializer.Serialize((await service.GetSnapshotAsync()).Entities));
        Assert.AreEqual(JsonSerializer.Serialize(final.Records), JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task ChoiceCollisionAndStaleCompensationRollBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        var before = await service.GetSnapshotAsync();
        await Code("label-conflict", () => coordinator.ApplyAsync(Mutation("collision", new("collision", "entry", "status", "new", " DONE ", false, before.Manifest.DefinitionRevision))));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        var rename = await coordinator.ApplyAsync(Mutation("rename", new("rename", "entry", "status", "new", "Fresh", false, before.Manifest.DefinitionRevision)));
        var renamed = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("later", new("later", "entry", "status", "done", "Completed", false, renamed.Manifest.DefinitionRevision)));
        await Code("definition-version-conflict", () => service.CompensateRevisionAsync(rename.RevisionId, "stale"));
    }
    private static NendoMutation Mutation(string key, SetChoiceMetadataOperation operation) => new("test", key, "test", key, [operation]);
    private static NendoRequestContext Context(string key) => new("test", key, "test");
    private static async Task Code(string code, Func<Task> action) => Assert.AreEqual(code,
        (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
