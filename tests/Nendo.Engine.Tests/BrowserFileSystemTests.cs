using System.Diagnostics;

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

    /// <summary>
    /// A page's file is in memory only this Engine writes, so opening it hashes its content once,
    /// in the inspection, where a desktop hashes it again under the write lease. Each pass over
    /// every row took seconds in the page, whose runtime is the slowest place the Engine runs.
    /// </summary>
    [TestMethod]
    public async Task APageHashesItsFileOnceWhenItOpensItWhereADesktopHashesItTwice()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        workspace.Forget(created);
        await created.DisposeAsync();

        Assert.AreEqual(2, await CountContentDigestsAsync(workspace.FilePath, inPage: false), "A desktop open did not hash the file again under its lease.");
        Assert.AreEqual(1, await CountContentDigestsAsync(workspace.FilePath, inPage: true), "A page hashed its file more than once to open it.");
    }

    private static readonly ActivitySource Scope = new("Nendo.Engine.Tests.BrowserFileSystem");

    /// <summary>Content digests computed to observe and open the file, counted under this test's own parent activity.</summary>
    private static async Task<int> CountContentDigestsAsync(string path, bool inPage)
    {
        using var page = inPage ? BrowserFileSystem.Use() : null;
        var count = 0;
        string? root = null;
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name is "Nendo.Engine.Startup" or "Nendo.Engine.Tests.BrowserFileSystem",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStarted = activity => { if (activity.OperationName == "engine.content-digest" && root is not null && activity.RootId == root) Interlocked.Increment(ref count); },
        };
        ActivitySource.AddActivityListener(listener);
        using (var scope = Scope.StartActivity("count-digests")!)
        {
            root = scope.RootId;
            var observed = await NendoWriteCoordinator.ObserveAsync(path);
            await using var opened = await NendoWriteCoordinator.OpenObservedAsync(path, "digest-count", observed);
            Assert.IsTrue(opened.Capabilities.Mutate);
        }
        return count;
    }

    private static string Digest(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        return VerifiedFileMove.Digest(file);
    }
}
