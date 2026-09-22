using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Summary tiles on a list and a board, ADR-0004's 2026-09-12 vocabulary-widening
/// amendment. A tile states one exact number over the records the surface shows —
/// not over the page in view — and `scope` group narrows it to one board column.
/// The restriction on `scope` is contextual: the parent decides, so a flat kind
/// table cannot enforce it and the compiler is given the parent explicitly.
/// </summary>
[TestClass]
public sealed class SurfaceSummaryTileTests
{
    [TestMethod]
    public void ATileCompilesOnAListAndOnABoardAndDefaultsToSurfaceScope()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(Nodes(
            List("list", ("title", "Open")),
            Binding("list-name", "list", "e-name"),
            Tile("list-total", "list", "count"),
            Board("board"),
            Binding("board-name", "board", "e-name"),
            Tile("board-total", "board", "sum", ("fieldId", "e-value")))));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var surfaces = compiled.Applications.Single().Surfaces;
        var listTile = surfaces.Single(root => root.Kind == "recordList").Children
            .Single(child => child.Kind == "summaryTile");
        Assert.AreEqual("count", listTile.Properties["aggregate"].GetString());
        Assert.IsFalse(listTile.Properties.ContainsKey("scope"),
            "An absent scope is the published default, not a value the compiler invents.");
        Assert.IsTrue(surfaces.Single(root => root.Kind == "boardSurface").Children
            .Any(child => child.Kind == "summaryTile"));
    }

    [TestMethod]
    public void APerColumnTileIsAcceptedOnlyAsADirectChildOfABoard()
    {
        var onBoard = new NendoSemanticCompiler().Compile(Source(Nodes(
            Board("board"),
            Binding("board-name", "board", "e-name"),
            Tile("board-column", "board", "count", ("scope", "group")))));
        Assert.IsTrue(onBoard.IsValid, Messages(onBoard));

        var onList = new NendoSemanticCompiler().Compile(Source(Nodes(
            List("list"),
            Binding("list-name", "list", "e-name"),
            Tile("list-column", "list", "count", ("scope", "group")))));
        Assert.IsFalse(onList.IsValid);
        var refusal = onList.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI297");
        Assert.AreEqual("list-column", refusal.SemanticId);
        Assert.AreEqual("scope", refusal.PropertyPath);
        StringAssert.Contains(refusal.Hint, "boardSurface");
    }

    /// <summary>
    /// A tile several sections deep has no column to belong to. Searching upward
    /// for a board would invent a grouping rule nothing published states, so the
    /// intervening section is not a path to per-column meaning.
    /// </summary>
    [TestMethod]
    public void APerColumnTileInsideASectionOnARecordPageIsRefusedRatherThanResolvedUpward()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(Nodes(
            Node("page", null, "detailSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("page-name", "page", "e-name"),
            Node("page-section", "page", "section", 1, ("title", "Numbers")),
            Tile("page-column", "page-section", "count", ("scope", "group")))));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("page-column", compiled.Diagnostics.Single(d => d.Code == "NUI297").SemanticId);
    }

    [TestMethod]
    public void AnUnknownScopeIsRefusedAndTheRefusalNamesTheClosedValues()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(Nodes(
            Board("board"),
            Binding("board-name", "board", "e-name"),
            Tile("board-tile", "board", "count", ("scope", "column")))));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI296");
        Assert.AreEqual("scope", refusal.PropertyPath);
        StringAssert.Contains(refusal.Hint, "surface");
        StringAssert.Contains(refusal.Hint, "group");
    }

    /// <summary>
    /// Composition is what spends the budget, so the check is on the sum rather
    /// than on any one node's clause count. A board column tile pays for the
    /// board's clauses, its own, and the column predicate.
    /// </summary>
    [TestMethod]
    public void ABoardColumnTileIsBoundedByCompositionNotByItsOwnClauseCount()
    {
        var atCeiling = new NendoSemanticCompiler().Compile(Source(Nodes(
            [Board("board")],
            [Binding("board-name", "board", "e-name")],
            Clauses("board", 6),
            [Tile("board-tile", "board", "count", ("scope", "group"))],
            Clauses("board-tile", 1))));
        Assert.IsTrue(atCeiling.IsValid, Messages(atCeiling));

        var overCeiling = new NendoSemanticCompiler().Compile(Source(Nodes(
            [Board("board")],
            [Binding("board-name", "board", "e-name")],
            Clauses("board", 7),
            [Tile("board-tile", "board", "count", ("scope", "group"))],
            Clauses("board-tile", 1))));
        Assert.IsFalse(overCeiling.IsValid);
        var refusal = overCeiling.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300" && diagnostic.SemanticId == "board-tile");
        Assert.AreEqual("filterClause", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "9 effective filters");
        StringAssert.Contains(refusal.Hint, "7 declared on the boardSurface");
        StringAssert.Contains(refusal.Hint, "1 column predicate the host adds");
        Assert.IsEmpty(overCeiling.Applications, "A refused definition leaves no partial plan.");
    }

    [TestMethod]
    public void AListWindowOverTheCeilingIsRefusedOnItsOwnClauses()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(Nodes(
            [List("list")],
            [Binding("list-name", "list", "e-name")],
            Clauses("list", NendoSemanticVocabulary.MaximumEffectiveFilters + 1))));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("list", compiled.Diagnostics.Single(d => d.Code == "NUI300").SemanticId);
    }

    /// <summary>
    /// A relation reserves one reference predicate, so eight declared clauses on
    /// it already composes to nine.
    /// </summary>
    [TestMethod]
    public void ARelatedListReservesItsReferencePredicateAgainstTheSameCeiling()
    {
        var compiled = new NendoSemanticCompiler().Compile(RelationSource(
            Clauses("page-related", NendoSemanticVocabulary.MaximumEffectiveFilters)));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(d => d.Code == "NUI300");
        Assert.AreEqual("page-related", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint, "reference predicate the host adds");
    }

    /// <summary>
    /// A tile on a record page keeps its existing entity-wide meaning: nothing
    /// encloses it, so it spends only its own clauses.
    /// </summary>
    [TestMethod]
    public void ARecordPageTileKeepsTheWholeBudgetForItsOwnClauses()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(Nodes(
            [
                Node("page", null, "detailSurface", 0,
                    ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
                Binding("page-name", "page", "e-name"),
                Tile("page-tile", "page", "count"),
            ],
            Clauses("page-tile", NendoSemanticVocabulary.MaximumEffectiveFilters))));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    /// <summary>
    /// The introduction path, through the store: a tile placed under a list raises
    /// the file's recorded minimum, and a move that puts an existing page tile
    /// under a board does too even though it adds no node and sets no property.
    /// Removing it again never lowers what the file records.
    /// </summary>
    [TestMethod]
    public async Task PlacingATileUnderAListOrMovingOneThereRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
        ]));
        await coordinator.ApplyAsync(new("test", "page", "test", "Record page",
        [
            new AddUiNodeOperation("page-add", "s", "page", null, "detailSurface", 0),
            new SetUiPropertyOperation("page-version", "s", "page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("page-entity", "s", "page", "entityId", "e"),
            new AddUiNodeOperation("page-name-add", "s", "page-name", "page", "fieldBinding", 0),
            new SetUiPropertyOperation("page-name-field", "s", "page-name", "fieldId", "e-name"),
            new AddUiNodeOperation("page-tile-add", "s", "page-tile", "page", "summaryTile", 1),
            new SetUiPropertyOperation("page-tile-aggregate", "s", "page-tile", "aggregate", "count"),
        ]));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "A tile on a record page is the shape that already compiled.");

        await coordinator.ApplyAsync(new("test", "list", "test", "A list with its own total",
        [
            new AddUiNodeOperation("list-add", "s", "list", null, "recordList", 1),
            new SetUiPropertyOperation("list-version", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("list-entity", "s", "list", "entityId", "e"),
            new AddUiNodeOperation("list-name-add", "s", "list-name", "list", "fieldBinding", 0),
            new SetUiPropertyOperation("list-name-field", "s", "list-name", "fieldId", "e-name"),
            // The move is the interesting path: no node is added and no property
            // is set, yet what the definition needs changes.
            new MoveUiNodeOperation("tile-move", "s", "page-tile", "list", 1),
        ]));
        var raised = await service.GetSnapshotAsync();
        Assert.AreEqual(NendoFormat.SurfaceSummaryTilesMinimumHostVersion, raised.Manifest.MinimumHostVersion);
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);

        await coordinator.ApplyAsync(new("test", "undo", "test", "Take the tile off the list",
            [new RemoveUiNodeOperation("tile-remove", "s", "page-tile")]));
        Assert.AreEqual(NendoFormat.SurfaceSummaryTilesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    /// <summary>
    /// The vocabulary a client reads has to carry the contextual rule and the
    /// closed values, or the rule is discoverable only by failing validation.
    /// </summary>
    [TestMethod]
    public void TheVocabularyPublishesTheScopeValuesTheDefaultAndTheFilterBudget()
    {
        var description = NendoSemanticVocabulary.Description();

        foreach (var kind in new[] { "recordList", "boardSurface" })
            Assert.Contains("summaryTile", description.Kinds.Single(rule => rule.Kind == kind).Children.ToArray());
        Assert.Contains("scope", description.Kinds.Single(rule => rule.Kind == "summaryTile").Properties.ToArray());

        var scopes = description.SummaryScopes;
        Assert.IsNotNull(scopes);
        CollectionAssert.AreEqual(new[] { "group", "surface" }, scopes.Values.ToArray());
        Assert.AreEqual("surface", scopes.Default);
        StringAssert.Contains(scopes.Note, "direct child of a boardSurface");

        var budget = description.EffectiveFilters;
        Assert.IsNotNull(budget);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumEffectiveFilters, budget.MaximumClauses);
        Assert.Contains("Board column tile", budget.Contexts.Select(context => context.Context).ToArray());
        // The published ceiling has to be the one that actually refuses.
        var overBudget = new NendoRecordQuery("e")
        {
            Filters = Enumerable.Range(0, budget.MaximumClauses + 1)
                .Select(index => new NendoRecordFilter($"f{index}", "isNotNull")).ToArray(),
        };
        Assert.ThrowsExactly<NendoValidationException>(() => RecordQueryValidation(overBudget));
    }

    private static void RecordQueryValidation(NendoRecordQuery query) => RecordQuerySemantics.Validate(query);

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot[] Nodes(params IEnumerable<NendoUiNodeSnapshot>[] groups) =>
        groups.SelectMany(group => group).ToArray();

    private static NendoUiNodeSnapshot[] Nodes(params NendoUiNodeSnapshot[] nodes) => nodes;

    private static NendoUiNodeSnapshot[] Clauses(string parentNodeId, int count) =>
        Enumerable.Range(0, count)
            .Select(index => Node($"{parentNodeId}-clause-{index}", parentNodeId, "filterClause", 100 + index,
                ("fieldId", "e-name"), ("operator", "isNotNull")))
            .ToArray();

    private static NendoUiNodeSnapshot List(string nodeId, params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "recordList", 0,
            [("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), .. properties]);

    private static NendoUiNodeSnapshot Board(string nodeId) =>
        Node(nodeId, null, "boardSurface", 1,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"),
            ("groupByFieldId", "e-stage"));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Tile(
        string nodeId,
        string parentNodeId,
        string aggregate,
        params (string Name, object Value)[] properties) =>
        Node(nodeId, parentNodeId, "summaryTile", 50, [("aggregate", aggregate), .. properties]);

    private static NendoSessionSnapshot RelationSource(params NendoUiNodeSnapshot[] extra)
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("page", null, "detailSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("page-name", "page", "e-name"),
            Node("page-related", "page", "relatedList", 1, ("targetEntityId", "t"), ("viaFieldId", "t-parent")),
            Binding("page-related-name", "page-related", "t-name"),
        };
        nodes.AddRange(extra);
        // A relation's clauses bind the related record type, so they name its fields.
        var rewritten = nodes.Select(node => node.Kind == "filterClause"
            ? node with { Properties = Properties(("fieldId", "t-name"), ("operator", "isNotNull")) }
            : node).ToArray();
        return Source(rewritten, withTarget: true);
    }

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, bool withTarget = false)
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
            new("e-value", "Value", NendoStorageKind.Decimal, false, null, []),
            new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "won"]),
        };
        var entities = new List<NendoEntitySnapshot> { new("e", "Example", fields) };
        if (withTarget)
        {
            entities.Add(new NendoEntitySnapshot("t", "Target",
            [
                new("t-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                new("t-parent", "Parent", NendoStorageKind.Reference, false, null, [])
                {
                    Reference = new NendoReferenceDefinition("e", "e-name"),
                },
            ]));
        }

        var now = new DateTimeOffset(2026, 9, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "tiles.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.SurfaceSummaryTilesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            entities,
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static Dictionary<string, JsonElement> Properties(params (string Name, object Value)[] properties) =>
        properties.ToDictionary(
            property => property.Name,
            property => JsonSerializer.SerializeToElement(property.Value),
            StringComparer.Ordinal);

    private static NendoUiNodeSnapshot Node(
        string nodeId,
        string? parentNodeId,
        string kind,
        int position,
        params (string Name, object Value)[] properties) =>
        new("s", nodeId, parentNodeId, kind, position, Properties(properties));
}
