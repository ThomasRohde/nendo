using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Named tabs on a record page, ADR-0004's 2026-09-12 vocabulary-widening
/// amendment. A <c>tabGroup</c> contains sections and nothing else, so a tab is
/// always a titled section: tabs organise named record information rather than
/// becoming a general layout API.
/// </summary>
[TestClass]
public sealed class TabbedRecordPageTests
{
    [TestMethod]
    [DataRow("detailSurface")]
    [DataRow("recordForm")]
    public void ATabGroupCompilesUnderEitherRecordPageKindAndKeepsItsSectionOrder(string pageKind)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", pageKind),
            Node("page-tabs", "page", "tabGroup", 0, ("title", "Details")),
            Node("page-identity", "page-tabs", "section", 0, ("title", "Identity")),
            Binding("page-name", "page-identity", "e-name"),
            Node("page-numbers", "page-tabs", "section", 1, ("title", "Numbers")),
            Binding("page-value", "page-numbers", "e-value"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var group = compiled.Applications.Single().Surfaces.Single().Children
            .Single(child => child.Kind == "tabGroup");
        Assert.AreEqual("Details", group.Properties["title"].GetString());
        CollectionAssert.AreEqual(
            new[] { "Identity", "Numbers" },
            group.Children.Select(section => section.Properties["title"].GetString()).ToArray(),
            "Each section is one tab, in declared order.");
    }

    /// <summary>A tab group nested in a section is still admitted; a group is not.</summary>
    [TestMethod]
    public void ATabGroupIsAcceptedInsideASectionOfARecordPage()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-outer", "page", "section", 0, ("title", "Everything")),
            Binding("page-name", "page-outer", "e-name"),
            Node("page-tabs", "page-outer", "tabGroup", 1),
            Node("page-tab", "page-tabs", "section", 0, ("title", "Numbers")),
            Binding("page-value", "page-tab", "e-value"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
    }

