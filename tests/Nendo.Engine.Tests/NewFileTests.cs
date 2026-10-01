using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0022 (W-129): a record is kept in new files or left out, by its record type's default or
/// its own mark, and New makes a file of the same application with the definition and the kept
/// records only, its history folded into one checkpoint, and the source unchanged.
/// </summary>
[TestClass]
public sealed class NewFileTests
{
    private const string NewFileLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-v1";
    private const string PackageId = "org.example.map";

    [TestMethod]
    public async Task MarksAndTheLabelAreReadBackAndTakeTheirOwnRung()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        var before = await service.GetSnapshotAsync();
        Assert.IsFalse(before.Entities.Any(entity => entity.KeptInNewFiles), "A type nobody set is kept.");
        Assert.IsTrue(before.Records.All(record => record.KeptInNewFiles is null));
        Assert.IsNull(before.Manifest.NewFileLabel);
        Assert.DoesNotContain("-newfile-", (await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Inspection.Layout!,
            "A file that marked nothing gained the rung.");

        await MarkAsync(coordinator, service);
        var after = await service.GetSnapshotAsync();
        Assert.IsTrue(after.Entities.Single(entity => entity.EntityId == "kinds").KeptInNewFiles);
        Assert.IsFalse(after.Entities.Single(entity => entity.EntityId == "folders").KeptInNewFiles);
        Assert.IsTrue(after.Records.Single(record => record.RecordId == "top").KeptInNewFiles);
        Assert.IsNull(after.Records.Single(record => record.RecordId == "k-actor").KeptInNewFiles, "A record without a mark follows its type and carries none.");
        Assert.AreEqual("Test model", after.Manifest.NewFileLabel);
        Assert.AreEqual(NendoFormat.NewFileMinimumHostVersion, after.Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.AreEqual(NewFileLayout, inspected.Inspection.Layout);
        Assert.IsEmpty(inspected.Inspection.Findings, string.Join("; ", inspected.Inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        var reopened = await service.GetSnapshotAsync();
        Assert.IsTrue(reopened.Records.Single(record => record.RecordId == "top").KeptInNewFiles);
        Assert.AreEqual("Test model", reopened.Manifest.NewFileLabel);

        var again = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetRecordKeptInNewFilesAsync("folders", "top", true, Context("again")));
        Assert.AreEqual("kept-in-new-files-unchanged", again.Code);
        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetRecordKeptInNewFilesAsync("folders", "nowhere", true, Context("missing")));
        Assert.AreEqual("record-not-found", missing.Code);
        Assert.ThrowsExactly<NendoValidationException>(() => new SetNewFileLabelOperation("x", "Line\nbreak", 0));
        Assert.ThrowsExactly<NendoValidationException>(() => new SetNewFileLabelOperation("x", new string('a', 41), 0));
    }

    /// <summary>A mark is a fact about a record, not a value of it: no version moves and no action runs.</summary>
    [TestMethod]
    public async Task AMarkChangesNoRecordVersionAndFiresNoAutomaticAction()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("t", "behaviour", "test", "Stamp a renamed folder", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition("folder.stamp", "Stamp a renamed folder",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("stamp", "Concat('Touched ', name)",
                        [NendoBehaviourBinding.SameRecordField("name", "folders", "folderName", NendoBehaviourScalar.Text, false)], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition("10-stamp", "folders", "Stamp a renamed folder",
                NendoTriggerEvents.Updated, "folder.stamp", ["folderName"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        var data = (await service.GetSnapshotAsync()).Manifest.DataRevision;

        var marked = await service.SetRecordKeptInNewFilesAsync("folders", "top", true, Context("mark-top"));
        Assert.IsEmpty(marked.GeneratedChanges, "A mark ran an automatic action.");
        var snapshot = await service.GetSnapshotAsync();
        var top = snapshot.Records.Single(record => record.RecordId == "top");
        Assert.AreEqual(1L, top.RecordVersion, "A mark moved the record's version.");
        Assert.AreEqual(JsonValueKind.Null, top.Values["stamp"].ValueKind);
        Assert.AreEqual(data + 1, snapshot.Manifest.DataRevision, "A mark is one Data revision.");
        Assert.AreEqual(revision + 1, snapshot.Manifest.DefinitionRevision, "A mark changed the definition.");
        Assert.AreEqual("Keep Folders record top in new files",
            (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == marked.RevisionId).Description,
            "History must name the record, or a mark reads as the type's default.");

        // The action does run on a rename, so the silence above is the mark's, not the trigger's.
        await service.SetFieldAsync(new("folders", "top", "folderName", 1, "Core", Context("rename")));
        Assert.AreEqual("Touched Core", (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "top").Values["stamp"].GetString());
    }

    [TestMethod]
    public async Task AMarkATypeDefaultAndTheLabelAreUndoneFromHistory()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        // A definition change is undone while it is the latest one, as every definition change is.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var typed = await coordinator.ApplyAsync(new("t", "keep-kinds", "test", "Keep kinds", [
            new SetKeptInNewFilesDefaultOperation("keep-kinds", "kinds", true, revision)]));
        Assert.IsTrue(await CanUndoAsync(service, typed.RevisionId), "History does not offer to undo a type's default.");
        await service.CompensateRevisionAsync(typed.RevisionId, "undo-kinds");
        Assert.IsFalse((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "kinds").KeptInNewFiles);

        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var labelled = await coordinator.ApplyAsync(new("t", "label", "test", "Label", [
            new SetNewFileLabelOperation("label", "Test model", revision)]));
        Assert.IsTrue(await CanUndoAsync(service, labelled.RevisionId), "History does not offer to undo the label.");
        await service.CompensateRevisionAsync(labelled.RevisionId, "undo-label");
        Assert.IsNull((await service.GetSnapshotAsync()).Manifest.NewFileLabel);

        var marked = await service.SetRecordKeptInNewFilesAsync("folders", "top", true, Context("mark-top"));
        Assert.IsTrue(await CanUndoAsync(service, marked.RevisionId), "History does not offer to undo a mark.");
        await service.CompensateRevisionAsync(marked.RevisionId, "undo-mark");
        Assert.IsNull((await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "top").KeptInNewFiles);

        // A mark changed after the revision being undone is not overwritten.
        var first = await service.SetRecordKeptInNewFilesAsync("folders", "sub", true, Context("sub-1"));
        await service.SetRecordKeptInNewFilesAsync("folders", "sub", false, Context("sub-2"));
        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.CompensateRevisionAsync(first.RevisionId, "undo-sub-1"));
        StringAssert.Contains(refused.Message, "changed after");
    }

