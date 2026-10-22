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
    [DataRow("{\"Version\":1,\"Last\":{\"Width\":0,\"Height\":800},\"Files\":{}}")]
    public async Task InvalidStateFallsBackWithoutChangingBytes(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot));
        var path = Path.Combine(DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot), "places.json");
        await File.WriteAllTextAsync(path, text);
        Assert.IsNull(new DesktopWindowStore(workspace.FileHistoryRoot).Load());
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    public async Task FailedSaveDoesNotThrowOrLeaveTemporaryFiles()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(Path.Combine(DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot), "places.json"));
        Assert.IsFalse(new DesktopWindowStore(workspace.FileHistoryRoot).Save(new(10, 10, 1200, 800, false)));
        Assert.IsEmpty(Directory.GetFiles(DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot)));
    }

    /// <summary>
    /// One place for the device meant every Nendo window opened on the same
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
        Assert.DoesNotContain("Planner", await File.ReadAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot), "places.json")),
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
    [DataRow("null")]
    [DataRow("{}")]
    [DataRow("{\"0123\":null}")]
    public async Task AFileListWithoutThisFileFallsBackToTheLastPlaceWithoutChangingBytes(string files)
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopWindowStore(workspace.FileHistoryRoot);
        var folder = DesktopDeviceStateLayout.Window(workspace.FileHistoryRoot);
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "places.json");
        var text = "{\"Version\":1,\"Last\":{\"X\":40,\"Y\":40,\"Width\":1200,\"Height\":800,\"Maximized\":false},\"Files\":" + files + "}";
        await File.WriteAllTextAsync(path, text);
        Assert.AreEqual(new DesktopWindowState(40, 40, 1200, 800, false), store.Load(Path.Combine(workspace.FileHistoryRoot, "Planner.nendo")));
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
