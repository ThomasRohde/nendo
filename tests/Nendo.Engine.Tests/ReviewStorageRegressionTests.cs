using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ReviewStorageRegressionTests
{
    [TestMethod]
    public async Task R004EveryReadOnlyFoldUsesStoredCalculatedAndHierarchyFilters()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema", [
            new CreateEntityOperation("entity", "items", "Items", "items"),
            new AddFieldOperation("title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("flag", "items", "flag", "Flag", "flag", NendoStorageKind.Boolean, false),
            new AddFieldOperation("other", "items", "other", "Other", "other", NendoStorageKind.Boolean, false),
            new AddFieldOperation("amount", "items", "amount", "Amount", "amount", NendoStorageKind.Integer, true),
            new AddFieldOperation("date", "items", "date", "Date", "date", NendoStorageKind.Date, false),
            new AddFieldOperation("parent", "items", "parent", "Parent", "parent", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("reference", "items", "parent", "items", "title", 0),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("semantics", [
            new DeclareHierarchyOperation("tree", "items", "parent", null, revision),
            new SetBehaviourDefinitionOperation("calculation", new NendoCalculationDefinition("items.double", "items", "double", "Double",
                NendoBehaviourScalar.Integer, false, "value * 2",
                [NendoBehaviourBinding.SameRecordField("value", "items", "amount", NendoBehaviourScalar.Integer, false)]), revision),
        ]));
        foreach (var (id, amount, parent) in new (string, long, string?)[] { ("root", 90, null), ("child", 10, "root") })
            await service.CreateRecordAsync(new("items", id, new Dictionary<string, object?> {
                ["title"] = id, ["flag"] = id == "child", ["other"] = true, ["amount"] = amount,
                ["date"] = DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd"), ["parent"] = parent,
            }, Context(id), parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 }));
        NendoRecordFilter[][] filters = [
            [new("flag", "eq", JsonSerializer.SerializeToElement(true))],
            [new("double", "lt", JsonSerializer.SerializeToElement(100))],
            [new("parent", "descendantOf", JsonSerializer.SerializeToElement("root"))],
        ];
        var expected = new List<string[]>();
        foreach (var filter in filters) expected.Add(await Fold(service, filter));
        await coordinator.DisposeAsync();
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        for (var index = 0; index < filters.Length; index++)
            CollectionAssert.AreEqual(expected[index], await Fold(new(readOnly), filters[index]),
                $"R004 read-only folds must use the same set as writable folds ({filters[index][0].FieldId}).");

        static async Task<string[]> Fold(NendoApplicationService app, IReadOnlyList<NendoRecordFilter> filters)
        {
            var page = await app.QueryRecordsAsync(new("items") { Filters = filters });
            Assert.AreEqual("child", page.Items.Single().RecordId);
            return [
                JsonSerializer.Serialize(await app.CountRecordsAsync(new("items") { Filters = filters })),
                JsonSerializer.Serialize(await app.AggregateRecordsAsync(new("items", "sum", "amount") { Filters = filters })),
                JsonSerializer.Serialize(await app.GroupAggregateRecordsAsync(new("items", "flag", "sum", "amount") { Filters = filters })),
                JsonSerializer.Serialize(await app.BucketAggregateRecordsAsync(new("items", "date", "month", "last6Months", "sum", "amount") { Filters = filters })),
                JsonSerializer.Serialize(await app.CellAggregateRecordsAsync(new("items", "flag", "other", "sum", "amount") { Filters = filters })),
            ];
        }
    }

    [TestMethod]
    [DataRow("missing")]
    [DataRow("replaced")]
    [DataRow("changed")]
    public async Task R005AFoldRefusesAnUnavailableOrChangedBackup(string change)
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 12);
        coordinator.HistoryFoldPolicy = new(5, 1000, 2);
        var before = JsonSerializer.Serialize(await service.GetHistoryAsync());
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        var plan = await coordinator.PrepareBackupAsync(path, "backup");
        await coordinator.CreateBackupAsync(plan.PlanId);
        if (change == "missing") File.Delete(path);
        else if (change == "replaced")
        {
            var replacement = path + ".replacement";
            File.Copy(path, replacement);
            File.Delete(path);
            File.Move(replacement, path);
        }
        else await ChangeLabel(path);
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.FoldHistoryAsync(plan.PlanId),
            "R005 folding must refuse a backup that no longer holds the inspected recovery history.");
        Assert.AreEqual("history-fold-backup-changed", refusal.Code);
        Assert.AreEqual(before, JsonSerializer.Serialize(await service.GetHistoryAsync()), "R005 refusal removed history.");
    }

    [TestMethod]
    public async Task R005BackupIsProtectedThroughTheDestructiveFold()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 12);
        coordinator.HistoryFoldPolicy = new(5, 1000, 2);
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        var plan = await coordinator.PrepareBackupAsync(path, "backup");
        await coordinator.CreateBackupAsync(plan.PlanId);
        var checkedPin = false;
        coordinator.BeforeHistoryFoldCommit = () =>
        {
            Assert.ThrowsExactly<IOException>(() => File.Delete(path), "R005 the backup must not be deletable during fold.");
            Assert.ThrowsExactly<IOException>(() => { using var writer = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite); });
            checkedPin = true;
        };
        await service.FoldHistoryAsync(plan.PlanId);
        Assert.IsTrue(checkedPin);
        Assert.IsTrue(File.Exists(path));
    }

    [TestMethod]
    public async Task R006ReadOnlyPreviewAndCreationKeepTheSameRecordsAndLabel()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 2);
        await service.SetRecordKeptInNewFilesAsync("notes", "n0", true, Context("keep"));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("label", [new SetNewFileLabelOperation("new-file-label", "Notebook", revision)]));
        var expected = await service.PreviewNewFileAsync();
        await coordinator.DisposeAsync();
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var app = new NendoApplicationService(readOnly);
        Assert.AreEqual(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(await app.PreviewNewFileAsync()),
            "R006 read-only preview must match the writable source preview.");
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "new.nendo");
        var made = await app.CreateNewFileAsync(path, "new");
        Assert.AreEqual(expected.Kept, made.KeptRecords);
        await using var opened = await NendoWriteCoordinator.OpenReadOnlyAsync(path);
        Assert.AreEqual("n0", (await opened.GetSnapshotAsync()).Records.Single().RecordId);
    }

    [TestMethod]
    public async Task R022AChangedStageNeverActivatesAndLeavesItsSourceUntouched()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 2);
        await service.SetRecordKeptInNewFilesAsync("notes", "n0", true, Context("keep"));
        var before = JsonSerializer.Serialize(await service.GetSnapshotAsync());
        coordinator.BeforeNewFileValidation = path => ChangeLabel(path).GetAwaiter().GetResult();
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "new.nendo");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CreateNewFileAsync(destination, "new"),
            "R022 altered kept values must prevent stage activation.");
        Assert.IsFalse(File.Exists(destination));
        Assert.AreEqual(before, JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(destination)!, ".nendo-stage-*"));
    }

    [TestMethod]
    public async Task R022StageProtectionContinuesThroughActivation()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 1);
        var checkedPin = false;
        coordinator.BeforeNewFileActivation = path =>
        {
            Assert.ThrowsExactly<IOException>(() => File.Delete(path));
            Assert.ThrowsExactly<IOException>(() => { using var writer = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); });
            checkedPin = true;
        };
        await service.CreateNewFileAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "new.nendo"), "new");
        Assert.IsTrue(checkedPin, "R022 activation must pass through protected stage ownership.");
    }

    [TestMethod]
    public async Task R025LargestRecordBatchRollsBackBeforeCrossingTheOpenRowLimit()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await Notes(workspace, 0);
        await coordinator.ApplyAsync(Mutation("fields", Enumerable.Range(0, 63).Select(index => (NendoOperation)
            new AddFieldOperation("f" + index, "notes", "f" + index, "F" + index, "f_" + index, NendoStorageKind.Text, false)).ToArray()));
        await service.ApplyRecordWritesAsync(new(Enumerable.Range(0, 200).Select(index =>
            new NendoRecordWrite(NendoRecordWriteKind.Create, "notes", "n" + index, new Dictionary<string, object?> { ["label"] = "Note" })).ToArray(), Context("seed")));
        var values = Enumerable.Range(0, 63).ToDictionary(index => "f" + index, _ => (object?)"Value");
        values["label"] = "Changed";
        long version = 1;
        for (var batch = 0; batch < 7; batch++)
            version = (await Write(batch)).Records[0].RecordVersion!.Value;
        var rows = (await service.PreviewHistoryFoldAsync()).OperationRows;
        var before = (await service.GetSnapshotAsync()).Manifest;
        Assert.IsLessThan(SqliteNendoStore.WriteCeilingRows, rows, "Fixture must be below the pre-write ceiling.");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Write(7),
            "R025 a supported 200-record/64-field write must not commit past the open row limit.");
        Assert.AreEqual("write-ceiling-rows", refused.Code);
        Assert.AreEqual(rows, (await service.PreviewHistoryFoldAsync()).OperationRows);
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest);
        Assert.AreEqual(version, (await service.QueryRecordsAsync(new("notes") { RecordId = "n0" })).Items.Single().RecordVersion);

        // A slightly smaller initiating batch fits by itself. Its automatic
        // changes must be included in the same final measurement.
        var count = (int)((SqliteNendoStore.MaximumInspectionRows - rows - 2) / 64);
        var generated = (int)(SqliteNendoStore.MaximumInspectionRows - rows - 2 - count * 64 + 1);
        await coordinator.ApplyAsync(Mutation("automatic-growth", [
            new SetBehaviourDefinitionOperation("growth-action", new NendoActionDefinition("grow", "Generated values",
                Enumerable.Range(0, generated).Select(index => NendoActionStep.SetField("s" + index.ToString("D2"), NendoActionTarget.EventRecord,
                    new NendoActionAssignment("f" + index, "'Generated'", [], []))).ToArray()), before.DefinitionRevision),
            new SetBehaviourDefinitionOperation("growth-trigger", new NendoTriggerDefinition("grow-trigger", "notes", "Generated values",
                NendoTriggerEvents.Updated, "grow", ["label"]), before.DefinitionRevision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);
        rows = (await service.PreviewHistoryFoldAsync()).OperationRows;
        before = (await service.GetSnapshotAsync()).Manifest;
        Assert.IsLessThanOrEqualTo(SqliteNendoStore.MaximumInspectionRows, rows + count * 64,
            "The initiating operations must fit without their generated effects.");
        var automatic = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ApplyRecordWritesAsync(new(
            Enumerable.Range(0, count).Select(index => new NendoRecordWrite(NendoRecordWriteKind.Update, "notes", "n" + index,
                index == 0 ? new Dictionary<string, object?>(values) { ["label"] = "Fire" } : values, version)).ToArray(), Context("generated-overflow"))),
            "R025 generated changes must be included before committing near the open limit.");
        Assert.AreEqual("write-ceiling-rows", automatic.Code);
        Assert.AreEqual(rows, (await service.PreviewHistoryFoldAsync()).OperationRows);
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest);
        await coordinator.DisposeAsync();
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.IsTrue(inspection.Capabilities.ReadData, "R025 refused growth must leave the source reopenable.");
        await using var reopened = await workspace.OpenAsync();
        Assert.AreEqual(before, (await reopened.GetSnapshotAsync()).Manifest);
        TestBehaviourAuthority.Approving(reopened);
        var control = await new NendoApplicationService(reopened).SetFieldAsync(new("notes", "n0", "label", version, "Fire", Context("generated-control")));
        Assert.AreEqual(version + 1 + generated, control.GeneratedChanges.Single().RecordVersion,
            "The overflow fixture's automatic changes must really execute.");

        Task<NendoRecordWritesResult> Write(int batch) => service.ApplyRecordWritesAsync(new(Enumerable.Range(0, 200).Select(index =>
            new NendoRecordWrite(NendoRecordWriteKind.Update, "notes", "n" + index, values, version)).ToArray(), Context("batch" + batch)));
    }

    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> Notes(EngineTestWorkspace workspace, int count)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("label", "notes", "label", "Label", "label", NendoStorageKind.Text, false),
        ]));
        for (var index = 0; index < count; index++)
            await service.CreateRecordAsync(new("notes", "n" + index, new Dictionary<string, object?> { ["label"] = "Note " + index }, Context("note" + index)));
        return (coordinator, service);
    }

    private static async Task ChangeLabel(string path)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadWrite;Pooling=False");
        await connection.OpenAsync();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE notes SET label = 'CORRUPTED' WHERE __nendo_record_id = 'n0';";
        Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
    }

    private static NendoMutation Mutation(string key, IReadOnlyList<NendoOperation> operations) => new("storage-review", key, "test", key, operations);
    private static NendoRequestContext Context(string key) => new("storage-review", key, "test");
}
