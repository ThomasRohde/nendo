using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The overview page, ADR-0004's 2026-09-14 amendment (S4): the first root that
/// belongs to the file rather than to a record type. Every rule here follows from
/// that one fact — the root has no <c>entityId</c>, so each tile, chart and recent
/// list under it names the type it reads, and anything that needs a record in hand
/// has nothing to read and is refused rather than drawn empty. The range tile and
/// the recent list arrive with it, and the range is the one aggregate that reads a
/// Date.
/// </summary>
[TestClass]
public sealed class OverviewSurfaceTests
{
    [TestMethod]
    public void AnOverviewCompilesAsItsOwnPlanWithEachTileNamingTheRecordTypeItReads()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front", ("title", "Everything"), ("description", "What this file is for.")),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
            Node("front-stage", "front", "breakdownChart", 1, ("entityId", "e"), ("aggregate", "count"), ("groupByFieldId", "e-stage")),
            Node("front-span", "front", "rangeTile", 2, ("entityId", "e"), ("fieldId", "e-due")),
            Node("front-recent", "front", "recentList", 3, ("entityId", "f"), ("limit", 5), ("orderByFieldId", "f-name")),
            Binding("front-recent-name", "front-recent", "f-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var overview = compiled.Overview;
        Assert.IsNotNull(overview, "The front page is its own plan.");
        Assert.AreEqual("overviewSurface", overview.Surface.Kind);
        Assert.AreEqual("What this file is for.", overview.Surface.Properties["description"].GetString());
        Assert.IsFalse(overview.Surface.Properties.ContainsKey("entityId"));

        // It is not one of the record types' applications, and it has not quietly
        // become one of them either.
        Assert.IsEmpty(compiled.Applications);
        CollectionAssert.AreEqual(
            new[] { "summaryTile", "breakdownChart", "rangeTile", "recentList" },
            overview.Surface.Children.Select(child => child.Kind).ToArray());
        Assert.AreEqual("f", overview.Surface.Children.Single(child => child.Kind == "recentList").Properties["entityId"].GetString());
    }

    /// <summary>
    /// A record type's own surfaces still compile beside the front page: an overview
    /// is an addition to the file, not a replacement for what a type already has.
    /// </summary>
    [TestMethod]
    public void TheFrontPageCompilesBesideTheRecordTypesOwnSurfaces()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
            Node("list", null, "recordList", 1, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("list-name", "list", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.IsNotNull(compiled.Overview);
        Assert.AreEqual("e", compiled.Applications.Single().Entity.SemanticId);
    }

    [TestMethod]
    public void TheFrontPageHasNoRecordTypeOfItsOwn()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("front", null, "overviewSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI390");
        Assert.AreEqual("front", refusal.SemanticId);
        Assert.AreEqual("entityId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Hint!, "name the record type on each tile");
    }

    /// <summary>
    /// One per file. The ceiling and the sentence come from the vocabulary table a
    /// client reads, so a refusal cannot name a rule the description does not carry.
    /// </summary>
    [TestMethod]
    public void AFileOwnsOneFrontPage()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
            Overview("front-two"),
            Node("front-two-count", "front-two", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI391");
        StringAssert.Contains(refusal.Message, "has 2 overviewSurface roots");
        StringAssert.Contains(refusal.Hint!, "A file owns at most one overviewSurface root.");
        Assert.IsNull(compiled.Overview);
    }

    [TestMethod]
    [DataRow("summaryTile")]
    [DataRow("breakdownChart")]
    [DataRow("progressTile")]
    [DataRow("rangeTile")]
    [DataRow("recentList")]
    public void EveryTileOnTheFrontPageNamesTheRecordTypeItReads(string kind)
    {
        (string Name, object Value)[] own = kind switch
        {
            "summaryTile" => [("aggregate", "count")],
            "breakdownChart" => [("aggregate", "count"), ("groupByFieldId", "e-stage")],
            "rangeTile" => [("fieldId", "e-due")],
            "recentList" => [("title", "Lately")],
            _ => [("title", "Done")],
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-tile", "front", kind, 0, own),
            .. kind == "recentList"
                ? new[] { Binding("front-tile-name", "front-tile", "e-name") }
                : [Clause("front-tile-open", "front-tile", "e-stage", "ne", "done")],
        ]));

