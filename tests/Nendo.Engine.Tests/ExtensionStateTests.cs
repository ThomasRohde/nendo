using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// What a custom view keeps with the file (ADR-0013 Phase 3, <c>nendo.state</c>): one Data
/// operation, <c>extension.setState</c>, per view or shared by a package, versioned like a
/// record, bounded, attributed to its origin in History and reversed there.
/// </summary>
[TestClass]
public sealed class ExtensionStateTests
{
    private const string PackageId = "org.example.map";
    private const string View = "node.view.map";
    private const string Origin = "extension:" + PackageId;

    [TestMethod]
    public async Task AValueIsKeptVersionedAndRemovedAsDataUnderItsOrigin()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await WithPackageAsync(workspace);
        var before = await service.GetSnapshotAsync();

        var first = await Set(service, "layout", """{ "zoom": 1.5, "pinned": ["a", "b"] }""", key: "k1");
        Assert.AreEqual("""{"zoom":1.5,"pinned":["a","b"]}""", (await ReadAsync(service, "layout"))!.ValueJson, "The value is not kept in one spelling.");
        Assert.AreEqual(1, (await ReadAsync(service, "layout"))!.Version);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.DefinitionRevision, after.Manifest.DefinitionRevision, "Keeping a value changed the definition.");
        Assert.AreEqual(before.Manifest.DataRevision + 1, after.Manifest.DataRevision);

        await Set(service, "layout", "2", key: "k2", expected: 1);
        Assert.AreEqual(("2", 2L), ((await ReadAsync(service, "layout"))!.ValueJson, (await ReadAsync(service, "layout"))!.Version));

        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "layout", "3", key: "k3", expected: 1));
        Assert.AreEqual("state-version-conflict", stale.Code);
        var taken = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "layout", "3", key: "k4", expected: 0));
        Assert.AreEqual("state-version-conflict", taken.Code, "A write that expected an absent key replaced one.");

        await Set(service, "shared", "true", key: "k5", viewId: "");
        CollectionAssert.AreEqual(new[] { "layout" }, (await service.ReadExtensionStateAsync(PackageId, View, null)).Select(entry => entry.Key).ToArray(),
            "A package-wide value leaked into a view's keys.");

        await Set(service, "layout", null, key: "k6");
        Assert.IsNull(await ReadAsync(service, "layout"));

        var history = await service.GetHistoryAsync();
        var kept = history.Single(revision => revision.RevisionId == first.RevisionId);
        Assert.AreEqual((Origin, NendoRevisionLane.Data, "Keep layout for the view Map"), (kept.Origin, kept.Lane, kept.Description));
    }

    [TestMethod]
    public async Task CompensationPutsBackTheValueItReplacedAndRefusesOverALaterWrite()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await WithPackageAsync(workspace);

        var created = await Set(service, "zoom", "1", key: "c1");
        var replaced = await Set(service, "zoom", "2", key: "c2");
        await service.CompensateRevisionAsync(replaced.RevisionId, "undo-replace");
        Assert.AreEqual("1", (await ReadAsync(service, "zoom"))!.ValueJson, "Compensation did not put back the value it replaced.");

        var removed = await Set(service, "zoom", null, key: "c3");
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        Assert.AreEqual("1", (await ReadAsync(service, "zoom"))!.ValueJson, "Compensating a removal did not bring the value back.");

        await Set(service, "zoom", "9", key: "c4");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(created.RevisionId, "undo-create"),
            "Compensation overwrote a value written after the one it reverses.");
        Assert.AreEqual("9", (await ReadAsync(service, "zoom"))!.ValueJson);
    }

    [TestMethod]
    public async Task StateIsForAPackageTheFileCarriesAndStaysWithinItsBounds()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var none = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "k", "1", key: "n1"));
        Assert.AreEqual("extension-package-not-found", none.Code, "State was kept for a package the file does not carry.");

        await coordinator.ApplyAsync(new NendoMutation("state-tests", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", PackageId, "Map", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("index", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>"))]));

        Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionStateOperation("o", PackageId, View, "k", "{not json"));
        Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionStateOperation("o", PackageId, View, "k",
            "\"" + new string('x', NendoExtensionLimits.StateValueBytes) + "\""));
        Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionStateOperation("o", PackageId, View, new string('k', 129), "1"));

        for (var index = 0; index < NendoExtensionLimits.StateKeysPerView; index++)
            await Set(service, $"key-{index}", "1", key: $"b{index}");
        var tooMany = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "one-more", "1", key: "b-over"));
        Assert.AreEqual("state-too-large", tooMany.Code);
        Assert.IsNull(await ReadAsync(service, "one-more"), "The refused key was kept.");

        var big = "\"" + new string('x', 60 * 1024) + "\"";
        var refused = 0;
        for (var index = 0; index < 20 && refused == 0; index++)
        {
            try { await Set(service, $"big-{index}", big, key: $"g{index}", viewId: $"node.view.{index}"); }
            catch (NendoPreconditionException exception) when (exception.Code == "state-too-large") { refused = index; }
        }
        Assert.IsTrue(refused is > 0 and < 20, "A package kept more than 1 MiB of state.");
    }

    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> WithPackageAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("state-tests", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", PackageId, "Map", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("index", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>"))]));
        return (coordinator, service);
    }

    private static Task<NendoApplyResult> Set(
        NendoApplicationService service, string stateKey, string? value, string key, long? expected = null, string viewId = View) =>
        service.SetExtensionStateAsync(PackageId, viewId, stateKey, value, expected, $"Keep {stateKey} for the view Map",
            new NendoRequestContext("state-tests", key, Origin));

    private static async Task<NendoExtensionStateEntry?> ReadAsync(NendoApplicationService service, string key) =>
        (await service.ReadExtensionStateAsync(PackageId, View, key)).SingleOrDefault();
}
