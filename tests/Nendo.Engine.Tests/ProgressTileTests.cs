namespace Nendo.Engine.Tests;

/// <summary>
/// The progress ring, ADR-0004 2026-09-14 amendment, slice S1: the records matching
/// its own clauses over everything its scope covers. It is drawn from two exact
/// counts, and a ring that narrows nothing is refused rather than always full.
/// </summary>
[TestClass]
public sealed class ProgressTileTests
{
    [TestMethod]
    public void ARingCompilesOnAListWithItsClausesAndMovesTheFileToTheChartsRung()
    {
        var nodes = new[]
        {
            BreakdownChartTests.Node("list", null, "recordList", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items")),
            BreakdownChartTests.Node("list-name", "list", "fieldBinding", 0, ("fieldId", "e-name")),
            BreakdownChartTests.Node("ring", "list", "progressTile", 1, ("title", "Done")),
            BreakdownChartTests.Node("ring-done", "ring", "filterClause", 0, ("fieldId", "e-stage"), ("operator", "eq"), ("value", "done")),
        };
        var compiled = new NendoSemanticCompiler().Compile(BreakdownChartTests.Source(nodes));

        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}")));
        var ring = compiled.Applications.Single().Surfaces.Single().Children.Single(child => child.Kind == "progressTile");
        Assert.AreEqual("Done", ring.Properties["title"].GetString());
        Assert.AreEqual(NendoFormat.FirstChartsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    [TestMethod]
    public void ARingOnARecordPageSectionReadsTheWholeRecordType()
    {
        var compiled = new NendoSemanticCompiler().Compile(BreakdownChartTests.Source(
        [
            BreakdownChartTests.Node("page", null, "detailSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Item")),
            BreakdownChartTests.Node("page-name", "page", "fieldBinding", 0, ("fieldId", "e-name")),
            BreakdownChartTests.Node("section", "page", "section", 1, ("title", "Progress")),
            BreakdownChartTests.Node("ring", "section", "progressTile", 0),
            BreakdownChartTests.Node("ring-flag", "ring", "filterClause", 0, ("fieldId", "e-flag"), ("operator", "eq"), ("value", true)),
        ]));

        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}")));
    }

    [TestMethod]
    public void ARingWithNoClauseIsRefusedBecauseItWouldAlwaysBeFull()
    {
        var compiled = new NendoSemanticCompiler().Compile(BreakdownChartTests.Source(
        [
            BreakdownChartTests.Node("list", null, "recordList", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items")),
            BreakdownChartTests.Node("list-name", "list", "fieldBinding", 0, ("fieldId", "e-name")),
            BreakdownChartTests.Node("ring", "list", "progressTile", 1),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI360");
        Assert.AreEqual("ring", refusal.SemanticId);
        StringAssert.Contains(refusal.Message, "always be full");
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void ARingSpendsTheSurfacesBudgetLikeATile()
    {
        // Six clauses on the list and three on the ring compose to nine, one past
        // the ceiling, and the refusal names the ring.
        var clauses = Enumerable.Range(0, 6).Select(index =>
            BreakdownChartTests.Node($"list-clause-{index}", "list", "filterClause", index + 1, ("fieldId", "e-amount"), ("operator", "gt"), ("value", index)));
        var own = Enumerable.Range(0, 3).Select(index =>
            BreakdownChartTests.Node($"ring-clause-{index}", "ring", "filterClause", index, ("fieldId", "e-amount"), ("operator", "lt"), ("value", index)));
        var compiled = new NendoSemanticCompiler().Compile(BreakdownChartTests.Source(
        [
            BreakdownChartTests.Node("list", null, "recordList", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Items")),
            BreakdownChartTests.Node("list-name", "list", "fieldBinding", 0, ("fieldId", "e-name")),
            .. clauses,
            BreakdownChartTests.Node("ring", "list", "progressTile", 8),
            .. own,
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("ring", compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300").SemanticId);
    }
}
