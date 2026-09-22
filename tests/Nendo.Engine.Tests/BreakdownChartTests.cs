using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The breakdown chart, ADR-0004 2026-09-14 amendment, slice S1. A tile in the sense
/// a summary tile is: accepted where it is accepted, scoped as it is scoped, refusing
/// the numbers it refuses, and its own only in the grouping field, which must close
/// the groups and which is not a filter.
/// </summary>
[TestClass]
public sealed class BreakdownChartTests
{
    [TestMethod]
    public void AChartCompilesOnAListAndMovesTheFileToTheChartsRung()
    {
        var nodes = new[]
        {
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("chart", "list", "breakdownChart", 1, ("groupByFieldId", "e-stage"), ("aggregate", "sum"), ("fieldId", "e-amount"), ("title", "Amount by stage")),
            Node("chart-open", "chart", "filterClause", 0, ("fieldId", "e-flag"), ("operator", "eq"), ("value", true)),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var chart = compiled.Applications.Single().Surfaces.Single().Children.Single(child => child.Kind == "breakdownChart");
        Assert.AreEqual("e-stage", chart.Properties["groupByFieldId"].GetString());
        Assert.AreEqual("filterClause", chart.Children.Single().Kind);
        Assert.AreEqual(NendoFormat.FirstChartsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(nodes, []).Any(feature => feature.Name == "a chart"));
    }

    [TestMethod]
    public void AColumnBreakdownBreaksABoardColumnDownByASecondChoice()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Board("board"),
            Binding("board-name", "board", "e-name"),
            Node("chart", "board", "breakdownChart", 1, ("groupByFieldId", "e-kind"), ("aggregate", "count"), ("scope", "group")),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    [TestMethod]
    public void ABooleanClosesTheGroupsToo()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("chart", "list", "breakdownChart", 1, ("groupByFieldId", "e-flag"), ("aggregate", "count")),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    [TestMethod]
    [DataRow("e-name", "NUI350", "cannot group a chart")]
    [DataRow("e-amount", "NUI350", "cannot group a chart")]
    [DataRow("e-gone", "NUI350", "does not exist or is retired")]
    public void AGroupingThatDoesNotCloseIsRefusedByName(string fieldId, string code, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("chart", "list", "breakdownChart", 1, ("groupByFieldId", fieldId), ("aggregate", "count")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == code);
        Assert.AreEqual("chart", refusal.SemanticId);
        Assert.AreEqual("groupByFieldId", refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void AColumnBreakdownByTheBoardsOwnGroupingIsRefused()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Board("board"),
            Binding("board-name", "board", "e-name"),
            Node("chart", "board", "breakdownChart", 1, ("groupByFieldId", "e-stage"), ("aggregate", "count"), ("scope", "group")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI352");
        Assert.AreEqual("groupByFieldId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "board's own grouping");
    }

    [TestMethod]
    public void TheTilesNumberRulesApplyUnchanged()
    {
        // A column scope off a board, a sum with no field, and a refused aggregate
        // are the summary tile's refusals, by the same codes.
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            List("list"),
            Binding("list-name", "list", "e-name"),
            Node("scoped", "list", "breakdownChart", 1, ("groupByFieldId", "e-stage"), ("aggregate", "count"), ("scope", "group")),
            Node("fieldless", "list", "breakdownChart", 2, ("groupByFieldId", "e-stage"), ("aggregate", "sum")),
            Node("mean", "list", "breakdownChart", 3, ("groupByFieldId", "e-stage"), ("aggregate", "avg"), ("fieldId", "e-amount")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("scoped", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI297").SemanticId);
        Assert.AreEqual("fieldless", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI293").SemanticId);
        Assert.AreEqual("mean", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI292").SemanticId);
    }

    [TestMethod]
    public void TheVocabularyPublishesBothKindsWhereATileIsAccepted()
    {
        var description = NendoSemanticVocabulary.Description();
        foreach (var parent in new[] { "recordList", "boardSurface", "detailSurface", "section" })
        {
            var rule = description.Kinds.Single(kind => kind.Kind == parent);
            Assert.IsTrue(rule.Children.Contains("breakdownChart"), $"{parent} accepts a breakdown chart");
            Assert.IsTrue(rule.Children.Contains("progressTile"), $"{parent} accepts a progress ring");
        }
        // A chart inside a related list is not drawn in this slice, so it is refused
        // rather than compiled and silently missing from the page.
        Assert.IsFalse(description.Kinds.Single(kind => kind.Kind == "relatedList").Children.Contains("breakdownChart"));
        var chart = description.Kinds.Single(kind => kind.Kind == "breakdownChart");
        CollectionAssert.AreEquivalent(new[] { "groupByFieldId", "aggregate" }, chart.RequiredProperties.ToArray());
        Assert.IsFalse(chart.CanBeRoot);
        Assert.IsNotNull(description.Charts);
        CollectionAssert.AreEqual(new[] { "singleChoice", "boolean" }, description.Charts!.Groupings.ToArray());
        Assert.AreEqual(366, description.Charts.MaximumGroups);
        Assert.IsTrue(description.PropertyNotes!.ContainsKey("groupByFieldId"));
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot List(string nodeId) =>
        Node(nodeId, null, "recordList", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items"));

    private static NendoUiNodeSnapshot Board(string nodeId) =>
        Node(nodeId, null, "boardSurface", 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Board"), ("groupByFieldId", "e-stage"));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    internal static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 14, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "charts.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.FirstChartsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                    new("e-kind", "Kind", NendoStorageKind.Text, false, "singleChoice", ["a", "b"]),
                    new("e-amount", "Amount", NendoStorageKind.Decimal, false, null, []),
                    new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
                ]),
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    internal static NendoUiNodeSnapshot Node(
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
