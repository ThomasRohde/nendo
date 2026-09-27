namespace Nendo.Engine.Tests;

/// <summary>
/// A unique field, ADR-0020 stage 1: declared by schema.setFieldUnique, checked against the
/// data on declaration, and then refused on every write that would give two records the same
/// value, naming the record that holds it. Text compares case-insensitively for ASCII; an empty
/// value never collides.
/// </summary>
[TestClass]
public sealed class FieldUniqueTests
{
    private const string Entity = "items";

    [TestMethod]
    public async Task DeclaringRecordsTheRuleRaisesTheLayoutAndSurvivesAReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        Assert.IsFalse(Field(await service.GetSnapshotAsync(), "code").Unique);

        await DeclareAsync(coordinator, service, "code");
        var after = await service.GetSnapshotAsync();
        Assert.IsTrue(Field(after, "code").Unique);
        Assert.IsFalse(Field(after, "title").Unique);
        Assert.AreEqual(NendoFormat.FieldRuleMinimumHostVersion, after.Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-v1",
            inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
        coordinator = await workspace.OpenAsync();
        Assert.IsTrue(Field(await new NendoApplicationService(coordinator).GetSnapshotAsync(), "code").Unique);
    }

    [TestMethod]
    public async Task AFileThatNeverDeclaresOneKeepsItsLayoutAndHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SchemaAsync(coordinator);
        var snapshot = await new NendoApplicationService(coordinator).GetSnapshotAsync();
        Assert.IsTrue(Version.Parse(snapshot.Manifest.MinimumHostVersion) < Version.Parse(NendoFormat.FieldRuleMinimumHostVersion));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.IsFalse((await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout!.Contains("-rule-", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task DeclaringOverCollidingValuesIsRefusedNamingEachAndNothingIsRenumbered()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a", "F-070");
        await CreateAsync(service, "b", "f-070");
        await CreateAsync(service, "c", "F-071");
        await CreateAsync(service, "d", "F-071");
        await CreateAsync(service, "e", "F-072");
        await CreateAsync(service, "f", null);
        await CreateAsync(service, "g", null);

        var refused = await Refused(() => DeclareAsync(coordinator, service, "code"));
        Assert.AreEqual("field-values-not-unique", refused.Code);
        StringAssert.Contains(refused.Message, "a and b; c and d.");
        Assert.IsFalse(refused.Message.Contains("F-07", StringComparison.OrdinalIgnoreCase), "A refusal names records, never stored values: " + refused.Message);
        Assert.IsFalse(Field(await service.GetSnapshotAsync(), "code").Unique);
        Assert.AreEqual("f-070", (await RecordAsync(service, "b")).Values["code"]!.ToString(), "Nothing is renumbered.");

        // Resolved through ordinary writes, the declaration is accepted; two empty values never collide.
        await service.SetFieldAsync(new(Entity, "b", "code", 1, "F-073", Context("fix-b")));
        await service.SetFieldAsync(new(Entity, "d", "code", 1, "F-074", Context("fix-d")));
        await DeclareAsync(coordinator, service, "code");
        Assert.IsTrue(Field(await service.GetSnapshotAsync(), "code").Unique);
    }

    [TestMethod]
    public async Task EveryWriteThatWouldDuplicateAValueIsRefusedNamingTheHolder()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a", "W-001");
        await CreateAsync(service, "b", "W-002");
        await DeclareAsync(coordinator, service, "code");
        var history = (await service.GetHistoryAsync()).Count;

        var create = await Refused(() => CreateAsync(service, "c", "w-001"));
        var set = await Refused(() => service.SetFieldAsync(new(Entity, "b", "code", 1, "W-001", Context("set"))));
        var form = await Refused(() => service.SetFieldsAsync(new(Entity, "b", 1,
            new Dictionary<string, object?> { ["title"] = "B", ["code"] = "W-001" }, Context("form"))));
        var batch = await Refused(() => service.CreateRecordsAsync(new(Entity,
        [
            new("d", new Dictionary<string, object?> { ["title"] = "D", ["code"] = "W-009" }, null),
            new("e", new Dictionary<string, object?> { ["title"] = "E", ["code"] = "W-009" }, null),
        ], Context("paste"))));
        foreach (var (path, refusal, holder) in new[] { ("create", create, "a"), ("set", set, "a"), ("form", form, "a"), ("batch", batch, "d") })
        {
            Assert.AreEqual("value-not-unique", refusal.Code, path);
            StringAssert.Contains(refusal.Message, $"already used by {holder}", path);
            StringAssert.Contains(refusal.Message, "Code", path);
            Assert.AreEqual(holder, refusal.RecordId, "The refusal names its holder for a person-facing host to label.");
        }
        Assert.HasCount(history, await service.GetHistoryAsync(), "Every refusal left the file as it was.");

        // A record keeps its own value, a new value is free, and empty never collides.
        await service.SetFieldsAsync(new(Entity, "a", 1, new Dictionary<string, object?> { ["title"] = "A2", ["code"] = "W-001" }, Context("same")));
        await CreateAsync(service, "c", "W-003");
        await CreateAsync(service, "x", null);
        await CreateAsync(service, "y", null);
    }

    [TestMethod]
    public async Task AnIntegerCanBeUniqueAndOtherShapesAreRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await DeclareAsync(coordinator, service, "number");
        await service.CreateRecordAsync(new(Entity, "a", new Dictionary<string, object?> { ["title"] = "A", ["number"] = 7L }, Context("a")));
        Assert.AreEqual("value-not-unique", (await Refused(() =>
            service.CreateRecordAsync(new(Entity, "b", new Dictionary<string, object?> { ["title"] = "B", ["number"] = 7L }, Context("b"))))).Code);

        foreach (var (field, shape) in new[] { ("notes", "long text"), ("stage", "a single choice"), ("due", "a Date field") })
        {
            var refused = await Refused(() => DeclareAsync(coordinator, service, field));
            Assert.AreEqual("field-unique-invalid", refused.Code, field);
            StringAssert.Contains(refused.Message, shape, field);
        }
        Assert.AreEqual("field-unique-unchanged", (await Refused(() => DeclareAsync(coordinator, service, "number"))).Code);
    }

