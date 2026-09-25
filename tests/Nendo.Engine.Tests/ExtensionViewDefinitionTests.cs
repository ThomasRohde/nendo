using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Custom-view definitions as ADR-0013 reads them since 2026-09-25: a view names its package in
/// the file, a record type, and the fields it shows — stored or calculated — and its code reads
/// the rest through the file's API. Nothing in a definition is a permission, and a view the
/// earlier rules accepted keeps the host version it had.
/// </summary>
[TestClass]
public sealed class ExtensionViewDefinitionTests
{
    /// <summary>A panel exactly as a 1.32 host wrote it: pinned, protocol 2, empty configuration.</summary>
    private static Dictionary<string, object?> PinnedPanel() => new()
    {
        ["title"] = "Schedule", ["packageId"] = "org.nendo.gantt", ["packageVersion"] = "0.1.0",
        ["packageDigest"] = new string('a', 64), ["protocolVersion"] = 2,
        ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "title",
    };

    /// <summary>A panel as this host writes one: a package, a title and a label.</summary>
    private static Dictionary<string, object?> OpenPanel() => new()
    {
        ["title"] = "Schedule", ["packageId"] = "org.nendo.gantt", ["labelFieldId"] = "title",
    };

    private static (string, Dictionary<string, object?>) Show(string fieldId) => ("fieldBinding", new() { ["fieldId"] = fieldId });

    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> Seed(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            new AddFieldOperation("ends", "tasks", "ends", "Ends", "ends", NendoStorageKind.Date, false),
        ]));
        var service = new NendoApplicationService(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "calculation", "test", "Title length", [
            new SetBehaviourDefinitionOperation("length", new NendoCalculationDefinition("tasks.titleLength", "tasks", "titleLength",
                "Title length", NendoBehaviourScalar.Integer, true, "TextLength(title)",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Tasks", Enumerable.Range(0, 3).Select(i =>
            (NendoOperation)new CreateRecordOperation("t" + i, "tasks", "t" + i, new Dictionary<string, object?>
            { ["title"] = "Task " + i, ["starts"] = $"2026-10-0{i + 1}" })).ToArray()));
        return (coordinator, service);
    }

    /// <summary>
    /// A record page for tasks with its own title field and a section; the views go where
    /// <paramref name="parent"/> says: "page", "section", or null for no page at all.
    /// </summary>
    private static NendoProposalRequest Page(Dictionary<string, object?> properties, (string, Dictionary<string, object?>)[] children,
        string root = "detailSurface", string? parent = "section", int views = 1)
    {
        var operations = new List<NendoOperation>
        {
            new AddUiNodeOperation("page", "page", "page", null, root, 0),
            new SetUiPropertyOperation("page-v", "page", "page", "definitionVersion", 3),
            new SetUiPropertyOperation("page-e", "page", "page", "entityId", "tasks"),
            new AddUiNodeOperation("page-f", "page", "page-title", "page", "fieldBinding", 0),
            new SetUiPropertyOperation("page-f-id", "page", "page-title", "fieldId", "title"),
            new AddUiNodeOperation("section", "page", "section", "page", "section", 1),
            new SetUiPropertyOperation("section-t", "page", "section", "title", "Plan"),
            new AddUiNodeOperation("section-f", "page", "section-title", "section", "fieldBinding", 0),
            new SetUiPropertyOperation("section-f-id", "page", "section-title", "fieldId", "title"),
        };
        for (var v = 0; v < views; v++)
        {
            var id = v == 0 ? "panel" : "panel" + v;
            var surface = parent is null ? id : "page";
            operations.Add(new AddUiNodeOperation(id + "-add", surface, id, parent, NendoExtensionViewDefinition.PanelKind, 5 + v));
            operations.AddRange(properties.Select(p => new SetUiPropertyOperation(id + "-" + p.Key, surface, id, p.Key, p.Value)));
            operations.AddRange(children.SelectMany((child, i) => (NendoOperation[])[
                new AddUiNodeOperation($"{id}-c{i}", surface, $"{id}-c{i}", id, child.Item1, i),
                .. child.Item2.Select(p => new SetUiPropertyOperation($"{id}-c{i}-{p.Key}", surface, $"{id}-c{i}", p.Key, p.Value))]));
        }
        return new("proposal-" + Guid.NewGuid().ToString("N"), "panel", "test", new([new("test", "panel-" + Guid.NewGuid().ToString("N"), "test", "Panel", operations)]));
    }

    /// <summary>A record-set view of tasks as a root of its own.</summary>
    private static NendoProposalRequest Records(Dictionary<string, object?> properties, (string, Dictionary<string, object?>)[] children)
    {
        var operations = new List<NendoOperation> { new AddUiNodeOperation("records-add", "records", "records", null, NendoExtensionViewDefinition.RecordsKind, 0) };
        operations.AddRange(properties.Select(p => new SetUiPropertyOperation("records-" + p.Key, "records", "records", p.Key, p.Value)));
        operations.AddRange(children.SelectMany((child, i) => (NendoOperation[])[
            new AddUiNodeOperation($"records-c{i}", "records", $"records-c{i}", "records", child.Item1, i),
            .. child.Item2.Select(p => new SetUiPropertyOperation($"records-c{i}-{p.Key}", "records", $"records-c{i}", p.Key, p.Value))]));
        return new("proposal-" + Guid.NewGuid().ToString("N"), "records", "test", new([new("test", "records-" + Guid.NewGuid().ToString("N"), "test", "Records", operations)]));
    }

    private static async Task<NendoProposalPreview> Accept(NendoApplicationService service, NendoProposalRequest request)
    {
        var preview = await service.PrepareProposalAsync(request);
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
        return preview;
    }

    private static async Task Refused(NendoApplicationService service, string why, NendoProposalRequest request)
    {
        var preview = await service.PrepareProposalAsync(request);
        Assert.AreNotEqual(NendoProposalState.Previewable, preview.State, why);
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Severity == NendoDiagnosticSeverity.Error), why);
    }

    [TestMethod]
    public async Task AViewNamesAPackageAndShowsAnyFieldStoredOrCalculated()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var properties = OpenPanel();
        properties["statusFieldId"] = "titleLength";
        properties["configuration"] = JsonSerializer.Serialize(new { start = "starts", end = "ends", zoom = new[] { 1, 2, 4 } });
        var preview = await Accept(service, Page(properties, [Show("starts"), Show("ends"), Show("titleLength")]));
        Assert.AreEqual(NendoFormat.OpenCustomViewsMinimumHostVersion, preview.MinimumHostVersionAfter);

        var snapshot = await service.GetDefinitionSnapshotAsync();
        var node = snapshot.UiNodes.Single(n => n.NodeId == "panel");
        var definition = NendoExtensionViewDefinition.ReadNode(node, snapshot.UiNodes);
        Assert.AreEqual("tasks", definition.Binding.NodeEntityId, "A panel takes its record type from its page.");
        CollectionAssert.AreEqual(new[] { "starts", "ends", "titleLength" }, definition.Binding.FieldIds.ToArray());
        using var configuration = JsonDocument.Parse(definition.Configuration);
        Assert.AreEqual("starts", configuration.RootElement.GetProperty("start").GetString());
    }

    [TestMethod]
    public async Task AViewTheEarlierRulesAcceptedKeepsItsHostVersion()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var preview = await Accept(service, Page(PinnedPanel(), [Show("starts")]));
        Assert.AreEqual(NendoFormat.ExtensionRecordPanelMinimumHostVersion, preview.MinimumHostVersionAfter,
            "A view the 1.32 rules accepted was raised to the host that reads open definitions, which disables editing it in the host that opened it.");
    }

    [TestMethod]
    [DataRow("no pins")]
    [DataRow("configuration")]
    [DataRow("calculated field")]
    [DataRow("relative filter")]
    public async Task WhatTheEarlierRulesRefusedRaisesTheFileToTheOpenRung(string shape)
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var properties = PinnedPanel();
        properties.Remove("edgeEntityId");
        properties["entityId"] = "tasks";
        properties["definitionVersion"] = 3;
        (string, Dictionary<string, object?>)[] children = [Show("starts")];
        switch (shape)
        {
            case "no pins": properties.Remove("packageDigest"); break;
            case "configuration": properties["configuration"] = "{\"zoom\":2}"; break;
            case "calculated field": children = [Show("titleLength")]; break;
            case "relative filter": children = [Show("starts"), ("filterClause", new() { ["fieldId"] = "starts", ["operator"] = "lte", ["valueKind"] = "today" })]; break;
        }
        var preview = await Accept(service, Records(properties, children));
        Assert.AreEqual(NendoFormat.OpenCustomViewsMinimumHostVersion, preview.MinimumHostVersionAfter, shape);
    }

    [TestMethod]
    public async Task APanelBelongsOnARecordPageAndReadsThatPagesRecordType()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        await Refused(service, "as a root", Page(OpenPanel(), [Show("starts")], parent: null));
        var named = OpenPanel(); named["entityId"] = "tasks";
        await Refused(service, "its own record type", Page(named, [Show("starts")]));
        var edged = OpenPanel(); edged["edgeEntityId"] = "tasks";
        await Refused(service, "an edge type", Page(edged, [Show("starts")]));
        await Refused(service, "a filter", Page(OpenPanel(), [Show("starts"), ("filterClause", new() { ["fieldId"] = "title", ["operator"] = "isNotNull" })]));
        await Refused(service, "a field that does not exist", Page(OpenPanel(), [Show("nothing")]));
        var unlabelled = OpenPanel(); unlabelled["labelFieldId"] = "nothing";
        await Refused(service, "a label that does not exist", Page(unlabelled, []));
        // No cap on how many a page carries: each draws where it was put.
        await Accept(service, Page(OpenPanel(), [Show("starts")], views: 6));
    }

    [TestMethod]
    public async Task AFilterFeedsTheSameQueriesSoItNamesAStoredField()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "tasks", ["title"] = "Soon", ["packageId"] = "org.nendo.gantt", ["labelFieldId"] = "title" };
        await Refused(service, "a filter on a calculated field", Records(properties,
            [("filterClause", new() { ["fieldId"] = "titleLength", ["operator"] = "gt", ["value"] = 3 })]));
        await Refused(service, "an operator the vocabulary does not have", Records(properties,
            [("filterClause", new() { ["fieldId"] = "title", ["operator"] = "matches", ["value"] = "x" })]));
        await Accept(service, Records(properties,
            [("filterClause", new() { ["fieldId"] = "starts", ["operator"] = "gte", ["valueKind"] = "today" })]));
    }

    [TestMethod]
    public async Task AViewWhosePackageIsNotInTheFileCompilesWithAWarning()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Seed(workspace);
        var preview = await Accept(service, Page(OpenPanel(), [Show("starts")]));
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Code == "NUI452" && d.Severity == NendoDiagnosticSeverity.Warning),
            string.Join(";", preview.Diagnostics.Select(d => d.Code)));

        await coordinator.ApplyAsync(new("test", "package", "test", "Put the package in the file", [
            new SetExtensionPackageOperation("p", "org.nendo.gantt", "Gantt", "index.html"),
            PutExtensionFileOperation.FromContent("f", "org.nendo.gantt", "index.html", null, "<!doctype html>"u8.ToArray()),
        ]));
        var compiled = new NendoSemanticCompiler().Compile(await service.GetSnapshotAsync());
        Assert.IsFalse(compiled.Diagnostics.Any(d => d.Code == "NUI452"), "The warning outlived the package arriving in the file.");
    }

    [TestMethod]
    public async Task APanelsFieldsAreTheViewsNotTheForms()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        await Accept(service, Page(OpenPanel(), [Show("starts"), Show("ends")], root: "recordForm", parent: "page"));
        var compiled = new NendoSemanticCompiler().Compile(await service.GetSnapshotAsync());
        var page = compiled.Applications.Single().Surfaces.Single(s => s.Kind == "recordForm");
        static IEnumerable<NendoSurfaceNodePlan> Walk(IEnumerable<NendoSurfaceNodePlan> nodes) => nodes.SelectMany(n => Walk(n.Children).Prepend(n));
        var bound = Walk(page.Children).Where(n => n.Kind == "fieldBinding").Select(n => n.Properties["fieldId"].GetString()).Distinct().ToArray();
        CollectionAssert.AreEquivalent(new[] { "title" }, bound, "A view's fields leaked into the form it sits on.");
        Assert.IsEmpty(Walk(page.Children).Single(n => n.Kind == NendoExtensionViewDefinition.PanelKind).Children);
    }

    [TestMethod]
    public async Task TheReviewSaysWhatAViewShowsAndThatItsCodeRuns()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var lines = (await service.PrepareProposalAsync(Page(OpenPanel(), [Show("starts")]))).SemanticDiff.Select(e => e.Summary).ToArray();
        CollectionAssert.Contains(lines, "Show Starts in the custom view \"Schedule\".", string.Join(" | ", lines));
        CollectionAssert.Contains(lines, "Label each record with Title.", string.Join(" | ", lines));
        Assert.IsFalse(lines.Any(line => line.Contains("consent", StringComparison.OrdinalIgnoreCase) || line.Contains("install", StringComparison.OrdinalIgnoreCase)),
            "A review still speaks of installing a package or consenting to it: " + string.Join(" | ", lines));
        Assert.IsFalse(lines.Any(line => line.StartsWith("This code runs", StringComparison.Ordinal)), "A proposal with no code said code would run.");

        var code = new NendoProposalRequest("proposal-" + Guid.NewGuid().ToString("N"), "code", "test", new([new("test", "code", "test", "Code", [
            new SetExtensionPackageOperation("p", "org.nendo.gantt", "Gantt", "index.html"),
            PutExtensionFileOperation.FromContent("f", "org.nendo.gantt", "index.html", null, "<!doctype html>"u8.ToArray()),
        ])]));
        var codeLines = (await service.PrepareProposalAsync(code)).SemanticDiff.Select(e => e.Summary).ToArray();
        Assert.AreEqual(1, codeLines.Count(line => line.StartsWith("This code runs when a view that uses its package is shown.", StringComparison.Ordinal)),
            "Accepting code must say, once, that it runs: " + string.Join(" | ", codeLines));
    }

    [TestMethod]
    public void ConfigurationIsAnyObjectWithinItsBound()
    {
        Dictionary<string, JsonElement> Properties(object? configuration)
        {
            var properties = new Dictionary<string, object?>
            {
                ["title"] = "Soon", ["entityId"] = "tasks", ["packageId"] = "org.nendo.gantt", ["labelFieldId"] = "title",
            };
            if (configuration is not null) properties["configuration"] = configuration;
            return properties.ToDictionary(p => p.Key, p => JsonSerializer.SerializeToElement(p.Value));
        }
        Assert.AreEqual("{}", NendoExtensionViewDefinition.Read("v", Properties(null), [], NendoExtensionViewDefinition.RecordsKind).Configuration);
        var settings = JsonSerializer.Serialize(new { script = "anything the view reads", nested = new { deeper = true } });
        Assert.AreEqual(settings, NendoExtensionViewDefinition.Read("v", Properties(settings), [], NendoExtensionViewDefinition.RecordsKind).Configuration);
        Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionViewDefinition.Read("v", Properties("[1,2]"), [], NendoExtensionViewDefinition.RecordsKind));
        Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionViewDefinition.Read("v", Properties("not json"), [], NendoExtensionViewDefinition.RecordsKind));
        var large = "{\"x\":\"" + new string('a', NendoExtensionViewDefinition.MaximumConfigurationBytes) + "\"}";
        Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionViewDefinition.Read("v", Properties(large), [], NendoExtensionViewDefinition.RecordsKind));
    }

    [TestMethod]
    public async Task RemovingAViewKeepsItsRecordsAndCanBeReversed()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Seed(workspace);
        var properties = new Dictionary<string, object?> { ["definitionVersion"] = 3, ["entityId"] = "tasks", ["title"] = "Soon", ["packageId"] = "org.nendo.gantt", ["labelFieldId"] = "title" };
        await Accept(service, Records(properties, []));
        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove view", [new RemoveUiNodeOperation("remove", "records", "records")]));
        Assert.HasCount(3, (await service.GetSnapshotAsync()).Records);
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation);
        await service.CompensateRevisionAsync(removed.RevisionId, "restore-view");
        Assert.IsTrue((await service.GetDefinitionSnapshotAsync()).UiNodes.Any(n => n.NodeId == "records"));
    }
}
