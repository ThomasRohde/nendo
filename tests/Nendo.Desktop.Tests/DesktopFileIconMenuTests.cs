namespace Nendo.Desktop.Tests;

/// <summary>
/// W-001 follow-up. The taskbar menu showed the same document icon on every file, so the icon a
/// file carries stopped at its window. Each row now shows the icon this device last drew for that
/// file. A picture dropped on About this file from Explorer reached nothing either, because
/// the browser and the grid that holds it took no drop.
/// </summary>
[TestClass]
public sealed class DesktopFileIconMenuTests
{
    [TestMethod]
    public async Task EachRowShowsTheIconLastDrawnForItsFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        var cache = DesktopFileIcon.CacheRoot(workspace.FileHistoryRoot);
        Directory.CreateDirectory(cache);
        var planner = Path.Combine(cache, "file-v1-picture-aa.ico");
        var garden = Path.Combine(cache, "file-v1-green-47.ico");
        await File.WriteAllBytesAsync(planner, [0, 0, 1, 0]);
        await File.WriteAllBytesAsync(garden, [0, 0, 1, 0]);

        Assert.IsTrue(DesktopFileIconIndex.Remember(cache, @"C:\work\Planner.nendo", planner));
        Assert.IsTrue(DesktopFileIconIndex.Remember(cache, @"C:\work\Garden.nendo", garden));
        Assert.IsFalse(DesktopFileIconIndex.Remember(cache, @"C:\work\Garden.nendo", garden), "The same icon again changes nothing.");
        var icons = DesktopFileIconIndex.Read(cache);

        const string documentIcon = @"C:\Program Files\Nendo\Assets\DocumentIcon.ico";
        Assert.AreEqual(planner, DesktopJumpList.IconFor(@"c:\WORK\planner.nendo", icons, documentIcon), "A path is matched ignoring case, as Windows does.");
        Assert.AreEqual(garden, DesktopJumpList.IconFor(@"C:\work\Garden.nendo", icons, documentIcon));
        Assert.AreEqual(documentIcon, DesktopJumpList.IconFor(@"C:\work\Never drawn.nendo", icons, documentIcon));

        File.Delete(planner);
        Assert.AreEqual(documentIcon, DesktopJumpList.IconFor(@"C:\work\Planner.nendo", DesktopFileIconIndex.Read(cache), documentIcon),
            "An icon since deleted from the cache reads as none.");
    }

    [TestMethod]
    public async Task TheIndexKeepsTheNewestFilesAndSurvivesAnUnreadableOne()
    {
        await using var workspace = new DesktopTestWorkspace();
        var cache = DesktopFileIcon.CacheRoot(workspace.FileHistoryRoot);
        Directory.CreateDirectory(cache);
        var icon = Path.Combine(cache, "file-v1-teal-41.ico");
        await File.WriteAllBytesAsync(icon, [0, 0, 1, 0]);
        for (var index = 0; index < DesktopFileIconIndex.MaximumFiles + 6; index++)
            DesktopFileIconIndex.Remember(cache, $@"C:\files\{index}.nendo", icon);
        var icons = DesktopFileIconIndex.Read(cache);
        Assert.HasCount(DesktopFileIconIndex.MaximumFiles, icons);
        Assert.IsTrue(icons.ContainsKey($@"C:\files\{DesktopFileIconIndex.MaximumFiles + 5}.nendo"), "The newest is kept.");
        Assert.IsFalse(icons.ContainsKey(@"C:\files\0.nendo"), "The oldest goes first.");

        await File.WriteAllTextAsync(DesktopFileIconIndex.IndexPath(cache), "{ not json");
        Assert.IsEmpty(DesktopFileIconIndex.Read(cache));
        Assert.IsTrue(DesktopFileIconIndex.Remember(cache, @"C:\files\again.nendo", icon), "A damaged index is replaced, not a failure.");
    }

    /// <summary>
    /// What is checked is the code that sets it: whether Windows then delivers a drag cannot be
    /// driven reliably from a test (a synthetic OLE drag landed on some runs and not others, and
    /// on a plain WinForms window too). Measured once by hand on 2026-10-19: with both set, a
    /// picture dragged from another process became the pending icon; with either removed, the
    /// page saw no drag event in four drags.
    /// </summary>
    [TestMethod]
    public void TheBrowserAndTheGridThatHoldsItTakeADropFromWindows()
    {
        var source = File.ReadAllText(Path.Combine(TestRepository.Root(), "src", "Nendo.Desktop", "MainPage.xaml.cs"));
        var created = source[source.IndexOf("_webView = new WebView2", StringComparison.Ordinal)..];
        created = created[..created.IndexOf("};", StringComparison.Ordinal)];
        StringAssert.Contains(created, "AllowDrop = true", "The Workbench browser takes no drop from Windows.");
        StringAssert.Contains(source, "WebHost.AllowDrop = true;", "The grid holding the browser takes no drop, so no drag reaches it.");
    }
}