    /// <summary>A deleted record keeps its mark, since its ID stays reserved; restoring it finds the mark.</summary>
    [TestMethod]
    public async Task ADeletedRecordKeepsItsMarkAndARestoreFindsIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        await service.SetRecordKeptInNewFilesAsync("items", "i-2", true, Context("mark-i2"));
        var deleted = await service.DeleteRecordAsync(new("items", "i-2", 1, Context("delete-i2")));
        Assert.IsFalse((await service.GetSnapshotAsync()).Records.Any(record => record.RecordId == "i-2"));
        await service.CompensateRevisionAsync(deleted.RevisionId, "restore-i2");
        Assert.IsTrue((await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "i-2").KeptInNewFiles);
    }

    [TestMethod]
    public async Task ANewFileKeepsTheDefinitionAndOnlyWhatItShipsWith()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        await MarkAsync(coordinator, service);
        await service.DeleteRecordAsync(new("items", "i-3", 1, Context("delete-i3")));
        await service.SetExtensionStateAsync(PackageId, "node.view.map", "zoom", "2", null, "Keep zoom",
            new NendoRequestContext("new-file-tests", "zoom", "extension:" + PackageId));
        // A second version of the package's page: the first stays in the source for its History.
        await coordinator.ApplyAsync(new("t", "page-2", "test", "A new page", [
            PutExtensionFileOperation.FromContent("index-2", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html><p>2"))]));
        var source = await service.GetSnapshotAsync();
        var sourceDefinition = await service.GetDefinitionSnapshotAsync();
        var sourceHistory = await service.GetHistoryAsync();
        var sourceHash = Hash(workspace.FilePath);

        var preview = await service.PreviewNewFileAsync();
        Assert.AreEqual("New Test model…", preview.MenuLabel);
        Assert.IsTrue(preview.CanCreate);
        Assert.AreEqual((2L, 0L), Count(preview, "kinds"));
        Assert.AreEqual((1L, 1L), Count(preview, "folders"));
        Assert.AreEqual((0L, 2L), Count(preview, "items"));
        Assert.AreEqual(sourceHistory.Count - 1, preview.Revisions);

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "fresh.nendo");
        var made = await service.CreateNewFileAsync(destination, "new-1");
        Assert.AreEqual(sourceHash, Hash(workspace.FilePath), "Making a new file changed the source.");
        Assert.AreEqual((3L, 3L), (made.KeptRecords, made.LeftOutRecords));
        Assert.AreEqual(source.Manifest.ApplicationId, made.Manifest.ApplicationId, "A new file is the same application.");
        Assert.AreNotEqual(source.Manifest.InstanceId, made.Manifest.InstanceId, "A new file kept its source's instance.");
        Assert.AreEqual(made, await service.CreateNewFileAsync(destination, "new-1"), "The same request did not answer with the same file.");
        await Assert.ThrowsExactlyAsync<IOException>(() => service.CreateNewFileAsync(destination, "new-2"));
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(destination)!, ".nendo-stage-*"), "A stage was left behind.");

        var inspected = await SqliteNendoStore.InspectAsync(destination, CancellationToken.None);
        Assert.IsEmpty(inspected.Inspection.Findings, string.Join("; ", inspected.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
        Assert.AreEqual(NewFileLayout, inspected.Inspection.Layout);

        await using var opened = await NendoWriteCoordinator.OpenAsync(destination, "test-new");
        var fresh = new NendoApplicationService(opened);
        var snapshot = await fresh.GetSnapshotAsync();
        CollectionAssert.AreEquivalent(new[] { "k-actor", "k-role", "top" }, snapshot.Records.Select(record => record.RecordId).ToArray());
        foreach (var record in snapshot.Records)
        {
            var original = source.Records.Single(candidate => candidate.EntityId == record.EntityId && candidate.RecordId == record.RecordId);
            Assert.AreEqual(original.RecordVersion, record.RecordVersion);
            Assert.AreEqual(JsonSerializer.Serialize(original.Values), JsonSerializer.Serialize(record.Values));
            Assert.AreEqual(original.KeptInNewFiles, record.KeptInNewFiles, "A kept record lost its mark.");
        }
        var definition = await fresh.GetDefinitionSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(sourceDefinition.Entities), JsonSerializer.Serialize(definition.Entities), "The record types differ.");
        Assert.AreEqual(JsonSerializer.Serialize(sourceDefinition.UiNodes), JsonSerializer.Serialize(definition.UiNodes));
        Assert.AreEqual(JsonSerializer.Serialize(sourceDefinition.ExtensionPackages), JsonSerializer.Serialize(definition.ExtensionPackages), "The packages differ.");
        Assert.AreEqual("Test model", snapshot.Manifest.NewFileLabel);
        Assert.AreEqual(source.Manifest.DefinitionRevision + 1, snapshot.Manifest.DefinitionRevision, "Only the identity transition is new.");
        Assert.AreEqual(NendoFormat.NewFileMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);

        var history = await fresh.GetHistoryAsync();
        CollectionAssert.AreEqual(new[] { NendoRevisionLane.Genesis, NendoRevisionLane.Checkpoint, NendoRevisionLane.Definition },
            history.Select(revision => revision.Lane).ToArray());
        StringAssert.StartsWith(history[1].Description, $"Started from {Path.GetFileName(workspace.FilePath)}");
        Assert.AreEqual("New", JsonDocument.Parse(history[2].Operations.Single().CanonicalJson).RootElement.GetProperty("payload").GetProperty("kind").GetString());
        Assert.IsEmpty(await fresh.ReadExtensionStateAsync(PackageId, "node.view.map", null), "A view's state came along.");
        Assert.AreEqual((2L, 1L), (Scalar(workspace.FilePath, "SELECT COUNT(*) FROM __nendo_extension_blob;"), Scalar(destination, "SELECT COUNT(*) FROM __nendo_extension_blob;")),
            "The new file carries package content no file uses, or the source lost some.");

        // Every ID is free, and numbering starts again past what was kept.
        var created = await fresh.CreateRecordAsync(new("items", "i-3", new Dictionary<string, object?> { ["itemName"] = "Again" }, Context("again")));
        Assert.AreEqual("I-001", created.AssignedValues.Single().Value);
        Assert.AreEqual("ok", (await opened.VerifyIntegrityAsync()).IntegrityResult);
    }

    [TestMethod]
    public async Task AKeptRecordPointingAtALeftOutOneRefusesNewAndNamesIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        // sub is kept, but its parent top is left out: the new file would hold a parent that is not there.
        await service.SetRecordKeptInNewFilesAsync("folders", "sub", true, Context("keep-sub"));
        var sourceHash = Hash(workspace.FilePath);

        var preview = await service.PreviewNewFileAsync();
        Assert.IsFalse(preview.CanCreate);
        Assert.AreEqual(1L, preview.ConflictCount);
        Assert.AreEqual(new NendoNewFileConflict("folders", "sub", "parent", "folders", "top"), preview.Conflicts.Single());

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "refused.nendo");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CreateNewFileAsync(destination, "refused"));
        Assert.AreEqual("new-file-reference-left-out", refused.Code);
        StringAssert.Contains(refused.Message, "folders sub through parent at folders top");
        Assert.IsFalse(File.Exists(destination), "A refused new file was made anyway.");
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(destination)!, ".nendo-stage-*"), "A refused stage was left behind.");
        Assert.AreEqual(sourceHash, Hash(workspace.FilePath));

        // Keeping what it points at settles it.
        await service.SetRecordKeptInNewFilesAsync("folders", "top", true, Context("keep-top"));
        Assert.IsTrue((await service.PreviewNewFileAsync()).CanCreate);
    }

    [TestMethod]
    public async Task AFileThatMarksNothingStartsANewFileWithTheDefinitionAlone()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await SeedAsync(workspace);
        var preview = await service.PreviewNewFileAsync();
        Assert.AreEqual(NendoNewFile.DefaultMenuLabel, preview.MenuLabel);
        Assert.AreEqual(0L, preview.Kept);

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "empty.nendo");
        await service.CreateNewFileAsync(destination, "empty");
        await using var opened = await NendoWriteCoordinator.OpenAsync(destination, "test-empty");
        var snapshot = await new NendoApplicationService(opened).GetSnapshotAsync();
        Assert.IsEmpty(snapshot.Records);
        Assert.HasCount(3, snapshot.Entities);
    }

    [TestMethod]
    public async Task ANewFileDeclaringAnOlderHostIsRefusedAsALayoutMismatch()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        await MarkAsync(coordinator, service);
        await coordinator.DisposeAsync();
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_manifest SET minimum_host_version = '1.40.0';";
            await command.ExecuteNonQueryAsync();
        }
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.AreEqual("layout-version-mismatch", inspected.Inspection.Findings.Single().Code);
    }

    [TestMethod]
    public void ChangeSetsCarryTheOperationsAndTheReviewSaysWhatTheyDo()
    {
        static NendoOperation Compile(string type, string payload) => CanonicalChangeSetRequestCompiler.CompileOperation(
            new NendoCanonicalOperationRequest("op", type, JsonDocument.Parse(payload).RootElement));
        Assert.IsInstanceOfType<SetKeptInNewFilesDefaultOperation>(Compile("schema.setKeptInNewFiles", """{"entityId":"kinds","kept":true,"expectedDefinitionRevision":3}"""));
        var mark = (SetRecordKeptInNewFilesOperation)Compile("data.setKeptInNewFiles", """{"entityId":"folders","recordId":"top","kept":null}""");
        Assert.IsNull(mark.Kept);
        Assert.ThrowsExactly<NendoValidationException>(() => Compile("data.setKeptInNewFiles", """{"entityId":"folders","recordId":"top"}"""),
            "A mark that says nothing was read as following the type.");
        Assert.AreEqual("Archi model", ((SetNewFileLabelOperation)Compile("application.setNewFileLabel", """{"label":" Archi model ","expectedDefinitionRevision":3}""")).Label);
        Assert.AreEqual(NendoRevisionLane.Data, mark.Lane);
        Assert.AreEqual("New Archi model…", NendoNewFile.MenuLabel("Archi model"));
    }

    // ---------------------------------------------------------------- helpers

    /// <summary>
    /// Kinds, a lookup; folders, a hierarchy holding both seeded and user folders; items, the
    /// work, pointing at both and numbered I-001. A package so a view's state can be kept.
    /// </summary>
    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> SeedAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("t", "schema", "test", "Schema", [
            new CreateEntityOperation("kinds", "kinds", "Kinds", "kinds"),
            new AddFieldOperation("k-name", "kinds", "kindName", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("folders", "folders", "Folders", "folders"),
            new AddFieldOperation("f-name", "folders", "folderName", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("f-stamp", "folders", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            new AddFieldOperation("f-parent", "folders", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-parent", "folders", "parent", "folders", "folderName", 0),
            new CreateEntityOperation("items", "items", "Items", "items"),
            new AddFieldOperation("i-name", "items", "itemName", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("i-code", "items", "code", "Code", "code", NendoStorageKind.Text, false),
            new AddFieldOperation("i-kind", "items", "kind", "Kind", "kind_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("i-folder", "items", "folder", "Folder", "folder_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-kind", "items", "kind", "kinds", "kindName", 0),
            new ConfigureReferenceOperation("bind-folder", "items", "folder", "folders", "folderName", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("t", "tree", "test", "Tree", [new DeclareHierarchyOperation("tree", "folders", "parent", null, revision)]));
        await coordinator.ApplyAsync(new("t", "unique", "test", "Unique", [new SetFieldUniqueOperation("unique", "items", "code", true, revision + 1)]));
        await coordinator.ApplyAsync(new("t", "sequence", "test", "Number", [new SetFieldSequenceOperation("sequence", "items", "code", "I-", 3, revision + 2)]));
        await coordinator.ApplyAsync(new("t", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", PackageId, "Map", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("index", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>"))]));

        await service.CreateRecordAsync(new("kinds", "k-actor", new Dictionary<string, object?> { ["kindName"] = "Actor" }, Context("k-actor")));
        await service.CreateRecordAsync(new("kinds", "k-role", new Dictionary<string, object?> { ["kindName"] = "Role" }, Context("k-role")));
        await service.CreateRecordAsync(new("folders", "top", new Dictionary<string, object?> { ["folderName"] = "Business" }, Context("top")));
        await service.CreateRecordAsync(new("folders", "sub", new Dictionary<string, object?> { ["folderName"] = "Mine", ["parent"] = "top" },
            Context("sub"), new Dictionary<string, long> { ["parent"] = 1 }));
        await service.CreateRecordAsync(new("items", "i-1", new Dictionary<string, object?> { ["itemName"] = "Customer", ["kind"] = "k-actor", ["folder"] = "sub" },
            Context("i-1"), new Dictionary<string, long> { ["kind"] = 1, ["folder"] = 1 }));
        await service.CreateRecordAsync(new("items", "i-2", new Dictionary<string, object?> { ["itemName"] = "Clerk", ["kind"] = "k-role" },
            Context("i-2"), new Dictionary<string, long> { ["kind"] = 1 }));
        await service.CreateRecordAsync(new("items", "i-3", new Dictionary<string, object?> { ["itemName"] = "Draft" }, Context("i-3")));
        return (coordinator, service);
    }

    /// <summary>Kinds ship with the application, as does the top folder; the label names one new file.</summary>
    private static async Task MarkAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("t", "ships", "test", "What the application ships with", [
            new SetKeptInNewFilesDefaultOperation("keep-kinds", "kinds", true, revision),
            new SetNewFileLabelOperation("label", "Test model", revision),
        ]));
        await service.SetRecordKeptInNewFilesAsync("folders", "top", true, Context("keep-top"));
    }

    private static async Task<bool> CanUndoAsync(NendoApplicationService service, string revisionId) =>
        (await service.QueryHistoryAsync(new())).Items.Single(item => item.RevisionId == revisionId).CanRequestCompensation;

    private static (long Kept, long LeftOut) Count(NendoNewFilePreview preview, string entityId)
    {
        var type = preview.Types.Single(candidate => candidate.EntityId == entityId);
        return (type.Kept, type.LeftOut);
    }

    private static long Scalar(string path, string sql)
    {
        using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Hash(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static NendoRequestContext Context(string key) => new("new-file-tests", key, "surface");
}
