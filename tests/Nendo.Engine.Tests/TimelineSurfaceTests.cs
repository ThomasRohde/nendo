using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The timeline, ADR-0004's 2026-09-14 amendment (S3): records on a spine by one
/// Date field, one civil year at a time, with an optional end date that turns an
/// entry into a span, a stored Text field that titles it and a single-choice
/// field that tones its dot. It reads what a calendar reads — two date bounds and
/// an undated view — and it borrows the calendar's date rule and the record
/// page's title and accent rules rather than restating them, so each refusal here
/// names the field's actual shape.
/// </summary>
[TestClass]
public sealed class TimelineSurfaceTests
{
    [TestMethod]
    public void ATimelineCompilesOverAnActiveDateFieldWithItsSpanTitleAccentAndOrder()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Timeline("when", "e-due",
                ("title", "Over time"), ("endDateFieldId", "e-end"), ("titleFieldId", "e-name"), ("accentFieldId", "e-stage"),
                ("orderByFieldId", "e-name"), ("orderDirection", "descending")),
            Binding("when-notes", "when", "e-notes"),
            Clause("when-open", "when", "e-stage", "ne", "done"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var root = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("timelineSurface", root.Kind);
        Assert.AreEqual("e-due", root.Properties["dateFieldId"].GetString());
        Assert.AreEqual("e-end", root.Properties["endDateFieldId"].GetString());
        Assert.AreEqual("e-name", root.Properties["titleFieldId"].GetString());
        Assert.AreEqual("e-stage", root.Properties["accentFieldId"].GetString());
        Assert.IsTrue(root.Children.Any(child => child.Kind == "filterClause"));
    }

