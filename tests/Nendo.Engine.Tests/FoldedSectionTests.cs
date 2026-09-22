using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A section can be folded away, ADR-0004 2026-09-20 amendment. Only one thing is
/// authored -- how the section starts, <c>opens</c> -- so these tests are about that
/// property: where it is accepted, what it may say, the rung it moves a file to, and
/// what the vocabulary tells an agent about it. The fold itself is renderer behaviour
/// and is measured by the agent-authoring gate, not here.
/// </summary>
[TestClass]
public sealed class FoldedSectionTests
{
    [TestMethod]
    public void ASectionOnARecordPageMaySayItStartsClosed()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-lately", "page", "section", 0, ("title", "Lately"), ("opens", "closed")),
            Binding("page-name", "page-lately", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var section = compiled.Applications.Single().Surfaces.Single().Children.Single();
        Assert.AreEqual("closed", section.Properties["opens"].GetString());
    }

    [TestMethod]
    public void ASectionOnTheFrontPageMaySayItStartsClosed()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("front", null, "overviewSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("title", "Front")),
            Node("front-lately", "front", "section", 0, ("title", "Lately"), ("opens", "closed")),
            Node("front-count", "front-lately", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count"), ("title", "Examples")),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.AreEqual("closed", compiled.Overview!.Surface.Children.Single().Properties["opens"].GetString());
    }

    [TestMethod]
    public void AWordThatIsNotAWayToStartIsRefusedByName()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-lately", "page", "section", 0, ("title", "Lately"), ("opens", "sideways")),
            Binding("page-name", "page-lately", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI312");
        Assert.AreEqual("page-lately", refusal.SemanticId);
        Assert.AreEqual("opens", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "'sideways'");
        StringAssert.Contains(refusal.Hint!, "closed, open");
    }

    /// <summary>
    /// A tab's body is opened and closed by the tab strip. Saying how it starts would
    /// be a second answer to the same question, so it is refused on the record page
    /// and on the front page alike -- and a section inside the tab still may.
    /// </summary>
    [TestMethod]
    public void ATabsBodyCannotSayHowItStartsButASectionInsideItCan()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-tabs", "page", "tabGroup", 0, ("title", "Details")),
            Node("page-tab", "page-tabs", "section", 0, ("title", "Identity"), ("opens", "closed")),
            Node("page-inner", "page-tab", "section", 0, ("title", "More"), ("opens", "closed")),
            Binding("page-name", "page-inner", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI313");
        Assert.AreEqual("page-tab", refusal.SemanticId);
        Assert.AreEqual("opens", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "tab strip");

        var front = new NendoSemanticCompiler().Compile(Source(
        [
            Node("front", null, "overviewSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("title", "Front")),
            Node("front-tabs", "front", "tabGroup", 0, ("title", "Views")),
            Node("front-tab", "front-tabs", "section", 0, ("title", "Lately"), ("opens", "closed")),
            Node("front-count", "front-tab", "summaryTile", 0, ("entityId", "e"), ("aggregate", "count"), ("title", "Examples")),
        ]));

        Assert.IsFalse(front.IsValid);
        Assert.AreEqual("front-tab", front.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI313").SemanticId);
    }

    [TestMethod]
    public void OpensIsRefusedOnAnyKindButASection()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-name", "page", "fieldBinding", 0, ("fieldId", "e-name"), ("opens", "closed")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(diagnostic => diagnostic.SemanticId == "page-name" && diagnostic.PropertyPath == "opens"),
            Messages(compiled));
    }

    /// <summary>
    /// The rung, and its falsification in one: the same page with the property is on
    /// the new rung, and without it stays where it was. Every section folding puts
    /// nothing in the file, so a file that says nothing needs what it needed.
    /// </summary>
    [TestMethod]
    public void OnlyASectionThatSaysHowItStartsMovesTheFileToTheNewRung()
    {
        var closed = new[]
        {
            Page("page", "detailSurface"),
            Node("page-lately", "page", "section", 0, ("title", "Lately"), ("opens", "closed")),
            Binding("page-name", "page-lately", "e-name"),
        };
        var silent = new[]
        {
            Page("page", "detailSurface"),
            Node("page-lately", "page", "section", 0, ("title", "Lately")),
            Binding("page-name", "page-lately", "e-name"),
        };

        Assert.AreEqual(NendoFormat.FoldedSectionMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(closed, []));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(closed, [])
            .Any(feature => feature.Name == "a section that says how it starts"));
        Assert.AreNotEqual(NendoFormat.FoldedSectionMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(silent, []));
    }

    [TestMethod]
    public void TheVocabularyPublishesHowASectionStartsAndThatEverySectionFolds()
    {
        var description = NendoSemanticVocabulary.Description();

        var section = description.Kinds.Single(kind => kind.Kind == "section");
        Assert.IsTrue(section.Properties.Contains("opens"));
        Assert.IsFalse(section.RequiredProperties.Contains("opens"));
        CollectionAssert.AreEqual(new[] { "closed", "open" }, description.SectionOpens!.Values.ToArray());
        Assert.AreEqual("open", description.SectionOpens.Default);
        StringAssert.Contains(description.SectionOpens.Note, "never stored");
        StringAssert.Contains(description.PropertyNotes!["opens"], "NUI313");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Page(string nodeId, string kind) =>
        Node(nodeId, null, kind, 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Example"));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 20, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "folds.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.FoldedSectionMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-value", "Value", NendoStorageKind.Decimal, false, null, []),
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
