namespace Nendo.Engine.Tests;

/// <summary>
/// A board grouped by a reference, ADR-0004 2026-09-17 amendment, slice S7.
/// <para>
/// Two halves, and the split is the point of the slice. What a definition can be held to
/// is refused when it is authored: that the grouping field exists, is not calculated, and
/// where it is a reference, that it is bound to an active record type with an active label
/// field. How many records that type holds is data, so the column ceiling is a read-time
/// rule and is not asserted here.
/// </para>
/// <para>
/// The rung is the other half. A board grouped by a reference and a board grouped by a
/// choice are the same shape, so the capability ladder has to read the grouping field to
/// tell them apart, and the falsification for that is
/// <see cref="TheRungIsInvisibleToATreeThatCannotSeeTheField"/>.
/// </para>
/// </summary>
[TestClass]
public sealed class ReferenceBoardTests
{
    [TestMethod]
    public void ABoardGroupedByABoundReferenceCompiles()
    {
        var nodes = new[]
        {
            Board("board", "t-client"),
            Binding("board-title", "board", "t-title"),
        };
        var compiled = new NendoSemanticCompiler().Compile(Source(nodes));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var board = compiled.Applications.Single(app => app.Entity.SemanticId == "task").Surfaces.Single();
        Assert.AreEqual("boardSurface", board.Kind);
        Assert.AreEqual("t-client", board.Properties["groupByFieldId"].GetString());
    }

