using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ReferenceTests
{
    [TestMethod]
    public async Task RequiredReferencesCheckBothVersionsAndPreserveStableIdsAcrossRenameAndReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, true);
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "t" }, Context("source"),
            new Dictionary<string, long> { ["ref"] = 1 }));
        var before = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoReferenceDefinition("target", "label"), before.Entities.Single(e => e.EntityId == "source").Fields.Single().Reference);
        Assert.AreEqual(NendoFormat.ReferenceMinimumHostVersion, before.Manifest.MinimumHostVersion);
        await Code("target-version-required", () => service.SetFieldAsync(new("source", "s", "ref", 1, "t", Context("missing-version"))));
        await Code("target-not-found", () => service.SetFieldAsync(new("source", "s", "ref", 1, "s", Context("wrong-type"), 1)));
        await Code("target-not-found", () => service.SetFieldAsync(new("source", "s", "ref", 1, "absent", Context("absent"), 1)));
        await Code("record-version-conflict", () => service.SetFieldAsync(new("source", "s", "ref", 2, "t", Context("stale-source"), 1)));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.SetFieldAsync(new("source", "s", "ref", 1, null, Context("required-null"))));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await service.SetFieldAsync(new("target", "t", "label", 1, "Renamed target", Context("target-edit")));
        var edited = await service.GetSnapshotAsync();
        await Code("target-version-conflict", () => service.SetFieldAsync(new("source", "s", "ref", 1, "t", Context("stale-target"), 1)));
        Assert.AreEqual(JsonSerializer.Serialize(edited), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await coordinator.ApplyAsync(Mutation("rename-target", new RenameEntityOperation("rename-target", "target", "Renamed type", edited.Manifest.DefinitionRevision)));
        var afterRename = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("rename-label", new RenameFieldOperation("rename-label", "target", "label", "Display label", afterRename.Manifest.DefinitionRevision)));
        await service.SetFieldAsync(new("source", "s", "ref", 1, "t", Context("current-target"), 2));
        var final = await service.GetSnapshotAsync();
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var reopened = await workspace.OpenAsync();
        var snapshot = await new NendoApplicationService(reopened).GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(final.Entities), JsonSerializer.Serialize(snapshot.Entities));
        Assert.AreEqual(JsonSerializer.Serialize(final.Records), JsonSerializer.Serialize(snapshot.Records));
        await reopened.DisposeAsync(); workspace.Forget(reopened);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath), "Opening a reference file rewrote its bytes.");
    }

    [TestMethod]
    public async Task OptionalReferenceAllowsNullAndCreateRejectsMissingOrExtraneousTargetVersions()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, false);
        await service.CreateRecordAsync(new("source", "empty", new Dictionary<string, object?>(), Context("empty")));
        await Code("target-version-required", () => service.CreateRecordAsync(new("source", "invalid", new Dictionary<string, object?> { ["ref"] = "t" }, Context("invalid"))));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.CreateRecordAsync(new("source", "extra", new Dictionary<string, object?>(), Context("extra"), new Dictionary<string, long> { ["ref"] = 1 })));
        await service.SetFieldsAsync(new("source", "empty", 1, new Dictionary<string, object?> { ["ref"] = "t" }, Context("set"), new Dictionary<string, long> { ["ref"] = 1 }));
        await service.SetFieldAsync(new("source", "empty", "ref", 2, null, Context("clear")));
        var record = (await service.GetSnapshotAsync()).Records.Single(r => r.EntityId == "source");
        Assert.AreEqual(JsonValueKind.Null, record.Values["ref"].ValueKind);
        Assert.AreEqual(3L, record.RecordVersion);
    }

    [TestMethod]
    public async Task InvalidReferenceDefinitionRollsBackAndUnboundValuesAreNeverGuessed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "unbound", "test", "Unbound schema", [
            new CreateEntityOperation("e", "source", "Source", "sources"),
            new AddFieldOperation("r", "source", "ref", "Reference", "reference_value", NendoStorageKind.Reference, false),
            new CreateEntityOperation("t", "target", "Target", "targets"),
            new AddFieldOperation("n", "target", "number", "Number", "number_value", NendoStorageKind.Integer, false),
        ]));
        var before = await service.GetSnapshotAsync();
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(Mutation("invalid-label",
            new ConfigureReferenceOperation("invalid-label", "source", "ref", "target", "number", before.Manifest.DefinitionRevision))));
        await Code("reference-unbound", () => service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "guess" }, Context("guess"), new Dictionary<string, long> { ["ref"] = 1 })));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    [TestMethod]
    public async Task ReferenceCompensationRetainsTargetVersionAndConflictsAfterTargetChanges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, false);
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "t" }, Context("s"), new Dictionary<string, long> { ["ref"] = 1 }));
        var clear = await service.SetFieldAsync(new("source", "s", "ref", 1, null, Context("clear")));
        await service.CompensateRevisionAsync(clear.RevisionId, "restore");
        Assert.AreEqual("t", (await service.GetSnapshotAsync()).Records.Single(r => r.EntityId == "source").Values["ref"].GetString());
        var clearAgain = await service.SetFieldAsync(new("source", "s", "ref", 3, null, Context("clear-again")));
        await service.SetFieldAsync(new("target", "t", "label", 1, "Changed", Context("target-change")));
        var before = await service.GetSnapshotAsync();
        await Code("target-version-conflict", () => service.CompensateRevisionAsync(clearAgain.RevisionId, "stale-restore"));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    [TestMethod]
    public async Task BoundedReferenceLabelsAndRecordLookupMatchTheReadOnlyProjection()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator, false);
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?> { ["ref"] = "t" }, Context("s"), new Dictionary<string, long> { ["ref"] = 1 }));
        var query = new NendoRecordQuery("source", 1) { RecordId = "s" };
        var first = await service.QueryRecordsAsync(query);
        Assert.AreEqual("Target label", first.Items.Single().ReferenceLabels["ref"]);
        Assert.IsEmpty((await service.QueryRecordsAsync(query with { RecordId = "s' OR 1=1 --" })).Items);
        await service.SetFieldAsync(new("target", "t", "label", 1, "  Current label 🌱  ", Context("rename")));
        var current = await service.QueryRecordsAsync(query);
        Assert.AreEqual("  Current label 🌱  ", current.Items.Single().ReferenceLabels["ref"]);
        Assert.AreEqual(1L, current.Items.Single().RecordVersion);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath))
            Assert.AreEqual(JsonSerializer.Serialize(current.Items), JsonSerializer.Serialize((await reader.QueryRecordsAsync(query)).Items));
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    private static async Task Seed(NendoWriteCoordinator coordinator, bool required)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Reference schema", [
            new CreateEntityOperation("target", "target", "Target", "targets"),
            new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("source", "source", "Source", "sources"),
            new AddFieldOperation("ref", "source", "ref", "Reference", "target_id", NendoStorageKind.Reference, required),
            new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", 0),
        ]));
        await coordinator.ApplyAsync(Mutation("target-record", new CreateRecordOperation("t", "target", "t", new Dictionary<string, object?> { ["label"] = "Target label" })));
    }
    private static NendoMutation Mutation(string key, NendoOperation operation) => new("test", key, "test", key, [operation]);
    private static NendoRequestContext Context(string key) => new("test", key, "test");
    private static async Task Code(string code, Func<Task> action) => Assert.AreEqual(code,
        (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
