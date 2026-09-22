using Windows.Graphics;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopWindowStoreTests
{
    [TestMethod]
    public async Task GeometryAndThemeSurviveIndependentStores()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopWindowStore(workspace.FileHistoryRoot);
        Assert.IsNull(store.Load());
        var state = new DesktopWindowState(-1500, 40, 1200, 800, true);
        Assert.IsTrue(store.Save(state));
        new DesktopAppearanceStore(workspace.FileHistoryRoot).Save("dark");
        Assert.AreEqual(state, new DesktopWindowStore(workspace.FileHistoryRoot).Load());
        Assert.AreEqual("dark", new DesktopAppearanceStore(workspace.FileHistoryRoot).Preference);
        Assert.IsFalse(File.Exists(workspace.FilePath));
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("null")]
    [DataRow("{\"Version\":2}")]
    [DataRow("{\"Version\":1,\"State\":{\"Width\":0,\"Height\":800}}")]
    public async Task InvalidStateFallsBackWithoutChangingBytes(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "window.json");
        await File.WriteAllTextAsync(path, text);
        Assert.IsNull(new DesktopWindowStore(workspace.FileHistoryRoot).Load());
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    public async Task FailedSaveDoesNotThrowOrLeaveTemporaryFiles()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(Path.Combine(workspace.FileHistoryRoot, "window.json"));
        Assert.IsFalse(new DesktopWindowStore(workspace.FileHistoryRoot).Save(new(10, 10, 1200, 800, false)));
        Assert.IsEmpty(Directory.GetFiles(workspace.FileHistoryRoot));
    }

    [TestMethod]
    public void DisconnectedMonitorAndSmallWorkAreaKeepWindowVisible()
    {
        var bounds = DesktopWindowPolicy.FitSavedTo(new(int.MaxValue, int.MinValue, 1600, 960, true), new(0, 0, 800, 600));
        Assert.AreEqual(new RectInt32(0, 0, 800, 600), bounds);
        var negativeMonitor = new RectInt32(-1920, 0, 1920, 1040);
        Assert.AreEqual(new RectInt32(-1500, 40, 1200, 800),
            DesktopWindowPolicy.FitSavedTo(new(-1500, 40, 1200, 800, false), negativeMonitor));
    }
}