    /// <summary>
    /// The renderer draws a column per target record and heads it with the reference's
    /// label, so both have to reach it. They travel on the field plan rather than in a
    /// second question, because a surface that had to ask again to learn what its own
    /// columns are would draw once without them.
    /// </summary>
    [TestMethod]
    public void TheCompiledFieldPlanCarriesWhereTheReferencePoints()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Board("board", "t-client"), Binding("b1", "board", "t-title")]));

        var field = compiled.Applications.Single(app => app.Entity.SemanticId == "task")
            .Entity.Fields.Single(candidate => candidate.SemanticId == "t-client");
        Assert.AreEqual("client", field.Reference?.TargetEntityId);
        Assert.AreEqual("c-name", field.Reference?.LabelFieldId);
        Assert.IsNull(compiled.Applications.Single(app => app.Entity.SemanticId == "task")
            .Entity.Fields.Single(candidate => candidate.SemanticId == "t-status").Reference);
    }

    /// <summary>
    /// An unbound reference has no target type to read columns from and no label to head
    /// them with. It is named on its own rather than sent through the choice-field
    /// diagnostic, which would point an author at the wrong fix.
    /// </summary>
    [TestMethod]
    public void ABoardRefusesAnUnboundReference()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Board("board", "t-loose"), Binding("b1", "board", "t-title")]));

        Assert.IsFalse(compiled.IsValid);
        var diagnostic = compiled.Diagnostics.Single(value => value.Code == "NUI237");
        StringAssert.Contains(diagnostic.Message, "has no target record type");
        Assert.AreEqual("groupByFieldId", diagnostic.PropertyPath);
        Assert.IsFalse(compiled.Diagnostics.Any(value => value.Code == "NUI236"), Messages(compiled));
    }

    [TestMethod]
    public void ABoardRefusesAReferenceWhoseLabelFieldIsRetired()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
            [Board("board", "t-client"), Binding("b1", "board", "t-title")], retireLabel: true));

        Assert.IsFalse(compiled.IsValid);
        StringAssert.Contains(compiled.Diagnostics.Single(value => value.Code == "NUI239").Message, "so the columns have no headings");
    }

    [TestMethod]
    public void ABoardStillRefusesAFieldThatIsNeitherAChoiceNorAReference()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source([Board("board", "t-title"), Binding("b1", "board", "t-title")]));

        Assert.IsFalse(compiled.IsValid);
        StringAssert.Contains(compiled.Diagnostics.Single(value => value.Code == "NUI236").Message,
            "active bounded choice field or a bound reference");
    }

    [TestMethod]
    public void ABoardGroupedByAReferenceMovesTheFileToItsOwnRung()
    {
        var nodes = new[] { Board("board", "t-client"), Binding("b1", "board", "t-title") };

        Assert.AreEqual(NendoFormat.ReferenceBoardMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, Fields()));
        Assert.IsTrue(NendoSemanticCapability.PresentFeatures(nodes, Fields())
            .Any(feature => feature.Name == "a board grouped by a reference"));
    }

    /// <summary>
    /// The falsification for the rung, and the reason the ladder's signature changed.
    /// <para>
    /// These are the same nodes as the test above. Asked without the fields — which is
    /// every question the ladder could answer before this slice — the answer is the rung
    /// below, and a file would record a host version it can be seen not to need. That is
    /// the defect; this test is what fails if the fields stop being read.
    /// </para>
    /// </summary>
    [TestMethod]
    public void TheRungIsInvisibleToATreeThatCannotSeeTheField()
    {
        var nodes = new[] { Board("board", "t-client"), Binding("b1", "board", "t-title") };

        Assert.AreNotEqual(NendoFormat.ReferenceBoardMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
        Assert.AreEqual(NendoSemanticCapability.RequiredHostVersion(
            [Board("board", "t-status"), Binding("b1", "board", "t-title")], Fields()),
            NendoSemanticCapability.RequiredHostVersion(nodes, []));
    }

    [TestMethod]
    public void ABoardGroupedByAChoiceStaysOnTheRungItWasOn()
    {
        var nodes = new[] { Board("board", "t-status"), Binding("b1", "board", "t-title") };

        Assert.AreNotEqual(NendoFormat.ReferenceBoardMinimumHostVersion,
            NendoSemanticCapability.RequiredHostVersion(nodes, Fields()));
    }

    /// <summary>
    /// Twenty-four is a published number, not a renderer's private one: a client that draws
    /// a board reads it from the vocabulary rather than choosing its own.
    /// </summary>
    [TestMethod]
    public void TheColumnCeilingIsPublished()
    {
        var described = NendoSemanticVocabulary.Description();

        Assert.AreEqual(24, described.Boards?.MaximumReferenceColumns);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumReferenceBoardColumns, described.Boards?.MaximumReferenceColumns);
        Assert.AreEqual(NendoFormat.ReferenceBoardMinimumHostVersion, described.Boards?.ReferenceColumnsMinimumHostVersion);
        StringAssert.Contains(described.Boards?.Note ?? string.Empty, "every active record of the target type");
        StringAssert.Contains(described.PropertyNotes["groupByFieldId"], "bound Reference field");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(value => $"{value.Code}: {value.Message}"));

    private static NendoUiNodeSnapshot Board(string nodeId, string groupByFieldId) =>
        new("task-surface", nodeId, null, "boardSurface", 0, new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal)
        {
            ["definitionVersion"] = System.Text.Json.JsonSerializer.SerializeToElement(NendoSemanticVocabulary.ContractVersion),
            ["entityId"] = System.Text.Json.JsonSerializer.SerializeToElement("task"),
            ["groupByFieldId"] = System.Text.Json.JsonSerializer.SerializeToElement(groupByFieldId),
        });

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        new("task-surface", nodeId, parentNodeId, "fieldBinding", 0, new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal)
        {
            ["fieldId"] = System.Text.Json.JsonSerializer.SerializeToElement(fieldId),
        });

    /// <summary>The same fields the snapshot has, as the capability ladder reads them.</summary>
    private static IReadOnlyList<NendoCapabilityField> Fields() =>
    [
        new("task", "t-title", NendoStorageKind.Text),
        new("task", "t-status", NendoStorageKind.Text),
        new("task", "t-client", NendoStorageKind.Reference),
        new("task", "t-loose", NendoStorageKind.Reference),
    ];

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes, bool retireLabel = false)
    {
        var now = new DateTimeOffset(2026, 9, 17, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "boards.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ReferenceBoardMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("client", "Client",
                [
                    new("c-name", "Name", NendoStorageKind.Text, true, "singleLine", []) { Retired = retireLabel },
                ]),
                new NendoEntitySnapshot("task", "Task",
                [
                    new("t-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
                    new("t-status", "Status", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                    new("t-client", "Client", NendoStorageKind.Reference, false, null, [])
                    {
                        Reference = new NendoReferenceDefinition("client", "c-name"),
                    },
                    new("t-loose", "Unbound", NendoStorageKind.Reference, false, null, []),
                ]),
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
