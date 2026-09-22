using System.Text.Json;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class LegacyUpgradeTests
{
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task RegisteredStageUpgradePreservesEveryExistingPayloadAndHistory(bool populated)
    {
        await using var workspace = new EngineTestWorkspace();
        await CreateLegacyAsync(workspace, populated);
        var originalBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var source = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.IsTrue(SqliteNendoStore.CanUpgradeLegacy(source));
        var stage = StagePath(workspace);
        await using (var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath))
        {
            var backup = await readOnly.PrepareBackupAsync(stage, "stage");
            await readOnly.CreateBackupAsync(backup.PlanId);
        }
        InspectedNendoFile upgraded;
        try { upgraded = await SqliteNendoStore.UpgradeLegacyStageAsync(stage, source.ContentDigest!, null, null, CancellationToken.None); }
        catch (NendoPreconditionException exception) when (exception.Code == "upgrade-validation-failed")
        {
            Assert.Fail(JsonSerializer.Serialize((await SqliteNendoStore.InspectAsync(stage, CancellationToken.None)).Inspection));
            throw;
        }
        Assert.AreEqual(SqliteNendoStore.LegacyUpgradeTargetLayout, upgraded.Inspection.Layout);
        Assert.IsTrue(upgraded.Inspection.CanAcquireWriteAuthority);
        Assert.AreEqual(source.Inspection.Manifest! with { MinimumHostVersion = NendoFormat.SemanticMinimumHostVersion }, upgraded.Inspection.Manifest);
        Assert.AreEqual(Payload(source), Payload(upgraded));
        CollectionAssert.AreEqual(originalBytes, await File.ReadAllBytesAsync(workspace.FilePath));
        await using var reopened = await NendoWriteCoordinator.OpenAsync(stage, "upgraded");
        if (populated)
        {
            var replay = await new NendoApplicationService(reopened).CreateIdeaRecordAsync("idea-1", "Keep my original value", "record");
            Assert.IsTrue(replay.IsIdempotentReplay);
            await new NendoApplicationService(reopened).SetIdeaTitleAsync("idea-1", 1, "Still editable", "edit");
        }
    }

    [TestMethod]
    [DataRow("cancel")]
    [DataRow("exception")]
    [DataRow("capacity")]
    public async Task FailedOrCancelledUpgradeTransactionLeavesTheLegacyStageIntact(string failure)
    {
        await using var workspace = new EngineTestWorkspace();
        await CreateLegacyAsync(workspace, true);
        var source = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        var stage = StagePath(workspace);
        File.Copy(workspace.FilePath, stage);
        using var cancellation = new CancellationTokenSource();
        Action? beforeCommit = failure == "cancel" ? cancellation.Cancel : failure == "exception" ?
            () => throw new InvalidOperationException("injected failure before commit") : null;
        var operation = () => SqliteNendoStore.UpgradeLegacyStageAsync(stage, source.ContentDigest!, beforeCommit,
            failure == "capacity" ? 1 : null, cancellation.Token);
        if (failure == "capacity")
        {
            var error = await Assert.ThrowsExactlyAsync<SqliteException>(operation);
            Assert.AreEqual(13, error.SqliteErrorCode);
        }
        else if (failure == "cancel") await Assert.ThrowsAsync<OperationCanceledException>(operation);
        else await Assert.ThrowsExactlyAsync<InvalidOperationException>(operation);
        var after = await SqliteNendoStore.InspectAsync(stage, CancellationToken.None);
        Assert.AreEqual(source.ContentDigest, after.ContentDigest);
        Assert.AreEqual(SqliteNendoStore.LegacyUpgradeSourceLayout, after.Inspection.Layout);
        Assert.IsFalse(File.Exists(stage + "-journal"));
    }

    [TestMethod]
    [DataRow("current")]
    [DataRow("newer-host")]
    [DataRow("unknown-layout")]
    [DataRow("changed-digest")]
    public async Task UpgradeDoesNotGuessCurrentNewerUnknownOrChangedSources(string fixture)
    {
        await using var workspace = new EngineTestWorkspace();
        if (fixture == "current")
        {
            var current = await workspace.CreateAsync();
            await current.DisposeAsync();
        }
        else await CreateLegacyAsync(workspace, true);
        if (fixture is "newer-host" or "unknown-layout")
        {
            await using var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False");
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = fixture == "newer-host" ?
                "UPDATE __nendo_manifest SET minimum_host_version = '999.0.0';" :
                "ALTER TABLE __nendo_entity ADD COLUMN guessed TEXT NULL;";
            await command.ExecuteNonQueryAsync();
        }
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => SqliteNendoStore.UpgradeLegacyStageAsync(
            workspace.FilePath, fixture == "changed-digest" ? "changed" : inspected.ContentDigest ?? "unreadable",
            null, null, CancellationToken.None));
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task OrdinaryStorageMutationCannotImplicitlyExpandALegacyLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        await CreateLegacyAsync(workspace, true);
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        await using (var store = await SqliteNendoStore.OpenAsync(workspace.FilePath, CancellationToken.None))
        {
            var authority = await store.GetAuthoritySnapshotAsync(CancellationToken.None);
            var mutation = new NendoMutation("upgrade-tests", "denied", "test", "No implicit upgrade",
                [new SetFieldOperation("operation-denied", NendoApplicationService.IdeaEntityId, "idea-1",
                    NendoApplicationService.IdeaTitleFieldId, 1, "Must not be stored")]);
            await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => store.ApplyAsync(mutation, authority, CancellationToken.None));
        }
        var after = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.AreEqual(inspected.ContentDigest, after.ContentDigest);
        Assert.AreEqual(SqliteNendoStore.LegacyUpgradeSourceLayout, after.Inspection.Layout);
    }

    internal static async Task CreateLegacyAsync(EngineTestWorkspace workspace, bool populated)
    {
        var original = await workspace.CreateAsync();
        if (populated)
        {
            var service = new NendoApplicationService(original);
            await service.CreateIdeaSchemaAsync("schema");
            await service.CreateIdeaRecordAsync("idea-1", "Keep my original value", "record");
        }
        await original.DisposeAsync();
        await SemanticMetadataTests.StripSemanticMetadataAsync(workspace.FilePath);
        // Remove freed fixture pages so max_page_count deterministically exercises
        // SQLite's real capacity failure while adding the registered layout.
        await using var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "VACUUM;";
        await command.ExecuteNonQueryAsync();
    }

    private static string StagePath(EngineTestWorkspace workspace) => Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "stage.nendo");

    private static string Payload(InspectedNendoFile file) => JsonSerializer.Serialize(new
    {
        Manifest = file.Snapshot!.Manifest with { MinimumHostVersion = "normalised-for-comparison" },
        file.Snapshot.Entities, file.Snapshot.Records, file.Snapshot.UiNodes, file.History,
    });
}
