using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A custom view on a record page, scoped to that page's one record (ADR-0013, 2026-09-24
/// record-set amendment; W-061 step 2). It takes its record type from the page, reads only
/// the fields it names, and those fields are never the form's.
/// </summary>
[TestClass]
public sealed class ExtensionRecordPanelTests
{
    private static Dictionary<string, object?> Properties(int protocol = 2) => new()
    {
        ["title"] = "Schedule", ["packageId"] = "org.nendo.gantt", ["packageVersion"] = "0.1.0",
        ["packageDigest"] = new string('a', 64), ["protocolVersion"] = protocol,
        ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "title",
    };

    private static (string, Dictionary<string, object?>) Disclose(string fieldId) => ("fieldBinding", new() { ["fieldId"] = fieldId });

    private static async Task<NendoApplicationService> Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            new AddFieldOperation("secret", "tasks", "secret", "Secret", "secret", NendoStorageKind.Text, false),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Tasks", Enumerable.Range(0, 3).Select(i =>
            (NendoOperation)new CreateRecordOperation("t" + i, "tasks", "t" + i, new Dictionary<string, object?>
            { ["title"] = "Task " + i, ["starts"] = $"2026-10-0{i + 1}", ["secret"] = "never sent" })).ToArray()));
        return new(coordinator);
    }

    /// <summary>
    /// A record page for tasks with its own title field, a section, and the view inside the
    /// section. <paramref name="root"/> is the page kind; <paramref name="parent"/> is where
    /// the view goes: "page", "section", or null for no page at all (the view as a root).
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
            operations.Add(new AddUiNodeOperation(id + "-add", parent is null ? id : "page", id, parent, NendoExtensionViewDefinition.PanelKind, 5 + v));
            operations.AddRange(properties.Select(p => new SetUiPropertyOperation(id + "-" + p.Key, parent is null ? id : "page", id, p.Key, p.Value)));
            operations.AddRange(children.SelectMany((child, i) => (NendoOperation[])[
                new AddUiNodeOperation($"{id}-c{i}", parent is null ? id : "page", $"{id}-c{i}", id, child.Item1, i),
                .. child.Item2.Select(p => new SetUiPropertyOperation($"{id}-c{i}-{p.Key}", parent is null ? id : "page", $"{id}-c{i}", p.Key, p.Value))]));
        }
        return new("proposal-" + Guid.NewGuid().ToString("N"), "panel", "test", new([new("test", "panel", "test", "Panel", operations)]));
    }

    private static async Task Pin(NendoApplicationService service, NendoProposalRequest request)
    {
        var preview = await service.PrepareProposalAsync(request);
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
    }

    [TestMethod]
    public async Task APanelSendsItsOneRecordWithExactlyTheDisclosedFields()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        await Pin(service, Page(Properties(), [Disclose("starts")]));
        Assert.AreEqual(NendoFormat.ExtensionRecordPanelMinimumHostVersion, (await service.GetDefinitionSnapshotAsync()).Manifest.MinimumHostVersion);

        // Described without a record, which is what its review and status read.
        var described = await service.ReadExtensionViewAsync("panel");
        Assert.IsTrue(described.Definition.IsRecordPanel);
        Assert.AreEqual("tasks", described.Definition.Binding.NodeEntityId);
        Assert.IsEmpty(described.Projection.Nodes);

        var view = await service.ReadExtensionViewAsync("panel", "t1");
        var record = view.Projection.Nodes.Single();
        Assert.AreEqual("t1", record.Id);
        CollectionAssert.AreEquivalent(new[] { "starts" }, record.Values!.Keys.ToArray());
        Assert.AreEqual("2026-10-02", record.Values["starts"]);

        var grant = new NendoExtensionGrant(view.ApplicationId, view.InstanceId, "panel", view.Definition.PackageDigest,
            view.Definition.ComputeBindingDigest(), 2);
        using var session = new NendoExtensionViewSession(grant, new Authority(grant), view.Projection);
        var sent = Encoding.UTF8.GetString(session.GetInitialization("light", "en"));
        Assert.IsFalse(sent.Contains("never sent", StringComparison.Ordinal), sent);
        Assert.IsFalse(sent.Contains("Task 0", StringComparison.Ordinal) || sent.Contains("Task 2", StringComparison.Ordinal),
            "A view on one record's page was sent another record: " + sent);
        using var document = JsonDocument.Parse(sent);
        var shape = document.RootElement.GetProperty("projection");
        CollectionAssert.AreEquivalent(new[] { "sourceChangeSequence", "fields", "record" }, shape.EnumerateObject().Select(p => p.Name).ToArray(), sent);
        Assert.AreEqual("Task 1", shape.GetProperty("record").GetProperty("label").GetString());

        // Its permission is not a record set's over the same fields: one reads a record, the other all of them.
        var properties = Properties().ToDictionary(p => p.Key, p => JsonSerializer.SerializeToElement(p.Value));
        properties["entityId"] = JsonSerializer.SerializeToElement("tasks");
        var records = NendoExtensionViewDefinition.Read("panel", properties,
            [new("page", "panel-c0", "panel", "fieldBinding", 0, new Dictionary<string, JsonElement> { ["fieldId"] = JsonSerializer.SerializeToElement("starts") })],
            NendoExtensionViewDefinition.RecordsKind);
        Assert.AreEqual(view.Definition.Binding, records.Binding);
        Assert.AreNotEqual(records.ComputeBindingDigest(), view.Definition.ComputeBindingDigest());
    }

    [TestMethod]
    public async Task APanelsRecordMustExistAndOnlyAPanelTakesOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await Seed(coordinator);
        await Pin(service, Page(Properties(), [Disclose("starts")]));
        Assert.AreEqual("extension-record-missing",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ReadExtensionViewAsync("panel", "nowhere"))).Code);
        Assert.AreEqual("extension-view-missing",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ReadExtensionViewAsync("section", "t1"))).Code);
        // A session refuses a panel projection that is not exactly one record.
        var described = await service.ReadExtensionViewAsync("panel");
        var grant = new NendoExtensionGrant(described.ApplicationId, described.InstanceId, "panel", described.Definition.PackageDigest,
            described.Definition.ComputeBindingDigest(), 2);
        Assert.ThrowsExactly<ArgumentException>(() => new NendoExtensionViewSession(grant, new Authority(grant), described.Projection));
    }

    [TestMethod]
    public async Task APanelsFieldsAreNotTheFormsFields()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        await Pin(service, Page(Properties(), [Disclose("starts"), Disclose("secret")], root: "recordForm", parent: "page"));
        var compiled = new NendoSemanticCompiler().Compile(await service.GetSnapshotAsync());
        var page = compiled.Applications.Single().Surfaces.Single(s => s.Kind == "recordForm");
        static IEnumerable<NendoSurfaceNodePlan> Walk(IEnumerable<NendoSurfaceNodePlan> nodes) => nodes.SelectMany(n => Walk(n.Children).Prepend(n));
        var bound = Walk(page.Children).Where(n => n.Kind == "fieldBinding").Select(n => n.Properties["fieldId"].GetString()).Distinct().ToArray();
        CollectionAssert.AreEquivalent(new[] { "title" }, bound, "A view's disclosed fields leaked into the form it sits on.");
        var panel = Walk(page.Children).Single(n => n.Kind == NendoExtensionViewDefinition.PanelKind);
        Assert.IsEmpty(panel.Children);
    }

    [TestMethod]
    public async Task TheCompilerRefusesAPanelAnywhereButARecordPage()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        async Task Refused(string why, NendoProposalRequest request)
        {
            var preview = await service.PrepareProposalAsync(request);
            Assert.AreNotEqual(NendoProposalState.Previewable, preview.State, why);
            Assert.IsNotEmpty(preview.Diagnostics.Where(d => d.Severity == NendoDiagnosticSeverity.Error).ToArray(), why);
        }
        await Refused("as a root", Page(Properties(), [Disclose("starts")], parent: null));
        await Refused("protocol 1", Page(Properties(protocol: 1), []));
        var named = Properties(); named["entityId"] = "tasks";
        await Refused("its own record type", Page(named, [Disclose("starts")]));
        var edged = Properties(); edged["edgeEntityId"] = "tasks";
        await Refused("an edge type", Page(edged, [Disclose("starts")]));
        await Refused("a filter", Page(Properties(), [Disclose("starts"), ("filterClause", new() { ["fieldId"] = "title", ["operator"] = "isNotNull" })]));
        await Refused("a field it cannot read", Page(Properties(), [Disclose("nothing")]));
        await Refused("five on one page", Page(Properties(), [Disclose("starts")], views: NendoExtensionViewDefinition.MaximumPanelsPerPage + 1));
        await Pin(service, Page(Properties(), [Disclose("starts")], views: NendoExtensionViewDefinition.MaximumPanelsPerPage));
    }

    private sealed class Authority(NendoExtensionGrant expected) : INendoExtensionAuthority
    {
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoExtensionGrant grant) => grant == expected;
    }
}
