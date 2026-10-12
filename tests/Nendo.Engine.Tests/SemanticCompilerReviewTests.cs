using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The broad review of 2026-10-10 on the semantic compiler (W-208): definitions that compiled
/// and then failed on every read or every press, or that the compiler could not judge at all.
/// </summary>
[TestClass]
public sealed class SemanticCompilerReviewTests
{
    private static readonly NendoFieldSnapshot[] TaskFields =
    [
        new("t-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
        new("t-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done", "old"])
        {
            Choices = [new("open", "Open", false), new("done", "Done", false), new("old", "Old", true)],
        },
        new("t-points", "Points", NendoStorageKind.Integer, false, null, []),
        new("t-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
        new("t-due", "Due", NendoStorageKind.Date, false, "date", []),
        new("t-at", "At", NendoStorageKind.DateTime, false, null, []),
        new("t-key", "Key", NendoStorageKind.Uuid, false, null, []),
    ];

    [TestMethod]
    [DataRow("t-flag", "today", null, "NUI457")]
    [DataRow("t-points", "today", null, "NUI457")]
    [DataRow("t-due", "now", null, "NUI457")]
    [DataRow("t-due", "literal", "2026/10/31", "NUI277")]
    [DataRow("t-due", "literal", "31-10-2026", "NUI277")]
    [DataRow("t-at", "literal", "2026-10-01", "NUI277")]
    [DataRow("t-key", "literal", "abc", "NUI277")]
    public void ESM03_ESM05_AFilterThatEveryReadWouldRefuseDoesNotCompile(string fieldId, string valueKind, string? value, string code)
    {
        var compiled = Compile(List(Clause("f", "l", fieldId, "lt", valueKind, value)));
        Assert.IsFalse(compiled.IsValid, $"{fieldId} lt {valueKind} {value} compiled; every read of the list would refuse it.");
        Assert.IsNotNull(compiled.Diagnostics.SingleOrDefault(d => d.Code == code && d.SemanticId == "f"),
            $"Expected {code}; got {Codes(compiled)}.");
    }

    [TestMethod]
    [DataRow("t-due", "today", null)]
    [DataRow("t-at", "today", null)]
    [DataRow("t-at", "now", null)]
    [DataRow("t-due", "literal", "2026-10-31")]
    [DataRow("t-at", "literal", "2026-10-31T09:00:00Z")]
    [DataRow("t-at", "literal", "2026-10-31T09:00:00.5+02:00")]
    [DataRow("t-key", "literal", "0f8fad5b-d9cb-469f-a165-70867728950e")]
    [DataRow("t-stage", "literal", "old")]
    public void ESM03_ESM05_AFilterStorageCanReadCompiles(string fieldId, string valueKind, string? value)
    {
        var compiled = Compile(List(Clause("f", "l", fieldId, fieldId == "t-stage" ? "eq" : "lt", valueKind, value)));
        Assert.IsTrue(compiled.IsValid, Codes(compiled));
    }

    [TestMethod]
    public void ESM05_ACommandStepThatSetsARetiredChoiceIsWarnedAbout()
    {
        // A warning, not an error: the choice is usually retired after the step was written, and
        // an error would take every custom screen of the file down for one button (review).
        var warned = Compile(Command("old"));
        var warning = warned.Diagnostics.SingleOrDefault(d => d.Code == "NUI286" && d.SemanticId == "s");
        Assert.IsNotNull(warning, $"A step setting the retired choice said nothing, and every press would be refused: {Codes(warned)}.");
        Assert.AreEqual(NendoDiagnosticSeverity.Warning, warning.Severity);
        Assert.IsTrue(warned.IsValid, Codes(warned));
        StringAssert.Contains(warning.Message, "Old", StringComparison.Ordinal);
        Assert.IsFalse(Compile(Command("done")).Diagnostics.Any(d => d.Code == "NUI286"), "A step setting an available choice is warned about.");
    }

    [TestMethod]
    public void ESM03_AValueBesideTodayIsIgnoredAndWarnedAboutNotRefused()
    {
        // No operation removes a property, so an error here could only be cleared by removing the
        // clause; the read ignores the value, so the screen keeps working (review).
        var compiled = Compile(List(Clause("f", "l", "t-due", "lt", "today", "2026-10-31")));
        Assert.IsTrue(compiled.IsValid, Codes(compiled));
        Assert.AreEqual(NendoDiagnosticSeverity.Warning, compiled.Diagnostics.Single(d => d.Code == "NUI458").Severity);
    }

    [TestMethod]
    public void ESM05_ACommandStepDateIsWrittenAsStorageKeepsIt()
    {
        var nodes = Command("done");
        nodes[^1] = Node("s", "c", "commandStep", 0, ("fieldId", "t-due"), ("valueKind", "literal"), ("value", "tomorrow"));
        Assert.IsNotNull(Compile(nodes).Diagnostics.SingleOrDefault(d => d.Code == "NUI277"), "A step setting Due to 'tomorrow' compiled.");
    }

    [TestMethod]
    public void ESM03_AViewFilterComparingNowWithADateDoesNotCompile()
    {
        var compiled = Compile(View(1, ("valueKind", "now")));
        var refused = compiled.Diagnostics.SingleOrDefault(d => d.Code == "NUI450");
        Assert.IsNotNull(refused, $"A view filter Due lt now compiled: {Codes(compiled)}.");
        StringAssert.Contains(refused.Message, "now is a date and time", StringComparison.Ordinal);
    }

    [TestMethod]
    public void ESM06_AViewCarriesNoMoreFiltersOnOneRecordTypeThanOneQueryTakes()
    {
        var atCeiling = Compile(View(NendoSemanticVocabulary.MaximumEffectiveFilters));
        Assert.IsTrue(atCeiling.IsValid, Codes(atCeiling));
        var over = Compile(View(NendoSemanticVocabulary.MaximumEffectiveFilters + 1));
        Assert.IsNotNull(over.Diagnostics.SingleOrDefault(d => d.Code == "NUI300"),
            $"A view with nine filters on one record type compiled, and every load would be refused: {Codes(over)}.");
    }

    [TestMethod]
    public void ESM08_ASurfaceNestsToItsBoundAndIsRefusedPastItWithoutThrowing()
    {
        // The root is the first level, so sections fill the rest and a binding sits at the bottom.
        var atBound = Compile(DeepPage(NendoSemanticVocabulary.MaximumNodeDepth));
        Assert.IsTrue(atBound.IsValid, Codes(atBound));
        var past = Compile(DeepPage(NendoSemanticVocabulary.MaximumNodeDepth + 1));
        Assert.IsFalse(past.IsValid);
        Assert.AreEqual(1, past.Diagnostics.Count(d => d.Code == "NUI456"), Codes(past));
        // Past the digest's JSON depth this threw out of Compile rather than answering.
        var far = Compile(DeepPage(40));
        Assert.AreEqual(1, far.Diagnostics.Count(d => d.Code == "NUI456"), Codes(far));
    }

    [TestMethod]
    public void ESM08_AThousandSectionsDeepFrontPageIsADiagnosticNotAStackOverflow()
    {
        var nodes = new List<NendoUiNodeSnapshot> { Node("ov", null, "overviewSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion)) };
        var parent = "ov";
        for (var level = 1; level < 1000; level++)
        {
            nodes.Add(Node($"ov-{level}", parent, "section", 0, ("title", $"Level {level}")));
            parent = $"ov-{level}";
        }
        // A small stack makes the old recursion fail fast rather than after the whole default one.
        NendoCompileResult? compiled = null;
        var thread = new Thread(() => compiled = Compile(nodes, surfaceId: "ov"), 256 * 1024);
        thread.Start();
        thread.Join();
        Assert.IsNotNull(compiled);
        Assert.AreEqual(1, compiled.Diagnostics.Count(d => d.Code == "NUI456"), Codes(compiled));
    }

    [TestMethod]
    public void ESM16_AGraphViewFilteringItsEdgesOnAStoredFieldNeedsNoCalculatedFilterHost()
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("g", null, "extensionGraphSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"), ("title", "Map"),
                ("packageId", "org.example.map"), ("labelFieldId", "t-title"), ("edgeEntityId", "k"),
                ("sourceFieldId", "k-from"), ("targetFieldId", "k-to")),
            Node("g-f", "g", "filterClause", 0, ("fieldId", "k-type"), ("operator", "eq"), ("value", "uses")),
        };
        var fields = TaskFields.Select(field => new NendoCapabilityField("t", field.FieldId, field.StorageKind))
            .Concat(LinkFields.Select(field => new NendoCapabilityField("k", field.FieldId, field.StorageKind))).ToArray();
        var features = NendoSemanticCapability.PresentFeatures(nodes, fields).Select(feature => feature.Name).ToArray();
        CollectionAssert.DoesNotContain(features, "a filter or sort on a calculated field",
            "A filter on the edge type's stored Type field was counted as a calculated-field filter.");
        Assert.IsTrue(Compile(nodes, surfaceId: "g").IsValid, "The graph view itself does not compile.");
    }

