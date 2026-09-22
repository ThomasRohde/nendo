using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The central capability calculation, ADR-0004's 2026-09-12 vocabulary-widening
/// amendment. Contract version 3's tree is preserved across the widening, so the
/// version number on a root no longer says what a host must understand: what a
/// stored definition needs is read from its shape. Before this, only setting
/// definitionVersion raised the recorded minimum, so a second list root or a tile
/// moved under a board reached an older host claiming 1.11 was enough.
/// </summary>
[TestClass]
public sealed class SemanticCapabilityTests
{
    [TestMethod]
    public void AnEmptyDefinitionNeedsNothingAndOneCustomNodeNeedsTheSemanticBaseline()
    {
        Assert.AreEqual(NendoFormat.MinimumHostVersion, NendoSemanticCapability.RequiredHostVersion([], []),
            "An empty-but-valid file must keep opening in the first host that could read the format.");
        Assert.IsEmpty(NendoSemanticCapability.PresentFeatures([], []));

        // A node with no declared contract version is still a custom surface.
        Assert.AreEqual(NendoFormat.SemanticMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion([Node("s", "n", null, "recordForm", 0)], []));
    }

    [TestMethod]
    public void APlainContractVersionThreeSurfaceNeedsTheComposableSurfacesHost()
    {
        var nodes = new[]
        {
            Root("form", "recordForm", "e"),
            Node("s", "form-name", "form", "fieldBinding", 0, ("fieldId", "e-name")),
        };

        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
        CollectionAssert.AreEqual(
            new[] { "a custom surface", "composable semantic surfaces" },
            NendoSemanticCapability.PresentFeatures(nodes, []).Select(feature => feature.Name).ToArray());
    }

