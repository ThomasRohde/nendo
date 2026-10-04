namespace Nendo.Engine.Tests;

/// <summary>Hierarchy move outcomes at integer bounds, on durable retries, and after action writes.</summary>
[TestClass]
public sealed class HierarchyMoveReviewTests
{
    private const string Entity = "nodes";

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task APlacementBeyondTheIntegerBoundsRenumbersIntoTheRequestedTreePosition(bool first)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "anchor", first ? long.MinValue : long.MaxValue);
        await CreateAsync(service, "moving", 0);
        await DeclareAsync(coordinator, service);
        var before = await service.GetSnapshotAsync();

        var moved = await service.MoveRecordAsync(new(Entity, "moving", 1, null, null, first ? "anchor" : null, Context("extreme")));

        var tree = await service.TreeRecordsAsync(new(Entity));
        CollectionAssert.AreEqual(first ? new[] { "moving", "anchor" } : new[] { "anchor", "moving" },
            tree.Items.Select(node => node.Record.RecordId).ToArray(), "The move placed the record on the wrong side of its sibling.");
        CollectionAssert.AreEquivalent(new[] { "anchor", "moving" }, moved.TouchedRecordIds.ToArray());
        for (var index = 0; index < tree.Items.Count; index++)
            Assert.AreEqual((index + 1) * NendoHierarchyLimits.OrderGap, tree.Items[index].Record.Values["ord"].GetInt64());
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, moved.Applied.ChangeSequence, "Renumbering must remain one committed move.");
    }

    [TestMethod]
    [DataRow(long.MinValue, long.MaxValue, -1L)]
    [DataRow(-1L, long.MaxValue, 4611686018427387903L)]
    public async Task AWideMixedSignGapPlacesBetweenTheNeighboursWithoutRenumbering(long lower, long upper, long middle)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(service, "lower", lower);
        await CreateAsync(service, "upper", upper);
        await CreateAsync(service, "moving", upper);
        await DeclareAsync(coordinator, service);

        var moved = await service.MoveRecordAsync(new(Entity, "moving", 1, null, null, "upper", Context("wide-gap")));

        CollectionAssert.AreEqual(new[] { "lower", "moving", "upper" },
            (await service.TreeRecordsAsync(new(Entity))).Items.Select(node => node.Record.RecordId).ToArray());
        Assert.AreEqual(middle, (await RecordAsync(service, "moving")).Values["ord"].GetInt64(),
            "A representable midpoint was lost to ordering overflow.");
        CollectionAssert.AreEqual(new[] { "moving" }, moved.TouchedRecordIds.ToArray(),
            "A wide integer gap needlessly renumbered the siblings.");
        Assert.AreEqual(lower, (await RecordAsync(service, "lower")).Values["ord"].GetInt64());
        Assert.AreEqual(upper, (await RecordAsync(service, "upper")).Values["ord"].GetInt64());
    }

    [TestMethod]
    public async Task AnExactMoveRetryReplaysBeforeAndAfterSiblingReorderingAndReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await FixtureAsync(coordinator, service);
        var request = new NendoMoveRecordRequest(Entity, "moving", 1, null, null, "a", Context("move-first"));
        var original = await service.MoveRecordAsync(request);

        AssertReplay(original, await service.MoveRecordAsync(request));
        await service.MoveRecordAsync(new(Entity, "b", 1, null, null, "moving", Context("reorder-sibling")));
        var afterReorder = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;
        AssertReplay(original, await service.MoveRecordAsync(request));
        Assert.AreEqual(afterReorder, (await service.GetSnapshotAsync()).Manifest.ChangeSequence,
            "An exact move replay committed a new revision after sibling reordering.");

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        service = new(await workspace.OpenAsync());
        AssertReplay(original, await service.MoveRecordAsync(request));
        CollectionAssert.AreEqual(new[] { "b", "moving", "a" },
            (await service.TreeRecordsAsync(new(Entity))).Items.Select(node => node.Record.RecordId).ToArray(),
            "A replay moved the record again using the newer sibling geometry.");
    }

    [TestMethod]
    [DataRow("entity")]
    [DataRow("record")]
    [DataRow("version")]
    [DataRow("parent")]
    [DataRow("parent-version")]
    [DataRow("before")]
    [DataRow("origin")]
    public async Task AMoveKeyCannotAcknowledgeDifferentRequestInputs(string changedInput)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await FixtureAsync(coordinator, service);
        var request = new NendoMoveRecordRequest(Entity, "moving", 1, null, null, "a", Context("move-first"));
        var original = await service.MoveRecordAsync(request);
        var different = changedInput switch
        {
            "entity" => request with { EntityId = "different" },
            "record" => request with { RecordId = "b" },
            "version" => request with { ExpectedRecordVersion = 2 },
            "parent" => request with { ParentRecordId = "a", ExpectedParentVersion = 1 },
            "parent-version" => request with { ExpectedParentVersion = 2 },
            "before" => request with { BeforeRecordId = "b" },
            "origin" => request with { Context = request.Context with { Origin = "different" } },
            _ => throw new AssertFailedException("Unknown changed move input."),
        };

        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => service.MoveRecordAsync(different));
        Assert.AreEqual(original.Applied.ChangeSequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    [TestMethod]
    public async Task ARenumberedMoveRetryRebuildsTouchedRecordsAcrossHistoryPages()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var writes = Enumerable.Range(0, 102).Select(index => new NendoRecordWrite(NendoRecordWriteKind.Create,
            Entity, $"a{index:D3}", new Dictionary<string, object?> { ["title"] = $"A{index}", ["ord"] = (long)index })).ToList();
        writes.Add(new(NendoRecordWriteKind.Create, Entity, "moving", new Dictionary<string, object?> { ["title"] = "Moving", ["ord"] = 102L }));
        await service.ApplyRecordWritesAsync(new(writes, Context("create-many")));
        await DeclareAsync(coordinator, service);
        var request = new NendoMoveRecordRequest(Entity, "moving", 1, null, null, "a001", Context("renumber-many"));
        var original = await service.MoveRecordAsync(request);

        Assert.HasCount(103, original.TouchedRecordIds);
        AssertReplay(original, await service.MoveRecordAsync(request));
        Assert.AreEqual(original.Applied.ChangeSequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    [TestMethod]
    public async Task AMoveReturnsTheActionWrittenVersionForTheNextWriteAndReplaysItsOriginalVersion()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await FixtureAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Stamp moved records", [
            new SetBehaviourDefinitionOperation("action", new NendoActionDefinition("stamp", "Stamp a move",
                [NendoActionStep.SetField("stamp-title", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("title", "'Moved'", [], []))]), revision),
            new SetBehaviourDefinitionOperation("trigger", new NendoTriggerDefinition("on-order", Entity, "Stamp a move",
                NendoTriggerEvents.Updated, "stamp", ["ord"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var request = new NendoMoveRecordRequest(Entity, "moving", 1, null, null, "a", Context("move-with-action"));

        var moved = await service.MoveRecordAsync(request);

        var actual = await RecordAsync(service, "moving");
        Assert.AreEqual(3L, actual.RecordVersion);
        Assert.AreEqual(actual.RecordVersion, moved.RecordVersion, "The move returned the version before its action wrote back.");
        Assert.AreEqual("Moved", actual.Values["title"].GetString());
        await service.SetFieldAsync(new(Entity, "moving", "title", moved.RecordVersion!.Value, "Follow-up", Context("follow-up")));
        Assert.AreEqual(4L, (await RecordAsync(service, "moving")).RecordVersion);
        AssertReplay(moved, await service.MoveRecordAsync(request));
    }

    [TestMethod]
    public async Task AMoveWhoseActionDeletesTheRecordReportsNoVersionAndReplaysThat()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await FixtureAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Delete moved records", [
            new SetBehaviourDefinitionOperation("action", new NendoActionDefinition("drop", "Drop a moved record",
                [NendoActionStep.DeleteRecord("drop-step", NendoActionTarget.EventRecord)]), revision),
            new SetBehaviourDefinitionOperation("trigger", new NendoTriggerDefinition("on-order", Entity, "Drop a moved record",
                NendoTriggerEvents.Updated, "drop", ["ord"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var request = new NendoMoveRecordRequest(Entity, "moving", 1, null, null, "a", Context("move-deleted-by-action"));

        var moved = await service.MoveRecordAsync(request);

        Assert.IsEmpty((await service.QueryRecordsAsync(new(Entity) { RecordId = "moving" })).Items);
        Assert.IsNull(moved.RecordVersion, "A move whose action deleted the record returned a live version.");
        AssertReplay(moved, await service.MoveRecordAsync(request));
    }

    private static void AssertReplay(NendoMoveRecordResult original, NendoMoveRecordResult replay)
    {
        Assert.IsTrue(replay.Applied.IsIdempotentReplay, "An exact move retry did not return its committed receipt.");
        Assert.AreEqual(original.Applied.RevisionId, replay.Applied.RevisionId);
        Assert.AreEqual(original.Applied.OperationDigest, replay.Applied.OperationDigest);
        Assert.AreEqual(original.Applied.DefinitionRevision, replay.Applied.DefinitionRevision);
        Assert.AreEqual(original.Applied.DataRevision, replay.Applied.DataRevision);
        Assert.AreEqual(original.Applied.ChangeSequence, replay.Applied.ChangeSequence);
        Assert.AreEqual(original.RecordVersion, replay.RecordVersion);
        CollectionAssert.AreEqual(original.TouchedRecordIds.ToArray(), replay.TouchedRecordIds.ToArray());
    }

    private static async Task FixtureAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await SchemaAsync(coordinator);
        await CreateAsync(service, "a", 1024);
        await CreateAsync(service, "moving", 2048);
        await CreateAsync(service, "b", 3072);
        await DeclareAsync(coordinator, service);
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "A tree", [
            new CreateEntityOperation("entity", Entity, "Nodes", "nodes"),
            new AddFieldOperation("title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("parent", Entity, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("order", Entity, "ord", "Order", "ord", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("reference", Entity, "parent", Entity, "title", 0),
        ]));

    private static Task<NendoApplyResult> CreateAsync(NendoApplicationService service, string id, long order) =>
        service.CreateRecordAsync(new(Entity, id, new Dictionary<string, object?> { ["title"] = id, ["ord"] = order }, Context($"create-{id}")));

    private static async Task DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service) =>
        await coordinator.ApplyAsync(new("test", "declare", "test", "Declare a tree", [
            new DeclareHierarchyOperation("tree", Entity, "parent", "ord", (await service.GetSnapshotAsync()).Manifest.DefinitionRevision),
        ]));

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Entity, 1) { RecordId = id })).Items.Single();
}
