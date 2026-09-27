namespace Nendo.Engine.Tests;

/// <summary>
/// A declared hierarchy, ADR-0019 stage 2: the declaration and its rung, the rule every parent
/// write obeys, the refusal to declare over data that is not a tree, and the move request that
/// expands into ordinary set-field operations.
/// </summary>
[TestClass]
public sealed class HierarchyTests
{
    private const string Entity = "nodes";

    [TestMethod]
    public async Task DeclaringTakesTheHierarchyRungAndTheReopenedFileStillKnowsIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Hierarchy);

        await DeclareAsync(coordinator, service, order: true);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoHierarchy("parent", "ord"), after.Entities.Single().Hierarchy);
        Assert.AreEqual(NendoFormat.HierarchyMinimumHostVersion, after.Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-v1",
            inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));
        coordinator = await workspace.OpenAsync();
        Assert.AreEqual(new NendoHierarchy("parent", "ord"), (await new NendoApplicationService(coordinator).GetSnapshotAsync()).Entities.Single().Hierarchy);
    }

    [TestMethod]
    public async Task AFileThatNeverDeclaresOneKeepsItsLayoutAndHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await SchemaAsync(coordinator);
        var snapshot = await new NendoApplicationService(coordinator).GetSnapshotAsync();
        Assert.IsTrue(Version.Parse(snapshot.Manifest.MinimumHostVersion) < Version.Parse(NendoFormat.HierarchyMinimumHostVersion));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.IsFalse((await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout!.Contains("-hierarchy-", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task OnlyAnOptionalSelfReferenceCanBeTheParent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "other", "test", "Another type and fields", [
            new CreateEntityOperation("e-other", "others", "Others", "others"),
            new AddFieldOperation("o-name", "others", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("n-owner", Entity, "owner", "Owner", "owner_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-owner", Entity, "owner", "others", "name", 1),
        ]));

        Assert.AreEqual("hierarchy-parent-invalid", (await Refused(() => DeclareAsync(coordinator, service, parent: "owner"))).Code);
        Assert.AreEqual("hierarchy-parent-invalid", (await Refused(() => DeclareAsync(coordinator, service, parent: "title"))).Code);
        Assert.AreEqual("hierarchy-order-invalid", (await Refused(() => DeclareAsync(coordinator, service, orderField: "title"))).Code);
        await DeclareAsync(coordinator, service);
        Assert.AreEqual("hierarchy-already-declared", (await Refused(() => DeclareAsync(coordinator, service))).Code);
    }

    [TestMethod]
    public async Task DeclaringOverLoopsIsRefusedNamingEveryLoopAndChangesNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a");
        await CreateAsync(service, "b", "a");
        await CreateAsync(service, "c", "b");
        await CreateAsync(service, "s");
        // Before the declaration nothing stops a loop: a under c, and s under itself.
        await service.SetFieldAsync(new(Entity, "a", "parent", 1, "c", Context("loop"), 1));
        await service.SetFieldAsync(new(Entity, "s", "parent", 1, "s", Context("self"), 1));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        var refused = await Refused(() => DeclareAsync(coordinator, service));
        Assert.AreEqual("hierarchy-cycle-present", refused.Code);
        StringAssert.Contains(refused.Message, "a → c → b → a");
        StringAssert.Contains(refused.Message, "s → s");
        Assert.AreEqual(revision, (await service.GetSnapshotAsync()).Manifest.DefinitionRevision);
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Hierarchy);
    }

    [TestMethod]
    public async Task DeclaringOverATooDeepBranchIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await ChainAsync(service, NendoHierarchyLimits.MaximumDepth + 1);
        var refused = await Refused(() => DeclareAsync(coordinator, service));
        Assert.AreEqual("hierarchy-too-deep", refused.Code);
        StringAssert.Contains(refused.Message, $"n{NendoHierarchyLimits.MaximumDepth + 1:D2}");
    }

    [TestMethod]
    public async Task EveryParentWriteRefusesALoopAndNamesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a");
        await CreateAsync(service, "b", "a");
        await CreateAsync(service, "c", "b");
        await DeclareAsync(coordinator, service);

        // A single field write, a form save of several fields, and a raw mutation: all one rule.
        var single = await Refused(() => service.SetFieldAsync(new(Entity, "a", "parent", 1, "c", Context("single"), 1)));
        Assert.AreEqual("hierarchy-cycle", single.Code);
        StringAssert.Contains(single.Message, "a → c → b → a");
        var form = await Refused(() => service.SetFieldsAsync(new(Entity, "a", 1,
            new Dictionary<string, object?> { ["parent"] = "b", ["title"] = "A" }, Context("form"),
            new Dictionary<string, long> { ["parent"] = 1 })));
        Assert.AreEqual("hierarchy-cycle", form.Code);
        var self = await Refused(() => coordinator.ApplyAsync(new("test", "raw", "test", "Self", [
            new SetFieldOperation("s", Entity, "b", "parent", 1, "b", 1)])));
        Assert.AreEqual("hierarchy-cycle", self.Code);

        // A legal move still goes through.
        await service.SetFieldAsync(new(Entity, "c", "parent", 1, "a", Context("legal"), 1));
    }

    [TestMethod]
    public async Task NoWriteMayGoDeeperThanTheBound()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await ChainAsync(service, NendoHierarchyLimits.MaximumDepth);
        await CreateAsync(service, "x");
        await CreateAsync(service, "y", "x");
        await DeclareAsync(coordinator, service);
        var deepest = $"n{NendoHierarchyLimits.MaximumDepth:D2}";

        // A new record under the deepest one would sit one level too deep.
        var created = await Refused(() => CreateAsync(service, "z", deepest));
        Assert.AreEqual("hierarchy-too-deep", created.Code);
        // Moving x, which has a child, under a record at depth 31 would put y at depth 33.
        var moved = await Refused(() => service.SetFieldAsync(new(Entity, "x", "parent", 1,
            $"n{NendoHierarchyLimits.MaximumDepth - 1:D2}", Context("deep"), 1)));
        Assert.AreEqual("hierarchy-too-deep", moved.Code);
    }

    [TestMethod]
    public async Task TheParentCannotBeRetiredOrRequiredWhileDeclaredAndRemovingLiftsTheRule()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a");
        await CreateAsync(service, "b", "a");
        await DeclareAsync(coordinator, service, order: true);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

        Assert.AreEqual("hierarchy-field-in-use", (await Refused(() => coordinator.ApplyAsync(new("test", "retire", "test", "Retire",
            [new SetRetiredOperation("r", Entity, "parent", true, revision)])))).Code);
        Assert.AreEqual("hierarchy-field-in-use", (await Refused(() => coordinator.ApplyAsync(new("test", "retire-order", "test", "Retire",
            [new SetRetiredOperation("r", Entity, "ord", true, revision)])))).Code);
        Assert.AreEqual("hierarchy-parent-required", (await Refused(() => coordinator.ApplyAsync(new("test", "require", "test", "Require",
            [new SetFieldRequiredOperation("q", Entity, "parent", true, revision)])))).Code);

        await coordinator.ApplyAsync(new("test", "remove", "test", "Remove", [new RemoveHierarchyOperation($"x-{Guid.NewGuid():N}", Entity, revision)]));
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Hierarchy);
        // Only the rule went: the values stay, and a loop is ordinary data again.
        await service.SetFieldAsync(new(Entity, "a", "parent", 1, "b", Context("free"), 1));
    }

    [TestMethod]
    public async Task DeclareAndRemoveEachCompensate()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var declared = await DeclareAsync(coordinator, service, order: true);

        await service.CompensateRevisionAsync(declared.RevisionId, "undo-declare");
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Hierarchy);

        var redeclared = await DeclareAsync(coordinator, service, order: true);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove", [new RemoveHierarchyOperation($"x-{Guid.NewGuid():N}", Entity, revision)]));
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        Assert.AreEqual(new NendoHierarchy("parent", "ord"), (await service.GetSnapshotAsync()).Entities.Single().Hierarchy);
        Assert.AreNotEqual(declared.RevisionId, redeclared.RevisionId);
    }

    [TestMethod]
    public async Task AMoveWritesTheParentAndTakesTheMiddleOfTheGap()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        await CreateAsync(service, "a", "root", 1024);
        await CreateAsync(service, "b", "root", 2048);
        await CreateAsync(service, "loose");
        await DeclareAsync(coordinator, service, order: true);

        var moved = await service.MoveRecordAsync(new(Entity, "loose", 1, "root", 1, "b", Context("between")));
        CollectionAssert.AreEqual(new[] { "loose" }, moved.TouchedRecordIds.ToArray());
        Assert.AreEqual(3L, moved.RecordVersion);
        var loose = await RecordAsync(service, "loose");
        Assert.AreEqual("root", loose.Values["parent"].GetString());
        Assert.AreEqual(1536L, loose.Values["ord"].GetInt64());

        // Last among its siblings, then back to the top level.
        await service.MoveRecordAsync(new(Entity, "loose", 3, "root", 1, null, Context("last")));
        Assert.AreEqual(3072L, (await RecordAsync(service, "loose")).Values["ord"].GetInt64());
        Assert.AreEqual("move-unchanged", (await Refused(() => service.MoveRecordAsync(new(Entity, "loose", 4, "root", 1, null, Context("again"))))).Code);
    }

    [TestMethod]
    public async Task AMoveWithNoGapRenumbersTheSiblingsInOneRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        await CreateAsync(service, "a", "root", 1);
        await CreateAsync(service, "b", "root", 2);
        await CreateAsync(service, "c", "root", 3);
        await DeclareAsync(coordinator, service, order: true);
        var history = (await service.GetHistoryAsync()).Count;

        var moved = await service.MoveRecordAsync(new(Entity, "c", 1, "root", 1, "b", Context("squeeze")));
        Assert.HasCount(history + 1, await service.GetHistoryAsync());
        CollectionAssert.AreEquivalent(new[] { "a", "b", "c" }, moved.TouchedRecordIds.ToArray());
        var order = new[] { "a", "c", "b" };
        for (var index = 0; index < order.Length; index++)
            Assert.AreEqual((index + 1) * NendoHierarchyLimits.OrderGap, (await RecordAsync(service, order[index])).Values["ord"].GetInt64(), order[index]);
    }

    [TestMethod]
    public async Task AMoveUnderItsOwnDescendantIsRefusedByTheEngineRule()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a");
        await CreateAsync(service, "b", "a");
        await DeclareAsync(coordinator, service);
        Assert.AreEqual("hierarchy-cycle", (await Refused(() => service.MoveRecordAsync(new(Entity, "a", 1, "b", 1, null, Context("down"))))).Code);
        Assert.AreEqual("hierarchy-order-not-declared",
            (await Refused(() => service.MoveRecordAsync(new(Entity, "b", 1, null, null, "a", Context("before"))))).Code);
        Assert.AreEqual("target-version-required",
            (await Refused(() => service.MoveRecordAsync(new(Entity, "b", 1, "a", null, null, Context("unversioned"))))).Code);
    }

    // ------------------------------------------------------------------------------------------

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "A tree", [
            new CreateEntityOperation("e", Entity, "Nodes", "nodes"),
            new AddFieldOperation("f-title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-parent", Entity, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("f-ord", Entity, "ord", "Order", "ord", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("bind", Entity, "parent", Entity, "title", 0),
        ]));

    private static async Task<NendoApplyResult> DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service,
        string parent = "parent", bool order = false, string? orderField = null)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"declare-{Guid.NewGuid():N}", "test", "Declare",
            [new DeclareHierarchyOperation($"d-{Guid.NewGuid():N}", Entity, parent, orderField ?? (order ? "ord" : null), revision)]));
    }

    private static Task<NendoApplyResult> CreateAsync(NendoApplicationService service, string id, string? parent = null, long? order = null) =>
        service.CreateRecordAsync(new(Entity, id, new Dictionary<string, object?> { ["title"] = id.ToUpperInvariant(), ["parent"] = parent, ["ord"] = order },
            Context($"create-{id}"), parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 }));

    private static async Task ChainAsync(NendoApplicationService service, int length)
    {
        string? parent = null;
        for (var depth = 1; depth <= length; depth++)
        {
            var id = $"n{depth:D2}";
            await CreateAsync(service, id, parent);
            parent = id;
        }
    }

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Entity, 1) { RecordId = id })).Items.Single();

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
