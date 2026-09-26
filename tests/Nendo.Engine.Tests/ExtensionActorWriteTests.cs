using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// A write made in a custom view's package's name (origin <c>extension:&lt;package&gt;</c>) is
/// admitted by the host before it reaches the Engine, and the package can be removed in
/// between by a writer that host does not serialize with. The Engine refuses it inside the
/// write transaction that would commit it (R-014).
/// </summary>
[TestClass]
public sealed class ExtensionActorWriteTests
{
    private const string PackageId = "org.example.board";
    private const string Actor = "extension:" + PackageId;

    [TestMethod]
    public async Task AWriteInTheNameOfARemovedPackageIsRefusedAndACommittedOneStillReplays()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("actor-tests", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true)]));
        await coordinator.ApplyAsync(new NendoMutation("actor-tests", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", PackageId, "Board", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("index", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>"))]));

        var first = await Create(service, "n1", "first", Actor);

        await coordinator.ApplyAsync(new NendoMutation("actor-tests", "remove", "test", "Remove the package", [
            new RemoveExtensionFileOperation("remove-index", PackageId, "index.html", null),
            new RemoveExtensionPackageOperation("remove-package", PackageId)]));
        var before = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Create(service, "n2", "second", Actor));
        Assert.AreEqual("actor-not-allowed", refused.Code, refused.Message);
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest.ChangeSequence, "The refused write changed the file.");

        // The write that did commit still answers its retry with its receipt.
        var replay = await Create(service, "n1", "first", Actor);
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(first.RevisionId, replay.RevisionId);

        // Only a package's name is checked; everyone else writes as before.
        await Create(service, "n3", "third", "surface");
    }

    [TestMethod]
    [DataRow("extension:")]
    [DataRow("extension:org.example.never-here")]
    public async Task AWriteInTheNameOfAPackageTheFileNeverCarriedIsRefused(string origin)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("actor-tests", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true)]));

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Create(service, "n1", "forged", origin));
        Assert.AreEqual("actor-not-allowed", refused.Code, refused.Message);
        Assert.IsEmpty((await service.QueryRecordsAsync(new("notes", 10))).Items);
    }

    private static Task<NendoApplyResult> Create(NendoApplicationService service, string recordId, string key, string origin) =>
        service.CreateRecordAsync(new NendoCreateRecordRequest("notes", recordId,
            new Dictionary<string, object?> { ["label"] = recordId }, new NendoRequestContext("actor-tests", key, origin)));
}
