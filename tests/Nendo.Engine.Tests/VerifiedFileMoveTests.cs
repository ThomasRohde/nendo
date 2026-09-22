namespace Nendo.Engine.Tests;

[TestClass]
public sealed class VerifiedFileMoveTests
{
    [TestMethod]
    public async Task VerifiedHandleRenamePreservesTheExactFileAndExcludesWritesAndPathReplacement()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "retained.nendo");
        var evidence = Observe(workspace.FilePath);
        using (var move = VerifiedFileMove.Acquire(workspace.FilePath, evidence.Identity, evidence.Hash))
        {
            Assert.ThrowsExactly<IOException>(() => File.Delete(workspace.FilePath));
            Assert.ThrowsExactly<IOException>(() => File.WriteAllBytes(workspace.FilePath, []));
            move.MoveTo(retained);
            Assert.IsFalse(File.Exists(workspace.FilePath));
            Assert.ThrowsExactly<IOException>(() => File.WriteAllBytes(retained, []));
        }
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(retained));
        Assert.AreEqual(evidence.Identity, Observe(retained).Identity);
        Assert.IsTrue((await NendoWriteCoordinator.InspectAsync(retained)).CanAcquireWriteAuthority);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ExistingAndRacingDestinationIsNeverOverwritten(bool occupiedBeforeAcquire)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "unrelated.nendo");
        var observed = Observe(workspace.FilePath);
        if (occupiedBeforeAcquire) await File.WriteAllTextAsync(destination, "unrelated");
        using (var move = VerifiedFileMove.Acquire(workspace.FilePath, observed.Identity, observed.Hash))
        {
            if (!occupiedBeforeAcquire) await File.WriteAllTextAsync(destination, "unrelated");
            Assert.ThrowsExactly<IOException>(() => move.MoveTo(destination));
        }
        Assert.AreEqual("unrelated", await File.ReadAllTextAsync(destination));
        Assert.AreEqual(observed, Observe(workspace.FilePath));
    }

    [TestMethod]
    public async Task ChangedBytesOrMatchingBytesAtAReplacedPathCannotBeMoved()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        var before = Observe(workspace.FilePath);
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "original.nendo");
        File.Move(workspace.FilePath, retained);
        File.Copy(retained, workspace.FilePath);
        var replaced = Assert.ThrowsExactly<NendoPreconditionException>(() =>
            VerifiedFileMove.Acquire(workspace.FilePath, before.Identity, before.Hash));
        Assert.AreEqual("replacement-target-changed", replaced.Code);
        var replacement = Observe(workspace.FilePath);
        await File.WriteAllTextAsync(workspace.FilePath, "changed");
        var changed = Assert.ThrowsExactly<NendoPreconditionException>(() =>
            VerifiedFileMove.Acquire(workspace.FilePath, replacement.Identity, replacement.Hash));
        Assert.AreEqual("replacement-target-changed", changed.Code);
        Assert.AreEqual("changed", await File.ReadAllTextAsync(workspace.FilePath));
        Assert.IsTrue(File.Exists(retained));
    }

    private static (LocalFileIdentity Identity, string Hash) Observe(string path)
    {
        using var pin = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return (LocalFileIdentity.Read(pin), VerifiedFileMove.Digest(pin));
    }
}