    [TestMethod]
    public async Task DeclaringAndRemovingEachCompensateAndRemovingLiftsTheRule()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a", "W-001");
        var declared = await DeclareAsync(coordinator, service, "code");

        await service.CompensateRevisionAsync(declared.RevisionId, "undo-declare");
        Assert.IsFalse(Field(await service.GetSnapshotAsync(), "code").Unique);
        await CreateAsync(service, "b", "W-001");
        Assert.AreEqual("field-values-not-unique", (await Refused(() => DeclareAsync(coordinator, service, "code"))).Code);
        await service.SetFieldAsync(new(Entity, "b", "code", 1, "W-002", Context("fix")));

        await DeclareAsync(coordinator, service, "code");
        var removed = await DeclareAsync(coordinator, service, "code", unique: false);
        await CreateAsync(service, "c", "W-001");
        Assert.AreEqual("field-values-not-unique", (await Refused(() => service.CompensateRevisionAsync(removed.RevisionId, "undo-remove"))).Code,
            "Putting the rule back over a duplicate is refused like declaring it.");
    }

    [TestMethod]
    public async Task AFieldDeclaredInTheSameMutationAsItIsAddedIsEnforced()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "late", "test", "A late unique field",
        [
            new AddFieldOperation("f-late", Entity, "late", "Late", "late", NendoStorageKind.Text, false),
            new SetFieldUniqueOperation("u-late", Entity, "late", true, revision),
        ]));
        await service.CreateRecordAsync(new(Entity, "a", new Dictionary<string, object?> { ["title"] = "A", ["late"] = "x" }, Context("a")));
        Assert.AreEqual("value-not-unique", (await Refused(() =>
            service.CreateRecordAsync(new(Entity, "b", new Dictionary<string, object?> { ["title"] = "B", ["late"] = "X" }, Context("b"))))).Code);
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "Items", [
            new CreateEntityOperation("e", Entity, "Items", "items"),
            new AddFieldOperation("f-title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-code", Entity, "code", "Code", "code", NendoStorageKind.Text, false),
            new AddFieldOperation("f-number", Entity, "number", "Number", "number", NendoStorageKind.Integer, false),
            new AddFieldOperation("f-notes", Entity, "notes", "Notes", "notes", NendoStorageKind.Text, false, "longText"),
            new AddFieldOperation("f-stage", Entity, "stage", "Stage", "stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
            new AddFieldOperation("f-due", Entity, "due", "Due", "due", NendoStorageKind.Date, false, "date"),
        ]));

    private static async Task<NendoApplyResult> DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string field,
        bool unique = true)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"unique-{Guid.NewGuid():N}", "test", "Unique",
            [new SetFieldUniqueOperation($"u-{Guid.NewGuid():N}", Entity, field, unique, revision)]));
    }

    private static Task<NendoApplyResult> CreateAsync(NendoApplicationService service, string id, string? code) =>
        service.CreateRecordAsync(new(Entity, id, new Dictionary<string, object?> { ["title"] = id.ToUpperInvariant(), ["code"] = code },
            Context($"create-{id}-{Guid.NewGuid():N}")));

    private static NendoFieldSnapshot Field(NendoSessionSnapshot snapshot, string fieldId) =>
        snapshot.Entities.Single().Fields.Single(field => field.FieldId == fieldId);

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Entity, 1) { RecordId = id })).Items.Single();

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
