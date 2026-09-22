using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Several lists and boards on one record type, ADR-0004's 2026-09-12
/// vocabulary-widening amendment. An Open and a Closed list with different
/// columns, filters and orderings is ordinary; as two roots it used to refuse,
/// and the compiled plan carried one surface per kind, so nothing downstream
/// could address the second.
/// </summary>
[TestClass]
public sealed class MultipleSurfaceRootTests
{
    [TestMethod]
    public void TwoListsAndTwoBoardsOnOneEntityCompileWithTheirOwnColumnsAndQueries()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("open", "Open", ("orderByFieldId", "e-name"), ("orderDirection", "ascending")),
            Binding("open-name", "open", "e-name"),
            Clause("open-filter", "open", "e-stage", "ne", "won"),
            List("closed", "Closed", ("orderByFieldId", "e-value"), ("orderDirection", "descending")),
            Binding("closed-value", "closed", "e-value"),
            Clause("closed-filter", "closed", "e-stage", "eq", "won"),
            Board("stage", "e-stage", "By stage"),
            Binding("stage-name", "stage", "e-name"),
            Board("owner", "e-owner", "By owner"),
            Binding("owner-name", "owner", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var surfaces = compiled.Applications.Single().Surfaces;
        // Compiled order is declared position, which is the order Use offers them.
        CollectionAssert.AreEqual(
            new[] { "open", "closed", "stage", "owner" },
            surfaces.Select(root => root.SemanticId).ToArray());
        Assert.AreEqual("e-stage", surfaces.Single(root => root.SemanticId == "stage").Properties["groupByFieldId"].GetString());
        Assert.AreEqual("e-owner", surfaces.Single(root => root.SemanticId == "owner").Properties["groupByFieldId"].GetString());
        // Each list keeps its own columns, filter and ordering.
        Assert.AreEqual("e-value", surfaces.Single(root => root.SemanticId == "closed").Children
            .Single(child => child.Kind == "fieldBinding").Properties["fieldId"].GetString());
        Assert.AreEqual("descending", surfaces.Single(root => root.SemanticId == "closed").Properties["orderDirection"].GetString());
        Assert.AreEqual("ne", surfaces.Single(root => root.SemanticId == "open").Children
            .Single(child => child.Kind == "filterClause").Properties["operator"].GetString());
    }

    [TestMethod]
    [DataRow("recordList", 8, true)]
    [DataRow("recordList", 9, false)]
    [DataRow("boardSurface", 8, true)]
    [DataRow("boardSurface", 9, false)]
    public void TheSurfaceRootCeilingIsEightPerKindPerEntity(string kind, int roots, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot>();
        for (var index = 0; index < roots; index++)
        {
            nodes.Add(kind == "recordList"
                ? List($"root-{index}", $"List {index}")
                : Board($"root-{index}", "e-stage", $"Board {index}"));
            nodes.Add(Binding($"root-{index}-name", $"root-{index}", "e-name"));
        }

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        var hit = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI153");
        StringAssert.Contains(hit.Message, $"9 {kind} roots");
        StringAssert.Contains(hit.Message, "at most 8");
        StringAssert.Contains(hit.Hint, $"at most 8 {kind} roots");
        Assert.IsEmpty(compiled.Applications, "A refused definition leaves no partial plan.");
    }

    /// <summary>
    /// The ceiling is per record type. Eight lists on each of two entities is
    /// eight each, and reading it per file would refuse an ordinary application.
    /// </summary>
    [TestMethod]
    public void TheCeilingIsPerRecordTypeNotPerFile()
    {
        var nodes = new List<NendoUiNodeSnapshot>();
        foreach (var entityId in new[] { "e", "t" })
            for (var index = 0; index < NendoSemanticVocabulary.MaximumRootsPerKindPerEntity; index++)
            {
                var nodeId = $"{entityId}-list-{index}";
                nodes.Add(List(nodeId, $"List {index}", entityId: entityId));
                nodes.Add(Binding($"{nodeId}-name", nodeId, entityId == "e" ? "e-name" : "t-name"));
            }

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray(), withTarget: true));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.HasCount(2, compiled.Applications);
        foreach (var application in compiled.Applications)
            Assert.HasCount(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity, application.Surfaces);
    }

    /// <summary>
    /// The introduction path: a second list root raises the recorded minimum, and
    /// removing it again leaves the file stating the host it needed.
    /// </summary>
    [TestMethod]
    public async Task ASecondListRootRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
        ]));
        await coordinator.ApplyAsync(new("test", "one", "test", "One list", ListOperations("open", 0)));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "two", "test", "A second list", ListOperations("closed", 1)));
        Assert.AreEqual(NendoFormat.MultipleSurfaceRootsMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);

        await coordinator.ApplyAsync(new("test", "undo", "test", "Remove the second list",
            [new RemoveUiNodeOperation("closed-remove", "s", "closed")]));
        Assert.AreEqual(NendoFormat.MultipleSurfaceRootsMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    private static NendoOperation[] ListOperations(string nodeId, int position) =>
    [
        new AddUiNodeOperation($"{nodeId}-add", "s", nodeId, null, "recordList", position),
        new SetUiPropertyOperation($"{nodeId}-version", "s", nodeId, "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation($"{nodeId}-entity", "s", nodeId, "entityId", "e"),
        new AddUiNodeOperation($"{nodeId}-name-add", "s", $"{nodeId}-name", nodeId, "fieldBinding", 0),
        new SetUiPropertyOperation($"{nodeId}-name-field", "s", $"{nodeId}-name", "fieldId", "e-name"),
    ];

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot List(
        string nodeId,
        string title,
        params (string Name, object Value)[] properties) => List(nodeId, title, "e", properties);

    private static NendoUiNodeSnapshot List(
        string nodeId,
        string title,
        string entityId,
        params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "recordList",
            [("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", entityId), ("title", title), .. properties]);

    private static NendoUiNodeSnapshot Board(string nodeId, string groupByFieldId, string title) =>
        Node(nodeId, null, "boardSurface",
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"),
            ("groupByFieldId", groupByFieldId), ("title", title));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Clause(
        string nodeId,
        string parentNodeId,
        string fieldId,
        string comparison,
        object value) =>
        Node(nodeId, parentNodeId, "filterClause", ("fieldId", fieldId), ("operator", comparison), ("value", value));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, bool withTarget = false)
    {
        var entities = new List<NendoEntitySnapshot>
        {
            new("e", "Example",
            [
                new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                new("e-value", "Value", NendoStorageKind.Decimal, false, null, []),
                new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "won"]),
                new("e-owner", "Owner", NendoStorageKind.Text, false, "singleChoice", ["ana", "bo"]),
            ]),
        };
        if (withTarget)
            entities.Add(new NendoEntitySnapshot("t", "Target",
                [new("t-name", "Name", NendoStorageKind.Text, true, "singleLine", [])]));

        var now = new DateTimeOffset(2026, 9, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "surfaces.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.MultipleSurfaceRootsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            entities,
            [],
            // Position follows declaration order, which is the order Use offers.
            nodes.Select((node, index) => node with { Position = index }).ToArray(),
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoUiNodeSnapshot Node(
        string nodeId,
        string? parentNodeId,
        string kind,
        params (string Name, object Value)[] properties) => new(
            "s",
            nodeId,
            parentNodeId,
            kind,
            0,
            properties.ToDictionary(
                property => property.Name,
                property => JsonSerializer.SerializeToElement(property.Value),
                StringComparer.Ordinal));
}
