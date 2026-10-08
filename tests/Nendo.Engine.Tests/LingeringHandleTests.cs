namespace Nendo.Engine.Tests;

/// <summary>
/// W-198 (F-134's second half): a reopen that meets a handle still on the file waits it out and
/// names the holder, and a holder that never lets go still fails. Reproduced deterministically by
/// holding the file with a handle that does not share reading, as a dying child's or a scanner's
/// can, rather than by racing a real child.
/// </summary>
[TestClass]
public sealed class LingeringHandleTests
{
    [TestMethod]
    public async Task AReopenWaitsOutAHandleThatLetsGoAndNamesItsHolder()
    {
        await using var workspace = new EngineTestWorkspace();
        await ReleaseAsync(workspace, await workspace.CreateAsync());
        var lines = new List<string>();
        var holder = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.None);
        var release = Task.Run(async () =>
        {
            await Task.Delay(600);
            await holder.DisposeAsync();
        });

        var reopened = await LingeringHandle.OpenAsync(workspace.FilePath,
            () => NendoWriteCoordinator.OpenAsync(workspace.FilePath, "after-holder"), log: line => { lock (lines) lines.Add(line); });
        await using (reopened)
        {
            await release;
            Assert.AreEqual(NendoSessionHealth.Normal, reopened.Health);
        }
        Assert.IsNotEmpty(lines, "The open was never refused, so this guard did not meet a lingering handle.");
        StringAssert.Contains(lines[0], "held by", "The log does not say who held the file.");
        StringAssert.Contains(lines[0], "testhost", "Restart Manager did not name the process holding the file.");
    }

    [TestMethod]
    public async Task AHolderThatNeverLetsGoStillFails()
    {
        await using var workspace = new EngineTestWorkspace();
        await ReleaseAsync(workspace, await workspace.CreateAsync());
        await using var holder = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.None);
        var refused = await Assert.ThrowsExactlyAsync<IOException>(() => LingeringHandle.OpenAsync(workspace.FilePath,
            () => NendoWriteCoordinator.OpenAsync(workspace.FilePath, "never"), TimeSpan.FromSeconds(1), _ => { }));
        Assert.IsTrue(LingeringHandle.IsSharingViolation(refused), refused.Message);
    }

    [TestMethod]
    public async Task AnyOtherRefusalIsTheAnswerAtOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        await ReleaseAsync(workspace, await workspace.CreateAsync());
        var started = System.Diagnostics.Stopwatch.StartNew();
        var lines = new List<string>();
        await Assert.ThrowsExactlyAsync<FileNotFoundException>(() => LingeringHandle.OpenAsync(workspace.FilePath + ".missing.nendo",
            () => NendoWriteCoordinator.OpenAsync(workspace.FilePath + ".missing.nendo", "missing"), log: lines.Add));
        Assert.IsEmpty(lines, "A refusal that is not another handle was retried.");
        Assert.IsLessThan(TimeSpan.FromSeconds(5), started.Elapsed);
    }

    private static async Task ReleaseAsync(EngineTestWorkspace workspace, NendoWriteCoordinator coordinator)
    {
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
    }
}
