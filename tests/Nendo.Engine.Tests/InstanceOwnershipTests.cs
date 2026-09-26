using System.Diagnostics;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class InstanceOwnershipTests
{
    [TestMethod]
    public async Task RawCopyCannotClaimSecondWritableInstanceOrCleanItsOwnersProposal()
    {
        await using var workspace = new EngineTestWorkspace();
        var first = await workspace.CreateAsync();
        var service = new NendoApplicationService(first);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        var proposalDirectory = Path.Combine(first.ProposalRoot, proposal.ProposalId);
        var copyPath = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "raw-copy.nendo");
        var backup = await first.PrepareBackupAsync(copyPath, "raw-copy");
        await first.CreateBackupAsync(backup.PlanId);
        var before = await ObservedFile.ReadAllBytesAsync(copyPath);
        var error = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => NendoWriteCoordinator.OpenAsync(copyPath, "second"));
        Assert.AreEqual("instance-in-use", error.Code);
        Assert.IsFalse(File.Exists(copyPath + ".write-owner"));
        Assert.IsTrue(Directory.Exists(proposalDirectory));
        Assert.AreEqual(NendoProposalState.Previewable, (await service.GetProposalAsync(proposal.ProposalId)).State);
        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(copyPath))
            Assert.IsFalse(reader.Capabilities.Mutate);
        CollectionAssert.AreEqual(before, await ObservedFile.ReadAllBytesAsync(copyPath));
        await Task.Run(async () => await first.DisposeAsync());
        workspace.Forget(first);
        await using var afterClose = await NendoWriteCoordinator.OpenAsync(copyPath, "after-close");
        Assert.IsTrue(afterClose.Capabilities.Mutate);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ActualChildCoordinatorExcludesRawCopyAndReleasesOnCloseOrTermination(bool abrupt)
    {
        await using var workspace = new EngineTestWorkspace();
        var initial = await workspace.CreateAsync();
        await initial.DisposeAsync();
        workspace.Forget(initial);
        var copyPath = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "raw-copy.nendo");
        File.Copy(workspace.FilePath, copyPath);
        var sourceBytes = await ObservedFile.ReadAllBytesAsync(workspace.FilePath);
        using var child = StartChild(workspace.FilePath);
        try
        {
            var ready = await child.StandardOutput.ReadLineAsync().WithinAsync(TimeSpan.FromSeconds(20), "the child's first line");
            if (ready != "OWNED")
                Assert.Fail($"Child did not open the fixture: {ready}; {await child.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5))}");
            Assert.IsFalse(child.HasExited);
            var error = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => NendoWriteCoordinator.OpenAsync(copyPath, "parent"));
            Assert.AreEqual("instance-in-use", error.Code);
            Assert.IsFalse(File.Exists(copyPath + ".write-owner"));
            if (abrupt) child.Kill(entireProcessTree: true);
            else
            {
                await child.StandardInput.WriteLineAsync("close");
                await child.StandardInput.FlushAsync();
            }
            await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            if (!abrupt) Assert.AreEqual(0, child.ExitCode);
            await RestoreInterruptionTests.AssertExitedWriterReleasedAsync(workspace.FilePath);
            CollectionAssert.AreEqual(sourceBytes, await ObservedFile.ReadAllBytesAsync(workspace.FilePath));
            await using var reopened = await NendoWriteCoordinator.OpenAsync(copyPath, "after-child-exit");
            Assert.IsTrue(reopened.Capabilities.Mutate);
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

    [TestMethod]
    public async Task ObservedOpenRejectsAReplacedOrChangedFileBeforeCreatingWriterSidecars()
    {
        await using var workspace = new EngineTestWorkspace();
        var initial = await workspace.CreateAsync();
        await initial.DisposeAsync();
        workspace.Forget(initial);
        var observed = await NendoWriteCoordinator.ObserveAsync(workspace.FilePath);
        Assert.IsNotNull(observed.PhysicalFileKey);
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "retained.nendo");
        File.Move(workspace.FilePath, retained);
        File.Copy(retained, workspace.FilePath);
        var failure = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => NendoWriteCoordinator.OpenObservedAsync(workspace.FilePath, "stale", observed));
        Assert.AreEqual("file-changed-before-open", failure.Code);
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        await using var fresh = await NendoWriteCoordinator.OpenObservedAsync(workspace.FilePath, "fresh", await NendoWriteCoordinator.ObserveAsync(workspace.FilePath));
        Assert.IsTrue(fresh.Capabilities.Mutate);
    }

    private static Process StartChild(string path)
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
                     "-EngineDirectory", Path.GetDirectoryName(typeof(NendoWriteCoordinator).Assembly.Location)!, "-FilePath", path })
            start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new AssertFailedException("The owned storage child did not start.");
    }
}
