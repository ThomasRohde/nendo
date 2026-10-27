using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// Settings a view package declares (ADR-0038). The declarations arrive in nendo-package.json and
/// in extension.setPackage, are refused by name when a rule is broken, and are kept with the
/// shared values in two protected tables on the rung above a record type's icon. A shared value is
/// written by package.setSetting, checked against its declaration and undone to the value it
/// replaced; a value the declarations no longer allow is dropped when they change.
/// </summary>
[TestClass]
public sealed class PackageSettingsTests
{
    private const string SettingsLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-linkrule-search-media-icon-entityicon-setting-v1";

    private const string PackageId = "org.example.map";

    private const string Declared = """
        [
          { "id": "zoom", "title": "Zoom", "help": "How close the map starts.", "type": "number", "default": 3, "min": 1, "max": 9, "unit": "x", "layers": "both" },
          { "id": "style", "title": "Style", "type": "choice", "default": "plain",
            "options": [{ "value": "plain", "label": "Plain" }, { "value": "terrain", "label": "Terrain" }], "layers": "shared" },
          { "id": "labels", "title": "Labels", "type": "toggle", "default": true, "layers": "personal" },
          { "id": "caption", "title": "Caption", "type": "text", "default": "", "layers": "shared" }
        ]
        """;

    // ---------------------------------------------------------------- declarations

