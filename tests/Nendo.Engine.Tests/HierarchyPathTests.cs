namespace Nendo.Engine.Tests;

/// <summary>
/// The HierarchyPath calculation binding, ADR-0020 stage 3 (an ADR-0008 amendment): a record's
/// dotted place in its declared hierarchy, siblings counted in the tree read's order — the order
/// field, a missing order last, then record ID — with an optional literal prefix. It is
/// calculated, never stored, so it follows a move at once.
/// </summary>
[TestClass]
public sealed class HierarchyPathTests
{
    private const string Entity = "nodes";

    [TestMethod]
    public async Task EachRecordReadsItsDottedPlaceInTheTreeReadsOrder()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await TreeAsync(coordinator, service, order: true);
        await PathsAsync(coordinator, service, prefix: null);

        var paths = await ReadPathsAsync(service);
        // Top: a (order 1), b (order 2), c (no order, last). Under a: a2 (10), a1 (20), a3 (none).
        Assert.AreEqual("1", paths["a"]);
        Assert.AreEqual("2", paths["b"]);
        Assert.AreEqual("3", paths["c"]);
        Assert.AreEqual("1.1", paths["a2"]);
        Assert.AreEqual("1.2", paths["a1"]);
        Assert.AreEqual("1.3", paths["a3"]);
        Assert.AreEqual("1.1.1", paths["a2x"]);
    }

    [TestMethod]
    public async Task APrefixLeadsThePathAndAMoveIsFollowedAtOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await TreeAsync(coordinator, service, order: true);
        await PathsAsync(coordinator, service, prefix: "CAP-");
        Assert.AreEqual("CAP-1.1.1", (await ReadPathsAsync(service))["a2x"]);

        // b moves under a, before a1: a2 stays first, b takes second, a1 and a3 step down.
        await service.MoveRecordAsync(new(Entity, "b", 1, "a", 1, "a1", Context("move-b")));
        var paths = await ReadPathsAsync(service);
        Assert.AreEqual("CAP-1.1", paths["a2"]);
        Assert.AreEqual("CAP-1.2", paths["b"]);
        Assert.AreEqual("CAP-1.3", paths["a1"]);
        Assert.AreEqual("CAP-1.4", paths["a3"]);
        Assert.AreEqual("CAP-2", paths["c"], "c moved up a place at the top when b left it.");
    }

    [TestMethod]
    public async Task WithoutAnOrderFieldSiblingsCountByRecordId()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await TreeAsync(coordinator, service, order: false);
        await PathsAsync(coordinator, service, prefix: null);
        var paths = await ReadPathsAsync(service);
        Assert.AreEqual("1.1", paths["a1"]);
        Assert.AreEqual("1.2", paths["a2"]);
        Assert.AreEqual("1.2.1", paths["a2x"]);
        Assert.AreEqual("1.3", paths["a3"]);
    }

    [TestMethod]
    public async Task APathNeedsAHierarchyAndHoldsItInPlace()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => PathsAsync(coordinator, service, prefix: null));

        await DeclareAsync(coordinator, service, order: true);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => PathsAsync(coordinator, service, prefix: new string('x', 17)));
        await PathsAsync(coordinator, service, prefix: null);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "remove", "test", "Remove",
            [new RemoveHierarchyOperation("remove", Entity, revision)])));
        Assert.AreEqual("hierarchy-field-in-use", refused.Code);
    }

    [TestMethod]
    public void TheWireFormatCarriesAPathAndRefusesWhatAPathCannotBe()
    {
        static string Body(string binding) => $$"""
            {"entityId":"nodes","fieldId":"path","displayName":"Path","resultType":"Text","resultNullable":false,
             "expression":"p","callAliases":[],"bindings":[{{binding}}]}
            """;
        static NendoBehaviourBinding Read(string binding) => ((NendoCalculationDefinition)NendoBehaviourCodec.Read(
            "nodes.path", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, Body(binding), NendoBehaviourBodySource.Authored)).Bindings.Single();

        var path = Read("""{"bindingId":"p","kind":"HierarchyPath","entityId":"nodes","prefix":"CAP-"}""");
        Assert.AreEqual(NendoBindingKind.HierarchyPath, path.Kind);
        Assert.AreEqual("CAP-", path.Prefix);
        Assert.AreEqual(NendoBehaviourScalar.Text, path.ResultType);
        Assert.IsNull(Read("""{"bindingId":"p","kind":"HierarchyPath","entityId":"nodes"}""").Prefix);

        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            Read("""{"bindingId":"p","kind":"HierarchyPath","entityId":"nodes","resultType":"Integer"}""")).Message, "always produces Text");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            Read("""{"bindingId":"p","kind":"HierarchyPath","entityId":"nodes","nullable":true}""")).Message, "never empty");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            Read("""{"bindingId":"p","kind":"HierarchyPath","entityId":"nodes","fieldId":"title"}""")).Message, "does not define: fieldId");

        // Without a prefix the canonical body says nothing about one.
        var plain = new NendoCalculationDefinition("nodes.path", "nodes", "path", "Path", NendoBehaviourScalar.Text, false, "p",
            [NendoBehaviourBinding.HierarchyPath("p", "nodes")]).CanonicalBody();
        Assert.DoesNotContain("prefix", plain);
    }

    private static async Task TreeAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, bool order)
    {
        await SchemaAsync(coordinator);
        foreach (var (id, parent, ord) in new (string, string?, long?)[]
                 {
                     ("a", null, 1), ("b", null, 2), ("c", null, null),
                     ("a1", "a", 20), ("a2", "a", 10), ("a3", "a", null), ("a2x", "a2", null),
                 })
            await service.CreateRecordAsync(new(Entity, id,
                new Dictionary<string, object?> { ["title"] = id.ToUpperInvariant(), ["parent"] = parent, ["ord"] = ord },
                Context($"create-{id}"), parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 }));
        await DeclareAsync(coordinator, service, order);
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "A tree", [
            new CreateEntityOperation("e", Entity, "Nodes", "nodes"),
            new AddFieldOperation("f-title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-parent", Entity, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("f-ord", Entity, "ord", "Order", "ord", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("bind", Entity, "parent", Entity, "title", 0),
        ]));

    private static async Task DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, bool order)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "declare", "test", "Declare",
            [new DeclareHierarchyOperation("declare", Entity, "parent", order ? "ord" : null, revision)]));
    }

    private static async Task PathsAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string? prefix)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", $"path-{Guid.NewGuid():N}", "test", "Path", [
            new SetBehaviourDefinitionOperation($"p-{Guid.NewGuid():N}", new NendoCalculationDefinition("calc.path", Entity, "path", "Path",
                NendoBehaviourScalar.Text, false, "p", [NendoBehaviourBinding.HierarchyPath("p", Entity, prefix)]), revision),
        ]));
    }

    private static async Task<Dictionary<string, string>> ReadPathsAsync(NendoApplicationService service)
    {
        var paths = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var record in (await service.QueryRecordsAsync(new(Entity, 50))).Items)
        {
            var result = record.Calculations.Single(calculation => calculation.FieldId == "path");
            Assert.AreEqual(NendoCalculationState.Value, result.State, $"{record.RecordId}: {result.ErrorCode} {result.ErrorMessage}");
            paths[record.RecordId] = result.Value.GetString()!;
        }
        return paths;
    }
}
