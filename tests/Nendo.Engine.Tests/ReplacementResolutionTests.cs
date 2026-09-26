using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ReplacementResolutionTests
{
    [TestMethod]
    [DataRow("before-retention", NendoReplacementResolutionChoice.KeepActive, "Current")]
    [DataRow("replacement-activated", NendoReplacementResolutionChoice.KeepActive, "Backup")]
    [DataRow("original-retained", NendoReplacementResolutionChoice.UseRetainedOriginal, "Current")]
    [DataRow("original-retained", NendoReplacementResolutionChoice.UseStagedReplacement, "Backup")]
    public async Task ExplicitResolutionUsesOnlyVerifiedFilesAndPreservesUnusedRecoveryMaterial(
        string seam, NendoReplacementResolutionChoice choice, string expectedTitle)
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, seam);
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var selected = review.Plan.Options.Single(option => option.Choice == choice);
        var selectedPath = Path.Combine(folder, selected.FileName);
        var before = Directory.GetFiles(folder).ToDictionary(path => path, ObservedFile.ReadAllBytes);
        Assert.DoesNotContain(folder, JsonSerializer.Serialize(review));
        var result = await NendoWriteCoordinator.ResolveReplacementAsync(review, choice);
        Assert.IsNotNull(result.OpenObservation);
        Assert.IsFalse(result.IsIdempotentReplay);
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        CollectionAssert.AreEqual(before[selectedPath], await ObservedFile.ReadAllBytesAsync(workspace.FilePath));
        foreach (var (path, bytes) in before)
        {
            if (path == FileReplacementReceipt.PendingPath(workspace.FilePath))
                CollectionAssert.AreEqual(bytes, await ObservedFile.ReadAllBytesAsync(Path.Combine(folder, result.AcknowledgedReceiptFileName)));
            else if (path != selectedPath)
                CollectionAssert.AreEqual(bytes, await ObservedFile.ReadAllBytesAsync(path));
        }
        var replay = await NendoWriteCoordinator.ResolveReplacementAsync(review, choice);
        Assert.IsTrue(replay.IsIdempotentReplay);
        await using var opened = await workspace.OpenAsync();
        var snapshot = await opened.GetSnapshotAsync();
        Assert.AreEqual(selected.Manifest, snapshot.Manifest);
        Assert.AreEqual(expectedTitle, snapshot.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement);
    }

    [TestMethod]
    public async Task ChangedOrUnrecognisedFilesOfferNoResolutionAndAreNotModified()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "before-retention");
        await File.WriteAllTextAsync(workspace.FilePath, "unrelated replacement");
        var blocked = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath);
        Assert.HasCount(0, blocked.Plan.Options);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => NendoWriteCoordinator.ResolveReplacementAsync(blocked, NendoReplacementResolutionChoice.UseStagedReplacement));
        Assert.AreEqual("unrelated replacement", await File.ReadAllTextAsync(workspace.FilePath));
        Assert.IsTrue(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        await File.WriteAllTextAsync(FileReplacementReceipt.PendingPath(workspace.FilePath), "{\"Version\":1,\"TargetFileName\":\"../other.nendo\"}");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath));
    }

    [TestMethod]
    [DataRow("candidate")]
    [DataRow("marker")]
    [DataRow("archive")]
    [DataRow("target")]
    [DataRow("sidecar")]
    public async Task ChangedReviewAndRacingDestinationsFailClosed(string changed)
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var candidate = Path.Combine(folder, review.Plan.Options.Single(option => option.Choice == NendoReplacementResolutionChoice.UseStagedReplacement).FileName);
        var marker = FileReplacementReceipt.PendingPath(workspace.FilePath);
        var archive = workspace.FilePath + $".recovery-ack-{review.Plan.PlanId}.json";
        var path = changed switch { "candidate" => candidate, "marker" => marker, "archive" => archive, "target" => workspace.FilePath, _ => workspace.FilePath + "-journal" };
        await File.WriteAllTextAsync(path, "unrelated bytes must survive");
        try
        {
            await NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement);
            Assert.Fail("A stale review unexpectedly resolved.");
        }
        catch (Exception exception) when (exception is NendoPreconditionException or IOException) { }
        Assert.AreEqual("unrelated bytes must survive", await File.ReadAllTextAsync(path));
        Assert.IsTrue(File.Exists(marker));
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
    }

    [TestMethod]
    public async Task IdenticalBytesAtAReplacedPhysicalFileAndRetargetedReceiptNamesDoNotAuthorizeResolution()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "before-retention");
        var bytes = await ObservedFile.ReadAllBytesAsync(workspace.FilePath);
        File.Move(workspace.FilePath, workspace.FilePath + ".preserved");
        await File.WriteAllBytesAsync(workspace.FilePath, bytes);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.KeepActive));
        CollectionAssert.AreEqual(bytes, await ObservedFile.ReadAllBytesAsync(workspace.FilePath));
        var marker = FileReplacementReceipt.PendingPath(workspace.FilePath);
        var receipt = JsonSerializer.Deserialize<FileReplacementReceipt>(await File.ReadAllTextAsync(marker))!;
        await File.WriteAllTextAsync(marker, JsonSerializer.Serialize(receipt with { StagedFileName = "unrelated.nendo" }));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath));
        Assert.IsNull((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).OperationId);
    }

    [TestMethod]
    public async Task CancellationBeforeActivationPreservesEveryByteAndRequestRemainsRetryable()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var before = Directory.GetFiles(folder).ToDictionary(path => path, ObservedFile.ReadAllBytes);
        using var cancellation = new CancellationTokenSource();
        review.ResolutionCheckpoint = _ => cancellation.Cancel();
        await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseRetainedOriginal, cancellation.Token));
        CollectionAssert.AreEquivalent(before.Keys.ToArray(), Directory.GetFiles(folder));
        foreach (var (path, bytes) in before) CollectionAssert.AreEqual(bytes, await ObservedFile.ReadAllBytesAsync(path));
        review.ResolutionCheckpoint = null;
        await NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseRetainedOriginal);
    }

    [TestMethod]
    public async Task FailureAfterActivationLeavesMarkerAndRequiresFreshExplicitReview()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        review.ResolutionCheckpoint = seam => { if (seam == "resolution-file-activated") throw new IOException("injected interruption"); };
        await Assert.ThrowsExactlyAsync<IOException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement));
        Assert.IsTrue(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        var refreshed = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath);
        Assert.HasCount(1, refreshed.Plan.Options);
        Assert.AreEqual(NendoReplacementResolutionChoice.KeepActive, refreshed.Plan.Options.Single().Choice);
        await NendoWriteCoordinator.ResolveReplacementAsync(refreshed, NendoReplacementResolutionChoice.KeepActive);
        await using var opened = await workspace.OpenAsync();
        Assert.AreEqual(NendoSessionHealth.Normal, opened.Health);
    }

    [TestMethod]
    public async Task LostAcknowledgementCanBeRetriedButChangedCommittedFileCannotBeRecreated()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        review.ResolutionCheckpoint = seam => { if (seam == "resolution-acknowledged") throw new IOException("lost result"); };
        await Assert.ThrowsExactlyAsync<IOException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement));
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        Assert.IsTrue((await NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement)).IsIdempotentReplay);
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseRetainedOriginal));
        await File.WriteAllTextAsync(workspace.FilePath, "unrelated committed replacement");
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement));
        Assert.AreEqual("unrelated committed replacement", await File.ReadAllTextAsync(workspace.FilePath));
    }

    [TestMethod]
    [DataRow("target")]
    [DataRow("archive")]
    public async Task DestinationRaceAtCommitPreservesTheUnexpectedFileAndPendingMarker(string destination)
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        var path = destination == "target" ? workspace.FilePath : workspace.FilePath + $".recovery-ack-{review.Plan.PlanId}.json";
        review.ResolutionCheckpoint = seam => { if (seam == "before-resolution") File.WriteAllText(path, "racing file"); };
        await Assert.ThrowsExactlyAsync<IOException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.UseStagedReplacement));
        Assert.AreEqual("racing file", await File.ReadAllTextAsync(path));
        Assert.IsTrue(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
    }

    [TestMethod]
    [DataRow("resolution-file-activated", true)]
    [DataRow("resolution-acknowledged", false)]
    public async Task ActualProcessLossDuringResolutionLeavesVerifiedEvidenceForFreshInspection(string seam, bool pending)
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "original-retained");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var selectedPath = Path.Combine(folder, review.Plan.Options.Single(option => option.Choice == NendoReplacementResolutionChoice.UseStagedReplacement).FileName);
        var selectedBytes = await ObservedFile.ReadAllBytesAsync(selectedPath);
        var retainedPath = Path.Combine(folder, review.Plan.Recovery.Retained!.FileName);
        var originalBytes = await ObservedFile.ReadAllBytesAsync(retainedPath);
        using (var child = RestoreInterruptionTests.StartChild(workspace.FilePath, "ResolveRecovery", checkpoint: seam,
                   resolutionChoice: "UseStagedReplacement"))
        {
            try
            {
                Assert.AreEqual($"CHECKPOINT {seam}", await child.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line"));
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            finally
            {
                if (!child.HasExited) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
            }
        }
        await RestoreInterruptionTests.AssertExitedWriterReleasedAsync(workspace.FilePath);
        CollectionAssert.AreEqual(selectedBytes, await ObservedFile.ReadAllBytesAsync(workspace.FilePath));
        CollectionAssert.AreEqual(originalBytes, await ObservedFile.ReadAllBytesAsync(retainedPath));
        Assert.AreEqual(pending, (await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement);
        if (pending)
        {
            await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
            var fresh = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath);
            await NendoWriteCoordinator.ResolveReplacementAsync(fresh, NendoReplacementResolutionChoice.KeepActive);
        }
        await using var reopened = await workspace.OpenAsync();
        Assert.AreEqual(NendoSessionHealth.Normal, reopened.Health);
    }

    [TestMethod]
    public async Task SameInstanceWriterExcludesRecoveryAndConcurrentExactRequestsArchiveOnlyOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var review = await InterruptAsync(workspace, "before-retention");
        var otherPath = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        await using (var writer = await NendoWriteCoordinator.OpenAsync(otherPath, "other-writer"))
            await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.KeepActive));
        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => NendoWriteCoordinator.ResolveReplacementAsync(review, NendoReplacementResolutionChoice.KeepActive)));
        Assert.AreEqual(1, results.Count(result => !result.IsIdempotentReplay));
        Assert.AreEqual(3, results.Count(result => result.IsIdempotentReplay));
    }

    private static async Task<NendoReplacementRecoveryReview> InterruptAsync(EngineTestWorkspace workspace, string seam)
    {
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Backup", "create");
        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        await source.CreateBackupAsync((await source.PrepareBackupAsync(backup, "backup")).PlanId);
        await service.SetIdeaTitleAsync("idea-1", 1, "Current", "edit");
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        source.RestoreCheckpoint = reached => { if (reached == seam) throw new IOException("injected interruption"); };
        await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        await source.DisposeAsync();
        return await NendoWriteCoordinator.PrepareReplacementResolutionAsync(workspace.FilePath);
    }
}

// Loaded only by the owned disposable-fixture child, not a production API.
public static class ResolutionChildDriver
{
    public static async Task RunAsync(string path, string choice, string checkpoint)
    {
        var review = await NendoWriteCoordinator.PrepareReplacementResolutionAsync(path);
        review.ResolutionCheckpoint = reached =>
        {
            if (reached != checkpoint) return;
            Console.WriteLine($"CHECKPOINT {reached}");
            Console.Out.Flush();
            Console.ReadLine();
        };
        await NendoWriteCoordinator.ResolveReplacementAsync(review, Enum.Parse<NendoReplacementResolutionChoice>(choice));
        Console.WriteLine("COMPLETED");
    }
}
