using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class FormatAndLifecycleTests
{
    [TestMethod]
    public async Task EmptyFileHasGenesisMetadataAndOneFileAfterCleanClose()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();

        var snapshot = await coordinator.GetSnapshotAsync();
        var history = await coordinator.GetHistoryAsync();

        Assert.AreEqual("ideas.nendo", snapshot.FileName);
        Assert.AreEqual(NendoSessionHealth.Normal, snapshot.Health);
        Assert.AreEqual(NendoFormat.Identifier, snapshot.Manifest.FormatIdentifier);
        Assert.AreEqual(NendoFormat.CurrentVersion, snapshot.Manifest.FormatVersion);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, snapshot.Manifest.MinimumHostVersion);
        Assert.IsTrue(snapshot.Manifest.ApplicationId.StartsWith("application-", StringComparison.Ordinal));
        Assert.IsTrue(snapshot.Manifest.InstanceId.StartsWith("instance-", StringComparison.Ordinal));
        Assert.AreEqual(0L, snapshot.Manifest.DefinitionRevision);
        Assert.AreEqual(0L, snapshot.Manifest.DataRevision);
        Assert.AreEqual(0L, snapshot.Manifest.ChangeSequence);
        Assert.IsEmpty(snapshot.Entities);
        Assert.IsEmpty(snapshot.Records);
        Assert.AreEqual("DELETE", snapshot.Storage.JournalMode);
        Assert.AreEqual("FULL", snapshot.Storage.SynchronousMode);
        Assert.AreEqual(2_000, snapshot.Storage.BusyTimeoutMilliseconds);
        Assert.AreEqual("ok", snapshot.Storage.IntegrityResult, ignoreCase: true);
        Assert.HasCount(1, history);
        Assert.AreEqual(NendoRevisionLane.Genesis, history[0].Lane);
        Assert.AreEqual(0L, history[0].ChangeSequence);
        Assert.IsEmpty(history[0].Operations);

        var applicationId = snapshot.Manifest.ApplicationId;
        var instanceId = snapshot.Manifest.InstanceId;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var filesAfterClose = Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!);
        Assert.HasCount(1, filesAfterClose);
        Assert.AreEqual(workspace.FilePath, filesAfterClose[0]);

        var reopened = await workspace.OpenAsync();
        var reopenedSnapshot = await reopened.GetSnapshotAsync();
        Assert.AreEqual(applicationId, reopenedSnapshot.Manifest.ApplicationId);
        Assert.AreEqual(instanceId, reopenedSnapshot.Manifest.InstanceId);
        Assert.AreEqual(0L, reopenedSnapshot.Manifest.ChangeSequence);
    }

    [TestMethod]
    public async Task PhysicalFileUsesRequiredApplicationMarkersAndRelationalSchema()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema-physical-proof");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        };
        await using var connection = new SqliteConnection(builder.ToString());
        await connection.OpenAsync();

        Assert.AreEqual(NendoFormat.SqliteApplicationId, await ScalarInt64Async(connection, "PRAGMA application_id;"));
        Assert.AreEqual(NendoFormat.CurrentVersion, await ScalarInt64Async(connection, "PRAGMA user_version;"));
        Assert.AreEqual("delete", Convert.ToString(await ScalarAsync(connection, "PRAGMA journal_mode;")), ignoreCase: true);

        await using var table = connection.CreateCommand();
        table.CommandText = "PRAGMA table_info(idea);";
        await using var reader = await table.ExecuteReaderAsync();
        var columns = new List<(string Name, string Type, long NotNull)>();
        while (await reader.ReadAsync())
        {
            columns.Add((reader.GetString(1), reader.GetString(2), reader.GetInt64(3)));
        }
        CollectionAssert.Contains(columns.Select(column => column.Name).ToArray(), "__nendo_record_id");
        CollectionAssert.Contains(columns.Select(column => column.Name).ToArray(), "__nendo_record_version");
        var title = columns.Single(column => column.Name == "title");
        Assert.AreEqual("TEXT", title.Type);
        Assert.AreEqual(1L, title.NotNull);
    }

    [TestMethod]
    public async Task SecondCoordinatorIsExcludedAndPathIsPinnedUntilDispose()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync("first");

        await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(
            () => NendoWriteCoordinator.OpenAsync(workspace.FilePath, "second"));
        Assert.ThrowsExactly<IOException>(() => File.Move(workspace.FilePath, $"{workspace.FilePath}.moved"));
        Assert.ThrowsExactly<IOException>(() => File.Delete(workspace.FilePath));

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var moved = $"{workspace.FilePath}.moved";
        File.Move(workspace.FilePath, moved);
        File.Move(moved, workspace.FilePath);

        var successor = await workspace.OpenAsync("successor");
        Assert.AreEqual(NendoSessionHealth.Normal, successor.Health);
    }

    [TestMethod]
    public async Task CreateNeverOverwritesAnExistingPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = new byte[] { 0x4E, 0x45, 0x4E, 0x44, 0x4F };
        await File.WriteAllBytesAsync(workspace.FilePath, original);

        await Assert.ThrowsExactlyAsync<IOException>(
            () => NendoWriteCoordinator.CreateAsync(workspace.FilePath, "create-no-overwrite"));

        CollectionAssert.AreEqual(original, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.IsFalse(File.Exists($"{workspace.FilePath}.write-owner"));
    }

    [TestMethod]
    public async Task SaveSelectionCanInitializeAnEmptyPlaceholder()
    {
        await using var workspace = new EngineTestWorkspace();
        await File.WriteAllBytesAsync(workspace.FilePath, []);

        await using var coordinator = await NendoWriteCoordinator.CreateOrInitializeEmptyAsync(
            workspace.FilePath,
            "save-picker");
        var snapshot = await coordinator.GetSnapshotAsync();

        Assert.AreEqual(NendoFormat.Identifier, snapshot.Manifest.FormatIdentifier);
        Assert.AreEqual(0L, snapshot.Manifest.ChangeSequence);
        Assert.IsGreaterThan(0, new FileInfo(workspace.FilePath).Length);
    }

    [TestMethod]
    public async Task SaveSelectionNeverOverwritesANonEmptyPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = new byte[] { 0x4E, 0x45, 0x4E, 0x44, 0x4F };
        await File.WriteAllBytesAsync(workspace.FilePath, original);

        await Assert.ThrowsExactlyAsync<IOException>(
            () => NendoWriteCoordinator.CreateOrInitializeEmptyAsync(workspace.FilePath, "save-picker"));

        CollectionAssert.AreEqual(original, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.IsFalse(File.Exists($"{workspace.FilePath}.write-owner"));
    }

    private static async Task<object?> ScalarAsync(SqliteConnection connection, string sql)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        return await command.ExecuteScalarAsync();
    }

    private static async Task<long> ScalarInt64Async(SqliteConnection connection, string sql) =>
        Convert.ToInt64(await ScalarAsync(connection, sql), System.Globalization.CultureInfo.InvariantCulture);
}
