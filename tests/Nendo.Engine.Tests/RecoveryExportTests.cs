using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RecoveryExportTests
{
    [TestMethod]
    public async Task ExportUsesStableColumnsEscapingAndAnExactVerifiedRetryWithoutChangingTheApplication()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("record-1", "A, \"quoted\"\r\nidea", "record");
        var before = await HashAsync(workspace.FilePath);
        var destination = CsvPath(workspace);
        var plan = await service.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export");
        Assert.AreEqual(plan, await service.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export"));
        Assert.IsFalse(plan.IsPartial);
        Assert.AreEqual(1, plan.ExportedRecordCount);
        Assert.IsFalse(File.Exists(destination));
        var result = await service.CreateRecoveryExportAsync(plan.PlanId, false);
        Assert.IsFalse(result.IsIdempotentReplay);
        Assert.IsTrue((await service.CreateRecoveryExportAsync(plan.PlanId, false)).IsIdempotentReplay);
        var bytes = await File.ReadAllBytesAsync(destination);
        CollectionAssert.AreEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes[..3]);
        Assert.AreEqual(bytes.Length, plan.ByteCount);
        var text = Encoding.UTF8.GetString(bytes[3..]);
        Assert.StartsWith($"\"__nendo_record_id\",\"__nendo_record_version\",\"field/{NendoApplicationService.IdeaTitleFieldId}\"\r\n", text);
        Assert.Contains("\"record-1\",\"1\",\"A, \"\"quoted\"\"\r\nidea\"\r\n", text);
        CollectionAssert.AreEqual(before, await HashAsync(workspace.FilePath));
        Assert.IsFalse(Directory.EnumerateFiles(Path.GetDirectoryName(destination)!, ".nendo-export-*").Any());
        await File.WriteAllTextAsync(destination, "unrelated replacement");
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => service.CreateRecoveryExportAsync(plan.PlanId, false));
        Assert.AreEqual("unrelated replacement", await File.ReadAllTextAsync(destination));
    }

    [TestMethod]
    public async Task ReadableRecoveryExportsEvenWhenHistoryCannotSupportABackup()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("record-1", "Recover me", "record");
        await original.DisposeAsync();
        workspace.Forget(original);
        await ChangeAsync(workspace.FilePath, "UPDATE __nendo_revision SET operation_digest = 'damaged' WHERE change_sequence = 0;");
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var recovery = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.IsFalse(recovery.Capabilities.Backup);
        Assert.IsTrue(recovery.Capabilities.Export);
        var plan = await recovery.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, CsvPath(workspace), "export");
        await recovery.CreateRecoveryExportAsync(plan.PlanId, false);
        Assert.Contains("Recover me", await File.ReadAllTextAsync(CsvPath(workspace)));
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
    }

    [TestMethod]
    public async Task UnknownFieldsRequireExplicitPartialConfirmationAndLeaveOriginalBytesUntouched()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("record-1", "Unknown scalar", "record");
        await original.DisposeAsync();
        workspace.Forget(original);
        await ChangeAsync(workspace.FilePath, "UPDATE __nendo_field SET storage_kind = 'FutureScalar';");
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var recovery = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = await recovery.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, CsvPath(workspace), "export");
        Assert.IsTrue(plan.IsPartial);
        CollectionAssert.AreEqual(new[] { NendoApplicationService.IdeaTitleFieldId }, plan.OmittedFieldIds.ToArray());
        var denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => recovery.CreateRecoveryExportAsync(plan.PlanId, false));
        Assert.AreEqual("partial-export-confirmation", denied.Code);
        Assert.IsFalse(File.Exists(CsvPath(workspace)));
        await recovery.CreateRecoveryExportAsync(plan.PlanId, true);
        Assert.DoesNotContain("Unknown scalar", await File.ReadAllTextAsync(CsvPath(workspace)));
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    [DataRow("empty")]
    [DataRow("occupied")]
    [DataRow("racing")]
    public async Task ExistingOrRacingDestinationsAreNeverOverwritten(string scenario)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("schema");
        var destination = CsvPath(workspace);
        if (scenario != "racing") await File.WriteAllTextAsync(destination, scenario == "empty" ? "" : "unrelated");
        if (scenario == "racing")
        {
            var plan = await source.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export");
            source.BeforeRecoveryExportActivation = () => File.WriteAllText(destination, "racing bytes");
            await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateRecoveryExportAsync(plan.PlanId, false));
        }
        else await Assert.ThrowsExactlyAsync<IOException>(() => source.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export"));
        Assert.AreEqual(scenario == "empty" ? "" : scenario == "occupied" ? "unrelated" : "racing bytes", await File.ReadAllTextAsync(destination));
        Assert.IsFalse(Directory.EnumerateFiles(Path.GetDirectoryName(destination)!, ".nendo-export-*").Any());
    }

    [TestMethod]
    public async Task CancelAndInjectedWriteFailureLeaveNoDestinationAndLostResultRetriesTheCommittedExport()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("schema");
        var destination = CsvPath(workspace);
        var plan = await source.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export");
        using var cancellation = new CancellationTokenSource();
        source.DuringRecoveryExportWrite = cancellation.Cancel;
        await Assert.ThrowsAsync<OperationCanceledException>(() => source.CreateRecoveryExportAsync(plan.PlanId, false, cancellation.Token));
        Assert.IsFalse(File.Exists(destination));
        source.DuringRecoveryExportWrite = () => throw new IOException("simulated destination full");
        await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateRecoveryExportAsync(plan.PlanId, false));
        Assert.IsFalse(File.Exists(destination));
        source.DuringRecoveryExportWrite = null;
        source.AfterRecoveryExportActivation = () => throw new IOException("simulated lost result");
        await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateRecoveryExportAsync(plan.PlanId, false));
        Assert.IsTrue(File.Exists(destination));
        Assert.IsTrue((await source.CreateRecoveryExportAsync(plan.PlanId, false)).IsIdempotentReplay);
        Assert.IsFalse(Directory.EnumerateFiles(Path.GetDirectoryName(destination)!, ".nendo-export-*").Any());
    }

    [TestMethod]
    public async Task ChangedSourceAndLostAuthorityCannotExportAnUnreviewedNewState()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("record-1", "Before", "record");
        var plan = await source.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, CsvPath(workspace), "export");
        await service.SetIdeaTitleAsync("record-1", 1, "Changed", "edit");
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateRecoveryExportAsync(plan.PlanId, false));
        Assert.AreEqual("export-source-changed", stale.Code);
        Assert.IsFalse(File.Exists(CsvPath(workspace)));
        await ChangeAsync(workspace.FilePath, "UPDATE idea SET title = 'Outside';");
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => source.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, CsvPath(workspace), "after-outside"));
        Assert.IsFalse(source.Capabilities.Export);
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, source.Health);
    }

    [TestMethod]
    public void FormatterIsDeterministicScalarOnlyAndReportsEveryOmissionAndLimit()
    {
        NendoFieldSnapshot Field(string id, NendoStorageKind kind) => new(id, id, kind, false, null, []);
        var entity = new NendoEntitySnapshot("table", "Table", [Field("z", NendoStorageKind.Text), Field("a", NendoStorageKind.Integer), Field("future", NendoStorageKind.Unsupported)]);
        NendoRecordSnapshot Record(string id, object? text) => new("table", id, 2, new Dictionary<string, JsonElement>
        { ["z"] = JsonSerializer.SerializeToElement(text), ["a"] = JsonSerializer.SerializeToElement(-2) });
        var records = new[] { Record("c", "third"), Record("b", new { not = "scalar" }), Record("a", "  =1+2") };
        var csv = RecoveryCsvWriter.Create(entity, records, CancellationToken.None);
        var text = Encoding.UTF8.GetString(csv.Bytes[3..]);
        Assert.StartsWith("\"__nendo_record_id\",\"__nendo_record_version\",\"field/a\",\"field/z\"\r\n", text);
        Assert.Contains("\"a\",\"2\",\"-2\",\"'  =1+2\"", text);
        Assert.AreEqual(2, csv.ExportedRows);
        Assert.AreEqual(3, csv.SourceRows);
        Assert.IsTrue(csv.IsPartial);
        Assert.AreEqual(1, csv.EscapedCells);
        Assert.IsTrue(csv.Findings.Any(finding => finding.Code == "csv-unsupported-rows"));
        CollectionAssert.AreEqual(csv.Bytes, RecoveryCsvWriter.Create(entity, records.Reverse().ToArray(), CancellationToken.None).Bytes);
        var limited = RecoveryCsvWriter.Create(entity, records, CancellationToken.None, maximumRows: 1);
        Assert.AreEqual(1, limited.ExportedRows);
        Assert.IsTrue(limited.Findings.Any(finding => finding.Code == "csv-limit"));
        var byteLimited = RecoveryCsvWriter.Create(entity, records, CancellationToken.None, maximumBytes: csv.Bytes.Length - 1);
        Assert.AreEqual(1, byteLimited.ExportedRows);
        Assert.IsTrue(byteLimited.IsPartial);
    }

    [TestMethod]
    [DataRow("=SUM(A1)")]
    [DataRow("+1")]
    [DataRow("-1")]
    [DataRow("@function")]
    [DataRow("\tvalue")]
    [DataRow("\rvalue")]
    [DataRow("\nvalue")]
    [DataRow("\uFEFF=1")]
    [DataRow(" \uFEFF=1")]
    [DataRow("\u0001=1")]
    public void TextThatCouldBecomeASpreadsheetFormulaIsPrefixedAndDisclosed(string value)
    {
        var entity = new NendoEntitySnapshot("table", "Table", [new("text", "Text", NendoStorageKind.Text, false, null, [])]);
        var record = new NendoRecordSnapshot("table", "id", 1, new Dictionary<string, JsonElement> { ["text"] = JsonSerializer.SerializeToElement(value) });
        var csv = RecoveryCsvWriter.Create(entity, [record], CancellationToken.None);
        Assert.AreEqual(1, csv.EscapedCells);
        Assert.Contains("\"'" + value, Encoding.UTF8.GetString(csv.Bytes));
    }

    private static string CsvPath(EngineTestWorkspace workspace) => Path.ChangeExtension(workspace.FilePath, ".csv");

    [TestMethod]
    public void FieldIdsCannotCollideWithRecordMetadataColumns()
    {
        var entity = new NendoEntitySnapshot("table", "Table",
            [new("__nendo_record_id", "User field", NendoStorageKind.Text, false, null, []),
             new("field/__nendo_record_id", "Another field", NendoStorageKind.Text, false, null, [])]);
        var csv = RecoveryCsvWriter.Create(entity, [], CancellationToken.None);
        Assert.AreEqual("\"__nendo_record_id\",\"__nendo_record_version\",\"field/__nendo_record_id\",\"field/field/__nendo_record_id\"\r\n",
            Encoding.UTF8.GetString(csv.Bytes[3..]));
    }

    [TestMethod]
    public void EverySupportedScalarIsExportedWithoutGuessingAnUnsupportedRepresentation()
    {
        var values = new Dictionary<string, (NendoStorageKind Kind, object? Value)>
        {
            ["text"] = (NendoStorageKind.Text, "Plain"), ["integer"] = (NendoStorageKind.Integer, -123L),
            ["decimal"] = (NendoStorageKind.Decimal, 12.5m), ["boolean"] = (NendoStorageKind.Boolean, true),
            ["date"] = (NendoStorageKind.Date, "2026-09-04"), ["time"] = (NendoStorageKind.DateTime, "2026-09-04T08:00:00+00:00"),
            ["uuid"] = (NendoStorageKind.Uuid, "98f81ae7-6d84-4f96-9a34-e22d2742479a"), ["null"] = (NendoStorageKind.Text, null),
        };
        var entity = new NendoEntitySnapshot("table", "Table", values.Select(value => new NendoFieldSnapshot(value.Key, value.Key, value.Value.Kind, false, null, [])).ToArray());
        var record = new NendoRecordSnapshot("table", "id", 1, values.ToDictionary(value => value.Key, value => JsonSerializer.SerializeToElement(value.Value.Value)));
        var csv = RecoveryCsvWriter.Create(entity, [record], CancellationToken.None);
        Assert.IsFalse(csv.IsPartial);
        Assert.AreEqual(1, csv.ExportedRows);
        Assert.AreEqual(0, csv.EscapedCells);
        var text = Encoding.UTF8.GetString(csv.Bytes);
        foreach (var value in new[] { "Plain", "-123", "12.5", "true", "2026-09-04", "2026-09-04T08:00:00+00:00", "98f81ae7-6d84-4f96-9a34-e22d2742479a" }) Assert.Contains(value, text);
    }

    [TestMethod]
    public void RealDefaultRowFieldAndCellBoundsAreExplicit()
    {
        var fields = Enumerable.Range(0, RecoveryCsvWriter.MaximumFields + 1)
            .Select(index => new NendoFieldSnapshot($"f{index:D4}", "Field", NendoStorageKind.Text, false, null, [])).ToArray();
        var fieldLimited = RecoveryCsvWriter.Create(new("table", "Table", fields), [], CancellationToken.None);
        Assert.HasCount(1, fieldLimited.OmittedFields);
        var entity = new NendoEntitySnapshot("table", "Table", [fields[0]]);
        var values = new Dictionary<string, JsonElement> { [fields[0].FieldId] = JsonSerializer.SerializeToElement("value") };
        var records = Enumerable.Range(0, RecoveryCsvWriter.MaximumRows + 1).Select(index => new NendoRecordSnapshot("table", $"r{index:D5}", 1, values)).ToArray();
        var rowLimited = RecoveryCsvWriter.Create(entity, records, CancellationToken.None);
        Assert.AreEqual(RecoveryCsvWriter.MaximumRows, rowLimited.ExportedRows);
        Assert.IsTrue(rowLimited.IsPartial);
        var cellLimited = RecoveryCsvWriter.Create(entity,
            [new("table", "id", 1, new Dictionary<string, JsonElement> { [fields[0].FieldId] = JsonSerializer.SerializeToElement(new string('x', 100_001)) })], CancellationToken.None);
        Assert.AreEqual(0, cellLimited.ExportedRows);
        Assert.IsTrue(cellLimited.Findings.Any(finding => finding.Code == "csv-unsupported-rows"));
    }
    private static async Task<byte[]> HashAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return await SHA256.HashDataAsync(stream);
    }
    private static async Task ChangeAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }
}
