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
    private const string Units = "units";

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

    [TestMethod]
    public async Task ATreeReadIsDepthFirstInSiblingOrderWithDepthsAndChildCounts()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "r2", null, 2048);
        await CreateAsync(service, "r1", null, 1024);
        await CreateAsync(service, "b", "r1", 2048);
        await CreateAsync(service, "a", "r1", 1024);
        await CreateAsync(service, "loose", "r1");
        await CreateAsync(service, "a1", "a", 1);
        await CreateAsync(service, "neg", "r2", -5);
        await DeclareAsync(coordinator, service, order: true);

        var all = await service.TreeRecordsAsync(new(Entity, null, NendoHierarchyLimits.MaximumDepth, 100));
        // Ordered siblings by their order (a negative one first), unordered last, subtrees before the next sibling.
        CollectionAssert.AreEqual(new[] { "r1", "a", "a1", "b", "loose", "r2", "neg" }, all.Items.Select(node => node.Record.RecordId).ToArray());
        CollectionAssert.AreEqual(new[] { 1, 2, 3, 2, 2, 1, 2 }, all.Items.Select(node => node.Depth).ToArray());
        CollectionAssert.AreEqual(new[] { 3, 1, 0, 0, 0, 1, 0 }, all.Items.Select(node => node.ChildCount).ToArray());
        Assert.AreEqual("r1", all.Items.Single(node => node.Record.RecordId == "a").ParentRecordId);
        Assert.IsNull(all.Items[0].ParentRecordId);

        // One level from the top, and one level under a root: the root itself is not in its window.
        CollectionAssert.AreEqual(new[] { "r1", "r2" }, (await service.TreeRecordsAsync(new(Entity))).Items.Select(node => node.Record.RecordId).ToArray());
        var under = await service.TreeRecordsAsync(new(Entity, "r1", 1));
        CollectionAssert.AreEqual(new[] { "a", "b", "loose" }, under.Items.Select(node => node.Record.RecordId).ToArray());
        Assert.IsTrue(under.Items.All(node => node.Depth == 1));
    }

    [TestMethod]
    public async Task ATreeReadPagesByPositionAndRefusesAStaleCursor()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        for (var i = 0; i < 5; i++) await CreateAsync(service, $"c{i}", "root", (i + 1) * 1024L);
        await DeclareAsync(coordinator, service, order: true);

        var first = await service.TreeRecordsAsync(new(Entity, null, 2, 3));
        CollectionAssert.AreEqual(new[] { "root", "c0", "c1" }, first.Items.Select(node => node.Record.RecordId).ToArray());
        var second = await service.TreeRecordsAsync(new(Entity, null, 2, 3, first.NextCursor));
        CollectionAssert.AreEqual(new[] { "c2", "c3", "c4" }, second.Items.Select(node => node.Record.RecordId).ToArray());
        Assert.IsNull(second.NextCursor);

        await service.SetFieldAsync(new(Entity, "c4", "title", 1, "Changed", Context("change")));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.TreeRecordsAsync(new(Entity, null, 2, 3, first.NextCursor)));
    }

    [TestMethod]
    public async Task ATreeReadNeedsADeclarationAnExistingRootAndABound()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        Assert.AreEqual("hierarchy-not-declared", (await Refused(() => service.TreeRecordsAsync(new(Entity)))).Code);
        await DeclareAsync(coordinator, service);
        Assert.AreEqual("record-not-found", (await Refused(() => service.TreeRecordsAsync(new(Entity, "missing")))).Code);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.TreeRecordsAsync(new(Entity, null, NendoHierarchyLimits.MaximumDepth + 1)));
    }

    [TestMethod]
    public async Task DescendantOfFiltersThePageTheCountAndTheAggregates()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        await CreateAsync(service, "a", "root", 10);
        await CreateAsync(service, "a1", "a", 20);
        await CreateAsync(service, "a2", "a", 30);
        await CreateAsync(service, "b", "root", 40);
        await CreateAsync(service, "other", null, 50);
        await DeclareAsync(coordinator, service, order: true);
        var under = new NendoRecordFilter("parent", "descendantOf", System.Text.Json.JsonSerializer.SerializeToElement("a"));

        var page = await service.QueryRecordsAsync(new(Entity, 50) { Filters = [under] });
        CollectionAssert.AreEquivalent(new[] { "a1", "a2" }, page.Items.Select(record => record.RecordId).ToArray());
        var everything = new NendoRecordFilter("parent", "descendantOf", System.Text.Json.JsonSerializer.SerializeToElement("root"));
        Assert.AreEqual(4L, (await service.CountRecordsAsync(new(Entity) { Filters = [everything] })).Count);
        var sum = await service.AggregateRecordsAsync(new(Entity, "sum", "ord") { Filters = [everything] });
        Assert.AreEqual("100", sum.Value!.Value.ValueKind == System.Text.Json.JsonValueKind.Number ? sum.Value.Value.GetRawText() : sum.Value.Value.GetProperty("$nendoNumber").GetString());

        // Only the declared parent field reads a hierarchy.
        await coordinator.ApplyAsync(new("test", "other-ref", "test", "Another self-reference", [
            new AddFieldOperation($"f-{Guid.NewGuid():N}", Entity, "twin", "Twin", "twin_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation($"b-{Guid.NewGuid():N}", Entity, "twin", Entity, "title", (await service.GetSnapshotAsync()).Manifest.DefinitionRevision),
        ]));
        var wrong = new NendoRecordFilter("twin", "descendantOf", System.Text.Json.JsonSerializer.SerializeToElement("a"));
        Assert.AreEqual("hierarchy-not-declared", (await Refused(() => service.QueryRecordsAsync(new(Entity, 50) { Filters = [wrong] }))).Code);
    }

    [TestMethod]
    public async Task SubtreeCalculationsCountAndTotalEverythingUnderARecord()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        // Members a calculation counts or totals are required fields, as for a related aggregate.
        await coordinator.ApplyAsync(new("test", "units", "test", "Units and links into them", [
            new CreateEntityOperation("u", Units, "Units", "units"),
            new AddFieldOperation("u-title", Units, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("u-parent", Units, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("u-cost", Units, "cost", "Cost", "cost", NendoStorageKind.Integer, true),
            new AddFieldOperation("u-flag", Units, "flag", "Flag", "flag", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("u-bind", Units, "parent", Units, "title", 0),
            new CreateEntityOperation("e-link", "links", "Links", "links"),
            new AddFieldOperation("l-name", "links", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("l-node", "links", "node", "Node", "node_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("l-hours", "links", "hours", "Hours", "hours", NendoStorageKind.Integer, true),
            new ConfigureReferenceOperation("l-bind", "links", "node", Units, "title", 0),
        ]));
        foreach (var (id, parent, cost, flag) in new[] { ("root", (string?)null, 1L, false), ("a", "root", 10L, true), ("a1", "a", 20L, true), ("a2", "a", 30L, false), ("b", "root", 40L, true) })
            await service.CreateRecordAsync(new(Units, id, new Dictionary<string, object?> { ["title"] = id, ["parent"] = parent, ["cost"] = cost, ["flag"] = flag },
                Context($"unit-{id}"), parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 }));
        foreach (var (link, node, hours) in new[] { ("l1", "root", 1L), ("l2", "a1", 2L), ("l3", "b", 4L), ("l4", "a2", 8L) })
            await service.CreateRecordAsync(new("links", link, new Dictionary<string, object?> { ["name"] = link, ["node"] = node, ["hours"] = hours },
                Context(link), new Dictionary<string, long> { ["node"] = 1 }));
        var declared = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "declare-units", "test", "Declare",
            [new DeclareHierarchyOperation($"d-{Guid.NewGuid():N}", Units, "parent", null, declared)]));

        NendoCalculationDefinition Calculation(string field, NendoBehaviourBinding binding) =>
            new($"calc.{field}", Units, field, field, NendoBehaviourScalar.Integer, false, "v", [binding]);
        var calculations = new[]
        {
            Calculation("inside", NendoBehaviourBinding.Subtree("v", Units, NendoAggregateFunction.Count)),
            Calculation("withSelf", NendoBehaviourBinding.Subtree("v", Units, NendoAggregateFunction.Count, includeSelf: true)),
            Calculation("flagged", NendoBehaviourBinding.Subtree("v", Units, NendoAggregateFunction.FilteredCount, "flag")),
            Calculation("orderSum", NendoBehaviourBinding.Subtree("v", Units, NendoAggregateFunction.Sum, "cost")),
            Calculation("orderSumSelf", NendoBehaviourBinding.Subtree("v", Units, NendoAggregateFunction.Sum, "cost", includeSelf: true)),
            Calculation("linkCount", NendoBehaviourBinding.RelatedCount("v", Units, "links", "node", acrossSubtree: true)),
            Calculation("linkHours", NendoBehaviourBinding.RelatedSum("v", Units, "links", "node", "hours", NendoBehaviourScalar.Integer, acrossSubtree: true)),
            Calculation("directLinks", NendoBehaviourBinding.RelatedCount("v", Units, "links", "node")),
        };
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "calcs", "test", "Subtree calculations",
            calculations.Select((calculation, index) => (NendoOperation)new SetBehaviourDefinitionOperation($"c{index}", calculation, revision)).ToArray()));

        long Value(NendoRecordSnapshot record, string field)
        {
            var result = record.Calculations.Single(calculation => calculation.FieldId == field);
            Assert.AreEqual(NendoCalculationState.Value, result.State, $"{field}: {result.ErrorCode} {result.ErrorMessage}");
            return result.Value.GetInt64();
        }
        var root = await UnitAsync(service, "root");
        Assert.AreEqual(4L, Value(root, "inside"));
        Assert.AreEqual(5L, Value(root, "withSelf"));
        Assert.AreEqual(3L, Value(root, "flagged"));
        Assert.AreEqual(100L, Value(root, "orderSum"));
        Assert.AreEqual(101L, Value(root, "orderSumSelf"));
        Assert.AreEqual(4L, Value(root, "linkCount"));
        Assert.AreEqual(15L, Value(root, "linkHours"));
        Assert.AreEqual(1L, Value(root, "directLinks"));
        var a = await UnitAsync(service, "a");
        Assert.AreEqual(2L, Value(a, "inside"));
        Assert.AreEqual(10L, Value(a, "linkHours"));
        var leaf = await UnitAsync(service, "b");
        Assert.AreEqual(0L, Value(leaf, "inside"));
        Assert.AreEqual(40L, Value(leaf, "orderSumSelf"));

        // The hierarchy cannot go while a calculation reads it.
        var now = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreEqual("hierarchy-field-in-use", (await Refused(() => coordinator.ApplyAsync(new("test", "remove", "test", "Remove",
            [new RemoveHierarchyOperation($"x-{Guid.NewGuid():N}", Units, now)])))).Code);
    }

    [TestMethod]
    public async Task ASubtreeCalculationNeedsADeclaredHierarchy()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(new("test", "calc", "test", "Subtree", [
            new SetBehaviourDefinitionOperation("c", new NendoCalculationDefinition("calc.inside", Entity, "inside", "Inside",
                NendoBehaviourScalar.Integer, false, "v", [NendoBehaviourBinding.Subtree("v", Entity, NendoAggregateFunction.Count)]), revision)])));
    }

    [TestMethod]
    public async Task PastTheDescendantBoundEveryReadRefusesRatherThanAnswerInPart()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "root");
        var children = Enumerable.Range(0, NendoHierarchyLimits.MaximumDescendants + 1).Select(index => (NendoOperation)new CreateRecordOperation(
            $"wide-{index}", Entity, $"w{index:D5}", new Dictionary<string, object?> { ["title"] = $"W{index}", ["parent"] = "root" },
            new Dictionary<string, long> { ["parent"] = 1 })).ToArray();
        await coordinator.ApplyAsync(new("test", "wide", "test", "One more child than a subtree read folds", children));
        await DeclareAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "calc", "test", "Count", [
            new SetBehaviourDefinitionOperation("c", new NendoCalculationDefinition("calc.inside", Entity, "inside", "Inside",
                NendoBehaviourScalar.Integer, false, "v", [NendoBehaviourBinding.Subtree("v", Entity, NendoAggregateFunction.Count)]), revision)]));

        var count = (await RecordAsync(service, "root")).Calculations.Single();
        Assert.AreEqual(NendoCalculationState.Error, count.State);
        StringAssert.Contains(count.ErrorMessage, $"More than {NendoHierarchyLimits.MaximumDescendants} records");
        Assert.AreEqual("hierarchy-too-wide", (await Refused(() => service.TreeRecordsAsync(new(Entity, "root")))).Code);
        var under = new NendoRecordFilter("parent", "descendantOf", System.Text.Json.JsonSerializer.SerializeToElement("root"));
        Assert.AreEqual("hierarchy-too-wide", (await Refused(() => service.CountRecordsAsync(new(Entity) { Filters = [under] }))).Code);
    }

    [TestMethod]
    public void TheWireFormatCarriesSubtreeBindingsAndKeepsOlderBindingsByteForByte()
    {
        static string Body(string binding) => $$"""
            {"entityId":"units","fieldId":"total","displayName":"Total","resultType":"Integer","resultNullable":false,
             "expression":"v","callAliases":[],"bindings":[{{binding}}]}
            """;
        static NendoBehaviourBinding Read(string binding) => ((NendoCalculationDefinition)NendoBehaviourCodec.Read(
            "units.total", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, Body(binding), NendoBehaviourBodySource.Authored)).Bindings.Single();

        var subtree = Read("""{"bindingId":"v","kind":"SubtreeAggregate","aggregate":"Sum","entityId":"units","valueFieldId":"cost","resultType":"Integer","includeSelf":true}""");
        Assert.AreEqual(NendoBindingKind.SubtreeAggregate, subtree.Kind);
        Assert.IsTrue(subtree.IncludeSelf);
        Assert.AreEqual("cost", subtree.ValueFieldId);
        var across = Read("""{"bindingId":"v","kind":"RelatedAggregate","aggregate":"Count","entityId":"units","relatedEntityId":"links","relatedReferenceFieldId":"node","acrossSubtree":true}""");
        Assert.IsTrue(across.AcrossSubtree);

        // A key that belongs to the other shape is refused and the right keys are named.
        var wrong = Assert.ThrowsExactly<NendoValidationException>(() => Read(
            """{"bindingId":"v","kind":"RelatedAggregate","aggregate":"Count","entityId":"units","relatedEntityId":"links","relatedReferenceFieldId":"node","includeSelf":true}""")).Message;
        StringAssert.Contains(wrong, "does not define: includeSelf");

        // A binding written before this stage keeps its canonical bytes: the new keys appear only when true.
        var plain = new NendoCalculationDefinition("units.total", "units", "total", "Total", NendoBehaviourScalar.Integer, false, "v",
            [NendoBehaviourBinding.RelatedCount("v", "units", "links", "node")]).CanonicalBody();
        Assert.DoesNotContain("acrossSubtree", plain);
        Assert.DoesNotContain("includeSelf", plain);
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

    private static async Task<NendoRecordSnapshot> UnitAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Units, 1) { RecordId = id })).Items.Single();

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Entity, 1) { RecordId = id })).Items.Single();

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);
}
