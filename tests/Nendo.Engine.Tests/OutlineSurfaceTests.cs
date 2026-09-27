using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The outline surface, ADR-0019 stage 6 (ADR-0004's B6): a declared hierarchy drawn as an
/// expandable outline in Use. It reads the hierarchy's own order a level at a time, so it
/// takes no ordering and no filter; the record type must declare the tree it draws, and the
/// tree cannot be removed from under it.
/// </summary>
[TestClass]
public sealed class OutlineSurfaceTests
{
    [TestMethod]
    public void AnOutlineCompilesWithItsRolesDepthReorderAndColumns()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Outline("tree", ("title", "Capabilities"), ("titleFieldId", "e-name"), ("accentFieldId", "e-stage"),
                ("expandDepth", 3), ("reorder", true)),
            Binding("tree-stage", "tree", "e-stage"),
            Binding("tree-calc", "tree", "e-calc"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var root = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("outlineSurface", root.Kind);
        Assert.AreEqual(3, root.Properties["expandDepth"].GetInt32());
        Assert.IsTrue(root.Properties["reorder"].GetBoolean());
        CollectionAssert.AreEqual(new[] { "fieldBinding", "fieldBinding" }, root.Children.Select(child => child.Kind).ToArray());
    }

    /// <summary>The title is the row, so an outline with no other column still says something.</summary>
    [TestMethod]
    public void AnOutlineNeedsNoColumnsOrProperties()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Outline("tree")]));
        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    [TestMethod]
    public void AnOutlineOfARecordTypeWithNoHierarchyIsRefusedByName()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Outline("tree")], declared: false));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI430");
        Assert.AreEqual("tree", refusal.SemanticId);
        StringAssert.Contains(refusal.Message, "Example declares no hierarchy");
        StringAssert.Contains(refusal.Hint, "schema.declareHierarchy");
    }

    [TestMethod]
    [DataRow("titleFieldId", "e-stage", "NUI431", "a single choice, so it cannot title each row")]
    [DataRow("titleFieldId", "e-calc", "NUI431", "is calculated, so it cannot title each row")]
    [DataRow("titleFieldId", "e-gone", "NUI431", "does not exist or is retired")]
    [DataRow("accentFieldId", "e-name", "NUI432", "a Text, so it cannot colour each row")]
    [DataRow("accentFieldId", "e-gone", "NUI432", "does not exist or is retired")]
    public void AFieldRoleOfTheWrongShapeIsRefusedByName(string property, string fieldId, string code, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Outline("tree", (property, fieldId))]));

        Assert.IsFalse(compiled.IsValid, $"{property} = '{fieldId}' must be refused.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == code);
        Assert.AreEqual(property, refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
    }

    [TestMethod]
    [DataRow(0)]
    [DataRow(5)]
    [DataRow("two")]
    [DataRow(2.5)]
    public void AnExpandDepthOutsideOneToFourIsRefused(object depth)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Outline("tree", ("expandDepth", depth))]));

        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI433");
        Assert.AreEqual("expandDepth", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "between 1 and 4");
    }

    [TestMethod]
    [DataRow(1)]
    [DataRow(4)]
    public void AnExpandDepthFromOneToFourCompiles(int depth) =>
        Assert.IsTrue(new NendoSemanticCompiler().Compile(Source([Outline("tree", ("expandDepth", depth))])).IsValid);

    [TestMethod]
    public void AReorderThatIsNotTrueOrFalseIsRefused()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Outline("tree", ("reorder", "yes"))]));
        Assert.AreEqual("reorder", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI434").PropertyPath);
    }

    /// <summary>A filtered tree hides the ancestors that give a match its meaning, so the kind takes none.</summary>
    [TestMethod]
    public void AnOutlineTakesNoFilterAndNoOrdering()
    {
        var filtered = new NendoSemanticCompiler().Compile(Source(
        [
            Outline("tree"),
            Node("tree-open", "tree", "filterClause", 1, ("fieldId", "e-stage"), ("operator", "eq"), ("value", "open")),
        ]));
        Assert.IsFalse(filtered.IsValid);
        Assert.IsTrue(filtered.Diagnostics.Any(diagnostic => diagnostic.SemanticId == "tree-open"), Messages(filtered));

        var ordered = new NendoSemanticCompiler().Compile(Source([Outline("tree", ("orderByFieldId", "e-name"))]));
        Assert.IsFalse(ordered.IsValid);
        Assert.IsTrue(ordered.Diagnostics.Any(diagnostic => diagnostic.PropertyPath == "orderByFieldId"), Messages(ordered));
    }

    /// <summary>
    /// The introduction path: declaring the tree raises the file to the hierarchy's rung, and the
    /// outline to its own above it. The tree cannot then be removed while the outline shows it,
    /// because a surface that does not compile would switch every custom screen off.
    /// </summary>
    [TestMethod]
    public async Task AddingAnOutlineRaisesTheMinimumAndHoldsTheHierarchyInPlace()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "A tree",
        [
            new CreateEntityOperation("e-create", "e", "Nodes", "nodes"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("e-parent-create", "e", "e-parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("e-parent-bind", "e", "e-parent", "e", "e-name", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "declare", "test", "Declare",
            [new DeclareHierarchyOperation("e-declare", "e", "e-parent", null, revision)]));
        Assert.AreEqual(NendoFormat.HierarchyMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "outline", "test", "An outline",
        [
            new AddUiNodeOperation("tree-add", "s", "tree", null, "outlineSurface", 0),
            new SetUiPropertyOperation("tree-version", "s", "tree", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("tree-entity", "s", "tree", "entityId", "e"),
            new SetUiPropertyOperation("tree-reorder", "s", "tree", "reorder", true),
        ]));
        Assert.AreEqual(NendoFormat.OutlineSurfaceMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "remove", "test", "Remove",
            [new RemoveHierarchyOperation("e-remove", "e", revision)])));
        Assert.AreEqual("hierarchy-field-in-use", refused.Code);
        StringAssert.Contains(refused.Message, "The outline 'tree'");

        await coordinator.ApplyAsync(new("test", "undo", "test", "Remove the outline",
            [new RemoveUiNodeOperation("tree-remove", "s", "tree")]));
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "remove-after", "test", "Remove",
            [new RemoveHierarchyOperation("e-remove-after", "e", revision)]));
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Hierarchy);
        Assert.AreEqual(NendoFormat.OutlineSurfaceMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    [TestMethod]
    public void TheVocabularyPublishesTheOutlineRoot()
    {
        var description = NendoSemanticVocabulary.Description();
        var outline = description.Kinds.Single(kind => kind.Kind == "outlineSurface");

        Assert.IsTrue(outline.CanBeRoot);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity, outline.MaxRootsPerEntity);
        CollectionAssert.AreEquivalent(new[] { "fieldBinding" }, outline.Children.ToArray());
        CollectionAssert.AreEquivalent(new[] { "definitionVersion", "entityId" }, outline.RequiredProperties.ToArray());
        foreach (var property in new[] { "titleFieldId", "accentFieldId", "expandDepth", "reorder" })
        {
            Assert.IsTrue(outline.Properties.Contains(property), property);
            StringAssert.Contains(description.PropertyNotes![property], "outlineSurface", $"{property} needs a note that names the outline");
        }
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Outline(string nodeId, params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "outlineSurface", 0,
            [
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion),
                ("entityId", "e"),
                .. properties,
            ]);

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, bool declared = true)
    {
        var now = new DateTimeOffset(2026, 9, 27, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "outline.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.HierarchyMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-parent", "Parent", NendoStorageKind.Reference, false, "reference", []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                ])
                {
                    DerivedFields =
                    [
                        new NendoDerivedFieldSnapshot("e-calc", "Calc", "entity.e.calc", NendoBehaviourScalar.Text, false, "Concat(name, '!')"),
                    ],
                    Hierarchy = declared ? new NendoHierarchy("e-parent", null) : null,
                },
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoUiNodeSnapshot Node(
        string nodeId,
        string? parentNodeId,
        string kind,
        int position,
        params (string Name, object Value)[] properties) => new(
            "s",
            nodeId,
            parentNodeId,
            kind,
            position,
            properties.ToDictionary(
                property => property.Name,
                property => JsonSerializer.SerializeToElement(property.Value),
                StringComparer.Ordinal));
}
