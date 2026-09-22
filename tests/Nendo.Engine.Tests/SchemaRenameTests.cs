using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class SchemaRenameTests
{
    [TestMethod]
    public async Task RenameProposalRejectAndReplayPreserveTheActiveRecords()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Rename", "test",
            new([Mutation("proposal-rename", new RenameEntityOperation("proposal-rename", "e", "Proposed entries", before.Manifest.DefinitionRevision))])));
        Assert.AreEqual("Entries", (await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == "e").DisplayName);
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("Proposed entries", after.Entities.Single(e => e.EntityId == "e").DisplayName);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
    }

    [TestMethod]
    public async Task RenamePreservesIdsValuesAndVersionsAndCompensatesWithDefinitionGuard()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        var rename = await coordinator.ApplyAsync(Mutation("rename", new RenameFieldOperation("rename", "e", "f", "New label", before.Manifest.DefinitionRevision)));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("New label", after.Entities.Single(e => e.EntityId == "e").Fields.Single().DisplayName);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
        Assert.AreEqual(NendoFormat.EvolutionMinimumHostVersion, after.Manifest.MinimumHostVersion);
        await service.CompensateRevisionAsync(rename.RevisionId, "undo");
        Assert.AreEqual("Label", (await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == "e").Fields.Single().DisplayName);
        var current = await service.GetSnapshotAsync();
        var entityRename = await coordinator.ApplyAsync(Mutation("rename-type", new RenameEntityOperation("rename-type", "e", "Renamed entries", current.Manifest.DefinitionRevision)));
        var latest = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("later", new RenameFieldOperation("later", "e", "f", "Later label", latest.Manifest.DefinitionRevision)));
        await Code("definition-version-conflict", () => service.CompensateRevisionAsync(entityRename.RevisionId, "stale-undo"));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var reopened = await new NendoApplicationService(await workspace.OpenAsync()).GetSnapshotAsync();
        Assert.AreEqual("Renamed entries", reopened.Entities.Single(e => e.EntityId == "e").DisplayName);
        Assert.AreEqual("Later label", reopened.Entities.Single(e => e.EntityId == "e").Fields.Single().DisplayName);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(reopened.Records));
    }

    [TestMethod]
    public async Task RenameRejectsCollisionsStaleDefinitionsAndForeignFieldsAtomically()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        await Code("label-conflict", () => coordinator.ApplyAsync(Mutation("collision", new RenameEntityOperation("collision", "e", " OTHER ", before.Manifest.DefinitionRevision))));
        await Code("definition-version-conflict", () => coordinator.ApplyAsync(Mutation("stale", new RenameEntityOperation("stale", "e", "Rename", 0))));
        await Code("field-not-found", () => coordinator.ApplyAsync(Mutation("wrong", new RenameFieldOperation("wrong", "other", "f", "Rename", before.Manifest.DefinitionRevision))));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    private static Task Seed(NendoWriteCoordinator coordinator) => SeedCore(coordinator);
    private static async Task SeedCore(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "e", "Entries", "entries"),
            new AddFieldOperation("f", "e", "f", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("o", "other", "Other", "other_entries"),
        ]));
        await coordinator.ApplyAsync(Mutation("data", new CreateRecordOperation("r", "e", "r", new Dictionary<string, object?> { ["f"] = "  unchanged 🌱  " })));
    }
    private static NendoMutation Mutation(string key, NendoOperation operation) => new("test", key, "test", key, [operation]);
    private static async Task Code(string code, Func<Task> action) => Assert.AreEqual(code,
        (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
