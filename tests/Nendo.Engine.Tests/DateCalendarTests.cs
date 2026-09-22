using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The Date calendar, ADR-0004's 2026-09-12 vocabulary-widening amendment. This
/// first slice takes a Date field, a month view and a separate undated view.
/// DateTime, time zones, week and day scheduling, duration, recurrence and
/// drag-to-date are deferred: a due-date calendar is useful without inventing
/// time semantics, and a DateTime on a month grid needs a declared time zone to
/// group by that this contract version does not define.
/// </summary>
[TestClass]
public sealed class DateCalendarTests
{
    [TestMethod]
    public void ACalendarCompilesOverAnActiveDateFieldWithItsOwnColumnsAndOrder()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Calendar("due", "e-due", ("title", "Due dates"), ("orderByFieldId", "e-name"), ("orderDirection", "ascending")),
            Binding("due-name", "due", "e-name"),
            Clause("due-open", "due", "e-stage", "ne", "done"),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var root = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("calendarSurface", root.Kind);
        Assert.AreEqual("e-due", root.Properties["dateFieldId"].GetString());
        Assert.AreEqual("e-name", root.Properties["orderByFieldId"].GetString());
        Assert.IsTrue(root.Children.Any(child => child.Kind == "filterClause"));
    }

    [TestMethod]
    [DataRow("e-when", "DateTime", "declared time zone")]
    [DataRow("e-name", "Text", "cannot place a record")]
    [DataRow("e-gone", "missing", "does not exist or is retired")]
    public void OnlyAnActiveDateFieldPlacesRecordsOnACalendar(string fieldId, string kind, string reason)
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Calendar("due", fieldId),
            Binding("due-name", "due", "e-name"),
        ]));

        Assert.IsFalse(compiled.IsValid, $"A {kind} field must not place records on a calendar.");
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI321");
        Assert.AreEqual("due", refusal.SemanticId);
        Assert.AreEqual("dateFieldId", refusal.PropertyPath);
        StringAssert.Contains($"{refusal.Message} {refusal.Hint}", reason);
        Assert.IsEmpty(compiled.Applications);
    }

    [TestMethod]
    public void ACalendarWithNoDateFieldOrNoColumnsIsRefused()
    {
        var noField = new NendoSemanticCompiler().Compile(Source(
        [
            Node("due", null, "calendarSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e")),
            Binding("due-name", "due", "e-name"),
        ]));
        Assert.IsFalse(noField.IsValid);
        Assert.AreEqual("dateFieldId", noField.Diagnostics.First(d => d.Code is "NUI091" or "NUI320").PropertyPath);

        var noColumns = new NendoSemanticCompiler().Compile(Source([Calendar("due", "e-due")]));
        Assert.IsFalse(noColumns.IsValid);
        Assert.AreEqual("due", noColumns.Diagnostics.Single(d => d.Code == "NUI211").SemanticId);
    }

    /// <summary>
    /// A month is two date bounds the host adds, so a calendar carries at most
    /// six declared clauses against the published ceiling of eight.
    /// </summary>
    [TestMethod]
    [DataRow(6, true)]
    [DataRow(7, false)]
    public void ACalendarReservesTwoDateBoundsAgainstTheEffectiveFilterCeiling(int clauses, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot> { Calendar("due", "e-due"), Binding("due-name", "due", "e-name") };
        for (var index = 0; index < clauses; index++)
            nodes.Add(Clause($"due-clause-{index}", "due", "e-name", "isNotNull", null));

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        var refusal = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI300");
        Assert.AreEqual("due", refusal.SemanticId);
        StringAssert.Contains(refusal.Message, "9 effective filters");
        StringAssert.Contains(refusal.Hint, "2 date bounds the host adds");
    }

    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void TheCalendarRootCeilingIsEightPerEntity(int roots, bool expected)
    {
        var nodes = new List<NendoUiNodeSnapshot>();
        for (var index = 0; index < roots; index++)
        {
            nodes.Add(Calendar($"cal-{index}", "e-due", ("title", $"Calendar {index}")) with { Position = index });
            nodes.Add(Binding($"cal-{index}-name", $"cal-{index}", "e-name"));
        }

        var compiled = new NendoSemanticCompiler().Compile(Source(nodes.ToArray()));

        Assert.AreEqual(expected, compiled.IsValid, Messages(compiled));
        if (expected) return;
        StringAssert.Contains(
            compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI153").Message,
            "9 calendarSurface roots");
    }

    /// <summary>
    /// The introduction path: a calendar raises the recorded minimum to its own
    /// version, above every earlier widening.
    /// </summary>
    [TestMethod]
    public async Task AddingACalendarRaisesTheRecordedMinimumIrreversibly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema",
        [
            new CreateEntityOperation("e-create", "e", "e", "e_records"),
            new AddFieldOperation("e-name-create", "e", "e-name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("e-due-create", "e", "e-due", "Due", "due", NendoStorageKind.Date, false, "date"),
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

        await coordinator.ApplyAsync(new("test", "calendar", "test", "A due-date calendar",
        [
            new AddUiNodeOperation("cal-add", "s", "cal", null, "calendarSurface", 1),
            new SetUiPropertyOperation("cal-version", "s", "cal", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("cal-entity", "s", "cal", "entityId", "e"),
            new SetUiPropertyOperation("cal-date", "s", "cal", "dateFieldId", "e-due"),
            new AddUiNodeOperation("cal-name-add", "s", "cal-name", "cal", "fieldBinding", 0),
            new SetUiPropertyOperation("cal-name-field", "s", "cal-name", "fieldId", "e-name"),
        ]));
        Assert.AreEqual(NendoFormat.DateCalendarMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        await coordinator.ApplyAsync(new("test", "undo", "test", "Remove the calendar",
            [new RemoveUiNodeOperation("cal-remove", "s", "cal")]));
        Assert.AreEqual(NendoFormat.DateCalendarMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion,
            "Removing a feature never lowers what the file records needing.");
    }

    /// <summary>The vocabulary a client reads has to describe the new root.</summary>
    [TestMethod]
    public void TheVocabularyPublishesTheCalendarRoot()
    {
        var calendar = NendoSemanticVocabulary.Description().Kinds
            .Single(kind => kind.Kind == "calendarSurface");

        Assert.IsTrue(calendar.CanBeRoot);
        Assert.AreEqual(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity, calendar.MaxRootsPerEntity);
        Assert.Contains("dateFieldId", calendar.RequiredProperties.ToArray());
        CollectionAssert.AreEqual(new[] { "fieldBinding", "filterClause" }, calendar.Children.ToArray());
        // The reserved date bounds are published with the vocabulary, so an
        // author plans six clauses rather than discovering the seventh refuses.
        StringAssert.Contains(
            NendoSemanticVocabulary.Description().EffectiveFilters!.Contexts
                .Single(context => context.Context.StartsWith("Calendar", StringComparison.Ordinal)).Composition,
            "at most six declared clauses");
    }

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));

    private static NendoUiNodeSnapshot Calendar(
        string nodeId,
        string dateFieldId,
        params (string Name, object Value)[] properties) =>
        Node(nodeId, null, "calendarSurface", 0,
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
        var now = new DateTimeOffset(2026, 9, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "calendar.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.DateCalendarMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("e", "Example",
                [
                    new("e-name", "Name", NendoStorageKind.Text, true, "singleLine", []),
                    new("e-due", "Due", NendoStorageKind.Date, false, "date", []),
                    new("e-when", "When", NendoStorageKind.DateTime, false, null, []),
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
