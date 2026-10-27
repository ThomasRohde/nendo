using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// Icons from Nendo's set (ADR-0038). A record type's icon is a row in its own protected table on
/// the rung above the file's own icon, written by schema.setEntityIcon and undone to the icon it
/// replaced. A screen's or a view's icon is an <c>icon</c> property on its node, checked against
/// the same set by the compiler and lifted onto the plan.
/// </summary>
[TestClass]
public sealed class EntityIconTests
{
    private const string EntityIconLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-search-media-icon-entityicon-v1";

    private const string Albums = "albums";

    [TestMethod]
    public async Task AChosenIconIsStoredReadBackAfterReopenAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);

        await SetIconAsync(coordinator, service, Albums, "folder", "choose");
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("folder", after.Entities.Single(entity => entity.EntityId == Albums).Icon);
        Assert.AreEqual(NendoFormat.IconsMinimumHostVersion, after.Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(EntityIconLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding =>
            finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        Assert.AreEqual("folder", (await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == Albums).Icon);

        // Changing it writes through the other read path: one record type's mapping.
        await SetIconAsync(coordinator, service, Albums, "calendar", "change");
        Assert.AreEqual("calendar", (await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == Albums).Icon);
    }

    /// <summary>A file that never chooses an icon gains no table and states no newer host, even when told to clear one.</summary>
    [TestMethod]
    public async Task AFileThatNeverChoosesAnIconKeepsItsLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var host = (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var before = (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout;

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        await SetIconAsync(coordinator, service, Albums, null, "clear");
        var after = await service.GetSnapshotAsync();
        Assert.IsNull(after.Entities.Single().Icon);
        Assert.AreEqual(host, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual(before, (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout);
        Assert.AreEqual("production-semantic-v1", before);
    }

    [TestMethod]
    public async Task ChoosingAnIconCanBeCompensatedBackToTheOneBeforeAndToNone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var first = await SetIconAsync(coordinator, service, Albums, "folder", "first");
        await service.CompensateRevisionAsync(first.RevisionId, "undo-first");
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Icon, "the first choice is undone to the guessed icon");

        await SetIconAsync(coordinator, service, Albums, "folder", "again");
        var second = await SetIconAsync(coordinator, service, Albums, "calendar", "second");
        await service.CompensateRevisionAsync(second.RevisionId, "undo-second");
        Assert.AreEqual("folder", (await service.GetSnapshotAsync()).Entities.Single().Icon, "a change is undone to the icon it replaced");
    }

    [TestMethod]
    public async Task AnUnknownNameARetiredOrMissingTypeAndAStaleRevisionAreRefused()
    {
        var unknown = Assert.ThrowsExactly<NendoValidationException>(() => new SetEntityIconOperation("i", Albums, "not-an-icon", 0));
        StringAssert.Contains(unknown.Message, "'not-an-icon' is not an icon in Nendo's set");
        StringAssert.Contains(unknown.Message, NendoIconSet.ResourceUri);
        Assert.ThrowsExactly<NendoValidationException>(() => CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
            "i", "schema.setEntityIcon", JsonDocument.Parse("""{"entityId":"albums","icon":"Folder","expectedDefinitionRevision":1}""").RootElement)));

        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        Assert.AreEqual("entity-not-found", (await Refused(() => SetIconAsync(coordinator, service, "nothing", "folder", "missing"))).Code);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreEqual("definition-version-conflict", (await Refused(() => coordinator.ApplyAsync(new("test", "stale", "test", "Stale",
            [new SetEntityIconOperation("stale", Albums, "folder", revision - 1)])))).Code);

        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire albums", [new SetRetiredOperation("r", Albums, null, true, revision)]));
        Assert.AreEqual("entity-retired", (await Refused(() => SetIconAsync(coordinator, service, Albums, "folder", "retired"))).Code);
        Assert.IsNull((await service.GetSnapshotAsync()).Entities.Single().Icon, "a refused icon writes nothing");
    }

    [TestMethod]
    public void ACanonicalChangeSetCarriesTheIconAndTheDiffNamesIt()
    {
        var operation = (SetEntityIconOperation)CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
            "i", "schema.setEntityIcon", JsonDocument.Parse("""{"entityId":"albums","icon":"folder","expectedDefinitionRevision":4}""").RootElement));
        Assert.AreEqual((Albums, "folder", 4L), (operation.EntityId, operation.Icon, operation.ExpectedDefinitionRevision));
        Assert.AreEqual(NendoReversibilityClass.ReversibleWithRetainedState, operation.Reversibility);
        Assert.AreEqual(NendoRevisionLane.Definition, operation.Lane);

        var chosen = SemanticDiff.From(ChangeSet(operation), Active());
        Assert.AreEqual("setEntityIcon", chosen[0].Kind);
        Assert.AreEqual("Show Albums with the icon folder.", chosen[0].Summary);
        var cleared = SemanticDiff.From(ChangeSet(new SetEntityIconOperation("i", Albums, null, 4)), Active());
        Assert.AreEqual("Show Albums with the icon guessed from its name.", cleared[0].Summary);
        Assert.IsTrue(NendoAuthoringOperations.All.Any(description => description.OperationType == "schema.setEntityIcon" &&
            description.RequiredPayload.SequenceEqual(["entityId", "icon"])));
    }

    /// <summary>
    /// A stored name this version does not know is a newer set's, and reads as no choice; a row of
    /// any other shape is damage, refused at open as drift.
    /// </summary>
    [TestMethod]
    public async Task AnUnknownStoredNameReadsAsNoChoiceAndAMalformedOneIsDrift()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SetIconAsync(coordinator, service, Albums, "folder", "choose");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await StoreAsync(workspace.FilePath, "lunar-rover-9");
        var newer = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsFalse(newer.Findings.Any(finding => finding.Code == "mapping-drift"), string.Join("; ", newer.Findings.Select(finding => finding.Code)));
        coordinator = await workspace.OpenAsync();
        Assert.IsNull((await new NendoApplicationService(coordinator).GetSnapshotAsync()).Entities.Single().Icon);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await StoreAsync(workspace.FilePath, "Not An Icon");
        var damaged = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(damaged.Findings.Any(finding => finding.Code == "mapping-drift"), string.Join("; ", damaged.Findings.Select(finding => finding.Code)));
    }

    [TestMethod]
    public void AScreenRootAndAViewCarryAnIconOntoThePlan()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("list", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", Albums),
                ("title", "All albums"), ("icon", "folder")),
            Node("list-title", "list", "fieldBinding", 0, ("fieldId", "album.title")),
            Node("screen", null, "extensionView", 1, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("title", "Map"),
                ("packageId", "org.example.map"), ("icon", "map")),
        ]));

        Assert.IsTrue(compiled.IsValid, Messages(compiled));
        var list = compiled.Applications.Single().Surfaces.Single();
        Assert.AreEqual("folder", list.Icon);
        Assert.AreEqual("folder", list.Properties["icon"].GetString());
        Assert.IsNull(list.Children.Single().Icon);
        Assert.AreEqual("map", compiled.Views.Single().Icon);

        using var plan = JsonDocument.Parse(JsonSerializer.Serialize(compiled, NendoRenderPlanJson.Options));
        var surface = plan.RootElement.GetProperty("applications")[0].GetProperty("surfaces")[0];
        Assert.AreEqual("folder", surface.GetProperty("icon").GetString());
        Assert.IsFalse(surface.GetProperty("children")[0].TryGetProperty("icon", out _), "a node without an icon carries none");
        Assert.AreEqual("map", plan.RootElement.GetProperty("views")[0].GetProperty("icon").GetString());

        Assert.AreEqual(NendoFormat.IconsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(
            [Node("list", null, "recordList", 0, ("icon", "folder"))], []));
        Assert.AreNotEqual(NendoFormat.IconsMinimumHostVersion, NendoSemanticCapability.RequiredHostVersion(
            [Node("list", null, "recordList", 0)], []));
    }

    [TestMethod]
    public void AnIconTheSetDoesNotHoldIsReadAsNoChoiceWithTheWarningNui461()
    {
        var compiled = new NendoSemanticCompiler().Compile(Source(
        [
            Node("list", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", Albums),
                ("icon", "not-an-icon")),
            Node("list-title", "list", "fieldBinding", 0, ("fieldId", "album.title")),
        ]));

        Assert.IsTrue(compiled.IsValid, "one unknown icon does not take the screens away: " + Messages(compiled));
        var warning = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI461");
        Assert.AreEqual(NendoDiagnosticSeverity.Warning, warning.Severity);
        Assert.AreEqual("list", warning.SemanticId);
        Assert.AreEqual("icon", warning.PropertyPath);
        StringAssert.Contains(warning.Message, "'not-an-icon' is not an icon in Nendo's set");
        var list = compiled.Applications.Single().Surfaces.Single();
        Assert.IsNull(list.Icon, "an unknown name is no choice");
        using (var plan = JsonDocument.Parse(JsonSerializer.Serialize(list, NendoRenderPlanJson.Options)))
            Assert.IsFalse(plan.RootElement.TryGetProperty("icon", out _), "the plan entry carries no icon");

        var number = new NendoSemanticCompiler().Compile(Source(
        [
            Node("list", null, "recordList", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", Albums), ("icon", 7)),
            Node("list-title", "list", "fieldBinding", 0, ("fieldId", "album.title")),
        ]));
        Assert.IsFalse(number.IsValid);
        var error = number.Diagnostics.Single(diagnostic => diagnostic.SemanticId == "list");
        Assert.AreEqual(("NUI462", NendoDiagnosticSeverity.Error), (error.Code, error.Severity));

        // A node that is not a screen or a view takes no icon at all.
        var section = new NendoSemanticCompiler().Compile(Source(
        [
            Node("page", null, "detailSurface", 0, ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", Albums)),
            Node("page-section", "page", "section", 0, ("title", "Details"), ("icon", "folder")),
            Node("page-title", "page-section", "fieldBinding", 0, ("fieldId", "album.title")),
        ]));
        Assert.AreEqual("NUI090", section.Diagnostics.Single(diagnostic => diagnostic.SemanticId == "page-section").Code);
    }

    /// <summary>Writing a screen's icon is refused unless the set holds it; only reading tolerates another name.</summary>
    [TestMethod]
    public void AScreensIconIsWrittenOnlyAsANameTheSetHolds()
    {
        NendoOperation SetProperty(string name, object value) => CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
            "p", "ui.setProperty", JsonSerializer.SerializeToElement(new { surfaceId = "s-list", nodeId = "list", propertyName = name, value })));

        var refused = Assert.ThrowsExactly<NendoValidationException>(() => SetProperty("icon", "not-an-icon"));
        StringAssert.Contains(refused.Message, "'not-an-icon' is not an icon in Nendo's set");
        Assert.AreEqual("folder", ((SetUiPropertyOperation)SetProperty("icon", "folder")).Value.GetString());
        Assert.AreEqual("not-an-icon", ((SetUiPropertyOperation)SetProperty("title", "not-an-icon")).Value.GetString(),
            "only the icon property is checked");
    }

    /// <summary>The read-only inspection, the route a person recovers through, reads the icon as the writable session does.</summary>
    [TestMethod]
    public async Task TheReadOnlyInspectionReadsTheIconAndAnUnknownNameAsNone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await SetIconAsync(coordinator, service, Albums, "folder", "choose");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.AreEqual("folder", inspected.Snapshot!.Entities.Single(entity => entity.EntityId == Albums).Icon);

        await StoreAsync(workspace.FilePath, "lunar-rover-9");
        var newer = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.IsNull(newer.Snapshot!.Entities.Single(entity => entity.EntityId == Albums).Icon);
    }

    [TestMethod]
    public void TheVocabularyPublishesTheIconPropertyAndTheSet()
    {
        var description = NendoSemanticVocabulary.Description();
        foreach (var kind in description.Kinds)
        {
            var takesOne = (kind.CanBeRoot && kind.Kind != "recordCommand") || NendoExtensionViewDefinition.IsViewKind(kind.Kind);
            Assert.AreEqual(takesOne, kind.Properties.Contains("icon"), kind.Kind);
            Assert.IsFalse(kind.RequiredProperties.Contains("icon"), kind.Kind);
        }
        Assert.IsTrue(description.Kinds.Single(kind => kind.Kind == NendoExtensionViewDefinition.PanelKind).Properties.Contains("icon"));
        Assert.AreEqual(NendoIconSet.ResourceUri, description.Icons!.Resource);
        Assert.AreEqual(NendoIconSet.Icons.Count, description.Icons.Count);
        StringAssert.Contains(description.PropertyNotes["icon"], "NUI461");

        Assert.IsGreaterThan(400, NendoIconSet.Icons.Count, "the curated set is about 400 icons or more");
        Assert.AreEqual(NendoIconSet.Icons.Count, NendoIconSet.Icons.Select(icon => icon.Name).Distinct(StringComparer.Ordinal).Count());
        Assert.IsTrue(NendoIconSet.Icons.All(icon => NendoIconSet.IsWellFormed(icon.Name) && icon.Group.Length > 0), "every name has the stored shape");
        Assert.IsTrue(NendoIconSet.Contains("folder"));
        Assert.IsFalse(NendoIconSet.Contains("Folder"));
    }

    private static async Task<NendoApplyResult> SetIconAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string entityId, string? icon, string key)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", "entity-icon-" + key, "test", "Give a record type an icon",
            [new SetEntityIconOperation("i-" + key, entityId, icon, revision)]));
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        await coordinator.ApplyAsync(new("test", "schema", "test", "Albums",
        [
            new CreateEntityOperation("e-albums", Albums, "Albums", "albums"),
            new AddFieldOperation("f-title", Albums, "album.title", "Title", "title", NendoStorageKind.Text, true),
        ]));

    private static async Task StoreAsync(string path, string icon)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE __nendo_entity_icon SET icon = $icon;";
        command.Parameters.AddWithValue("$icon", icon);
        Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
    }

    private static NendoChangeSet ChangeSet(params NendoOperation[] operations) => new(
    [
        new NendoMutation("icon-diff", "diff-definition", "test", "Give a record type an icon", operations),
    ]);

    private static NendoSessionSnapshot Active() => Source([]);

    private static NendoSessionSnapshot Source(NendoUiNodeSnapshot[] nodes)
    {
        var now = new DateTimeOffset(2026, 10, 27, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "albums.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.IconsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 0, 4),
            [new NendoEntitySnapshot(Albums, "Albums", [new("album.title", "Title", NendoStorageKind.Text, true, "singleLine", [])])],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoUiNodeSnapshot Node(string nodeId, string? parentNodeId, string kind, int position,
        params (string Name, object Value)[] properties) => new(
            "s-" + (parentNodeId ?? nodeId).Split('-')[0],
            nodeId,
            parentNodeId,
            kind,
            position,
            properties.ToDictionary(property => property.Name, property => JsonSerializer.SerializeToElement(property.Value), StringComparer.Ordinal));

    private static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(diagnostic => $"{diagnostic.Code} {diagnostic.SemanticId}: {diagnostic.Message}"));

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);
}
