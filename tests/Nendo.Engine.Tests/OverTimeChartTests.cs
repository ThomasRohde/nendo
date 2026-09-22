using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The two kinds that group by a civil date, ADR-0004 2026-09-16 amendment, slice S5.
/// <para>
/// What is particular about them is that their groups are generated rather than declared,
/// and everything asserted here follows from that: a bucket with nothing in it still exists,
/// the range is a closed word rather than a date so a stored screen cannot go stale, and the
/// bounds the host resolves are two predicates an author is charged for.
/// </para>
/// </summary>
[TestClass]
public sealed class OverTimeChartTests
{
    [TestMethod]
    public void ATrendCompilesOnAListAndMovesTheFileToTheOverTimeRung()
    {
        var nodes = new[]
        {
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("trend", "list", "trendChart", 1,
                ("dateFieldId", "e-due"), ("bucket", "month"), ("range", "last12Months"),
                ("aggregate", "sum"), ("fieldId", "e-amount"), ("title", "Amount by month")),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var trend = compiled.Applications.Single().Surfaces.Single().Children.Single(child => child.Kind == "trendChart");
        Assert.AreEqual("e-due", trend.Properties["dateFieldId"].GetString());
        Assert.AreEqual("month", trend.Properties["bucket"].GetString());
        Assert.AreEqual(NendoFormat.OverTimeMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(nodes, []).Any(feature => feature.Name == "a chart over time"));
    }

    [TestMethod]
    public void AnActivityGridCompilesAndTakesNoAggregate()
    {
        var nodes = new[]
        {
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("grid", "list", "activityGrid", 1, ("dateFieldId", "e-due"), ("range", "thisYear")),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var grid = compiled.Applications.Single().Surfaces.Single().Children.Single(child => child.Kind == "activityGrid");
        Assert.IsFalse(grid.Properties.ContainsKey("aggregate"), "A grid counts; it has no aggregate to state.");
        Assert.AreEqual(NendoFormat.OverTimeMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    /// <summary>
    /// A grid toned by a sum is a heat map of a number nobody can read back off the square,
    /// so the property is not on the kind at all and the compiler says which property it is.
    /// </summary>
    [TestMethod]
    public void AnActivityGridRefusesAnAggregateByName()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("grid", "list", "activityGrid", 1,
                ("dateFieldId", "e-due"), ("range", "thisYear"), ("aggregate", "sum"), ("fieldId", "e-amount")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        StringAssert.Contains(Messages(compiled), "aggregate");
    }

    [TestMethod]
    public void ADateTimeIsRefusedByNameRatherThanTruncated()
    {
        foreach (var (kind, properties) in new (string, (string, object)[])[]
        {
            ("trendChart", [("dateFieldId", "e-moment"), ("bucket", "month"), ("range", "last12Months"), ("aggregate", "count")]),
            ("activityGrid", [("dateFieldId", "e-moment"), ("range", "thisYear")]),
        })
        {
            var compiled = new NendoSemanticCompiler().Compile(Source([List("list"), Binding("list-name", "list", "e-name"), Node("node", "list", kind, 1, properties)]));
            Assert.IsFalse(compiled.IsValid, kind);
            var message = Messages(compiled);
            StringAssert.Contains(message, "DateTime", kind);
            StringAssert.Contains(message, "time zone", kind);
        }
    }

    [TestMethod]
    public void AWordOutsideItsKindsClosedSetIsRefusedAndTheRefusalListsTheSet()
    {
        // thisYear is a real range word — for the other kind. A set is per kind because a
        // grid draws one square per day and only a year-shaped range fits its ceiling.
        var trend = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("trend", "list", "trendChart", 1,
                ("dateFieldId", "e-due"), ("bucket", "month"), ("range", "thisYear"), ("aggregate", "count")),
        ]));
        Assert.IsFalse(trend.IsValid);
        StringAssert.Contains(Messages(trend), "last12Months");

        var grid = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("grid", "list", "activityGrid", 1, ("dateFieldId", "e-due"), ("range", "last30Days")),
        ]));
        Assert.IsFalse(grid.IsValid);
        StringAssert.Contains(Messages(grid), "thisYear");

        var bucket = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("trend", "list", "trendChart", 1,
                ("dateFieldId", "e-due"), ("bucket", "day"), ("range", "last12Months"), ("aggregate", "count")),
        ]));
        Assert.IsFalse(bucket.IsValid);
        StringAssert.Contains(Messages(bucket), "activityGrid");
    }

    /// <summary>
    /// The two bounds the host resolves are predicates in the query, so an author gets two
    /// fewer clauses here than on a tile elsewhere — and the refusal says so, because
    /// somebody who has spent six and been refused cannot otherwise tell why six was the
    /// number.
    /// </summary>
    [TestMethod]
    public void TheRangeSpendsTwoOfTheFilterBudgetAndTheRefusalNamesThem()
    {
        var nodes = new List<NendoUiNodeSnapshot> { List("list"), Binding("list-name", "list", "e-name") };
        for (var index = 0; index < 7; index++)
            nodes.Add(Node($"clause{index}", "trend", "filterClause", index, ("fieldId", "e-flag"), ("operator", "eq"), ("value", true)));
        nodes.Add(Node("trend", "list", "trendChart", 1,
            ("dateFieldId", "e-due"), ("bucket", "month"), ("range", "last12Months"), ("aggregate", "count")));

        var compiled = new NendoSemanticCompiler().Compile(Source([.. nodes]));

        Assert.IsFalse(compiled.IsValid);
        var message = Messages(compiled);
        StringAssert.Contains(message, "2 date bounds of its range the host adds");
        StringAssert.Contains(message, "NUI300");
    }

    /// <summary>Six is accepted, which is what makes the seventh a boundary rather than a guess.</summary>
    [TestMethod]
    public void SixAuthoredClausesFitBesideTheTwoBoundsTheHostAdds()
    {
        var nodes = new List<NendoUiNodeSnapshot> { List("list"), Binding("list-name", "list", "e-name") };
        for (var index = 0; index < 6; index++)
            nodes.Add(Node($"clause{index}", "trend", "filterClause", index, ("fieldId", "e-flag"), ("operator", "eq"), ("value", true)));
        nodes.Add(Node("trend", "list", "trendChart", 1,
            ("dateFieldId", "e-due"), ("bucket", "month"), ("range", "last12Months"), ("aggregate", "count")));

        var compiled = new NendoSemanticCompiler().Compile(Source([.. nodes]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    [TestMethod]
    public void TheVocabularyPublishesTheClosedWordsAndWhatFollowsFromGeneratedGroups()
    {
        var description = NendoSemanticVocabulary.Description();
        var overTime = description.OverTime!;

        CollectionAssert.AreEquivalent(new[] { "month", "week" }, overTime.TrendBuckets.ToArray());
        CollectionAssert.AreEquivalent(
            new[] { "last12Months", "last6Months", "last90Days", "last30Days" }, overTime.TrendRanges.ToArray());
        CollectionAssert.AreEquivalent(new[] { "thisYear", "lastTwelveMonths" }, overTime.ActivityRanges.ToArray());
        StringAssert.Contains(overTime.Note, "never a stored date");
        StringAssert.Contains(overTime.Note, "refused by name");

        var trend = description.Kinds.Single(kind => kind.Kind == "trendChart");
        Assert.IsFalse(trend.CanBeRoot);
        CollectionAssert.AreEquivalent(
            new[] { "dateFieldId", "bucket", "range", "aggregate" }, trend.RequiredProperties.ToArray());
        var grid = description.Kinds.Single(kind => kind.Kind == "activityGrid");
        Assert.IsFalse(grid.Properties.Contains("aggregate"), "A grid counts and reads no field.");
        Assert.IsFalse(grid.Properties.Contains("fieldId"), "A grid counts and reads no field.");

        foreach (var property in new[] { "bucket", "range" })
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), property);
    }

    /// <summary>
    /// A related list takes no chart, and did not take one in S1 either. A kind accepted
    /// where nothing draws it compiles and then silently disappears, which is the failure
    /// this asserts against rather than a preference about layout.
    /// </summary>
    [TestMethod]
    public void ARelatedListTakesNoChartOverTime()
    {
        var related = NendoSemanticVocabulary.Description().Kinds.Single(kind => kind.Kind == "relatedList");
        CollectionAssert.DoesNotContain(related.Children.ToArray(), "trendChart");
        CollectionAssert.DoesNotContain(related.Children.ToArray(), "activityGrid");
    }

    /// <summary>
    /// Every property of both kinds reads as a person would say it in review.
    /// <para>
    /// This exists because the failure it guards against has already happened twice, and it
    /// looks like success both times. A property with no sentence of its own falls through
    /// to a generic one — F-038 was a cleared front-page description reviewed as
    /// "Say what this file is for: a description", a sentence that reads as a value the
    /// author typed. Authoring these kinds against a host built before them produced
    /// "Add a trendChart node", "Set Bucket", "Set Range" and, worst of the four,
    /// "Place each record on the calendar by Completed on" — a confident sentence about a
    /// calendar, for a chart that is not one.
    /// </para>
    /// </summary>
    [TestMethod]
    public void EveryPropertyOfBothKindsReadsAsAPersonWouldSayIt()
    {
        Assert.AreEqual("Add a trend chart, one exact number per month or week over a stretch of time.",
            Summary(new AddUiNodeOperation("o", "s", "trend", null, "trendChart", 0)));
        Assert.AreEqual("Add an activity grid, one square per day of a year toned by how much happened on it.",
            Summary(new AddUiNodeOperation("o", "s", "grid", null, "activityGrid", 0)));

        // dateFieldId is the one that fell through to the calendar's sentence.
        Assert.AreEqual("Count each record in the period of its Due.",
            Summary(Property("trend", "trendChart", "dateFieldId", "e-due")));
        Assert.AreEqual("Count each record in the period of its Due.",
            Summary(Property("grid", "activityGrid", "dateFieldId", "e-due")));

        // The closed words are said, not echoed: nobody reviews "Set Range: last12Months".
        Assert.AreEqual("Draw one column per month.", Summary(Property("trend", "trendChart", "bucket", "month")));
        Assert.AreEqual("Draw one column per week.", Summary(Property("trend", "trendChart", "bucket", "week")));
        Assert.AreEqual("Cover the last twelve months, ending with this one.",
            Summary(Property("trend", "trendChart", "range", "last12Months")));
        Assert.AreEqual("Cover the last thirty days, ending today.",
            Summary(Property("trend", "trendChart", "range", "last30Days")));
        Assert.AreEqual("Cover this calendar year, from January to December.",
            Summary(Property("grid", "activityGrid", "range", "thisYear")));
        Assert.AreEqual("Cover the twelve months ending today.",
            Summary(Property("grid", "activityGrid", "range", "lastTwelveMonths")));

        // A tile on the front page reads a record type; it does not bind a surface to one.
        Assert.AreEqual("Read Example for this number.", Summary(Property("trend", "trendChart", "entityId", "e")));
        Assert.AreEqual("Read Example for this number.", Summary(Property("grid", "activityGrid", "entityId", "e")));

        Assert.AreEqual("Label the trend Hours by month.", Summary(Property("trend", "trendChart", "title", "Hours by month")));
        Assert.AreEqual("Label the activity grid This year.", Summary(Property("grid", "activityGrid", "title", "This year")));
        Assert.AreEqual("Total Amount in each period.", Summary(Property("trend", "trendChart", "fieldId", "e-amount")));

        // And nothing in either kind falls through to the generic "Set <Property>." or to a
        // sentence about a node kind it is not.
        foreach (var (kind, property, value) in new[]
        {
            ("trendChart", "dateFieldId", "e-due"), ("trendChart", "bucket", "month"), ("trendChart", "range", "last12Months"),
            ("trendChart", "entityId", "e"), ("trendChart", "title", "T"), ("trendChart", "fieldId", "e-amount"),
            ("activityGrid", "dateFieldId", "e-due"), ("activityGrid", "range", "thisYear"),
            ("activityGrid", "entityId", "e"), ("activityGrid", "title", "T"),
        })
        {
            var summary = Summary(Property("n", kind, property, value));
            StringAssert.DoesNotMatch(summary, new System.Text.RegularExpressions.Regex("^Set [A-Z]"),
                $"{kind}.{property} falls through to the generic sentence: {summary}");
            StringAssert.DoesNotMatch(summary, new System.Text.RegularExpressions.Regex("on the calendar|on the timeline"),
                $"{kind}.{property} fell through to another kind's sentence: {summary}");
            StringAssert.DoesNotMatch(summary, new System.Text.RegularExpressions.Regex(kind),
                $"{kind}.{property} prints its own kind name rather than a person's words: {summary}");
        }
    }

    /// <summary>The diff for one operation, over a file whose node kinds the names table knows.</summary>
    private static string Summary(NendoOperation operation)
    {
        var nodes = new[]
        {
            Node("trend", null, "trendChart", 0),
            Node("grid", null, "activityGrid", 1),
            Node("n", null, "trendChart", 2),
        };
        var entries = SemanticDiff.From(
            new NendoChangeSet([new NendoMutation("m", "diff-definition", "test", "Over time", [operation])]),
            Source(nodes));
        return entries[0].Summary;
    }

    private static SetUiPropertyOperation Property(string nodeId, string kind, string propertyName, object value) =>
        new("o", "s", kind == "activityGrid" ? (nodeId == "n" ? "grid" : nodeId) : nodeId, propertyName,
            JsonSerializer.SerializeToElement(value));

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message} {d.Hint}"));

    private static NendoUiNodeSnapshot List(string nodeId) =>
        Node(nodeId, null, "recordList", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items"));

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

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 16, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "over-time.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.OverTimeMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-due", "Due", NendoStorageKind.Date, false, null, []),
                    new("e-moment", "Moment", NendoStorageKind.DateTime, false, null, []),
                    new("e-amount", "Amount", NendoStorageKind.Decimal, false, null, []),
                    new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
                ]),
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
