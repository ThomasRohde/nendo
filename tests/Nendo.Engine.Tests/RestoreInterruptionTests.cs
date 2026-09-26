using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Engine.Tests;

// Loaded only by the explicitly invoked disposable-fixture child harness.
public static class RestoreChildDriver
{
    public static async Task RunAsync(string path, string backup, string checkpoint)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, $"restore-child-{Environment.ProcessId}");
        var plan = await coordinator.PrepareRestoreAsync(backup, "child-restore");
        coordinator.RestoreCheckpoint = reached =>
        {
            if (reached != checkpoint) return;
            Console.WriteLine($"CHECKPOINT {reached}");
            Console.Out.Flush();
            // The parent terminates this exact child after observing this seam.
            // No cleanup/finally runs in that process-loss case.
            Console.ReadLine();
        };
        await coordinator.RestoreAsync(plan.PlanId, false);
        Console.WriteLine("COMPLETED");
    }
}

[TestClass]
public sealed class RestoreInterruptionTests
{
    [TestMethod]
    [DataRow("recovery-record-durable", "verifiedOriginal", "missing", "verifiedReplacement")]
    [DataRow("original-retained", "missing", "verifiedOriginal", "verifiedReplacement")]
    [DataRow("replacement-activated", "verifiedReplacement", "verifiedOriginal", "missing")]
    public async Task ActualProcessTerminationAndFreshProcessInspectionDoNotAdoptAnAmbiguousStage(
        string checkpoint, string activeState, string retainedState, string stagedState)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Backed-up state", "create");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var backup = Path.Combine(folder, "backup.nendo");
        var copyPlan = await source.PrepareBackupAsync(backup, "backup");
        await source.CreateBackupAsync(copyPlan.PlanId);
        await service.SetIdeaTitleAsync("idea-1", 1, "Current state before restore", "edit");
        await source.DisposeAsync();
        var originalBytes = await ObservedFile.ReadAllBytesAsync(workspace.FilePath);
        var backupBytes = await ObservedFile.ReadAllBytesAsync(backup);
        using (var child = StartChild(workspace.FilePath, "Restore", backup, checkpoint))
        {
            try
            {
                var signal = await child.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
                if (signal != $"CHECKPOINT {checkpoint}")
                    Assert.Fail($"Child missed the named seam: {signal}; {await child.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5))}");
                Assert.IsFalse(child.HasExited);
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            finally
            {
                if (!child.HasExited)
                {
                    child.Kill(entireProcessTree: true);
                    await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                }
            }
        }
        await AssertExitedWriterReleasedAsync(workspace.FilePath);
        var paths = Directory.GetFiles(folder).Order(StringComparer.Ordinal).ToArray();
        var hashes = paths.Select(path => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(ObservedFile.ReadAllBytes(path)))).ToArray();
        using (var reader = StartChild(workspace.FilePath, "InspectRecovery"))
        {
            try
            {
                var json = await reader.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
                await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                Assert.AreEqual(0, reader.ExitCode, await reader.StandardError.ReadToEndAsync());
                var recovery = JsonSerializer.Deserialize<NendoReplacementRecovery>(json!);
                Assert.IsNotNull(recovery);
                Assert.IsTrue(recovery.HasPendingReplacement);
                Assert.AreEqual(activeState, recovery.Active!.State);
                Assert.AreEqual(retainedState, recovery.Retained!.State);
                Assert.AreEqual(stagedState, recovery.Staged!.State);
                Assert.AreEqual("verifiedOriginal", recovery.PreChangeBackup!.State);
                var originalPath = activeState == "verifiedOriginal" ? workspace.FilePath : Path.Combine(folder, recovery.Retained.FileName);
                CollectionAssert.AreEqual(originalBytes, await ObservedFile.ReadAllBytesAsync(originalPath));
            }
            finally
            {
                if (!reader.HasExited)
                {
                    reader.Kill(entireProcessTree: true);
                    await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                }
            }
        }
        CollectionAssert.AreEqual(paths, Directory.GetFiles(folder).Order(StringComparer.Ordinal).ToArray());
        CollectionAssert.AreEqual(hashes, paths.Select(path => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(ObservedFile.ReadAllBytes(path)))).ToArray());
        CollectionAssert.AreEqual(backupBytes, await ObservedFile.ReadAllBytesAsync(backup));
        if (File.Exists(workspace.FilePath))
            await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => NendoWriteCoordinator.OpenAsync(workspace.FilePath, "no-silent-resume"));
        // A separate fresh process may resolve only after an explicit choice.
        // Inspection above did not grant permission or adopt the staged file.
        using var resolver = StartChild(workspace.FilePath, "ResolveRecovery", resolutionChoice:
            activeState == "missing" ? "UseStagedReplacement" : "KeepActive");
        try
        {
            var resultJson = await resolver.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
            await resolver.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.AreEqual(0, resolver.ExitCode, await resolver.StandardError.ReadToEndAsync());
            Assert.IsNotNull(JsonSerializer.Deserialize<NendoReplacementResolutionResult>(resultJson!));
        }
        finally
        {
            if (!resolver.HasExited) { resolver.Kill(entireProcessTree: true); await resolver.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
        }
        await using var resolved = await workspace.OpenAsync();
        Assert.AreEqual(NendoSessionHealth.Normal, resolved.Health);
        CollectionAssert.AreEqual(backupBytes, await ObservedFile.ReadAllBytesAsync(backup));
    }

    [TestMethod]
    public async Task ACancelledRestoreSurfacesTheRealFailureAndStillClearsTheReceipt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Backed-up state", "create");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var backup = Path.Combine(folder, "backup.nendo");
        var copyPlan = await coordinator.PrepareBackupAsync(backup, "backup");
        await coordinator.CreateBackupAsync(copyPlan.PlanId);
        await service.SetIdeaTitleAsync("idea-1", 1, "Current state before restore", "edit");

        var plan = await coordinator.PrepareRestoreAsync(backup, "restore");
        var pending = FileReplacementReceipt.PendingPath(workspace.FilePath);

        // At the moment the recovery record is durable, hold the pending marker open
        // without delete sharing — an indexer or sync client would — and cancel. The
        // finally then hits an IOException deleting the marker. That must not replace the
        // real OperationCanceledException the caller is owed, nor skip deleting the receipt.
        FileStream? lockHandle = null;
        using var cancellation = new CancellationTokenSource();
        coordinator.RestoreCheckpoint = point =>
        {
            if (point != "recovery-record-durable") return;
            lockHandle = new FileStream(pending, FileMode.Open, FileAccess.Read, FileShare.Read);
            cancellation.Cancel();
        };
        try
        {
            await Assert.ThrowsExactlyAsync<OperationCanceledException>(
                () => coordinator.RestoreAsync(plan.PlanId, false, cancellation.Token));
        }
        finally
        {
            lockHandle?.Dispose();
            coordinator.RestoreCheckpoint = null;
        }

        Assert.IsEmpty(Directory.GetFiles(folder, "*.receipt.json"),
            "A cleanup IOException masked the real failure and left the receipt behind.");
    }

    internal static async Task AssertExitedWriterReleasedAsync(string path)
    {
        // Process exit and observing delete-on-close are separate observations.
        // Allow a bounded release interval, but never delete/repair the marker or
        // start the fresh inspection while it still exists. Persistent leaks fail.
        //
        // The bound is generous rather than tight on purpose: what is under test is
        // that an exited child leaves nothing behind, not how fast Windows gets round
        // to it. A busy machine running the whole suite at once took longer than the
        // original two seconds, which said nothing about the behaviour being checked.
        var elapsed = Stopwatch.StartNew();
        while (File.Exists(path + ".write-owner") && elapsed.Elapsed < TimeSpan.FromSeconds(30))
            await Task.Delay(25);
        Assert.IsFalse(File.Exists(path + ".write-owner"), "The exited child's writer marker was still there after thirty seconds.");
    }

    internal static Process StartChild(string path, string mode, string? backup = null, string? checkpoint = null, string? resolutionChoice = null)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Nendo.slnx"))) root = root.Parent;
        Assert.IsNotNull(root);
        var start = new ProcessStartInfo("pwsh")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File", Path.Combine(root.FullName, "tools", "Invoke-StorageChild.ps1"),
                     "-EngineDirectory", Path.GetDirectoryName(typeof(NendoWriteCoordinator).Assembly.Location)!, "-FilePath", path, "-Mode", mode })
            start.ArgumentList.Add(argument);
        if (backup is not null) { start.ArgumentList.Add("-BackupPath"); start.ArgumentList.Add(backup); }
        if (checkpoint is not null) { start.ArgumentList.Add("-Checkpoint"); start.ArgumentList.Add(checkpoint); }
        if (resolutionChoice is not null) { start.ArgumentList.Add("-ResolutionChoice"); start.ArgumentList.Add(resolutionChoice); }
        return Process.Start(start) ?? throw new AssertFailedException("The owned storage child did not start.");
    }
}
