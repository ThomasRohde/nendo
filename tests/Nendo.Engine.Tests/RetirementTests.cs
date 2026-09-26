using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RetirementTests
{
    [TestMethod]
    public async Task RetiringRequiredFieldRetainsValuesAllowsNewRecordsAndGuardsReactivation()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        await service.CreateRecordAsync(new("e", "old", new Dictionary<string, object?> { ["title"] = "Keep 🌱", ["note"] = "" }, Context("old")));
        var before = await service.GetSnapshotAsync();
        var retirement = await coordinator.ApplyAsync(Mutation("retire", new SetRetiredOperation("retire", "e", "title", true, before.Manifest.DefinitionRevision)));
        var retired = await service.GetSnapshotAsync();
        Assert.IsTrue(retired.Entities.Single().Fields.Single(f => f.FieldId == "title").Retired);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(retired.Records));
        await Code("field-retired", () => service.SetFieldAsync(new("e", "old", "title", 1, "Lost", Context("blocked"))));
        await service.CreateRecordAsync(new("e", "new", new Dictionary<string, object?> { ["note"] = "Only active field" }, Context("new")));
        await Code("required-backfill-needed", () => service.CompensateRevisionAsync(retirement.RevisionId, "restore"));
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
    public async Task RetiredTypeRejectsWritesAndCompensationReactivatesIt()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator); await Seed(coordinator);
        await service.CreateRecordAsync(new("e", "r", new Dictionary<string, object?> { ["title"] = "Retain" }, Context("r")));
        var revision = await coordinator.ApplyAsync(Mutation("retire", new SetRetiredOperation("retire", "e", null, true, 1)));
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single().Retired);
        await Code("entity-retired", () => service.CreateRecordAsync(new("e", "n", new Dictionary<string, object?> { ["title"] = "No" }, Context("create"))));
        await Code("entity-retired", () => service.SetFieldAsync(new("e", "r", "title", 1, "No", Context("edit"))));
        await Code("entity-retired", () => service.DeleteRecordAsync(new("e", "r", 1, Context("delete"))));
        await service.CompensateRevisionAsync(revision.RevisionId, "reactivate");
        Assert.IsFalse((await service.GetSnapshotAsync()).Entities.Single().Retired);
        await service.SetFieldAsync(new("e", "r", "title", 1, "Active again", Context("edit-again")));
    }

    [TestMethod]
    public async Task RetiringBoundFieldRequiresBindingRemovalInTheSameAtomicMutation()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator); await Seed(coordinator);
        await coordinator.ApplyAsync(new("test", "ui", "test", "Field binding", [
            new AddUiNodeOperation("node", "form", "root", null, "recordForm", 0),
            new SetUiPropertyOperation("entity", "form", "root", "entityId", "e"),
            new AddUiNodeOperation("field", "form", "binding", "root", "fieldBinding", 0),
            new SetUiPropertyOperation("bind", "form", "binding", "fieldId", "title"),
        ]));
        var before = await service.GetSnapshotAsync();
        await Code("retired-binding", () => coordinator.ApplyAsync(Mutation("blocked", new SetRetiredOperation("blocked", "e", "title", true, 2))));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        await coordinator.ApplyAsync(new("test", "retire-remove", "test", "Retire and remove binding", [
            new SetRetiredOperation("retire", "e", "title", true, 2), new RemoveUiNodeOperation("remove", "form", "binding"),
        ]));
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single().Fields.Single(f => f.FieldId == "title").Retired);
    }

    [TestMethod]
    public async Task InspectionRetainsRetirementAndRejectsUnknownMetadataWithoutChangingBytes()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        await Seed(coordinator);
        await coordinator.ApplyAsync(Mutation("retire", new SetRetiredOperation("retire", "e", "title", true, 1)));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(inspection.CanAcquireWriteAuthority);
        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath))
            Assert.IsTrue((await reader.GetSnapshotAsync()).Entities.Single().Fields.Single(field => field.FieldId == "title").Retired);
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()))
        {
            await connection.OpenAsync(); await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO __nendo_retirement VALUES ('field','unknown',1);";
            await command.ExecuteNonQueryAsync();
        }
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsFalse(inspection.CanAcquireWriteAuthority);
        Assert.IsTrue(inspection.Findings.Any(finding => finding.Code == "mapping-drift"));
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    // R-012. A trigger whose action writes a field must not survive that field's
    // retirement: the next routine edit would raise it and roll back on the retired target.
    [TestMethod]
    public async Task RetiringAnActionTargetIsRefusedWhileAnActiveActionWritesIt()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await StampFixture(coordinator, service);

        var before = await service.GetSnapshotAsync();
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(
            Mutation("retire-stamp", new SetRetiredOperation("retire-stamp", "e", "stamp", true, before.Manifest.DefinitionRevision))));
        Assert.AreEqual("retired-binding", refusal.Code);
        StringAssert.Contains(refusal.Message, "stamp.action");
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));

        // The routine edit the defect used to break still runs its action.
        await service.SetFieldAsync(new("e", "r", "title", 1, "After", Context("edit")));
        Assert.AreEqual("Done", (await service.GetSnapshotAsync()).Records.Single().Values["stamp"].GetString());
    }

    [TestMethod]
    public async Task RetiringAnActionTargetSucceedsWhenTheSameMutationRewiresTheAction()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await StampFixture(coordinator, service);

        // Retirement listed first: the final candidate decides, not the operation order.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "rewire", "test", "Retire and rewire", [
            new SetRetiredOperation("retire-stamp", "e", "stamp", true, revision),
            new SetBehaviourDefinitionOperation("rewire", StampAction("note"), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        await service.SetFieldAsync(new("e", "r", "title", 1, "After", Context("edit")));
        var record = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual("Done", record.Values["note"].GetString());
        Assert.AreEqual("After", record.Values["title"].GetString());
    }

    [TestMethod]
    public async Task RetiringAnActionTargetSucceedsWhenTheSameMutationRemovesTheBehaviour()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await StampFixture(coordinator, service);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "remove", "test", "Remove and retire", [
            new RemoveBehaviourDefinitionOperation("drop-trigger", "stamp.trigger", NendoBehaviourKind.Trigger, revision),
            new RemoveBehaviourDefinitionOperation("drop-action", "stamp.action", NendoBehaviourKind.Action, revision),
            new SetRetiredOperation("retire-stamp", "e", "stamp", true, revision),
        ]));
        await service.SetFieldAsync(new("e", "r", "title", 1, "After", Context("edit")));
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single().Fields.Single(field => field.FieldId == "stamp").Retired);
    }

    [TestMethod]
    public async Task RetiringARecordTypeIsRefusedWhileBehaviourReadsOrWritesIt()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Parents and children", [
            new CreateEntityOperation("parents", "parents", "Parents", "parents"),
            new AddFieldOperation("p-name", "parents", "parentName", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "parents", "total", "Total", "total", NendoStorageKind.Integer, false),
            new CreateEntityOperation("children", "children", "Children", "children"),
            new AddFieldOperation("c-parent", "children", "parent", "Parent", "parent", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("configure", "children", "parent", "parents", "parentName", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Count onto the parent", [
            new SetBehaviourDefinitionOperation("action", new NendoActionDefinition("count", "Count children",
                [NendoActionStep.SetField("count", NendoActionTarget.Referenced("parent"), new NendoActionAssignment("total", "7", [], []))]), revision),
            new SetBehaviourDefinitionOperation("trigger", new NendoTriggerDefinition("count.trigger", "children", "Keep counts",
                NendoTriggerEvents.Updated, "count", ["parent"]), revision),
        ]));

        // No child refers to a parent, so only the action's target stands in the way.
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(
            Mutation("retire-parents", new SetRetiredOperation("retire-parents", "parents", null, true, revision))));
        Assert.AreEqual("retired-binding", refusal.Code);
        StringAssert.Contains(refusal.Message, "parents");
        Assert.IsFalse((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "parents").Retired);
    }

    private static NendoActionDefinition StampAction(string fieldId) => new("stamp.action", "Stamp",
        [NendoActionStep.SetField("write-stamp", NendoActionTarget.EventRecord, new NendoActionAssignment(fieldId, "'Done'", [], []))]);

    private static async Task StampFixture(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("e", "e", "Entries", "entries"),
            new AddFieldOperation("title", "e", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("note", "e", "note", "Note", "note", NendoStorageKind.Text, false),
            new AddFieldOperation("stamp", "e", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        await service.CreateRecordAsync(new("e", "r", new Dictionary<string, object?> { ["title"] = "Before" }, Context("r")));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "automatic", "test", "Stamp on title edits", [
            new SetBehaviourDefinitionOperation("action", StampAction("stamp"), revision),
            new SetBehaviourDefinitionOperation("trigger", new NendoTriggerDefinition("stamp.trigger", "e", "Stamp edits",
                NendoTriggerEvents.Updated, "stamp.action", ["title"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
    }

    private static async Task Seed(NendoWriteCoordinator coordinator) => await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
        new CreateEntityOperation("e", "e", "Entries", "entries"),
        new AddFieldOperation("title", "e", "title", "Title", "title", NendoStorageKind.Text, true),
        new AddFieldOperation("note", "e", "note", "Note", "note", NendoStorageKind.Text, false),
    ]));
    private static NendoMutation Mutation(string key, NendoOperation operation) => new("test", key, "test", key, [operation]);
    private static NendoRequestContext Context(string key) => new("test", key, "test");
    private static async Task Code(string code, Func<Task> action) => Assert.AreEqual(code,
        (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(action)).Code);
}
