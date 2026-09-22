using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The gallery, ADR-0004's 2026-09-14 amendment (S2): a card per record over exactly a
/// list's bounded window. Both field roles are the record page's rules with card wording
/// and both are optional, because a card without a declared title leads with its first
/// bound field. It takes the tiles and charts a list takes, and spends the same budget: a
/// gallery adds no predicate of its own, so its clauses are the ones an author declared.
/// </summary>
[TestClass]
public sealed class GallerySurfaceTests
{
    [TestMethod]
    public void AGalleryCompilesWithItsTitleAccentOrderAndTiles()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Gallery("cards", ("title", "Entry cards"), ("titleFieldId", "e-name"), ("accentFieldId", "e-stage"),
                ("orderByFieldId", "e-name"), ("orderDirection", "descending")),
            Binding("cards-notes", "cards", "e-notes"),
            Clause("cards-open", "cards", "e-stage", "ne", "done"),
            Node("cards-total", "cards", "summaryTile", 2, ("aggregate", "count"), ("title", "Cards")),
            Node("cards-chart", "cards", "breakdownChart", 3, ("groupByFieldId", "e-stage"), ("aggregate", "count")),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var root = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("gallerySurface", root.Kind);
        Assert.AreEqual("e-name", root.Properties["titleFieldId"].GetString());
        Assert.AreEqual("e-stage", root.Properties["accentFieldId"].GetString());
        Assert.AreEqual("e-name", root.Properties["orderByFieldId"].GetString());
        // A gallery takes the tiles and charts a list takes, in the same row.
        Assert.IsTrue(root.Children.Any(child => child.Kind == "summaryTile"));
        Assert.IsTrue(root.Children.Any(child => child.Kind == "breakdownChart"));
        Assert.IsTrue(root.Children.Any(child => child.Kind == "filterClause"));
    }

    /// <summary>
    /// A card with no declared title leads with its first bound field, as a timeline entry
    /// does, so the gallery and the board are titled by one rule.
    /// </summary>
    [TestMethod]
    public void AGalleryNeedsNoTitleFieldAndFallsBackToItsFirstBinding()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Gallery("cards"),
            Binding("cards-name", "cards", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.IsFalse(compiled.Applications.Single().Surfaces.Single().Properties.ContainsKey("titleFieldId"));
    }

    [TestMethod]
    [DataRow("titleFieldId", "e-stage", "NUI380", "a single choice, so it cannot title each card")]
    [DataRow("titleFieldId", "e-due", "NUI380", "a Date, so it cannot title each card")]
    [DataRow("titleFieldId", "e-calc", "NUI380", "is calculated, so it cannot title each card")]
    [DataRow("titleFieldId", "e-gone", "NUI380", "does not exist or is retired")]
    [DataRow("titleFieldId", "", "NUI380", "must name a field")]
    [DataRow("accentFieldId", "e-name", "NUI381", "a Text, so it cannot colour each card")]
    [DataRow("accentFieldId", "e-calc", "NUI381", "is calculated, so it cannot colour each card")]
    [DataRow("accentFieldId", "e-gone", "NUI381", "does not exist or is retired")]
    [DataRow("accentFieldId", "", "NUI381", "must name a field")]
    public void AFieldRoleOfTheWrongShapeIsRefusedByName(string property, string fieldId, string code, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Gallery("cards", (property, fieldId)),
            Binding("cards-name", "cards", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid, $"{property} = '{fieldId}' must be refused.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == code);
        Assert.AreEqual("cards", refusal.SemanticId);
        Assert.AreEqual(property, refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void AGalleryWithNoColumnsIsRefused()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Gallery("cards", ("titleFieldId", "e-name"))]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("cards", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI211").SemanticId);
    }

    /// <summary>
    /// A gallery reads a list's window, so it reserves nothing: eight declared clauses are
    /// accepted and a ninth is refused, and a tile inside one pays for the gallery's
    /// clauses as it pays for a list's.
    /// </summary>
    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void AGalleryReservesNoPredicateOfItsOwnAgainstTheEffectiveFilterCeiling(int clauses, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot> { Gallery("cards"), Binding("cards-name", "cards", "e-name") };
        for (var index = 0; index < clauses; index++)
            nodes.Add(Clause($"cards-clause-{index}", "cards", "e-name", "isNotNull", null));

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300");
        Assert.AreEqual("cards", refusal.SemanticId);
        StringAssert.Contains(refusal.Message, "9 effective filters");
        StringAssert.Contains(refusal.Hint, "9 declared on the gallerySurface");
    }

    [TestMethod]
    public void ATileInsideAGallerySpendsTheGallerysClauses()
    {
        var nodes = new List<NendoUiNodeSnapshot> { Gallery("cards"), Binding("cards-name", "cards", "e-name") };
        for (var index = 0; index < 7; index++)
            nodes.Add(Clause($"cards-clause-{index}", "cards", "e-name", "isNotNull", null));
        nodes.Add(Node("cards-total", "cards", "summaryTile", 8, ("aggregate", "count")));
        nodes.Add(Clause("tile-clause-a", "cards-total", "e-stage", "ne", "done"));
        nodes.Add(Clause("tile-clause-b", "cards-total", "e-name", "isNotNull", null));

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.IsFalse(compiled.IsValid, "Seven gallery clauses plus two of the tile's is nine.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300");
        Assert.AreEqual("cards-total", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint, "7 declared on the gallerySurface");
        StringAssert.Contains(refusal.Hint, "2 on this node");
    }

    /// <summary>A gallery has no columns, so a column-scoped total is refused as it is anywhere but a board.</summary>
    [TestMethod]
    public void AColumnScopedTileIsRefusedOnAGallery()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Gallery("cards"),
            Binding("cards-name", "cards", "e-name"),
            Node("cards-total", "cards", "summaryTile", 1, ("aggregate", "count"), ("scope", "group")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("cards-total", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI297").SemanticId);
    }

    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void TheGalleryRootCeilingIsEightPerEntity(int roots, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot>();
        for (var index = 0; index < roots; index++)
        {
            nodes.Add(Gallery($"cards-{index}", ("title", $"Gallery {index}")) with { Position = index });
            nodes.Add(Binding($"cards-{index}-name", $"cards-{index}", "e-name"));
        }

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        StringAssert.Contains(
            compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI153").Message,
            "9 gallerySurface roots");
    }

    /// <summary>
    /// The introduction path: a gallery raises the recorded minimum to its own version,
    /// above every earlier widening, and removing it lowers nothing.
    /// </summary>
    [TestMethod]
    public async Task AddingAGalleryRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
        ]));
        await coordinator.ApplyAsync(new("test", "list", "test", "A list",
        [
            new AddUiNodeOperation("list-add", "s", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-version", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("list-entity", "s", "list", "entityId", "e"),
            new AddUiNodeOperation("list-name-add", "s", "list-name", "list", "fieldBinding", 0),
            new SetUiPropertyOperation("list-name-field", "s", "list-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "gallery", "test", "A gallery of cards",
        [
            new AddUiNodeOperation("cards-add", "s", "cards", null, "gallerySurface", 1),
            new SetUiPropertyOperation("cards-version", "s", "cards", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("cards-entity", "s", "cards", "entityId", "e"),
            new SetUiPropertyOperation("cards-title", "s", "cards", "titleFieldId", "e-name"),
            new AddUiNodeOperation("cards-name-add", "s", "cards-name", "cards", "fieldBinding", 0),
            new SetUiPropertyOperation("cards-name-field", "s", "cards-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.GalleryAndRatingMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        await coordinator.ApplyAsync(new("test", "undo", "test", "Remove the gallery",
            [new RemoveUiNodeOperation("cards-remove", "s", "cards")]));
        Assert.AreEqual(NendoFormat.GalleryAndRatingMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    /// <summary>The vocabulary a client reads has to describe the new root.</summary>
    [TestMethod]
    public void TheVocabularyPublishesTheGalleryRoot()
    {
        var description = NendoSemanticVocabulary.Description();
        var gallery = description.Kinds.Single(kind => kind.Kind == "gallerySurface");

        Assert.IsTrue(gallery.CanBeRoot);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity, gallery.MaxRootsPerEntity);
        // A gallery takes exactly what a list takes: its own columns and conditions, and
        // the tile kinds that sit above them. S4's range joined them on both, and S5's two
        // over-time charts did the same.
        CollectionAssert.AreEquivalent(
            new[] { "fieldBinding", "filterClause", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid" },
            gallery.Children.ToArray());
        CollectionAssert.AreEquivalent(
            NendoSemanticVocabulary.Description().Kinds.Single(kind => kind.Kind == "recordList").Children.ToArray(),
            gallery.Children.ToArray());
        foreach (var property in new[] { "titleFieldId", "accentFieldId" })
        {
            Assert.IsTrue(gallery.Properties.Contains(property), property);
            Assert.IsFalse(gallery.RequiredProperties.Contains(property), $"{property} is optional");
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), $"{property} needs a note");
        }
        // A gallery spends what an author declared and nothing else, and the published
        // context says so where a list's and a board's do.
        StringAssert.Contains(
            description.EffectiveFilters!.Contexts
                .Single(context => context.Context.Contains("gallery", StringComparison.Ordinal)).Composition,
            "the surface's own filterClause children");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Gallery(
        string nodeId,
        params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "gallerySurface", 0,
            [
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion),
                ("entityId", "e"),
                .. properties,
            ]);

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Clause(
        string nodeId,
        string parentNodeId,
        string fieldId,
        string comparison,
        object? value) =>
        value is null
            ? Node(nodeId, parentNodeId, "filterClause", 1, ("fieldId", fieldId), ("operator", comparison))
            : Node(nodeId, parentNodeId, "filterClause", 1, ("fieldId", fieldId), ("operator", comparison), ("value", value));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 14, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "gallery.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.GalleryAndRatingMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-notes", "Notes", NendoStorageKind.Text, false, "longText", []),
                    new("e-due", "Due", NendoStorageKind.Date, false, "date", []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                ])
                {
                    DerivedFields =
                    [
                        new NendoDerivedFieldSnapshot("e-calc", "Calc", "entity.e.calc", NendoBehaviourScalar.Text, false, "Concat(name, '!')"),
                    ],
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
