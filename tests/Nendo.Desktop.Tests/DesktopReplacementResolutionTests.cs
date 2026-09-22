using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopReplacementResolutionTests
{
    [TestMethod]
    [DataRow("before-retention", "Current")]
    [DataRow("replacement-activated", "Backup")]
    public async Task RecoveryReviewPreservesReadOnlySessionUntilConfirmedAndReopensWithFreshAuthority(string seam, string title)
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, seam);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var before = await session.OpenReadOnlyAsync(workspace.FilePath);
        var bytes = await ReadBytesAsync(workspace.FilePath);
        var review = await session.PrepareReplacementResolutionAsync();
        Assert.HasCount(1, review.Plan.Options);
        Assert.AreEqual(before.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.KeepActive, false));
        CollectionAssert.AreEqual(bytes, await ReadBytesAsync(workspace.FilePath));
        Assert.IsTrue(File.Exists(Receipt(workspace)));
        var result = await session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.KeepActive, true);
        Assert.IsTrue(result.Session.Capabilities.Mutate, result.Notice);
        Assert.AreEqual(title, result.Session.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreNotEqual(before.FileSessionId, result.Session.FileSessionId);
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        Assert.IsFalse(File.Exists(Receipt(workspace)));
        CollectionAssert.AreEqual(bytes, await ReadBytesAsync(workspace.FilePath));
        var serialized = JsonSerializer.Serialize(new { review, result });
        Assert.DoesNotContain("OpenObservation", serialized);
        Assert.DoesNotContain("PhysicalFileKey", serialized);
        Assert.DoesNotContain(JsonEncodedText.Encode(Path.GetDirectoryName(workspace.FilePath)!).ToString(), serialized);
        using (session.BindFileRequest(before.FileSessionId!))
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.GetViewAsync());
    }

    [TestMethod]
    [DataRow(NendoReplacementResolutionChoice.UseRetainedOriginal, "Current")]
    [DataRow(NendoReplacementResolutionChoice.UseStagedReplacement, "Backup")]
    public async Task MissingTargetCanBeRecoveredFromItsNativeSelectedReceipt(NendoReplacementResolutionChoice choice, string title)
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var before = await session.GetViewAsync();
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        Assert.HasCount(2, review.Plan.Options);
        Assert.IsFalse(File.Exists(workspace.FilePath));
        Assert.IsFalse((await session.GetViewAsync()).HasFile);
        Assert.AreEqual(before.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        var result = await session.ResolveReplacementAsync(review.ReviewId, choice, true);
        Assert.IsTrue(result.Session.Capabilities.Mutate, result.Notice);
        Assert.AreEqual(title, result.Session.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.IsTrue(File.Exists(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, result.Resolution.AcknowledgedReceiptFileName)));
    }

    [TestMethod]
    public async Task ReviewDoesNotStopAnotherOpenFileOrAgentButConfirmationClosesThem()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        var other = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "other.nendo");
        var discovery = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery");
        await using var session = new DesktopSessionController(new(discovery), workspace.FileHistoryRoot);
        var original = await session.CreateAsync(other);
        var proposal = await session.PrepareIdeaGardenProposalAsync();
        await session.SetAgentModeAsync("shapeApp");
        var endpoint = Directory.GetFiles(discovery, "*.json").Single();
        var otherBytes = await ReadBytesAsync(other);
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        Assert.IsTrue(review.ClosesCurrentFile);
        Assert.IsTrue(File.Exists(endpoint));
        Assert.AreEqual(proposal.ProposalId, (await session.GetProposalAsync(proposal.ProposalId)).ProposalId);
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true, canceled.Token));
        Assert.AreEqual(original.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        Assert.IsTrue(File.Exists(endpoint));
        var resolved = await session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true);
        Assert.IsFalse(File.Exists(endpoint));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.GetProposalAsync(proposal.ProposalId));
        CollectionAssert.AreEqual(otherBytes, await File.ReadAllBytesAsync(other));
        Assert.AreNotEqual(original.FileSessionId, resolved.Session.FileSessionId);
    }

    [TestMethod]
    public async Task ClosedReviewForgedChoiceAndWrongReceiptNamesCannotResolveAFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.KeepActive, true));
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareReplacementResolutionAsync(workspace.FilePath + ".receipt.json"));
        await session.CloseAsync();
        var failure = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true));
        Assert.AreEqual("recovery-review-stale", failure.Code);
        Assert.IsFalse(File.Exists(workspace.FilePath));
        Assert.IsTrue(File.Exists(Receipt(workspace)));
    }

    [TestMethod]
    public async Task RecoveryLocationRequiresNativeAcknowledgementBeforeClosingOrChangingAnything()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot,
            locationPolicy: new([Path.GetDirectoryName(workspace.FilePath)!]));
        var before = await session.GetViewAsync();
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        Assert.IsNotNull(review.LocationWarning);
        var failure = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true));
        Assert.AreEqual("unsupported-sync-location", failure.Code);
        Assert.AreEqual(before.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        Assert.IsFalse(File.Exists(workspace.FilePath));
        using (session.BindFileRequest(before.FileSessionId!))
        {
            await session.AcknowledgeRecoveryLocationAsync(review.ReviewId);
            var result = await session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true);
            Assert.IsTrue(result.Session.Capabilities.Mutate, result.Notice);
            Assert.IsNotNull(result.Session.LocationWarning);
        }
    }

    [TestMethod]
    public async Task KnownOriginalIsNotPromotedAwayWhenResolvingACopy()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var original = Path.Combine(folder, "known-original.nendo");
        var recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath);
        File.Copy(Path.Combine(folder, recovery.Retained!.FileName), original);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(original);
        await session.CloseAsync();
        var before = await File.ReadAllBytesAsync(original);
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        var result = await session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true);
        Assert.AreEqual("readOnly", result.Session.Health);
        Assert.IsFalse(result.Session.Capabilities.Mutate);
        Assert.IsNotNull(result.Notice);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(original));
        Assert.IsTrue((await session.GetRecentFilesAsync()).Files.Any(file => file.FileName == "known-original.nendo"));
    }

    [TestMethod]
    public async Task ReopenRaceReportsCommittedRecoveryWithoutOverwritingOrAdoptingUnexpectedBytes()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedInterruptedAsync(workspace, "original-retained");
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var review = await session.PrepareReplacementResolutionAsync(Receipt(workspace));
        session.BeforeReplacementReopenForTest = () =>
        {
            File.Move(workspace.FilePath, workspace.FilePath + ".preserved");
            File.WriteAllText(workspace.FilePath, "unrelated racing file");
        };
        var result = await session.ResolveReplacementAsync(review.ReviewId, NendoReplacementResolutionChoice.UseStagedReplacement, true);
        Assert.IsFalse(result.Session.Capabilities.Mutate);
        Assert.IsNotNull(result.Notice);
        Assert.IsFalse(File.Exists(Receipt(workspace)));
        Assert.IsTrue(File.Exists(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, result.Resolution.AcknowledgedReceiptFileName)));
        Assert.AreEqual("unrelated racing file", await File.ReadAllTextAsync(workspace.FilePath));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
    }

    private static string Receipt(DesktopTestWorkspace workspace) => workspace.FilePath + ".recovery.json";

    private static async Task<byte[]> ReadBytesAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var bytes = new MemoryStream();
        await stream.CopyToAsync(bytes);
        return bytes.ToArray();
    }

    private static async Task SeedInterruptedAsync(DesktopTestWorkspace workspace, string seam)
    {
        await using (var seed = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, locationPolicy: new([])))
        {
            await seed.CreateAsync(workspace.FilePath);
            await seed.CreateIdeaSchemaAsync("schema");
            await seed.CreateIdeaRecordAsync("idea-1", "Backup", "create");
        }
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "resolution-fixture");
        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        await coordinator.CreateBackupAsync((await coordinator.PrepareBackupAsync(backup, "backup")).PlanId);
        await new NendoApplicationService(coordinator).SetIdeaTitleAsync("idea-1", 1, "Current", "edit");
        var restore = await coordinator.PrepareRestoreAsync(backup, "restore");
        // Existing internal Engine fault seam; no production/UI injection API.
        typeof(NendoWriteCoordinator).GetProperty("RestoreCheckpoint", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(coordinator, (Action<string>)(reached => { if (reached == seam) throw new IOException("owned fixture interruption"); }));
        await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => coordinator.RestoreAsync(restore.PlanId, false));
    }
}
