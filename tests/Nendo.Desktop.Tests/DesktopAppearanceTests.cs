using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopAppearanceTests
{
    [TestMethod]
    public async Task MissingPreferenceUsesSystemWithoutCreatingState()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        Assert.AreEqual("system", store.Preference);
        Assert.IsTrue(store.Persisted);
        Assert.IsNull(store.Notice);
        Assert.IsFalse(Directory.Exists(workspace.FileHistoryRoot));
    }

    [TestMethod]
    [DataRow("system")]
    [DataRow("light")]
    [DataRow("dark")]
    public async Task ExplicitPreferenceSurvivesANewStoreWithoutApplicationWrites(string preference)
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        store.Save(preference);
        var reopened = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        Assert.AreEqual(preference, reopened.Preference);
        Assert.IsTrue(reopened.Persisted);
        Assert.IsNull(reopened.Notice);
        Assert.IsFalse(File.Exists(workspace.FilePath));
        CollectionAssert.AreEqual(new[] { "appearance.json" }, Directory.GetFiles(workspace.FileHistoryRoot).Select(Path.GetFileName).ToArray());
        var serialized = await File.ReadAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "appearance.json"));
        Assert.IsFalse(serialized.Contains("Effective", StringComparison.Ordinal));
        Assert.IsFalse(serialized.Contains(workspace.FileHistoryRoot, StringComparison.Ordinal));
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("null")]
    [DataRow("{\"Version\":2,\"Preference\":\"dark\"}")]
    [DataRow("{\"Version\":1,\"Preference\":\"sepia\"}")]
    [DataRow("{\"Version\":1,\"Preference\":null}")]
    public async Task InvalidPreferenceFallsBackWithoutRepairingItsBytes(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "appearance.json");
        await File.WriteAllTextAsync(path, text);
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        Assert.AreEqual("system", store.Preference);
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
        store.Save("dark");
        Assert.AreEqual("dark", new DesktopAppearanceStore(workspace.FileHistoryRoot).Preference);
    }

    [TestMethod]
    public async Task OversizedPreferenceIsBoundedAndPreserved()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "appearance.json");
        var text = new string(' ', 4097);
        await File.WriteAllTextAsync(path, text);
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        Assert.AreEqual("system", store.Preference);
        Assert.IsFalse(store.Persisted);
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    public async Task InvalidChoiceCannotChangeMemoryOrDisk()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        store.Save("light");
        Assert.ThrowsExactly<NendoValidationException>(() => store.Save("sepia"));
        Assert.AreEqual("light", store.Preference);
        Assert.AreEqual("light", new DesktopAppearanceStore(workspace.FileHistoryRoot).Preference);
    }

    [TestMethod]
    public async Task SaveFailureAppliesOnlyToMemoryAndCleansOwnedStage()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "appearance.json");
        Directory.CreateDirectory(path); // Deterministic destination failure, not a disk-full test.
        var store = new DesktopAppearanceStore(workspace.FileHistoryRoot);
        store.Save("dark");
        Assert.AreEqual("dark", store.Preference);
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.IsTrue(Directory.Exists(path));
        Assert.IsEmpty(Directory.GetFiles(workspace.FileHistoryRoot));
    }

    [TestMethod]
    public async Task V5ReadsNativePreferenceWithoutFileAuthorityAndOlderVersionsDoNotGainTheMethod()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var store = new DesktopAppearanceStore(Path.Combine(workspace.FileHistoryRoot, "appearance"));
        store.Save("dark");
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), value => store.Save(value.Preference),
            getAppearance: () => new(store.Preference, store.Preference == "dark" ? "dark" : "light", store.Persisted, store.Notice));
        var result = await handler.HandleAsync(Request(5, WorkbenchMethods.AppearanceGet));
        Assert.IsTrue(result.Ok, result.Error?.Message);
        Assert.AreEqual("dark", ((DesktopAppearanceView)result.Result!).Preference);
        Assert.IsFalse(session.HasFile);
        var set = await handler.HandleAsync(Request(5, WorkbenchMethods.AppearanceSet, new { preference = "light", effective = "dark" }));
        Assert.IsTrue(set.Ok, set.Error?.Message);
        Assert.AreEqual("light", ((DesktopAppearanceView)set.Result!).Effective, "Effective appearance comes from the host, not the renderer claim.");
        foreach (var version in new[] { 2, 3, 4 })
            Assert.AreEqual("unknown-method", (await handler.HandleAsync(Request(version, WorkbenchMethods.AppearanceGet))).Error!.Code);
        Assert.IsFalse(JsonSerializer.Serialize(result.Result).Contains(workspace.FileHistoryRoot, StringComparison.Ordinal));
    }

    private static string Request(int version, string method, object? payload = null) => JsonSerializer.Serialize(new
    {
        protocolVersion = version, requestId = Guid.NewGuid().ToString("N"), method, payload = payload ?? new { },
    });
}
