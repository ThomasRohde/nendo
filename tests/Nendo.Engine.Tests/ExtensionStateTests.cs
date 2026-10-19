using System.Text;

namespace Nendo.Engine.Tests;

/// <summary>
/// What a custom view keeps with the file (ADR-0013, <c>nendo.state</c>): one Data
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
        var keptAt = (await ReadAsync(service, "layout"))!.Version;
        Assert.IsGreaterThanOrEqualTo(1L, keptAt);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.DefinitionRevision, after.Manifest.DefinitionRevision, "Keeping a value changed the definition.");
        Assert.AreEqual(before.Manifest.DataRevision + 1, after.Manifest.DataRevision);

        await Set(service, "layout", "2", key: "k2", expected: keptAt);
        Assert.AreEqual("2", (await ReadAsync(service, "layout"))!.ValueJson);
        Assert.IsGreaterThan(keptAt, (await ReadAsync(service, "layout"))!.Version, "A write did not move the key's version on.");

        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "layout", "3", key: "k3", expected: keptAt));
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

        await AddViewsAsync(coordinator, Enumerable.Range(0, 20).Select(index => $"node.view.{index}").ToArray());
        var big = "\"" + new string('x', 60 * 1024) + "\"";
        var refused = 0;
        for (var index = 0; index < 20 && refused == 0; index++)
        {
            try { await Set(service, $"big-{index}", big, key: $"g{index}", viewId: $"node.view.{index}"); }
            catch (NendoPreconditionException exception) when (exception.Code == "state-too-large") { refused = index; }
        }
        Assert.IsTrue(refused is > 0 and < 20, "A package kept more than 1 MiB of state.");
    }

    /// <summary>
    /// A value is bounded as it is kept, and kept as it was written. The default JSON writer
    /// escaped every non-ASCII letter into six characters, so 40 KB of Danish passed the 64 KiB check
    /// and failed the table's own bound as a raw SQLite error.
    /// </summary>
    [TestMethod]
    public async Task AValueWithinTheBoundIsKeptAsWrittenAndOnePastItAsKeptIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await WithPackageAsync(workspace);
        var danish = "\"" + new string('\u00e6', 20_000) + "\"";
        await Set(service, "note", danish, key: "d1");
        var kept = (await ReadAsync(service, "note"))!.ValueJson;
        Assert.AreEqual(danish, kept, $"The value was not kept as written: {kept.Length:N0} characters for {danish.Length:N0}.");
        await Set(service, "markup", "\"<b>a & b</b>\"", key: "d2");
        Assert.AreEqual("\"<b>a & b</b>\"", (await ReadAsync(service, "markup"))!.ValueJson);

        // A character outside the basic plane is kept as two escapes: within the bound as sent, past it as kept.
        var faces = "\"" + string.Concat(Enumerable.Repeat("\U0001F600", 15_000)) + "\"";
        Assert.IsLessThanOrEqualTo(NendoExtensionLimits.StateValueBytes, System.Text.Encoding.UTF8.GetByteCount(faces));
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "faces", faces, key: "d3"));
        Assert.AreEqual("state-too-large", refused.Code, refused.Message);
        Assert.IsNull(await ReadAsync(service, "faces"));
    }

    /// <summary>
    /// A key's version never returns to a number it had, even after the key is forgotten and
    /// set again, or put back by History. It restarted at 1, so a write that expected a version from
    /// before the forget replaced a value its writer never read.
    /// </summary>
    [TestMethod]
    public async Task AForgottenKeyNeverReturnsToAVersionItHadBefore()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await WithPackageAsync(workspace);
        await Set(service, "layout", "\"A\"", key: "v1");
        var read = (await ReadAsync(service, "layout"))!.Version;
        await Set(service, "layout", "\"B\"", key: "v2", expected: read);
        var forget = await Set(service, "layout", null, key: "v3");
        await service.CompensateRevisionAsync(forget.RevisionId, "undo-forget");
        Assert.AreEqual("\"B\"", (await ReadAsync(service, "layout"))!.ValueJson, "History did not put the forgotten value back.");
        var afterUndo = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "layout", "\"C\"", key: "v4", expected: read));
        Assert.AreEqual("state-version-conflict", afterUndo.Code, "A write that read the key before it was forgotten replaced the value History put back.");

        await Set(service, "layout", null, key: "v5");
        await Set(service, "layout", "\"D\"", key: "v6");
        var reset = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Set(service, "layout", "\"E\"", key: "v7", expected: read));
        Assert.AreEqual("state-version-conflict", reset.Code, "A key set again after a forget took a version it had before.");
        Assert.AreEqual("\"D\"", (await ReadAsync(service, "layout"))!.ValueJson);
    }

    /// <summary>
    /// What a removed view kept stays for compensation but no longer counts against the
    /// package's 1 MiB, which no surface could free.
    /// </summary>
    [TestMethod]
    public async Task StateARemovedViewKeptNoLongerCountsAgainstThePackage()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await WithPackageAsync(workspace);
        await AddViewsAsync(coordinator, "node.view.old", "node.view.new");
        var big = "\"" + new string('x', 60 * 1024) + "\"";
        for (var index = 0; index < 16; index++)
            await Set(service, $"tile-{index}", big, key: $"o{index}", viewId: "node.view.old");
        await coordinator.ApplyAsync(new NendoMutation("state-tests", "remove-old", "test", "Remove the old view",
            [new RemoveUiNodeOperation("remove-old", "node.view.old", "node.view.old")]));
        for (var index = 0; index < 16; index++)
            await Set(service, $"tile-{index}", big, key: $"n{index}", viewId: "node.view.new");
        Assert.HasCount(16, await service.ReadExtensionStateAsync(PackageId, "node.view.new", null));
        Assert.HasCount(16, await service.ReadExtensionStateAsync(PackageId, "node.view.old", null), "The removed view's state was dropped, so compensation could not bring it back.");
    }

    private static async Task AddViewsAsync(NendoWriteCoordinator coordinator, params string[] views) =>
        await coordinator.ApplyAsync(new NendoMutation("state-tests", "views-" + Guid.NewGuid().ToString("N"), "test", "Views",
            views.SelectMany((view, position) => new NendoOperation[]
            {
                new AddUiNodeOperation(view + "-add", view, view, null, NendoExtensionViewDefinition.ScreenKind, position),
                new SetUiPropertyOperation(view + "-v", view, view, "definitionVersion", 3),
                new SetUiPropertyOperation(view + "-t", view, view, "title", view),
                new SetUiPropertyOperation(view + "-p", view, view, "packageId", PackageId),
            }).ToArray()));

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