    [TestMethod]
    public void ESM17_EveryRecordTypeWithABrokenSurfaceIsReportedInOneCompile()
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("l1", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "k"),
                ("title", "Links"), ("orderByFieldId", "k-absent")),
            Node("l2", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"),
                ("title", "Tasks"), ("orderByFieldId", "t-absent")),
        };
        var compiled = Compile(nodes);
        CollectionAssert.AreEquivalent(new[] { "l1", "l2" },
            compiled.Diagnostics.Where(d => d.Code == "NUI278").Select(d => d.SemanticId).ToArray(),
            $"Only the first broken record type was reported: {Codes(compiled)}.");
    }

    [TestMethod]
    public void ESM18_ARecordPanelOnTheFrontPageIsToldItNeedsARecord()
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("ov", null, "overviewSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion)),
            Node("ov-s", "ov", "section", 0, ("title", "Mine")),
            Node("ov-panel", "ov-s", NendoExtensionViewDefinition.PanelKind, 0, ("title", "Panel"),
                ("packageId", "org.example.panel"), ("labelFieldId", "t-title")),
        };
        var compiled = Compile(nodes, surfaceId: "ov");
        Assert.IsNotNull(compiled.Diagnostics.SingleOrDefault(d => d.Code == "NUI398" && d.SemanticId == "ov-panel"), Codes(compiled));
        Assert.IsFalse(compiled.Diagnostics.Any(d => d.SemanticId == "ov-panel" && d.Code != "NUI398"),
            $"A panel on the front page was asked for an entityId that it may not declare: {Codes(compiled)}.");
    }

    [TestMethod]
    public void ESM20_AMatrixOverTheCeilingIsNotToldThatAFilterWouldShrinkIt()
    {
        var options = Enumerable.Range(1, 20).Select(i => $"o{i}").ToArray();
        var fields = new NendoFieldSnapshot[]
        {
            new("m-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("m-a", "A", NendoStorageKind.Text, false, "singleChoice", options),
            new("m-b", "B", NendoStorageKind.Text, false, "singleChoice", options),
        };
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("m", null, "matrixSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "m"),
                ("title", "Grid"), ("rowByFieldId", "m-a"), ("columnByFieldId", "m-b")),
            Node("m-f", "m", "filterClause", 0, ("fieldId", "m-a"), ("operator", "eq"), ("value", "o1")),
        };
        var refused = Compile(nodes, entities: [new NendoEntitySnapshot("m", "Matrix", fields)])
            .Diagnostics.Single(d => d.Code == "NUI413");
        Assert.DoesNotContain("removes its column", refused.Hint ?? string.Empty,
            "The hint offers a filterClause as a remedy, and the same clause is refused again.");
        StringAssert.Contains(refused.Hint, "counts every option", StringComparison.Ordinal);
    }

    [TestMethod]
    public void ESM24_TheVocabularyDoesNotSayAProgressTileTakesAScope()
    {
        var description = NendoSemanticVocabulary.Description();
        Assert.IsFalse(description.Kinds.Single(kind => kind.Kind == "progressTile").Properties.Contains("scope"));
        Assert.DoesNotContain("Both take the scope", description.Charts!.Note);
    }

    private static readonly NendoFieldSnapshot[] LinkFields =
    [
        new("k-type", "Type", NendoStorageKind.Text, false, "singleLine", []),
        new("k-from", "From", NendoStorageKind.Reference, true, null, []) { Reference = new("t", "t-title") },
        new("k-to", "To", NendoStorageKind.Reference, true, null, []) { Reference = new("t", "t-title") },
    ];

    private static List<NendoUiNodeSnapshot> List(params NendoUiNodeSnapshot[] children)
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("l", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"), ("title", "Tasks")),
            Node("l-title", "l", "fieldBinding", 0, ("fieldId", "t-title")),
        };
        nodes.AddRange(children);
        return nodes;
    }

    private static NendoUiNodeSnapshot Clause(string id, string parent, string fieldId, string comparison, string valueKind, string? value)
    {
        var properties = new List<(string, object)> { ("fieldId", fieldId), ("operator", comparison), ("valueKind", valueKind) };
        if (value is not null) properties.Add(("value", value));
        return Node(id, parent, "filterClause", 1, [.. properties]);
    }

    private static List<NendoUiNodeSnapshot> Command(string stage) =>
    [
        Node("p", null, "recordForm", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"), ("title", "Task")),
        Node("p-title", "p", "fieldBinding", 0, ("fieldId", "t-title")),
        Node("c", "p", "recordCommand", 1, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"), ("label", "Finish")),
        Node("s", "c", "commandStep", 0, ("fieldId", "t-stage"), ("valueKind", "literal"), ("value", stage)),
    ];

    private static List<NendoUiNodeSnapshot> View(int clauses, params (string, object)[] extra)
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("v", null, "extensionRecordsSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"),
                ("title", "Board"), ("packageId", "org.example.board"), ("labelFieldId", "t-title")),
        };
        for (var i = 0; i < clauses; i++)
            nodes.Add(Node($"v-f{i}", "v", "filterClause", i, [("fieldId", "t-due"), ("operator", "lt"), .. extra.Length > 0 ? extra : [("value", "2026-10-31")]]));
        return nodes;
    }

    private static List<NendoUiNodeSnapshot> DeepPage(int depth)
    {
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("d", null, "detailSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "t"), ("title", "Task")),
        };
        var parent = "d";
        for (var level = 2; level < depth; level++)
        {
            nodes.Add(Node($"d-{level}", parent, "section", 0, ("title", $"Level {level}")));
            parent = $"d-{level}";
        }
        nodes.Add(Node("d-title", parent, "fieldBinding", 0, ("fieldId", "t-title")));
        return nodes;
    }

    private static NendoCompileResult Compile(IReadOnlyList<NendoUiNodeSnapshot> nodes, string surfaceId = "surface",
        NendoEntitySnapshot[]? entities = null)
    {
        var now = new DateTimeOffset(2026, 10, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSemanticCompiler().Compile(new NendoSessionSnapshot(
            "review.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            entities ?? [new NendoEntitySnapshot("t", "Task", TaskFields), new NendoEntitySnapshot("k", "Link", LinkFields)],
            [],
            [.. nodes.Select(node => node with { SurfaceId = surfaceId })],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", [])));
    }

    private static string Codes(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code} [{d.SemanticId}/{d.PropertyPath}] {d.Message}"));

    private static NendoUiNodeSnapshot Node(string nodeId, string? parentNodeId, string kind, int position,
        params (string Name, object Value)[] properties) => new(
            "surface",
            nodeId,
            parentNodeId,
            kind,
            position,
            properties.ToDictionary(property => property.Name, property => JsonSerializer.SerializeToElement(property.Value), StringComparer.Ordinal));
}
