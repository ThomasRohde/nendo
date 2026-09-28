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

    /// <summary>
    /// W-089. One window.json for the device meant every Nendo window opened on the same
    /// rectangle, so a second file landed exactly on top of the first.
    /// </summary>
    [TestMethod]
    public async Task EachFileReopensWhereItsWindowWasAndANewFileTakesTheLastPlace()
    {
        await using var workspace = new DesktopTestWorkspace();
        var planner = Path.Combine(workspace.FileHistoryRoot, "Planner.nendo");
        var atlas = Path.Combine(workspace.FileHistoryRoot, "BCM.nendo");
        var left = new DesktopWindowState(0, 0, 1200, 900, false);
        var right = new DesktopWindowState(1280, 0, 1200, 900, true);
        Assert.IsTrue(new DesktopWindowStore(workspace.FileHistoryRoot).Save(left, planner));
        Assert.IsTrue(new DesktopWindowStore(workspace.FileHistoryRoot).Save(right, atlas));

        var store = new DesktopWindowStore(workspace.FileHistoryRoot);
        Assert.AreEqual(left, store.Load(planner), "The planner opens where its own window was.");
        Assert.AreEqual(right, store.Load(atlas), "BCM opens where its own window was.");
        Assert.AreEqual(left, store.Load(planner.ToUpperInvariant()), "Windows paths name one file whatever their case.");
        Assert.AreEqual(right, store.Load(Path.Combine(workspace.FileHistoryRoot, "Unseen.nendo")),
            "A file with no place of its own opens where the last window was.");
        Assert.AreEqual(right, store.Load(), "A window with no file opens where the last window was.");
        Assert.DoesNotContain("Planner", await File.ReadAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "window-files.json")),
            StringComparison.OrdinalIgnoreCase, "The list keeps where files are as digests, not as paths.");
    }

    [TestMethod]
    public async Task OnlyTheMostRecentlyPlacedFilesAreKept()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopWindowStore(workspace.FileHistoryRoot);
        string FileNumber(int number) => Path.Combine(workspace.FileHistoryRoot, $"file-{number}.nendo");
        for (var number = 0; number <= DesktopWindowStore.MaximumFiles; number++)
        {
            Assert.IsTrue(store.Save(new DesktopWindowState(number, 0, 1100, 800, false), FileNumber(number)));
        }
        var last = new DesktopWindowState(DesktopWindowStore.MaximumFiles, 0, 1100, 800, false);
        Assert.AreEqual(last, store.Load(FileNumber(0)), "The oldest file was forgotten and takes the last place.");
        Assert.AreEqual(new DesktopWindowState(1, 0, 1100, 800, false), store.Load(FileNumber(1)));
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("{\"Version\":2,\"Files\":{}}")]
    [DataRow("{\"Version\":1,\"Files\":null}")]
    public async Task AnUnreadableFileListFallsBackToTheLastPlaceWithoutChangingBytes(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopWindowStore(workspace.FileHistoryRoot);
        var device = new DesktopWindowState(40, 40, 1200, 800, false);
        Assert.IsTrue(store.Save(device));
        var path = Path.Combine(workspace.FileHistoryRoot, "window-files.json");
        await File.WriteAllTextAsync(path, text);
        Assert.AreEqual(device, store.Load(Path.Combine(workspace.FileHistoryRoot, "Planner.nendo")));
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
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
