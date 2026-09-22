using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The record-page header, ADR-0004 2026-09-14 amendment, slice S0. A
/// <c>detailSurface</c> may name the stored Text field that heads the page, a field
/// shown under it, and the single-choice field whose option's tone colours it. Each
/// is validated by shape and refused by name, and a page that uses any of them moves
/// the file to the colour-and-header rung.
/// </summary>
[TestClass]
public sealed class RecordPageHeaderTests
{
    [TestMethod]
    public void APageCompilesWithATitleASubtitleAndAnAccent()
    {
        var nodes = new[]
        {
            Page("page", ("titleFieldId", "e-name"), ("subtitleFieldId", "e-due"), ("accentFieldId", "e-stage")),
            Binding("page-name", "page", "e-name"),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var root = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("detailSurface", root.Kind);
        Assert.AreEqual("e-name", root.Properties["titleFieldId"].GetString());
        Assert.AreEqual("e-due", root.Properties["subtitleFieldId"].GetString());
        Assert.AreEqual("e-stage", root.Properties["accentFieldId"].GetString());

        // The header is a shape of the tree, so it is what moves a file to the rung.
        Assert.AreEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(nodes, []).Any(feature => feature.Name == "a record-page header"));
    }

    [TestMethod]
    public void APageWithoutAHeaderNeedsNoNewerHost()
    {
        var nodes = new[] { Page("page"), Binding("page-name", "page", "e-name") };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.IsFalse(NendoSemanticCapability.PresentFeatures(nodes, []).Any(feature => feature.Name == "a record-page header"));
    }

    [TestMethod]
    [DataRow("titleFieldId", "e-stage", "NUI340", "cannot head the page")]
    [DataRow("titleFieldId", "e-due", "NUI340", "cannot head the page")]
    [DataRow("titleFieldId", "e-gone", "NUI340", "does not exist or is retired")]
    [DataRow("titleFieldId", "", "NUI340", "must name a field")]
    [DataRow("subtitleFieldId", "e-gone", "NUI341", "does not exist or is retired")]
    [DataRow("accentFieldId", "e-name", "NUI342", "cannot colour the page")]
    [DataRow("accentFieldId", "e-due", "NUI342", "cannot colour the page")]
    [DataRow("accentFieldId", "e-gone", "NUI342", "does not exist or is retired")]
    public void AHeaderFieldOfTheWrongShapeIsRefusedByName(string property, string fieldId, string code, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", (property, fieldId)),
            Binding("page-name", "page", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid, $"{property} = '{fieldId}' must not compile.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == code);
        Assert.AreEqual("page", refusal.SemanticId);
        Assert.AreEqual(property, refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void ASubtitleThatRepeatsTheTitleIsRefused()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", ("titleFieldId", "e-name"), ("subtitleFieldId", "e-name")),
            Binding("page-name", "page", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI341");
        Assert.AreEqual("subtitleFieldId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "repeats the title");
    }

    [TestMethod]
    public void AFormIsNotAPageAndTakesNoHeader()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("form", null, "recordForm", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion),
                ("entityId", "e"),
                ("titleFieldId", "e-name")),
            Binding("form-name", "form", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI090");
        Assert.AreEqual("titleFieldId", refusal.PropertyPath);
    }

    [TestMethod]
    public void TheVocabularyPublishesTheHeaderPropertiesAndTheTones()
    {
        var description = NendoSemanticVocabulary.Description();

        var page = description.Kinds.Single(kind => kind.Kind == "detailSurface");
        foreach (var property in new[] { "titleFieldId", "subtitleFieldId", "accentFieldId" })
        {
            Assert.IsTrue(page.Properties.Contains(property), property);
            Assert.IsFalse(page.RequiredProperties.Contains(property), $"{property} is optional");
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), $"{property} needs a note");
        }
        Assert.IsFalse(description.Kinds.Single(kind => kind.Kind == "recordForm").Properties.Contains("titleFieldId"));

        Assert.IsNotNull(description.ChoiceTones);
        CollectionAssert.AreEqual(
            new[] { "red", "orange", "amber", "green", "teal", "blue", "violet", "grey" },
            description.ChoiceTones!.Values.ToArray());
        Assert.IsTrue(description.PropertyNotes!.ContainsKey("tone"));
        Assert.IsTrue(NendoSemanticVocabulary.ChoiceToneOrder.All(NendoSemanticVocabulary.ChoiceTones.Contains));
        Assert.HasCount(NendoSemanticVocabulary.ChoiceTones.Count, NendoSemanticVocabulary.ChoiceToneOrder);
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Page(string nodeId, params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "detailSurface", 0,
            [
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion),
                ("entityId", "e"),
                ("title", "Example"),
                .. properties,
            ]);

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 14, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "header.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ColourAndHeaderMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-due", "Due", NendoStorageKind.Date, false, "date", []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
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