        Assert.IsFalse(compiled.IsValid, $"A {kind} on the front page has no record type to inherit.");
        // A recentList exists only on the front page, so the vocabulary table can
        // require its entityId outright and the structural check refuses it first.
        // The four kinds that also live on a surface cannot be required to carry
        // one there, so they are refused by the front page's own rule instead.
        var expected = kind == "recentList" ? "NUI091" : "NUI392";
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == expected);
        Assert.AreEqual("front-tile", refusal.SemanticId);
        Assert.AreEqual("entityId", refusal.PropertyPath);
    }

    [TestMethod]
    public void ATileNamingARecordTypeThatIsNotThereIsRefusedByName()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "ghost"), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI393");
        StringAssert.Contains(refusal.Message, "'ghost'");
        Assert.AreEqual("entityId", refusal.PropertyPath);
    }

    /// <summary>
    /// The other half of the rule, and the reason it is a refusal rather than a
    /// silent preference: a tile that named one record type on a surface about
    /// another would have two answers to one question.
    /// </summary>
    [TestMethod]
    public void ATileOnASurfaceTakesItsRecordTypeFromThatSurface()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("list", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("list-name", "list", "e-name"),
            Node("list-count", "list", "summaryTile", 1, ("entityId", "f"), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI394");
        Assert.AreEqual("list-count", refusal.SemanticId);
        Assert.AreEqual("entityId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Hint!, "Only a tile on an overviewSurface names one");
    }

    [TestMethod]
    public void ARecentListBelongsOnTheFrontPage()
    {
        // A section is shared with the record page, which is the only way a recent
        // list can be parented anywhere but the front page at all.
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("page", null, "detailSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("page-name", "page", "e-name"),
            Node("page-section", "page", "section", 1, ("title", "Lately")),
            Node("page-recent", "page-section", "recentList", 0, ("entityId", "e")),
            Binding("page-recent-name", "page-recent", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI395");
        Assert.AreEqual("page-recent", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint!, "a list shows the same records with a pager");
    }

    /// <summary>
    /// The ceiling is refused, never narrowed: a limit the host quietly reduced
    /// would leave the stored definition and the screen saying different things.
    /// </summary>
    [TestMethod]
    [DataRow(1, true)]
    [DataRow(10, true)]
    [DataRow(0, false)]
    [DataRow(11, false)]
    public void ARecentListShowsBetweenOneAndTheStatedCeiling(int limit, bool accepted)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-recent", "front", "recentList", 0, ("entityId", "e"), ("limit", limit)),
            Binding("front-recent-name", "front-recent", "e-name"),
        ]));

        Assert.AreEqual(accepted, compiled.IsValid, Messages(compiled));
        if (accepted) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI396");
        Assert.AreEqual("limit", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, $"1 and {NendoSemanticVocabulary.MaximumRecentListRows}");
        StringAssert.Contains(refusal.Hint!, "refused rather than narrowed");
    }

    [TestMethod]
    public void ARecentListShowsAtLeastOneField()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-recent", "front", "recentList", 0, ("entityId", "e")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("front-recent", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI401").SemanticId);
    }

    [TestMethod]
    [DataRow("e-count", true)]
    [DataRow("e-score", true)]
    [DataRow("e-due", true)]
    [DataRow("e-name", false)]
    [DataRow("e-when", false)]
    [DataRow("e-gone", false)]
    public void ARangeReadsANumberOrACivilDateAndNothingElse(string fieldId, bool accepted)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-range", "front", "rangeTile", 0, ("entityId", "e"), ("fieldId", fieldId)),
        ]));

        Assert.AreEqual(accepted, compiled.IsValid, Messages(compiled));
        if (accepted) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI397");
        Assert.AreEqual("front-range", refusal.SemanticId);
        Assert.AreEqual("fieldId", refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", "Integer, Decimal or Date");
    }

    /// <summary>A calculated field is refused for what it is, once, as everywhere.</summary>
    [TestMethod]
    public void ACalculatedFieldHasNoRange()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-range", "front", "rangeTile", 0, ("entityId", "e"), ("fieldId", "e-calc")),
        ]));

        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI214");
        Assert.AreEqual("fieldId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "take a range of it");
        Assert.IsFalse(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI397"),
            "A calculated field is refused once, for what it is.");
    }

    [TestMethod]
    [DataRow("fieldBinding")]
    [DataRow("relatedList")]
    public void ANodeThatNeedsARecordIsRefusedOnTheFrontPage(string kind)
    {
        (string Name, object Value)[] needs = kind == "fieldBinding"
            ? [("fieldId", "e-name")]
            : [("targetEntityId", "f"), ("viaFieldId", "f-owner")];
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
            Node("front-section", "front", "section", 1, ("title", "Recent")),
            Node("front-needs-record", "front-section", kind, 0, needs),
        ]));

        Assert.IsFalse(compiled.IsValid, $"A {kind} has no record to read on the front page.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI398");
        Assert.AreEqual("front-needs-record", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint!, "Use a recentList");
    }

    [TestMethod]
    public void ThereIsNoRecordOnTheFrontPageForAVisibilityCalculationToRead()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-section", "front", "section", 0, ("title", "Recent"), ("visibleWhen", "e-flag")),
            Node("front-count", "front-section", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI399");
        Assert.AreEqual("front-section", refusal.SemanticId);
        Assert.AreEqual("visibleWhen", refusal.PropertyPath);
    }

    [TestMethod]
    public void AFrontPageThatReadsNothingIsRefused()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front", ("description", "A file with nothing on its front page.")),
            Node("front-section", "front", "section", 0, ("title", "Empty")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI400");
        Assert.AreEqual("front", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint!, "each naming the record type it reads");
    }

    /// <summary>
    /// A trend chart and an activity grid read records as surely as a tile does. The
    /// check that a front page reads something used to leave both kinds out, so a front
    /// page holding only one of them was refused as showing nothing.
    /// </summary>
    [TestMethod]
    [DataRow("trendChart")]
    [DataRow("activityGrid")]
    public void AFrontPageWithOnlyAChartOverTimeReadsSomething(string kind)
    {
        (string Name, object Value)[] properties = kind == "trendChart"
            ? [("entityId", "e"), ("dateFieldId", "e-due"), ("bucket", "month"), ("range", "last12Months"), ("aggregate", "count")]
            : [("entityId", "e"), ("dateFieldId", "e-due"), ("range", "thisYear")];
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("front-chart", "front", kind, 0, properties),
        ]));

        Assert.IsFalse(
            compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI400"),
            Messages(compiled));
        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    /// <summary>
    /// An overview adds no predicate of its own, so a tile on it carries the whole
    /// budget of eight and the ninth clause refuses with the count.
    /// </summary>
    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void ATileOnTheFrontPageCarriesTheWholeFilterBudget(int clauses, bool accepted)
    {
        NendoUiNodeSnapshot[] nodes =
        [
            Overview("front"),
            Node("front-count", "front", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count")),
            .. Enumerable.Range(0, clauses).Select(index =>
                Clause($"front-count-{index}", "front-count", "e-stage", "ne", "done")),
        ];
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.AreEqual(accepted, compiled.IsValid, Messages(compiled));
        if (accepted) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300");
        StringAssert.Contains(refusal.Message, "composes 9 effective filters");
    }

    /// <summary>
    /// The rung is computed from the tree's shape. A range tile reaches it without
    /// an overview, because a host that does not compile the kind cannot draw it
    /// wherever it sits.
    /// </summary>
    [TestMethod]
    [DataRow("overviewSurface")]
    [DataRow("recentList")]
    [DataRow("rangeTile")]
    public void EachNewKindRaisesTheFileToTheOverviewRung(string kind)
    {
        var required = NendoSemanticCapability.RequiredHostVersion(
        [
            Node("n", null, kind, 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion)),
        ], []);

        Assert.AreEqual(NendoFormat.OverviewMinimumHostVersion, required);
        // The ladder is monotone, so the newest rung is the host's own version.
        // Compared through Version rather than as two constants, which the
        // analyzer reads as a comparison that cannot fail.
        Assert.IsTrue(Version.Parse(NendoFormat.CurrentHostVersion) >= Version.Parse(required),
            "A host never advertises a later feature than it has.");
    }

    [TestMethod]
    public void TheVocabularyPublishesTheFrontPageItsCeilingAndItsNotes()
    {
        var description = NendoSemanticVocabulary.Description();
        var overview = description.Kinds.Single(kind => kind.Kind == "overviewSurface");

        Assert.IsTrue(overview.CanBeRoot);
        // The ceiling is per file, and it says so: a client reading only the
        // per-entity number would find nothing and infer no ceiling at all.
        Assert.IsNull(overview.MaxRootsPerEntity);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumOverviewRootsPerFile, overview.MaxRootsPerFile);
        StringAssert.Contains(overview.RootCardinality!, "A file owns at most one overviewSurface root.");
        Assert.IsFalse(overview.Properties.Contains("entityId"), "The front page has no record type of its own.");
        CollectionAssert.AreEquivalent(
            new[] { "section", "tabGroup", "summaryTile", "breakdownChart", "progressTile", "rangeTile", "trendChart", "activityGrid", "recentList", "rankedList" },
            overview.Children.ToArray());

        foreach (var property in new[] { "entityId", "description", "limit" })
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), $"{property} needs a note");
        StringAssert.Contains(description.PropertyNotes!["entityId"], "An overviewSurface has none");
        StringAssert.Contains(description.PropertyNotes["limit"], "Refused above it rather than clamped");

        Assert.AreEqual(NendoSemanticVocabulary.MaximumRecentListRows, description.Overview!.MaximumRecentListRows);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumOverviewRootsPerFile, description.Overview.MaximumRootsPerFile);
        StringAssert.Contains(description.Overview.Note, "A rangeTile is not a chart");

        // The published budget table names the context the compiler charges a
        // front-page tile under, so the stated rule and the rule that refuses
        // cannot drift.
        StringAssert.Contains(
            string.Join(" | ", description.EffectiveFilters!.Contexts.Select(context => $"{context.Context}: {context.Composition}")),
            "Overview tile, chart or recent list: its own clauses");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Overview(string nodeId, params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "overviewSurface", 0,
            [("definitionVersion", NendoSemanticVocabulary.ContractVersion), .. properties]);

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Clause(
        string nodeId,
        string parentNodeId,
        string fieldId,
        string comparison,
        object value) =>
        Node(nodeId, parentNodeId, "filterClause", 1, ("fieldId", fieldId), ("operator", comparison), ("value", value));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 15, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "overview.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.OverviewMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-count", "Count", NendoStorageKind.Integer, false, null, []),
                    new("e-score", "Score", NendoStorageKind.Decimal, false, null, []),
                    new("e-due", "Due", NendoStorageKind.Date, false, "date", []),
                    new("e-when", "When", NendoStorageKind.DateTime, false, null, []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                ])
                {
                    DerivedFields =
                    [
                        new NendoDerivedFieldSnapshot("e-calc", "Calc", "entity.e.calc", NendoBehaviourScalar.Integer, false, "count + 1"),
                        new NendoDerivedFieldSnapshot("e-flag", "Flag", "entity.e.flag", NendoBehaviourScalar.Boolean, false, "count > 1"),
                    ],
                },
                new NendoEntitySnapshot("f", "Other",
                [
                    new("f-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("f-owner", "Owner", NendoStorageKind.Reference, false, null, []),
                ]),
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
