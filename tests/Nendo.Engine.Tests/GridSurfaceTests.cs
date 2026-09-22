using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The two grid kinds, ADR-0004 2026-09-17 amendment, slice S6.
/// <para>
/// A matrix crosses two closed groupings and states one exact number in every cell; a
/// ranking states the few records at the top of one stored number. What is asserted here
/// is what each refuses and why: the axes must differ, the cross product must fit the
/// ceiling the grouped read already publishes, a ranking ranks a number rather than a
/// date, and its limit is refused above the ceiling rather than narrowed.
/// </para>
/// </summary>
[TestClass]
public sealed class GridSurfaceTests
{
    [TestMethod]
    public void AMatrixCompilesAndMovesTheFileToTheGridsRung()
    {
        var nodes = new[]
        {
            Matrix("grid", "e-status", "e-priority"),
            Binding("grid-name", "grid", "e-name"),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var matrix = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("matrixSurface", matrix.Kind);
        Assert.AreEqual("e-status", matrix.Properties["rowByFieldId"].GetString());
        Assert.AreEqual("e-priority", matrix.Properties["columnByFieldId"].GetString());
        Assert.AreEqual(NendoFormat.GridsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(nodes, []).Any(feature => feature.Name == "a matrix or a ranked list"));
    }

    /// <summary>
    /// A field against itself fills one diagonal and leaves every other cell empty, which
    /// states nothing a breakdown chart does not state better.
    /// </summary>
    [TestMethod]
    public void AMatrixRefusesTheSameFieldOnBothAxes()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Matrix("grid", "e-status", "e-status"),
            Binding("grid-name", "grid", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI412"), Messages(compiled));
        StringAssert.Contains(Messages(compiled), "two different fields");
    }

    /// <summary>
    /// An axis is a closed set of values, which is the grouping rule a chart already uses:
    /// a single choice or a Boolean, and nothing else closes it.
    /// </summary>
    [TestMethod]
    public void AnAxisMustBeAClosedGrouping()
    {
        foreach (var (row, column, code) in new[]
        {
            ("e-name", "e-priority", "NUI410"),
            ("e-status", "e-amount", "NUI411"),
        })
        {
            var compiled = new NendoSemanticCompiler().Compile(Source(
            [
                Matrix("grid", row, column),
                Binding("grid-name", "grid", "e-name"),
            ]));

            Assert.IsFalse(compiled.IsValid, $"{row} against {column} should be refused.");
            Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == code), Messages(compiled));
        }
    }

    [TestMethod]
    public void ABooleanIsAnAxisAsItIsAChartGrouping()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Matrix("grid", "e-status", "e-flag"),
            Binding("grid-name", "grid", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    /// <summary>
    /// The ceiling is spent on the cross product, and the author is refused while building
    /// rather than a person finding out while reading. The unset lane on each axis is one
    /// row and one column of that total, which the refusal says.
    /// </summary>
    [TestMethod]
    public void AGridWiderThanTheCeilingIsRefusedWhenItIsAuthored()
    {
        var wide = Enumerable.Range(0, 30).Select(index => $"o{index}").ToArray();
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Matrix("grid", "e-wide", "e-wider"),
            Binding("grid-name", "grid", "e-name"),
        ], wide));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI413"), Messages(compiled));
        StringAssert.Contains(Messages(compiled), "961 cells");
        StringAssert.Contains(Messages(compiled), "unset lane");
    }

    /// <summary>
    /// The read raises the same refusal, because two option sets change without the screen
    /// being touched: a definition that compiled a year ago cannot be un-compiled.
    /// </summary>
    [TestMethod]
    public void TheReadRefusesAGridThatGrewPastTheCeiling()
    {
        var rows = Enumerable.Range(0, 30).Select(index => $"r{index}").ToArray();
        var columns = Enumerable.Range(0, 30).Select(index => $"c{index}").ToArray();

        var failure = Assert.ThrowsExactly<NendoValidationException>(
            () => _ = new CellAggregateFold(rows, columns, "count", integral: true));

        StringAssert.Contains(failure.Message, "961 cells");
        StringAssert.Contains(failure.Message, "366");
    }

    [TestMethod]
    public void AMatrixTakesNoAggregateBecauseItCounts()
    {
        var matrix = NendoSemanticVocabulary.Description().Kinds.Single(kind => kind.Kind == "matrixSurface");

        Assert.IsFalse(matrix.Properties.Contains("aggregate"), "A matrix counts; its cells state a number beside the cards they hold.");
        Assert.IsFalse(matrix.Properties.Contains("fieldId"), "A matrix counts and reads no field.");
        Assert.IsTrue(matrix.CanBeRoot);
        CollectionAssert.AreEquivalent(
            new[] { "definitionVersion", "entityId", "rowByFieldId", "columnByFieldId" }, matrix.RequiredProperties.ToArray());
    }

    [TestMethod]
    public void ARankingCompilesOnTheFrontPageAndMovesTheFileToTheGridsRung()
    {
        var nodes = new[]
        {
            Overview("front"),
            Node("ranking", "front", "rankedList", 0,
                ("entityId", "e"), ("rankByFieldId", "e-amount"), ("limit", 10), ("title", "Largest")),
            Binding("ranking-name", "ranking", "e-name"),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var ranking = compiled.Overview!.Surface.Children.Single(child => child.Kind == "rankedList");
        Assert.AreEqual("e-amount", ranking.Properties["rankByFieldId"].GetString());
        Assert.AreEqual(NendoFormat.GridsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    /// <summary>
    /// min and max over a Date are comparisons, which is why a range tile reads one; a bar
    /// is arithmetic, so a ranking does not. The refusal says which of the two it is.
    /// </summary>
    [TestMethod]
    public void ARankingRefusesADateByName()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("ranking", "front", "rankedList", 0, ("entityId", "e"), ("rankByFieldId", "e-due")),
            Binding("ranking-name", "ranking", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI420"), Messages(compiled));
        StringAssert.Contains(Messages(compiled), "Date");
        StringAssert.Contains(Messages(compiled), "bar");
    }

    [TestMethod]
    public void ARankingIsRefusedAboveItsCeilingRatherThanNarrowed()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Overview("front"),
            Node("ranking", "front", "rankedList", 0, ("entityId", "e"), ("rankByFieldId", "e-amount"), ("limit", 51)),
            Binding("ranking-name", "ranking", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI421"), Messages(compiled));
        StringAssert.Contains(Messages(compiled), "1 and 50");
    }

    /// <summary>
    /// A ranking belongs where a recent list belongs. On a surface that already has a
    /// record type, a list ordered by the same field shows the same records with a pager.
    /// </summary>
    [TestMethod]
    public void ARankingIsRefusedOutsideTheFrontPage()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("ranking", "list", "rankedList", 1, ("entityId", "e"), ("rankByFieldId", "e-amount")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        StringAssert.Contains(Messages(compiled), "rankedList");
    }

    /// <summary>
    /// The host adds one predicate to keep the records that have a number, so an author
    /// carries seven clauses rather than eight — and the refusal names the one it adds,
    /// since an author who spends all eight cannot otherwise know why seven is the number.
    /// </summary>
    [TestMethod]
    public void SevenAuthoredClausesFitBesideThePredicateTheHostAdds()
    {
        var seven = new List<NendoUiNodeSnapshot>
        {
            Overview("front"),
            Node("ranking", "front", "rankedList", 0, ("entityId", "e"), ("rankByFieldId", "e-amount")),
            Binding("ranking-name", "ranking", "e-name"),
        };
        for (var index = 0; index < 7; index++)
            seven.Add(Node($"clause{index}", "ranking", "filterClause", index, ("fieldId", "e-flag"), ("operator", "eq"), ("value", true)));
        Assert.IsTrue(new NendoSemanticCompiler().Compile(Source([.. seven])).IsValid);

        seven.Add(Node("clause7", "ranking", "filterClause", 7, ("fieldId", "e-flag"), ("operator", "ne"), ("value", false)));
        var refused = new NendoSemanticCompiler().Compile(Source([.. seven]));

        Assert.IsFalse(refused.IsValid);
        Assert.IsTrue(refused.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI300"), Messages(refused));
        StringAssert.Contains(Messages(refused), "records that have a number to rank");
    }

    [TestMethod]
    public void TheVocabularyPublishesTheTwoCeilingsAndWhatFollowsFromOneCrossedRead()
    {
        var description = NendoSemanticVocabulary.Description();
        var grids = description.Grids!;

        Assert.AreEqual(366, grids.MaximumCells);
        Assert.AreEqual(50, grids.MaximumRankedListRows);
        StringAssert.Contains(grids.Note, "before a record is read");
        StringAssert.Contains(grids.Note, "different fields");
        StringAssert.Contains(grids.Note, "refused by name");

        var ranking = description.Kinds.Single(kind => kind.Kind == "rankedList");
        Assert.IsFalse(ranking.CanBeRoot);
        CollectionAssert.AreEquivalent(new[] { "entityId", "rankByFieldId" }, ranking.RequiredProperties.ToArray());

        foreach (var property in new[] { "rowByFieldId", "columnByFieldId", "rankByFieldId" })
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), property);
    }

    /// <summary>
    /// Every property of both kinds reads as a person would say it in review. The failure
    /// this guards against has happened twice already and looks like success both times: a
    /// property with no sentence of its own falls through to a generic one, or worse, to a
    /// confident sentence about a node kind it is not.
    /// </summary>
    [TestMethod]
    public void EveryPropertyOfBothKindsReadsAsAPersonWouldSayIt()
    {
        Assert.AreEqual("Add a matrix crossing two choice fields, with an exact count in every cell.",
            Summary(new AddUiNodeOperation("o", "s", "grid", null, "matrixSurface", 0)));
        Assert.AreEqual("Rank the records of one record type by a number, largest first, each with a bar.",
            Summary(new AddUiNodeOperation("o", "s", "ranking", null, "rankedList", 0)));

        Assert.AreEqual("Make one row per Status.", Summary(Property("grid", "rowByFieldId", "e-status")));
        Assert.AreEqual("Make one column per Priority.", Summary(Property("grid", "columnByFieldId", "e-priority")));
        Assert.AreEqual("Rank the records by Amount.", Summary(Property("ranking", "rankByFieldId", "e-amount")));

        // A limit means two different things on the two kinds that carry one.
        Assert.AreEqual("Rank at most 10 of them.", Summary(Property("ranking", "limit", 10)));
        Assert.AreEqual("Rank largest first.", Summary(Property("ranking", "orderDirection", "descending")));
        Assert.AreEqual("Rank smallest first.", Summary(Property("ranking", "orderDirection", "ascending")));
        Assert.AreEqual("Label the ranking Biggest.", Summary(Property("ranking", "title", "Biggest")));
        Assert.AreEqual("Read Example for this number.", Summary(Property("ranking", "entityId", "e")));
        Assert.AreEqual("Name the surface Work by state.", Summary(Property("grid", "title", "Work by state")));

        foreach (var (nodeId, property, value) in new (string, string, object)[]
        {
            ("grid", "rowByFieldId", "e-status"), ("grid", "columnByFieldId", "e-priority"), ("grid", "title", "T"),
            ("ranking", "rankByFieldId", "e-amount"), ("ranking", "limit", 5), ("ranking", "orderDirection", "descending"),
            ("ranking", "title", "T"), ("ranking", "entityId", "e"),
        })
        {
            var summary = Summary(Property(nodeId, property, value));
            StringAssert.DoesNotMatch(summary, new System.Text.RegularExpressions.Regex("^Set [A-Z]"),
                $"{nodeId}.{property} falls through to the generic sentence: {summary}");
            StringAssert.DoesNotMatch(summary, new System.Text.RegularExpressions.Regex("matrixSurface|rankedList"),
                $"{nodeId}.{property} prints its own kind name rather than a person's words: {summary}");
        }
    }

    private static string Summary(NendoOperation operation)
    {
        var nodes = new[]
        {
            Node("grid", null, "matrixSurface", 0),
            Node("ranking", null, "rankedList", 1),
        };
        var entries = SemanticDiff.From(
            new NendoChangeSet([new NendoMutation("m", "diff-definition", "test", "Grids", [operation])]),
            Source(nodes));
        return entries[0].Summary;
    }

    private static SetUiPropertyOperation Property(string nodeId, string propertyName, object value) =>
        new("o", "s", nodeId, propertyName, JsonSerializer.SerializeToElement(value));

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message} {d.Hint}"));

    private static NendoUiNodeSnapshot List(string nodeId) =>
        Node(nodeId, null, "recordList", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items"));

    private static NendoUiNodeSnapshot Overview(string nodeId) =>
        Node(nodeId, null, "overviewSurface", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("title", "Front page"));

    private static NendoUiNodeSnapshot Matrix(string nodeId, string rowByFieldId, string columnByFieldId) =>
        Node(nodeId, null, "matrixSurface", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Grid"),
            ("rowByFieldId", rowByFieldId), ("columnByFieldId", columnByFieldId));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Node(
        string nodeId, string? parentNodeId, string kind, int position,
        params (string Name, object Value)[] properties) => new(
            "s", nodeId, parentNodeId, kind, position,
            properties.ToDictionary(
                property => property.Name,
                property => JsonSerializer.SerializeToElement(property.Value),
                StringComparer.Ordinal));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, string[]? wideOptions = null)
    {
        var now = new DateTimeOffset(2026, 9, 17, 8, 0, 0, TimeSpan.Zero);
        var options = wideOptions ?? [];
        return new NendoSessionSnapshot(
            "grids.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.GridsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-status", "Status", NendoStorageKind.Text, false, "singleChoice", ["open", "won"]),
                    new("e-priority", "Priority", NendoStorageKind.Text, false, "singleChoice", ["low", "high"]),
                    new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
                    new("e-amount", "Amount", NendoStorageKind.Decimal, false, null, []),
                    new("e-due", "Due", NendoStorageKind.Date, false, null, []),
                    new("e-wide", "Wide", NendoStorageKind.Text, false, "singleChoice", options),
                    new("e-wider", "Wider", NendoStorageKind.Text, false, "singleChoice", options),
                ]),
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