    /// <summary>
    /// One row per widened shape. Each is contract version 3, and each needs a
    /// host an intermediate one is not: that is the whole reason the calculation
    /// exists rather than a version check on a root.
    /// </summary>
    [TestMethod]
    [DataRow("tileOnList", NendoFormat.SurfaceSummaryTilesMinimumHostVersion, "summary tiles on a list or board")]
    [DataRow("tileOnBoard", NendoFormat.SurfaceSummaryTilesMinimumHostVersion, "summary tiles on a list or board")]
    [DataRow("tileScope", NendoFormat.SurfaceSummaryTilesMinimumHostVersion, "summary tiles on a list or board")]
    [DataRow("twoCommandRoots", NendoFormat.MultipleCommandRootsMinimumHostVersion, "more than one command on a record type")]
    [DataRow("twoListRoots", NendoFormat.MultipleSurfaceRootsMinimumHostVersion, "more than one list or board on a record type")]
    [DataRow("twoBoardRoots", NendoFormat.MultipleSurfaceRootsMinimumHostVersion, "more than one list or board on a record type")]
    [DataRow("tabs", NendoFormat.TabbedRecordPagesMinimumHostVersion, "named tabs on a record page")]
    [DataRow("calendar", NendoFormat.DateCalendarMinimumHostVersion, "a Date calendar")]
    [DataRow("timeline", NendoFormat.TimelineMinimumHostVersion, "a timeline")]
    [DataRow("gallery", NendoFormat.GalleryAndRatingMinimumHostVersion, "a gallery")]
    public void EachWidenedShapeStatesItsOwnMinimumHost(string shape, string expected, string feature)
    {
        var nodes = Shape(shape);

        Assert.AreEqual(expected, NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.Contains(feature, NendoSemanticCapability.PresentFeatures(nodes, []).Select(present => present.Name).ToArray());
    }

    /// <summary>
    /// A tile on a record page is the shape that already compiled at 1.11, so it
    /// must not be dragged up the ladder by the list/board rule.
    /// </summary>
    [TestMethod]
    public void ATileOnARecordPageKeepsTheExistingMinimum()
    {
        var nodes = new[]
        {
            Root("page", "detailSurface", "e"),
            Node("s", "page-name", "page", "fieldBinding", 0, ("fieldId", "e-name")),
            Node("s", "page-tile", "page", "summaryTile", 1, ("aggregate", "count")),
        };

        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    /// <summary>
    /// Two roots of a kind on different record types is one each, not two. The
    /// ceiling is per entity, and reading it per file would demand a newer host
    /// of an ordinary two-entity application.
    /// </summary>
    [TestMethod]
    public void TwoListsOnDifferentRecordTypesIsOneEachAndNeedsNoNewerHost()
    {
        var nodes = new[]
        {
            Root("a", "recordList", "entity-a"),
            Root("b", "recordList", "entity-b"),
        };

        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    /// <summary>
    /// The highest feature a definition uses is what it needs. A widened
    /// definition that also carries an earlier widening states the later version,
    /// not an average and not the first one found.
    /// </summary>
    [TestMethod]
    public void ADefinitionUsingSeveralWideningsStatesTheHighestOne()
    {
        var nodes = Shape("tileOnList").Concat(Shape("tabs")).Concat(Shape("calendar"))
            .Concat(Shape("timeline")).Concat(Shape("gallery")).ToArray();

        Assert.AreEqual(NendoFormat.GalleryAndRatingMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
        var names = NendoSemanticCapability.PresentFeatures(nodes, []).Select(feature => feature.Name).ToArray();
        Assert.Contains("summary tiles on a list or board", names);
        Assert.Contains("named tabs on a record page", names);
        Assert.Contains("a Date calendar", names);
        Assert.Contains("a timeline", names);
        Assert.Contains("a gallery", names);
    }

    /// <summary>
    /// Every widened feature declares a version this host actually ships, and the
    /// ladder increases. A feature naming a version above CurrentHostVersion would
    /// write files this host cannot reopen.
    /// </summary>
    [TestMethod]
    public void TheCapabilityLadderIsOrderedAndWithinTheShippedHostVersion()
    {
        var versions = NendoSemanticCapability.Features
            .Select(feature => Version.Parse(feature.MinimumHostVersion))
            .ToArray();

        CollectionAssert.AreEqual(versions.OrderBy(version => version).ToArray(), versions,
            "Read the table in version order so a refusal names the first version that would do.");
        Assert.IsTrue(versions.All(version => version <= Version.Parse(NendoFormat.CurrentHostVersion)),
            "A feature cannot need a host newer than the one shipping it.");
        Assert.HasCount(versions.Length, versions.Distinct().ToArray(),
            "Each independently delivered widening owns its own version.");
    }

    private static NendoUiNodeSnapshot[] Shape(string shape) => shape switch
    {
        "tileOnList" =>
        [
            Root("list", "recordList", "e"),
            Node("s", "list-name", "list", "fieldBinding", 0, ("fieldId", "e-name")),
            Node("s", "list-tile", "list", "summaryTile", 1, ("aggregate", "count")),
        ],
        "tileOnBoard" =>
        [
            Root("board", "boardSurface", "e", ("groupByFieldId", "e-stage")),
            Node("s", "board-name", "board", "fieldBinding", 0, ("fieldId", "e-name")),
            Node("s", "board-tile", "board", "summaryTile", 1, ("aggregate", "count")),
        ],
        // Scope is the property that makes a tile mean per column, so it needs the
        // same host wherever it is declared.
        "tileScope" =>
        [
            Root("board", "boardSurface", "e", ("groupByFieldId", "e-stage")),
            Node("s", "board-tile", "board", "summaryTile", 1, ("aggregate", "count"), ("scope", "group")),
        ],
        "twoCommandRoots" =>
        [
            Root("won", "recordCommand", "e", ("label", "Mark won")),
            Root("lost", "recordCommand", "e", ("label", "Mark lost")),
        ],
        "twoListRoots" =>
        [
            Root("open", "recordList", "e", ("title", "Open")),
            Root("closed", "recordList", "e", ("title", "Closed")),
        ],
        "twoBoardRoots" =>
        [
            Root("stage", "boardSurface", "e", ("groupByFieldId", "e-stage")),
            Root("owner", "boardSurface", "e", ("groupByFieldId", "e-owner")),
        ],
        "tabs" =>
        [
            Root("page", "detailSurface", "e"),
            Node("s", "page-tabs", "page", "tabGroup", 0),
            Node("s", "page-tab-one", "page-tabs", "section", 0, ("title", "Identity")),
        ],
        "calendar" =>
        [
            Root("due", "calendarSurface", "e", ("dateFieldId", "e-due")),
            Node("s", "due-name", "due", "fieldBinding", 0, ("fieldId", "e-name")),
        ],
        "timeline" =>
        [
            Root("when", "timelineSurface", "e", ("dateFieldId", "e-due")),
            Node("s", "when-name", "when", "fieldBinding", 0, ("fieldId", "e-name")),
        ],
        "gallery" =>
        [
            Root("cards", "gallerySurface", "e", ("titleFieldId", "e-name")),
            Node("s", "cards-name", "cards", "fieldBinding", 0, ("fieldId", "e-name")),
        ],
        _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, "Unknown capability shape."),
    };

    private static NendoUiNodeSnapshot Root(
        string nodeId,
        string kind,
        string entityId,
        params (string Name, object Value)[] properties) => Node("s", nodeId, null, kind, 0,
            [("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", entityId), .. properties]);

    private static NendoUiNodeSnapshot Node(
        string surfaceId,
        string nodeId,
        string? parentNodeId,
        string kind,
        int position,
        params (string Name, object Value)[] properties) => new(
            surfaceId,
            nodeId,
            parentNodeId,
            kind,
            position,
            properties.ToDictionary(
                property => property.Name,
                property => JsonSerializer.SerializeToElement(property.Value),
                StringComparer.Ordinal));
}
