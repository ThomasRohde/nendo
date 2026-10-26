namespace Nendo.Engine.Tests;

/// <summary>
/// The browser host's file primitives (ADR-0036), run on Windows in one async flow: the lifecycle
/// paths that read identity, guard an instance or move a file must take the page's own primitives
/// there, and still create, copy, back up and reopen a file.
/// </summary>
[TestClass]
public sealed class BrowserFileSystemTests
{
    [TestMethod]
    public async Task APageNamesItsFilesByItsOwnIndexAndKeepsItAcrossAMove()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        workspace.Forget(created);
        await created.DisposeAsync();
        using var _ = BrowserFileSystem.Use();
        LocalFileIdentity before;
        using (var file = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            before = LocalFileIdentity.Read(file);
        StringAssert.StartsWith(before.Key, "browser-file-v1:");

        var moved = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "moved.nendo");
        using (var move = VerifiedFileMove.Acquire(workspace.FilePath, before, Digest(workspace.FilePath)))
            move.MoveTo(moved);
        using (var file = new FileStream(moved, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            Assert.AreEqual(before, LocalFileIdentity.Read(file), "A moved file keeps its identity.");
        Assert.IsFalse(File.Exists(workspace.FilePath));
    }

    [TestMethod]
    public void APageHoldsAnInstanceOnceUntilItIsReleased()
    {
        using var _ = BrowserFileSystem.Use();
        var instanceId = $"instance-{Guid.NewGuid():N}";
        using (InstanceOwnershipLease.Acquire(instanceId))
        {
            var refused = Assert.ThrowsExactly<NendoWriteOwnershipException>(() => InstanceOwnershipLease.Acquire(instanceId));
            Assert.AreEqual("instance-in-use", refused.Code);
        }
        using (InstanceOwnershipLease.Acquire(instanceId)) { }
    }

    [TestMethod]
    [DataRow(NendoIdentityCopyKind.Duplicate)]
    [DataRow(NendoIdentityCopyKind.Fork)]
    public async Task APageCreatesCopiesAndReopensAFileThroughItsOwnPrimitives(NendoIdentityCopyKind kind)
    {
        using var _ = BrowserFileSystem.Use();
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var original = await source.GetSnapshotAsync();
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "copy.nendo");

        var plan = await source.PrepareIdentityCopyAsync(kind, destination, "copy");
        var result = await source.CreateIdentityCopyAsync(plan.PlanId);
        Assert.IsFalse(result.IsIdempotentReplay);

        await using var copy = await NendoWriteCoordinator.OpenAsync(destination, "copy-test");
        var copied = await copy.GetSnapshotAsync();
        Assert.AreNotEqual(original.Manifest.InstanceId, copied.Manifest.InstanceId);
        Assert.AreEqual(kind == NendoIdentityCopyKind.Duplicate, copied.Manifest.ApplicationId == original.Manifest.ApplicationId);
    }

    private static string Digest(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return VerifiedFileMove.Digest(file);
    }
}