    [TestMethod]
    public void DeclarationsAreReadNormalised()
    {
        var settings = Parse(Declared);

        Assert.HasCount(4, settings);
        var zoom = settings[0];
        Assert.AreEqual(("zoom", "Zoom", "How close the map starts.", "number", "both"), (zoom.Id, zoom.Title, zoom.Help, zoom.Type, zoom.Layers));
        Assert.AreEqual((1d, 9d, "x"), (zoom.Min!.Value, zoom.Max!.Value, zoom.Unit));
        Assert.IsNull(zoom.Options, "a number takes no options");
        Assert.IsNull(zoom.MaxLength, "a number takes no maxLength");
        Assert.AreEqual(3d, zoom.Default.GetDouble());
        var style = settings[1];
        Assert.AreEqual("plain,terrain", string.Join(",", style.Options!.Select(option => option.Value)));
        Assert.IsNull(style.Help);
        Assert.AreEqual(NendoPackageSettings.TextCharacters, settings[3].MaxLength, "a text setting's maxLength defaults to 1,000");
        Assert.IsTrue(NendoPackageSettings.AllowsShared(zoom) && NendoPackageSettings.AllowsPersonal(zoom));
        Assert.IsFalse(NendoPackageSettings.AllowsShared(settings[2]));

        // Exposed in camelCase with nulls for what the type does not take.
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(settings[1], new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        Assert.AreEqual("plain", json.RootElement.GetProperty("default").GetString());
        Assert.AreEqual(JsonValueKind.Null, json.RootElement.GetProperty("min").ValueKind);
        Assert.AreEqual("Terrain", json.RootElement.GetProperty("options")[1].GetProperty("label").GetString());
    }

    [TestMethod]
    [DataRow("{}", "is a list of setting declarations")]
    [DataRow("[ 7 ]", "Setting 1 in nendo-package.json is not a JSON object")]
    [DataRow("""[ { "title": "Zoom", "type": "toggle", "default": true, "layers": "both" } ]""", "Setting 1 in nendo-package.json has no id")]
    [DataRow("""[ { "id": "Zoom", "title": "Zoom", "type": "toggle", "default": true, "layers": "both" } ]""", "has the id 'Zoom'")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "default": true, "layers": "both" }, { "id": "a", "title": "B", "type": "toggle", "default": false, "layers": "both" } ]""", "declares the setting a twice")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "date", "default": "x", "layers": "both" } ]""", "The setting a in nendo-package.json has the type 'date'")]
    [DataRow("""[ { "id": "a", "title": "A", "default": true, "layers": "both" } ]""", "has no type")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "default": true } ]""", "has no layers")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "default": true, "layers": "everyone" } ]""", "the layers 'everyone'")]
    [DataRow("""[ { "id": "a", "type": "toggle", "default": true, "layers": "both" } ]""", "needs a title of 1 to 120 characters")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "layers": "both" } ]""", "needs a default")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "default": "yes", "layers": "both" } ]""", "has a default that does not fit it. The setting a is a toggle")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "toggle", "default": true, "layers": "both", "min": 1 } ]""", "has the key min, which a toggle setting does not take")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "choice", "default": "x", "layers": "both", "options": [{ "value": "x", "label": "X" }] } ]""", "needs options: 2 to 32")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "choice", "default": "z", "layers": "both", "options": [{ "value": "x", "label": "X" }, { "value": "y", "label": "Y" }] } ]""", "'z' is not one of them")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "choice", "default": "x", "layers": "both", "options": [{ "value": "x", "label": "X" }, { "value": "x", "label": "Y" }] } ]""", "has the option x twice")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "choice", "default": "x", "layers": "both", "options": [{ "value": "x", "label": "X" }, { "value": "y" }] } ]""", "has the option y without a label")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "number", "default": 1, "min": 5, "max": 2, "layers": "both" } ]""", "has a min of 5 above its max of 2")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "number", "default": 12, "min": 1, "max": 9, "layers": "both" } ]""", "is a number from 1 to 9, and 12 is not")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "number", "default": 1, "unit": "aaaaaaaaaaaaaaaaaaaaaaaaa", "layers": "both" } ]""", "a unit is at most 24")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "text", "default": "", "maxLength": 0, "layers": "both" } ]""", "maxLength that is not a whole number from 1 to 1000")]
    [DataRow("""[ { "id": "a", "title": "A", "type": "text", "default": "abcdef", "maxLength": 3, "layers": "both" } ]""", "text of at most 3 characters, and this is 6")]
    public void ABadDeclarationIsRefusedByName(string settings, string expected)
    {
        var refused = Assert.ThrowsExactly<NendoValidationException>(() => Parse(settings));
        StringAssert.Contains(refused.Message, expected);
    }

    [TestMethod]
    public void MoreThanSixtyFourSettingsOrALongHelpAreRefused()
    {
        var many = "[" + string.Join(",", Enumerable.Range(0, 65).Select(index =>
            $$"""{ "id": "s{{index}}", "title": "S", "type": "toggle", "default": true, "layers": "both" }""")) + "]";
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => Parse(many)).Message, "declares 65 settings, and a package declares at most 64");
        var help = $$"""[ { "id": "a", "title": "A", "help": "{{new string('h', 501)}}", "type": "toggle", "default": true, "layers": "both" } ]""";
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => Parse(help)).Message, "help of 501 characters");
    }

    [TestMethod]
    public void AValueFitsItsDeclarationOrSaysWhyNot()
    {
        var settings = Parse(Declared);
        string? Reason(int index, string json) => NendoPackageSettings.Fits(settings[index], JsonDocument.Parse(json).RootElement, out var reason) ? null : reason;

        Assert.IsNull(Reason(0, "4.5"));
        Assert.AreEqual("The setting zoom is a number from 1 to 9, and 12 is not.", Reason(0, "12"));
        Assert.AreEqual("The setting zoom is a number from 1 to 9.", Reason(0, "\"4\""));
        Assert.IsNull(Reason(1, "\"terrain\""));
        Assert.AreEqual("The setting style is a choice of plain, terrain, and 'satellite' is not one of them.", Reason(1, "\"satellite\""));
        Assert.IsNull(Reason(2, "false"));
        Assert.AreEqual("The setting labels is a toggle: its value is true or false.", Reason(2, "1"));
        Assert.IsNull(Reason(3, "\"Roads\""));
        Assert.AreEqual("The setting caption is text of at most 1000 characters, and this is 1001.", Reason(3, JsonSerializer.Serialize(new string('c', 1001))));
        Assert.IsNotNull(Reason(3, "null"), "null clears a layer; it is never a value");
    }

    // ---------------------------------------------------------------- manifests

    [TestMethod]
    public void AFolderAndAZipCarryTheirSettingsAndASkillPackageRefusesThem()
    {
        using var folder = new TemporaryFolder();
        folder.Write("nendo-package.json", Manifest(Declared));
        folder.Write("index.html", "<p>map</p>");
        var archive = NendoExtensionArchives.Read(folder.Path);
        CollectionAssert.AreEqual(new[] { "zoom", "style", "labels", "caption" }, archive.Settings.Select(setting => setting.Id).ToArray());
        var set = (SetExtensionPackageOperation)NendoExtensionArchives.ChangeSet(archive, null).Mutations.Single().Operations[0];
        Assert.HasCount(4, set.Settings);

        var zip = NendoExtensionArchives.ReadZip(new MemoryStream(Zip(("map/nendo-package.json", Manifest(Declared)), ("map/index.html", "<p></p>"))));
        Assert.HasCount(4, zip.Settings);

        var bad = Zip(("nendo-package.json", Manifest("""[ { "id": "zoom", "title": "Zoom", "type": "number", "default": 99, "max": 9, "layers": "both" } ]""")),
            ("index.html", "<p></p>"));
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(bad))).Message,
            "The setting zoom in nendo-package.json has a default that does not fit it.");

        var skill = Zip(("nendo-package.json", """{ "packageId": "org.example.helper", "kind": "skill", "settings": [] }"""),
            ("SKILL.md", "---\nname: helper\ndescription: Helps.\n---\n"));
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadZip(new MemoryStream(skill))).Message,
            "The skill package org.example.helper declares settings in nendo-package.json");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionPackageOperation(
            "s", "org.example.helper", "Helper", null, kind: NendoExtensionPackageKind.Skill, settings: Parse(Declared))).Message, "a skill package has none");
    }

    [TestMethod]
    public async Task ReImportingTheSameSettingsIsUnchangedAndExportCarriesThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        using var folder = new TemporaryFolder();
        folder.Write("nendo-package.json", Manifest(Declared));
        folder.Write("index.html", "<p>map</p>");
        await coordinator.ApplyAsync(NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), null).Mutations.Single());
        var current = (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single();

        Assert.AreEqual("extension-unchanged", Assert.ThrowsExactly<NendoPreconditionException>(() =>
            NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), current)).Code);

        folder.Write("nendo-package.json", Manifest(Declared.Replace("\"max\": 9", "\"max\": 7", StringComparison.Ordinal)));
        var edit = NendoExtensionArchives.ChangeSet(NendoExtensionArchives.Read(folder.Path), current);
        CollectionAssert.AreEqual(new[] { "extension.setPackage" }, edit.Mutations.Single().Operations.Select(operation => operation.OperationType).ToArray(),
            "a change to the settings alone proposes the package's description and nothing else");

        using var exported = new TemporaryFolder();
        exported.Write("nendo-package.json", Encoding.UTF8.GetString(NendoExtensionArchives.Manifest(current)));
        exported.Write("index.html", "<p>map</p>");
        Assert.AreEqual(NendoPackageSettings.Canonical(current.Settings), NendoPackageSettings.Canonical(NendoExtensionArchives.Read(exported.Path).Settings));
    }

    // ---------------------------------------------------------------- storage

    [TestMethod]
    public async Task DeclaredSettingsAreStoredOnTheirRungAndReadByBothPaths()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        var operation = (SetExtensionPackageOperation)CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest(
            "p", "extension.setPackage", JsonDocument.Parse($$"""{ "packageId": "{{PackageId}}", "title": "Map", "settings": {{Declared}} }""").RootElement));
        StringAssert.Contains(operation.CanonicalJson(), "\"settings\":[{\"default\":3,\"help\":");
        await coordinator.ApplyAsync(new("test", "package", "test", "Add the map", [operation]));

        var snapshot = await service.GetDefinitionSnapshotAsync();
        var package = snapshot.ExtensionPackages.Single();
        CollectionAssert.AreEqual(new[] { "zoom", "style", "labels", "caption" }, package.Settings.Select(setting => setting.Id).ToArray());
        Assert.IsEmpty(package.SharedSettings);
        Assert.AreEqual(NendoFormat.PackageSettingsMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);

        await SetAsync(coordinator, service, "zoom", "5", "zoom");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(SettingsLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        var readOnly = (await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Snapshot!.ExtensionPackages.Single();
        Assert.HasCount(4, readOnly.Settings);
        Assert.AreEqual(5d, readOnly.SharedSettings["zoom"].GetDouble());

        coordinator = await workspace.OpenAsync();
        Assert.AreEqual(5d, (await new NendoApplicationService(coordinator).GetDefinitionSnapshotAsync()).ExtensionPackages.Single().SharedSettings["zoom"].GetDouble());
    }

    /// <summary>A package that declares no settings gains no table and states no newer host, and its canonical bytes carry no settings.</summary>
    [TestMethod]
    public async Task AFileWhosePackagesDeclareNoSettingsKeepsItsLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var plain = new SetExtensionPackageOperation("p", PackageId, "Map", "index.html");
        Assert.IsFalse(plain.CanonicalJson().Contains("settings", StringComparison.Ordinal));
        await coordinator.ApplyAsync(new("test", "package", "test", "Add the map", [plain]));
        await coordinator.ApplyAsync(new("test", "again", "test", "Retitle the map",
            [new SetExtensionPackageOperation("p2", PackageId, "Atlas", "index.html", settings: [])]));

        var snapshot = await service.GetDefinitionSnapshotAsync();
        Assert.AreEqual(NendoFormat.ExtensionPackagesMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);
        Assert.IsEmpty(snapshot.ExtensionPackages.Single().Settings);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1",
            (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Layout);
    }

    [TestMethod]
    public async Task ASharedValueIsSetClearedAndUndoneToTheValueItReplaced()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await PackageAsync(coordinator, Declared);

        var first = await SetAsync(coordinator, service, "style", "\"terrain\"", "first");
        Assert.AreEqual("terrain", (await SharedAsync(service))["style"].GetString());
        await service.CompensateRevisionAsync(first.RevisionId, "undo-first");
        Assert.IsFalse((await SharedAsync(service)).ContainsKey("style"), "the first value is undone to none");

        await SetAsync(coordinator, service, "style", "\"terrain\"", "again");
        var second = await SetAsync(coordinator, service, "style", "\"plain\"", "second");
        await service.CompensateRevisionAsync(second.RevisionId, "undo-second");
        Assert.AreEqual("terrain", (await SharedAsync(service))["style"].GetString(), "a change is undone to the value it replaced");

        var cleared = await SetAsync(coordinator, service, "style", "null", "clear");
        Assert.IsFalse((await SharedAsync(service)).ContainsKey("style"), "null clears the file's value");
        await service.CompensateRevisionAsync(cleared.RevisionId, "undo-clear");
        Assert.AreEqual("terrain", (await SharedAsync(service))["style"].GetString());
    }

    [TestMethod]
    public async Task APersonalSettingAValueThatDoesNotFitAndAStaleRevisionAreRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        Assert.AreEqual("extension-package-not-found", (await Refused(() => SetAsync(coordinator, service, "zoom", "2", "missing-package"))).Code);
        await PackageAsync(coordinator, Declared);

        var personal = await Refused(() => SetAsync(coordinator, service, "labels", "false", "personal"));
        Assert.AreEqual("package-setting-personal", personal.Code);
        StringAssert.Contains(personal.Message, "kept on each computer, never in the file");
        var range = await Refused(() => SetAsync(coordinator, service, "zoom", "12", "range"));
        Assert.AreEqual(("package-setting-invalid", "The setting zoom is a number from 1 to 9, and 12 is not."), (range.Code, range.Message));
        Assert.AreEqual("package-setting-invalid", (await Refused(() => SetAsync(coordinator, service, "style", "\"satellite\"", "option"))).Code);
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            SetAsync(coordinator, service, "caption", JsonSerializer.Serialize(new string('c', 1001)), "long"))).Message,
            "at most 1000 characters", "no setting holds more text than a text setting's bound");
        Assert.AreEqual("package-setting-not-found", (await Refused(() => SetAsync(coordinator, service, "nothing", "1", "unknown"))).Code);
        var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreEqual("definition-version-conflict", (await Refused(() => coordinator.ApplyAsync(new("test", "stale", "test", "Stale",
            [new SetPackageSettingOperation("stale", PackageId, "zoom", JsonDocument.Parse("2").RootElement, revision - 1)])))).Code);
        Assert.IsEmpty(await SharedAsync(service), "a refused value writes nothing");

        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => Compile("""{ "packageId": "org.example.map", "settingId": "zoom", "value": [1], "expectedDefinitionRevision": 1 }""")).Message,
            "text, a finite number, true or false, or null");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => Compile("""{ "packageId": "org.example.map", "settingId": "zoom", "expectedDefinitionRevision": 1 }""")).Message,
            "package.setSetting needs a value");
    }

    [TestMethod]
    public async Task ChangedDeclarationsKeepTheValuesThatStillFitAndUndoBringsBackTheRest()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await PackageAsync(coordinator, Declared);
        await SetAsync(coordinator, service, "zoom", "8", "zoom");
        await SetAsync(coordinator, service, "style", "\"terrain\"", "style");
        await SetAsync(coordinator, service, "caption", "\"Roads\"", "caption");

        // zoom's range shrinks below its value, caption becomes personal, style is unchanged.
        var changed = Declared.Replace("\"max\": 9", "\"max\": 5", StringComparison.Ordinal)
            .Replace("\"default\": 3,", "\"default\": 2,", StringComparison.Ordinal)
            .Replace("\"default\": \"\", \"layers\": \"shared\"", "\"default\": \"\", \"layers\": \"personal\"", StringComparison.Ordinal);
        var redeclared = await PackageAsync(coordinator, changed, "redeclare");
        var shared = await SharedAsync(service);
        CollectionAssert.AreEquivalent(new[] { "style" }, shared.Keys.ToArray(), "only the value that still fits is kept");
        Assert.AreEqual("terrain", shared["style"].GetString());

        await service.CompensateRevisionAsync(redeclared.RevisionId, "undo-redeclare");
        var restored = await service.GetDefinitionSnapshotAsync();
        var package = restored.ExtensionPackages.Single();
        Assert.AreEqual(9d, package.Settings[0].Max!.Value, "the declarations come back");
        Assert.AreEqual(8d, package.SharedSettings["zoom"].GetDouble(), "and so do the values they dropped");
        Assert.AreEqual("Roads", package.SharedSettings["caption"].GetString());
    }

    /// <summary>
    /// A value that stopped fitting is dropped from the file, not merely hidden: declaring the old
    /// range again, rather than undoing, does not bring it back.
    /// </summary>
    [TestMethod]
    public async Task ADroppedValueStaysGoneWhenTheDeclarationsWidenAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await PackageAsync(coordinator, Declared);
        await SetAsync(coordinator, service, "zoom", "8", "zoom");
        await PackageAsync(coordinator, Declared.Replace("\"max\": 9", "\"max\": 5", StringComparison.Ordinal)
            .Replace("\"default\": 3,", "\"default\": 2,", StringComparison.Ordinal), "narrow");
        await PackageAsync(coordinator, Declared, "widen");
        Assert.IsFalse((await SharedAsync(service)).ContainsKey("zoom"), "the value the narrower range dropped is gone");
    }

    [TestMethod]
    public async Task RemovingAPackageRemovesItsSettingsAndUndoRestoresThem()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await PackageAsync(coordinator, Declared);
        await SetAsync(coordinator, service, "zoom", "4", "zoom");

        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove the map", [new RemoveExtensionPackageOperation("r", PackageId)]));
        Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).ExtensionPackages);
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        var package = (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single();
        Assert.HasCount(4, package.Settings);
        Assert.AreEqual(4d, package.SharedSettings["zoom"].GetDouble());
    }

    /// <summary>A stored value that no longer fits is not used; a value that is not a scalar, or a declaration that names another setting, is damage.</summary>
    [TestMethod]
    public async Task AValueThatNoLongerFitsIsNotUsedAndAMalformedRowIsDrift()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await PackageAsync(coordinator, Declared);
        await SetAsync(coordinator, service, "zoom", "4", "zoom");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await StoreAsync(workspace.FilePath, "UPDATE __nendo_package_setting_value SET value_json = '40';");
        var unfit = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsFalse(unfit.Findings.Any(finding => finding.Code == "mapping-drift"), string.Join("; ", unfit.Findings.Select(finding => finding.Code)));
        Assert.IsEmpty((await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Snapshot!.ExtensionPackages.Single().SharedSettings);

        await StoreAsync(workspace.FilePath, "UPDATE __nendo_package_setting_value SET value_json = '[4]';");
        var damaged = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(damaged.Findings.Any(finding => finding.Code == "mapping-drift"), string.Join("; ", damaged.Findings.Select(finding => finding.Code)));

        await StoreAsync(workspace.FilePath, "UPDATE __nendo_package_setting_value SET value_json = '4';" +
            "UPDATE __nendo_package_setting SET declaration_json = replace(declaration_json, '\"id\":\"style\"', '\"id\":\"other\"') WHERE setting_id = 'style';");
        var renamed = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(renamed.Findings.Any(finding => finding.Code == "mapping-drift"), string.Join("; ", renamed.Findings.Select(finding => finding.Code)));
    }

    [TestMethod]
    public void TheDiffNamesTheSettingAndTheVocabularyPublishesTheOperation()
    {
        var settings = Parse(Declared);
        var active = Active(settings);
        string Said(NendoOperation operation) => SemanticDiff.From(new NendoChangeSet(
            [new NendoMutation("diff", "diff", "test", "Settings", [operation])]), active)[0].Summary;

        Assert.AreEqual("Set Zoom in the package Map to 4 x for everyone who opens this file.",
            Said(new SetPackageSettingOperation("s", PackageId, "zoom", JsonDocument.Parse("4").RootElement, 4)));
        Assert.AreEqual("Set Style in the package Map to Terrain for everyone who opens this file.",
            Said(new SetPackageSettingOperation("s", PackageId, "style", JsonDocument.Parse("\"terrain\"").RootElement, 4)));
        Assert.AreEqual("Clear the file's value for Zoom in the package Map, so its default is used.",
            Said(new SetPackageSettingOperation("s", PackageId, "zoom", null, 4)));
        StringAssert.EndsWith(Said(new SetExtensionPackageOperation("p", PackageId, "Map", "index.html", settings: settings)),
            "It declares 4 settings for Settings: Zoom, Style, Labels, Caption.");

        var compiled = (SetPackageSettingOperation)Compile("""{ "packageId": "org.example.map", "settingId": "zoom", "value": 4.0, "expectedDefinitionRevision": 4 }""");
        Assert.AreEqual((NendoRevisionLane.Definition, NendoReversibilityClass.ReversibleWithRetainedState), (compiled.Lane, compiled.Reversibility));
        StringAssert.Contains(compiled.CanonicalJson(), "\"value\":4}");
        Assert.IsTrue(NendoAuthoringOperations.All.Any(description => description.OperationType == "package.setSetting" &&
            description.RequiredPayload.SequenceEqual(["packageId", "settingId", "value"])));
        Assert.Contains("settings", NendoAuthoringOperations.AllowedPayloads["extension.setPackage"]);
        Assert.IsTrue(NendoDefinitionRevisions.IsDefinitionLane("package.setSetting"));
        Assert.Contains("package.setSetting", NendoDefinitionRevisions.RevisionScopedOperations);
    }

    // ---------------------------------------------------------------- helpers

    private static IReadOnlyList<NendoPackageSettingDeclaration> Parse(string json) =>
        NendoPackageSettings.Parse(JsonDocument.Parse(json).RootElement, NendoExtensionArchives.ManifestName);

    private static NendoOperation Compile(string payload) => CanonicalChangeSetRequestCompiler.CompileOperation(
        new NendoCanonicalOperationRequest("o", "package.setSetting", JsonDocument.Parse(payload).RootElement));

    private static string Manifest(string settings) =>
        $$"""{ "packageId": "{{PackageId}}", "title": "Map", "entryPoint": "index.html", "settings": {{settings}} }""";

    private static Task<NendoApplyResult> PackageAsync(NendoWriteCoordinator coordinator, string settings, string key = "package") =>
        coordinator.ApplyAsync(new("test", "package-" + key, "test", "Describe the map",
            [new SetExtensionPackageOperation("p-" + key, PackageId, "Map", "index.html", settings: Parse(settings))]));

    private static async Task<NendoApplyResult> SetAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string settingId, string value, string key)
    {
        var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", "setting-" + key, "test", "Set a package's setting",
            [new SetPackageSettingOperation("s-" + key, PackageId, settingId, JsonDocument.Parse(value).RootElement, revision)]));
    }

    private static async Task<IReadOnlyDictionary<string, JsonElement>> SharedAsync(NendoApplicationService service) =>
        (await service.GetDefinitionSnapshotAsync()).ExtensionPackages.Single().SharedSettings;

    private static async Task StoreAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);

    private static NendoSessionSnapshot Active(IReadOnlyList<NendoPackageSettingDeclaration> settings)
    {
        var now = new DateTimeOffset(2026, 10, 27, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "map.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.PackageSettingsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 0, 4),
            [],
            [],
            [],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []))
        {
            ExtensionPackages = [new NendoExtensionPackageSnapshot(PackageId, "Map", null, "index.html", null, []) { Settings = settings }],
        };
    }

    private static byte[] Zip(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var stream = zip.CreateEntry(name).Open();
                stream.Write(Encoding.UTF8.GetBytes(text));
            }
        }
        return buffer.ToArray();
    }

    private sealed class TemporaryFolder : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nendo-settings-" + Guid.NewGuid().ToString("N"));

        internal TemporaryFolder() => Directory.CreateDirectory(Path);

        internal void Write(string relative, string text)
        {
            var target = System.IO.Path.Combine(Path, relative.Replace('/', System.IO.Path.DirectorySeparatorChar));
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
            File.WriteAllText(target, text);
        }

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch (IOException) { }
        }
    }
}