    [TestMethod]
    public void AnEmptyTabGroupIsRefusedBecauseItIsATabStripWithNoTabs()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Binding("page-name", "page", "e-name"),
            Node("page-tabs", "page", "tabGroup", 1, ("title", "Empty")),
        ]));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI310");
        Assert.AreEqual("page-tabs", refusal.SemanticId);
        StringAssert.Contains(refusal.Hint, "each section is one tab");
    }

    /// <summary>
    /// A tab group holds sections only. A field, a tile or a related list
    /// directly inside one is the parent/child rule, which the vocabulary table
    /// already carries — so the refusal names the permitted children.
    /// </summary>
    [TestMethod]
    [DataRow("fieldBinding")]
    [DataRow("summaryTile")]
    [DataRow("relatedList")]
    public void ATabGroupTakesSectionsOnly(string kind)
    {
        var intruder = kind switch
        {
            "fieldBinding" => Node("page-intruder", "page-tabs", "fieldBinding", 1, ("fieldId", "e-name")),
            "summaryTile" => Node("page-intruder", "page-tabs", "summaryTile", 1, ("aggregate", "count")),
            _ => Node("page-intruder", "page-tabs", "relatedList", 1, ("targetEntityId", "t"), ("viaFieldId", "t-parent")),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-tabs", "page", "tabGroup", 0),
            Node("page-tab", "page-tabs", "section", 0, ("title", "Identity")),
            Binding("page-name", "page-tab", "e-name"),
            intruder,
        ], withTarget: true));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI013" && diagnostic.SemanticId == "page-intruder");
        StringAssert.Contains(refusal.Hint, "section");
    }

    /// <summary>
    /// `section` is shared, so a second group is reachable through an intervening
    /// section. Following that path would make the record page a layout API, and
    /// the parent/child table alone cannot see it.
    /// </summary>
    [TestMethod]
    [DataRow(false, DisplayName = "directly inside a tab")]
    [DataRow(true, DisplayName = "through an intervening section")]
    public void ANestedTabGroupIsRefusedEvenThroughASection(bool throughSection)
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Page("page", "detailSurface"),
            Node("page-tabs", "page", "tabGroup", 0),
            Node("page-tab", "page-tabs", "section", 0, ("title", "Identity")),
            Binding("page-name", "page-tab", "e-name"),
        };
        if (throughSection)
        {
            nodes.Add(Node("page-inner", "page-tab", "section", 1, ("title", "Inner")));
            nodes.Add(Node("page-nested", "page-inner", "tabGroup", 0));
        }
        else
        {
            nodes.Add(Node("page-nested", "page-tab", "tabGroup", 1));
        }
        nodes.Add(Node("page-nested-tab", "page-nested", "section", 0, ("title", "Deeper")));
        nodes.Add(Binding("page-nested-value", "page-nested-tab", "e-value"));

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.IsFalse(compiled.IsValid);
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI311");
        Assert.AreEqual("page-nested", refusal.SemanticId);
        Assert.AreEqual("parentNodeId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Hint, "one level of tabs");
        Assert.IsEmpty(compiled.Applications);
    }

    /// <summary>A tab keeps the section rule it already had: a nonblank title.</summary>
    [TestMethod]
    public void AnUntitledTabIsRefusedByTheExistingSectionRule()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-tabs", "page", "tabGroup", 0),
            Node("page-tab", "page-tabs", "section", 0),
            Binding("page-name", "page-tab", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid);
        Assert.AreEqual("page-tab", compiled.Diagnostics.Single(d => d.Code == "NUI091").SemanticId);
    }

    /// <summary>
    /// A page whose only fields are inside tabs still shows something: the
    /// "record page shows nothing" check reads the whole subtree.
    /// </summary>
    [TestMethod]
    public void APageWhoseFieldsAreAllInsideTabsIsNotEmpty()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Page("page", "detailSurface"),
            Node("page-tabs", "page", "tabGroup", 0),
            Node("page-tab", "page-tabs", "section", 0, ("title", "Identity")),
            Binding("page-name", "page-tab", "e-name"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        Assert.IsEmpty(compiled.Diagnostics.Where(d => d.Code is "NUI265" or "NUI211"));
    }

    /// <summary>
    /// The introduction path: tabs added into an existing section raise the
    /// recorded minimum, and removing them never lowers it.
    /// </summary>
    [TestMethod]
    public async Task IntroducingTabsIntoAnExistingSectionRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
        ]));
        await coordinator.ApplyAsync(new("test", "page", "test", "A record page with one section",
        [
            new AddUiNodeOperation("page-add", "s", "page", null, "detailSurface", 0),
            new SetUiPropertyOperation("page-version", "s", "page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("page-entity", "s", "page", "entityId", "e"),
            new AddUiNodeOperation("section-add", "s", "page-section", "page", "section", 0),
            new SetUiPropertyOperation("section-title", "s", "page-section", "title", "Identity"),
            new AddUiNodeOperation("name-add", "s", "page-name", "page-section", "fieldBinding", 0),
            new SetUiPropertyOperation("name-field", "s", "page-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "tabs", "test", "Turn the section into a tab",
        [
            new AddUiNodeOperation("tabs-add", "s", "page-tabs", "page", "tabGroup", 1),
            new SetUiPropertyOperation("tabs-title", "s", "page-tabs", "title", "Details"),
            // The section becomes a tab by moving into the group: no node is
            // added and no property is set, and what the file needs changes.
            new MoveUiNodeOperation("section-move", "s", "page-section", "page-tabs", 0),
        ]));
        Assert.AreEqual(NendoFormat.TabbedRecordPagesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);

        await coordinator.ApplyAsync(new("test", "untab", "test", "Take the section back out",
        [
            new MoveUiNodeOperation("section-back", "s", "page-section", "page", 0),
            new RemoveUiNodeOperation("tabs-remove", "s", "page-tabs"),
        ]));
        Assert.AreEqual(NendoFormat.TabbedRecordPagesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Page(string nodeId, string kind) =>
        Node(nodeId, null, kind, 0,
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Example"));

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, bool withTarget = false)
    {
        var entities = new List<NendoEntitySnapshot>
        {
            new("e", "Example",
            [
                new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                new("e-value", "Value", NendoStorageKind.Decimal, false, null, []),
            ]),
        };
        if (withTarget)
            entities.Add(new NendoEntitySnapshot("t", "Target",
            [
                new("t-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                new("t-parent", "Parent", NendoStorageKind.Reference, false, null, [])
                {
                    Reference = new NendoReferenceDefinition("e", "e-name"),
                },
            ]));

        var now = new DateTimeOffset(2026, 9, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "tabs.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.TabbedRecordPagesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            entities,
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