    [TestMethod]
    [DataRow("e-when", "DateTime", "declared time zone")]
    [DataRow("e-name", "Text", "cannot place a record on a timeline")]
    [DataRow("e-gone", "missing", "does not exist or is retired")]
    public void OnlyAnActiveDateFieldPlacesRecordsOnATimeline(string fieldId, string kind, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Timeline("when", fieldId),
            Binding("when-name", "when", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid, $"A {kind} field must not place records on a timeline.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI371");
        Assert.AreEqual("when", refusal.SemanticId);
        Assert.AreEqual("dateFieldId", refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    /// <summary>
    /// Both dates are bounds of a database query, so a calculated field is refused
    /// for what it is, once, by the rule every bounded query shares.
    /// </summary>
    [TestMethod]
    public void ACalculatedFieldCanNeitherPlaceARecordNorEndASpan()
    {
        var placed = new NendoSemanticCompiler().Compile(Source(
            [Timeline("when", "e-calc"), Binding("when-name", "when", "e-name")]));
        var refusal = placed.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI214");
        Assert.AreEqual("dateFieldId", refusal.PropertyPath);
        StringAssert.Contains(refusal.Message, "place records on a timeline by it");
        Assert.IsFalse(placed.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI371"),
            "A calculated date is refused once, for what it is, not also as a field of the wrong shape.");

        var ended = new NendoSemanticCompiler().Compile(Source(
            [Timeline("when", "e-due", ("endDateFieldId", "e-calc")), Binding("when-name", "when", "e-name")]));
        var endRefusal = ended.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI214");
        Assert.AreEqual("endDateFieldId", endRefusal.PropertyPath);
        StringAssert.Contains(endRefusal.Message, "end a span by it");
    }

    [TestMethod]
    [DataRow("endDateFieldId", "e-when", "NUI372", "declared time zone")]
    [DataRow("endDateFieldId", "e-name", "NUI372", "cannot end a span")]
    [DataRow("endDateFieldId", "e-gone", "NUI372", "does not exist or is retired")]
    [DataRow("endDateFieldId", "e-due", "NUI372", "repeats the start date")]
    [DataRow("endDateFieldId", "", "NUI372", "must name a field")]
    [DataRow("titleFieldId", "e-stage", "NUI373", "a single choice, so it cannot title each entry")]
    [DataRow("titleFieldId", "e-due", "NUI373", "a Date, so it cannot title each entry")]
    [DataRow("titleFieldId", "e-calc", "NUI373", "is calculated, so it cannot title each entry")]
    [DataRow("titleFieldId", "e-gone", "NUI373", "does not exist or is retired")]
    [DataRow("accentFieldId", "e-name", "NUI374", "a Text, so it cannot colour each entry")]
    [DataRow("accentFieldId", "e-calc", "NUI374", "is calculated, so it cannot colour each entry")]
    [DataRow("accentFieldId", "e-gone", "NUI374", "does not exist or is retired")]
    public void AFieldRoleOfTheWrongShapeIsRefusedByName(string property, string fieldId, string code, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Timeline("when", "e-due", (property, fieldId)),
            Binding("when-name", "when", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid, $"{property} = '{fieldId}' must be refused.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == code);
        Assert.AreEqual("when", refusal.SemanticId);
        Assert.AreEqual(property, refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void ATimelineWithNoDateFieldOrNoColumnsIsRefused()
    {
        var noField = new NendoSemanticCompiler().Compile(Source(
        [
            Node("when", null, "timelineSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("when-name", "when", "e-name"),
        ]));
        Assert.IsFalse(noField.IsValid);
        Assert.AreEqual("dateFieldId", noField.Diagnostics.First(d => d.Code is "NUI091" or "NUI370").PropertyPath);

        // A title names the entry, but the entry still shows fields; a timeline of
        // headings alone is refused as every record surface without a binding is.
        var noColumns = new NendoSemanticCompiler().Compile(Source([Timeline("when", "e-due", ("titleFieldId", "e-name"))]));
        Assert.IsFalse(noColumns.IsValid);
        Assert.AreEqual("when", noColumns.Diagnostics.Single(d => d.Code == "NUI211").SemanticId);
    }

    /// <summary>
    /// A year is two date bounds the host adds, exactly as a month is, so a
    /// timeline carries at most six declared clauses against the ceiling of eight.
    /// </summary>
    [TestMethod]
    [DataRow(6, true)]
    [DataRow(7, false)]
    public void ATimelineReservesTwoDateBoundsAgainstTheEffectiveFilterCeiling(int clauses, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot> { Timeline("when", "e-due"), Binding("when-name", "when", "e-name") };
        for (var index = 0; index < clauses; index++)
            nodes.Add(Clause($"when-clause-{index}", "when", "e-name", "isNotNull", null));

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300");
        Assert.AreEqual("when", refusal.SemanticId);
        StringAssert.Contains(refusal.Message, "9 effective filters");
        StringAssert.Contains(refusal.Hint, "2 date bounds the host adds");
    }

    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void TheTimelineRootCeilingIsEightPerEntity(int roots, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot>();
        for (var index = 0; index < roots; index++)
        {
            nodes.Add(Timeline($"tl-{index}", "e-due", ("title", $"Timeline {index}")) with { Position = index });
            nodes.Add(Binding($"tl-{index}-name", $"tl-{index}", "e-name"));
        }

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        StringAssert.Contains(
            compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI153").Message,
            "9 timelineSurface roots");
    }

    /// <summary>
    /// The introduction path: a timeline raises the recorded minimum to its own
    /// version, above every earlier widening, and removing it lowers nothing.
    /// </summary>
    [TestMethod]
    public async Task AddingATimelineRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("e-due-create", "e", "e-due", "Due", "due", NendoStorageKind.Date, false, "date"),
            new AddFieldOperation("e-end-create", "e", "e-end", "End", "end_date", NendoStorageKind.Date, false, "date"),
        ]));
        await coordinator.ApplyAsync(new("test", "list", "test", "A list",
        [
            new AddUiNodeOperation("list-add", "s", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-version", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("list-entity", "s", "list", "entityId", "e"),
            new AddUiNodeOperation("list-name-add", "s", "list-name", "list", "fieldBinding", 0),
            new SetUiPropertyOperation("list-name-field", "s", "list-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "timeline", "test", "A timeline of spans",
        [
            new AddUiNodeOperation("tl-add", "s", "tl", null, "timelineSurface", 1),
            new SetUiPropertyOperation("tl-version", "s", "tl", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("tl-entity", "s", "tl", "entityId", "e"),
            new SetUiPropertyOperation("tl-date", "s", "tl", "dateFieldId", "e-due"),
            new SetUiPropertyOperation("tl-end", "s", "tl", "endDateFieldId", "e-end"),
            new SetUiPropertyOperation("tl-title", "s", "tl", "titleFieldId", "e-name"),
            new AddUiNodeOperation("tl-name-add", "s", "tl-name", "tl", "fieldBinding", 0),
            new SetUiPropertyOperation("tl-name-field", "s", "tl-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.TimelineMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        await coordinator.ApplyAsync(new("test", "undo", "test", "Remove the timeline",
            [new RemoveUiNodeOperation("tl-remove", "s", "tl")]));
        Assert.AreEqual(NendoFormat.TimelineMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    /// <summary>The vocabulary a client reads has to describe the new root and explain its field roles.</summary>
    [TestMethod]
    public void TheVocabularyPublishesTheTimelineRootAndItsFieldRoles()
    {
        var description = NendoSemanticVocabulary.Description();
        var timeline = description.Kinds.Single(kind => kind.Kind == "timelineSurface");

        Assert.IsTrue(timeline.CanBeRoot);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity, timeline.MaxRootsPerEntity);
        Assert.Contains("dateFieldId", timeline.RequiredProperties.ToArray());
        CollectionAssert.AreEqual(new[] { "fieldBinding", "filterClause" }, timeline.Children.ToArray());
        foreach (var property in new[] { "endDateFieldId", "titleFieldId", "accentFieldId" })
        {
            Assert.IsTrue(timeline.Properties.Contains(property), property);
            Assert.IsFalse(timeline.RequiredProperties.Contains(property), $"{property} is optional");
        }
        foreach (var property in new[] { "dateFieldId", "endDateFieldId", "titleFieldId", "accentFieldId" })
            Assert.IsTrue(description.PropertyNotes!.ContainsKey(property), $"{property} needs a note");
        // Placement by the start date is the rule an author most needs told, because
        // the alternative — an overlap query — is what a project plan would expect.
        StringAssert.Contains(description.PropertyNotes!["endDateFieldId"], "placement stays by dateFieldId");
        // The reserved date bounds are published with the vocabulary, so an author
        // plans six clauses rather than discovering the seventh refuses.
        StringAssert.Contains(
            description.EffectiveFilters!.Contexts
                .Single(context => context.Context.StartsWith("Timeline", StringComparison.Ordinal)).Composition,
            "at most six declared clauses");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Timeline(
        string nodeId,
        string dateFieldId,
        params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "timelineSurface", 0,
            [
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion),
                ("entityId", "e"),
                ("dateFieldId", dateFieldId),
                .. properties,
            ]);

    private static NendoUiNodeSnapshot Binding(string nodeId, string parentNodeId, string fieldId) =>
        Node(nodeId, parentNodeId, "fieldBinding", 0, ("fieldId", fieldId));

    private static NendoUiNodeSnapshot Clause(
        string nodeId,
        string parentNodeId,
        string fieldId,
        string comparison,
        object? value) =>
        value is null
            ? Node(nodeId, parentNodeId, "filterClause", 1, ("fieldId", fieldId), ("operator", comparison))
            : Node(nodeId, parentNodeId, "filterClause", 1, ("fieldId", fieldId), ("operator", comparison), ("value", value));

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 9, 14, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "timeline.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.TimelineMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-notes", "Notes", NendoStorageKind.Text, false, "longText", []),
                    new("e-due", "Due", NendoStorageKind.Date, false, "date", []),
                    new("e-end", "End", NendoStorageKind.Date, false, "date", []),
                    new("e-when", "When", NendoStorageKind.DateTime, false, null, []),
                    new("e-stage", "Stage", NendoStorageKind.Text, false, "singleChoice", ["open", "done"]),
                ])
                {
                    DerivedFields =
                    [
                        new NendoDerivedFieldSnapshot("e-calc", "Calc", "entity.e.calc", NendoBehaviourScalar.Text, false, "Concat(name, '!')"),
                    ],
                },
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
