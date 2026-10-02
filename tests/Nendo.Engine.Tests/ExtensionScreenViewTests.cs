namespace Nendo.Engine.Tests;

/// <summary>
/// A custom view as a screen of the file (ADR-0013 Phase 5, W-106): an extensionView root that
/// belongs to the file as the front page does, names a package, a title and at most the record
/// type it is about, and may say that the file opens on it. A file holding one needs host 1.42.0.
/// </summary>
[TestClass]
public sealed class ExtensionScreenViewTests
{
    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> Seed(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
        ]));
        return (coordinator, new NendoApplicationService(coordinator));
    }

    private static Dictionary<string, object?> Workbench() => new()
    {
        ["definitionVersion"] = 3, ["title"] = "Workbench", ["packageId"] = "org.nendo.archi",
    };

    /// <summary>A list of tasks, so the file has a record type's screen beside the views.</summary>
    private static NendoOperation[] TaskList() =>
    [
        new AddUiNodeOperation("list-add", "list", "list", null, "recordList", 0),
        new SetUiPropertyOperation("list-v", "list", "list", "definitionVersion", 3),
        new SetUiPropertyOperation("list-e", "list", "list", "entityId", "tasks"),
        new AddUiNodeOperation("list-f", "list", "list-title", "list", "fieldBinding", 0),
        new SetUiPropertyOperation("list-f-id", "list", "list-title", "fieldId", "title"),
    ];

    private static NendoOperation[] View(string id, Dictionary<string, object?> properties, int position = 0) =>
    [
        new AddUiNodeOperation(id + "-add", id, id, null, NendoExtensionViewDefinition.ScreenKind, position),
        .. properties.Select(p => (NendoOperation)new SetUiPropertyOperation(id + "-" + p.Key, id, id, p.Key, p.Value)),
    ];

    private static NendoProposalRequest Proposal(params NendoOperation[][] parts) =>
        new("proposal-" + Guid.NewGuid().ToString("N"), "views", "test",
            new([new("test", "views-" + Guid.NewGuid().ToString("N"), "test", "Views", parts.SelectMany(part => part).ToArray())]));

    private static async Task<NendoProposalPreview> Accept(NendoApplicationService service, NendoProposalRequest request)
    {
        var preview = await service.PrepareProposalAsync(request);
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
        return preview;
    }

    private static async Task Refused(NendoApplicationService service, string code, string why, NendoProposalRequest request)
    {
        var preview = await service.PrepareProposalAsync(request);
        Assert.AreNotEqual(NendoProposalState.Previewable, preview.State, why);
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Code == code && d.Severity == NendoDiagnosticSeverity.Error),
            $"{why}: expected {code}, got {string.Join("; ", preview.Diagnostics.Select(d => d.Code + " " + d.Message))}");
    }

    [TestMethod]
    public async Task AViewOfTheFileIsAScreenBesideTheRecordTypesAndCanOpenTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var opening = Workbench();
        opening["opensFile"] = true;
        opening["entityId"] = "tasks";
        opening["configuration"] = "{\"layout\":\"wide\"}";
        var notes = Workbench(); notes["title"] = "Notes";
        var preview = await Accept(service, Proposal(TaskList(), View("workbench", opening), View("notes", notes, 1)));
        Assert.AreEqual(NendoFormat.FileViewMinimumHostVersion, preview.MinimumHostVersionAfter,
            "A file with a view of its own must state the host that compiles one.");

        var compiled = await service.CompileSemanticDefinitionAsync();
        Assert.IsTrue(compiled.IsValid);
        CollectionAssert.AreEqual(new[] { "workbench", "notes" }, compiled.Views.Select(view => view.SemanticId).ToArray(),
            "The file's views are its own, in authored order.");
        Assert.IsTrue(compiled.Views.All(view => view.Kind == NendoExtensionViewDefinition.ScreenKind && view.Children.Count == 0));
        CollectionAssert.AreEqual(new[] { "tasks" }, compiled.Applications.Select(app => app.Entity.SemanticId).ToArray(),
            "A view that names what it is about is still the file's, not a screen of that record type.");
        Assert.IsFalse(compiled.Applications.SelectMany(app => app.Surfaces).Any(surface => surface.Kind == NendoExtensionViewDefinition.ScreenKind));
        Assert.IsTrue(compiled.Diagnostics.Any(d => d.Code == "NUI452" && d.SemanticId == "workbench" && d.Severity == NendoDiagnosticSeverity.Warning),
            "A package the file does not carry yet is a warning, as for every view.");

        var snapshot = await service.GetDefinitionSnapshotAsync();
        var workbench = NendoExtensionViewDefinition.ReadNode(snapshot.UiNodes.Single(node => node.NodeId == "workbench"), snapshot.UiNodes);
        Assert.IsTrue(workbench.IsScreen && workbench.OpensFile);
        Assert.AreEqual("tasks", workbench.SubjectEntityId);
        Assert.AreEqual("{\"layout\":\"wide\"}", workbench.Configuration);
        var other = NendoExtensionViewDefinition.ReadNode(snapshot.UiNodes.Single(node => node.NodeId == "notes"), snapshot.UiNodes);
        Assert.IsFalse(other.OpensFile);
        Assert.IsNull(other.SubjectEntityId, "A view that names no record type is about none.");
    }

    [TestMethod]
    public async Task OneViewOpensTheFileAndAViewNamesNothingItDoesNotNeed()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        var opening = Workbench(); opening["opensFile"] = true;
        var alsoOpening = Workbench(); alsoOpening["opensFile"] = true; alsoOpening["title"] = "Second";
        await Refused(service, "NUI453", "two views open the file", Proposal(View("one", opening), View("two", alsoOpening, 1)));
        var missing = Workbench(); missing["entityId"] = "nothing";
        await Refused(service, "NUI450", "a record type that does not exist", Proposal(View("one", missing)));
        var unsure = Workbench(); unsure["opensFile"] = "yes";
        await Refused(service, "NUI450", "opensFile that is not true or false", Proposal(View("one", unsure)));
        var labelled = Workbench(); labelled["labelFieldId"] = "title";
        await Refused(service, "NUI090", "a label, which only a bound view has", Proposal(View("one", labelled)));
        var untitled = Workbench(); untitled.Remove("title");
        await Refused(service, "NUI091", "no title", Proposal(View("one", untitled)));
        await Refused(service, "NUI013", "a field binding, which its code does not need", Proposal(View("one", Workbench()),
            [new AddUiNodeOperation("child-add", "one", "child", "one", "fieldBinding", 0), new SetUiPropertyOperation("child-f", "one", "child", "fieldId", "title")]));
        await Refused(service, "NUI391", "nine views", Proposal(Enumerable.Range(0, 9).Select(i => View("v" + i, Workbench(), i)).ToArray()));
        await Accept(service, Proposal(Enumerable.Range(0, 8).Select(i => View("v" + i, Workbench(), i)).ToArray()));
    }

    /// <summary>
    /// A file whose screens all belong to the file has no record type's plan to project records
    /// into. The projection dropped everything else, so such a file lost its views, and a file
    /// whose only screen was its front page lost that too, and opened on Studio.
    /// </summary>
    [TestMethod]
    public async Task AFileWhoseScreensAllBelongToTheFileKeepsThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await Seed(workspace);
        await Accept(service, Proposal([
            new AddUiNodeOperation("front-add", "front", "front", null, "overviewSurface", 0),
            new SetUiPropertyOperation("front-v", "front", "front", "definitionVersion", 3),
            new SetUiPropertyOperation("front-t", "front", "front", "title", "Front page"),
            new AddUiNodeOperation("count-add", "front", "count", "front", "summaryTile", 0),
            new SetUiPropertyOperation("count-e", "front", "count", "entityId", "tasks"),
            new SetUiPropertyOperation("count-a", "front", "count", "aggregate", "count"),
        ]));
        var frontOnly = await service.CompileSemanticDefinitionAsync();
        Assert.IsTrue(frontOnly.IsValid);
        Assert.IsEmpty(frontOnly.Applications);
        Assert.AreEqual("front", frontOnly.Overview?.Surface.SemanticId, "A file whose only screen is its front page lost it.");
        await Accept(service, Proposal(View("workbench", Workbench(), 1)));
        var both = await service.CompileSemanticDefinitionAsync();
        Assert.AreEqual("front", both.Overview?.Surface.SemanticId);
        CollectionAssert.AreEqual(new[] { "workbench" }, both.Views.Select(view => view.SemanticId).ToArray(), "A file whose screens are all its own lost its view.");
    }

    [TestMethod]
    public async Task ARemovedViewOfTheFileComesBackWithItsProperties()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Seed(workspace);
        var opening = Workbench(); opening["opensFile"] = true;
        await Accept(service, Proposal(View("workbench", opening)));
        var removed = await coordinator.ApplyAsync(new NendoMutation("test", "remove-view", "test", "Remove the workbench",
            [new RemoveUiNodeOperation("operation-remove", "workbench", "workbench")]));
        Assert.IsEmpty((await service.CompileSemanticDefinitionAsync()).Views);
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        var after = await service.CompileSemanticDefinitionAsync();
        var view = after.Views.Single();
        Assert.AreEqual("workbench", view.SemanticId);
        Assert.IsTrue(view.Properties["opensFile"].GetBoolean());
    }
}
