using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

public static class UpgradeChildDriver
{
    public static async Task RunAsync(string path, string checkpoint)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenReadOnlyAsync(path);
        var plan = await coordinator.PrepareUpgradeAsync("child-upgrade");
        coordinator.UpgradeCheckpoint = reached =>
        {
            if (reached != checkpoint) return;
            Console.WriteLine($"CHECKPOINT {reached}");
            Console.Out.Flush();
            Console.ReadLine();
        };
        await coordinator.UpgradeAsync(plan.PlanId);
        Console.WriteLine("COMPLETED");
    }
}

[TestClass]
public sealed class UpgradeLifecycleTests
{
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ConfirmedUpgradeRetainsTheOriginalAndReopensTheSameApplicationWithExactHistory(bool populated)
    {
        await using var workspace = new EngineTestWorkspace();
        await LegacyUpgradeTests.CreateLegacyAsync(workspace, populated);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var legacy = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var state = await legacy.GetSnapshotAsync();
        var history = JsonSerializer.Serialize(await legacy.GetHistoryAsync());
        var service = new NendoApplicationService(legacy);
        var plan = await service.PrepareUpgradeAsync("upgrade");
        Assert.AreEqual(plan, await service.PrepareUpgradeAsync("upgrade"));
        Assert.AreEqual("production-p1-v1-to-semantic-v1", plan.UpgradeId);
        Assert.AreEqual("production-p1-v1", plan.SourceLayout);
        Assert.AreEqual("production-semantic-v1", plan.TargetLayout);
        Assert.IsGreaterThan(before.LongLength * 2, plan.EstimatedAdditionalBytes);
        var result = await service.UpgradeAsync(plan.PlanId);
        Assert.AreEqual(NendoSessionHealth.Closed, legacy.Health);
        await Assert.ThrowsExactlyAsync<ObjectDisposedException>(() => legacy.GetSnapshotAsync());
        await legacy.DisposeAsync();
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, result.RetainedFileName);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(retained));
        await using var upgraded = await workspace.OpenAsync();
        var after = await upgraded.GetSnapshotAsync();
        Assert.AreEqual(state.Manifest with { MinimumHostVersion = NendoFormat.SemanticMinimumHostVersion }, after.Manifest);
        Assert.AreEqual(history, JsonSerializer.Serialize(await upgraded.GetHistoryAsync()));
        Assert.AreEqual(JsonSerializer.Serialize(state.Records), JsonSerializer.Serialize(after.Records));
        Assert.AreEqual(JsonSerializer.Serialize(state.Entities), JsonSerializer.Serialize(after.Entities));
        Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement);
        if (populated) await new NendoApplicationService(upgraded).SetIdeaTitleAsync("idea-1", 1, "Edit after upgrade", "edit");
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*.nendo"));
    }

    [TestMethod]
    [DataRow("capacity")]
    [DataRow("transaction-failure")]
    [DataRow("transaction-cancel")]
    [DataRow("upgrade-stage-verified")]
    public async Task UpgradeFailureOrCancellationDoesNotChangeTheLegacyFile(string checkpoint)
    {
        await using var workspace = new EngineTestWorkspace();
        await LegacyUpgradeTests.CreateLegacyAsync(workspace, true);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var legacy = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = await legacy.PrepareUpgradeAsync("upgrade");
        using var cancellation = new CancellationTokenSource();
        if (checkpoint == "capacity") legacy.UpgradeMaximumPageCountForTest = 1;
        else if (checkpoint == "transaction-failure") legacy.BeforeUpgradeCommit = () => throw new IOException("injected failure");
        else if (checkpoint == "transaction-cancel") legacy.BeforeUpgradeCommit = cancellation.Cancel;
        else legacy.UpgradeCheckpoint = value => { if (value == checkpoint) cancellation.Cancel(); };
        if (checkpoint == "capacity")
        {
            var failure = await Assert.ThrowsExactlyAsync<SqliteException>(() => legacy.UpgradeAsync(plan.PlanId, cancellation.Token));
            Assert.AreEqual(13, failure.SqliteErrorCode);
        }
        else if (checkpoint == "transaction-failure") await Assert.ThrowsExactlyAsync<IOException>(() => legacy.UpgradeAsync(plan.PlanId, cancellation.Token));
        else await Assert.ThrowsAsync<OperationCanceledException>(() => legacy.UpgradeAsync(plan.PlanId, cancellation.Token));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, legacy.Health);
        Assert.IsTrue(legacy.Capabilities.ReadData);
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*.nendo"));
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        using (var pin = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            var bytes = new byte[pin.Length];
            await pin.ReadExactlyAsync(bytes);
            CollectionAssert.AreEqual(before, bytes);
        }
        legacy.UpgradeMaximumPageCountForTest = null;
        legacy.BeforeUpgradeCommit = null;
        legacy.UpgradeCheckpoint = null;
        await legacy.UpgradeAsync(plan.PlanId);
        Assert.AreEqual(NendoSessionHealth.Closed, legacy.Health);
    }

    [TestMethod]
    [DataRow("recovery-record-durable", "verifiedOriginal", "missing", "verifiedReplacement")]
    [DataRow("original-retained", "missing", "verifiedOriginal", "verifiedReplacement")]
    [DataRow("replacement-activated", "verifiedReplacement", "verifiedOriginal", "missing")]
    public async Task RealUpgradeInterruptionRemainsExplicitlyRecoverableAfterFreshProcessRestart(
        string checkpoint, string activeState, string retainedState, string stagedState)
    {
        await using var workspace = new EngineTestWorkspace();
        await LegacyUpgradeTests.CreateLegacyAsync(workspace, true);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        using (var child = RestoreInterruptionTests.StartChild(workspace.FilePath, "Upgrade", checkpoint: checkpoint))
        {
            try
            {
                var signal = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
                if (signal != $"CHECKPOINT {checkpoint}")
                    Assert.Fail($"Upgrade child missed the seam: {signal}; {await child.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5))}");
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            finally { await StopOwnedChildAsync(child); }
        }
        await RestoreInterruptionTests.AssertExitedWriterReleasedAsync(workspace.FilePath);
        var paths = Directory.GetFiles(folder).Order(StringComparer.Ordinal).ToArray();
        var hashes = paths.Select(path => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))).ToArray();
        using (var reader = RestoreInterruptionTests.StartChild(workspace.FilePath, "InspectRecovery"))
        {
            try
            {
                var json = await reader.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
                await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.AreEqual(0, reader.ExitCode, await reader.StandardError.ReadToEndAsync());
                var recovery = JsonSerializer.Deserialize<NendoReplacementRecovery>(json!);
                Assert.IsNotNull(recovery);
                Assert.IsTrue(recovery.HasPendingReplacement);
                Assert.IsTrue(recovery.OperationId!.StartsWith("upgrade-", StringComparison.Ordinal));
                Assert.AreEqual(activeState, recovery.Active!.State);
                Assert.AreEqual(retainedState, recovery.Retained!.State);
                Assert.AreEqual(stagedState, recovery.Staged!.State);
                Assert.AreEqual("verifiedOriginal", recovery.PreChangeBackup!.State);
                var original = activeState == "verifiedOriginal" ? workspace.FilePath : Path.Combine(folder, recovery.Retained.FileName);
                CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(original));
            }
            finally { await StopOwnedChildAsync(reader); }
        }
        CollectionAssert.AreEqual(paths, Directory.GetFiles(folder).Order(StringComparer.Ordinal).ToArray());
        CollectionAssert.AreEqual(hashes, paths.Select(path => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))).ToArray());
        if (File.Exists(workspace.FilePath))
            await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync("no-silent-adoption"));
    }

    [TestMethod]
    [DataRow("before-retention", NendoReplacementResolutionChoice.KeepActive, false)]
    [DataRow("original-retained", NendoReplacementResolutionChoice.UseRetainedOriginal, false)]
    [DataRow("original-retained", NendoReplacementResolutionChoice.UseStagedReplacement, true)]
    [DataRow("replacement-activated", NendoReplacementResolutionChoice.KeepActive, true)]
    public async Task UpgradeResolutionPreservesTheExplicitChoiceAndDoesNotImplicitlyUpgradeTheOriginal(
        string seam, NendoReplacementResolutionChoice choice, bool upgraded)
    {
        await using var workspace = new EngineTestWorkspace();
        await LegacyUpgradeTests.CreateLegacyAsync(workspace, true);
        var originalBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var legacy = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var before = await legacy.GetSnapshotAsync();
        var history = JsonSerializer.Serialize(await legacy.GetHistoryAsync());
        var upgrade = await legacy.PrepareUpgradeAsync("interrupted");
        legacy.UpgradeCheckpoint = reached => { if (reached == seam) throw new IOException("injected interruption"); };
        await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => legacy.UpgradeAsync(upgrade.PlanId));
        await legacy.DisposeAsync();
        var review = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath);
        await NendoWriteCoordinator.ResolveReplacementAsync(review, choice);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(upgraded, inspection.CanAcquireWriteAuthority);
        Assert.AreEqual(upgraded ? NendoFormat.SemanticMinimumHostVersion : NendoFormat.MinimumHostVersion, inspection.Manifest!.MinimumHostVersion);
        await using var reopened = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var after = await reopened.GetSnapshotAsync();
        Assert.AreEqual(history, JsonSerializer.Serialize(await reopened.GetHistoryAsync()));
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
        Assert.AreEqual(before.Manifest.ApplicationId, after.Manifest.ApplicationId);
        Assert.AreEqual(before.Manifest.InstanceId, after.Manifest.InstanceId);
        if (!upgraded) CollectionAssert.AreEqual(originalBytes, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    private static async Task StopOwnedChildAsync(Process process)
    {
        if (process.HasExited) return;
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    }
}
