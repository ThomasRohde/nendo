using System.Text.RegularExpressions;
using Nendo.Engine.Tests;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The Workbench browser's profile lives under the device-state folder, not beside the
/// executable, where it was 100 MB inside an install folder setup never owned. Window-free:
/// the folder is resolved from a stand-in environment and the sources are read as text.
/// </summary>
[TestClass]
public sealed class DesktopBrowserProfileTests
{
    private static string LocalDeviceState =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nendo");

    [TestMethod]
    public void AnOrdinaryLaunchKeepsTheProfileUnderDeviceStateAndOutOfTheInstallFolder()
    {
        var folder = DesktopBrowserProfile.ResolveUserDataFolder(_ => null, LocalDeviceState, debugBuild: false);

        Assert.AreEqual(Path.Combine(LocalDeviceState, DesktopBrowserProfile.FolderName), folder);
        var installFolder = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        Assert.IsFalse(folder.StartsWith(installFolder, StringComparison.OrdinalIgnoreCase),
            $"The browser profile resolved inside the folder the executable runs from: {folder}");
    }

    [TestMethod]
    public void ADebugBuildNeverSharesTheInstalledProfile()
    {
        var installed = DesktopBrowserProfile.ResolveUserDataFolder(_ => null, LocalDeviceState, debugBuild: false);
        var debug = DesktopBrowserProfile.ResolveUserDataFolder(_ => null, LocalDeviceState, debugBuild: true);
        Assert.AreEqual(Path.Combine(LocalDeviceState, DesktopBrowserProfile.DebugFolderName), debug);
        Assert.AreNotEqual(installed, debug, "A Debug host would share a browser process and page storage with the installed Nendo.");
    }

    [TestMethod]
    public void SetupMovesAnOldProfileToTheFolderTheInstalledAppReads()
    {
        // Setup cannot ask the application, so its default destination is written out in
        // Invoke-NendoSetup.ps1 and pinned here to a Release build's own default.
        var setup = File.ReadAllText(Path.Combine(TestRepository.Root(), "tools", "Invoke-NendoSetup.ps1"));
        var declared = Regex.Match(setup,
            @"\[string\] \$BrowserProfileRoot = \(Join-Path \(\[Environment\]::GetFolderPath\('LocalApplicationData'\)\) '([^']+)'\)");
        Assert.IsTrue(declared.Success, "Invoke-NendoSetup.ps1 no longer declares where it moves an old browser profile.");
        var setupDefault = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), declared.Groups[1].Value);
        Assert.AreEqual(
            DesktopBrowserProfile.ResolveUserDataFolder(_ => null, LocalDeviceState, debugBuild: false),
            setupDefault,
            "Setup moves the old browser profile somewhere the installed application does not read, so its drafts would seem lost.");
    }

    [TestMethod]
    public void AnIsolatedProfileFollowsItsDeviceStateRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "nendo-browser-profile-" + Guid.NewGuid().ToString("N"));
        Assert.AreEqual(Path.Combine(root, DesktopBrowserProfile.FolderName),
            DesktopBrowserProfile.ResolveUserDataFolder(_ => null, root, debugBuild: false));
        Assert.IsFalse(Directory.Exists(root), "Resolving the profile must not create it.");
    }

    [TestMethod]
    public void TheProcessOwnersBrowserFolderStillWins()
    {
        var chosen = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "nendo-lane-webview"));
        foreach (var debugBuild in new[] { false, true })
            Assert.AreEqual(chosen, DesktopBrowserProfile.ResolveUserDataFolder(
                name => name == "WEBVIEW2_USER_DATA_FOLDER" ? chosen : null, @"C:\unused", debugBuild));
    }

    [TestMethod]
    public void ThePageStartsEveryBrowserInThatEnvironment()
    {
        // A call without an environment is WebView2's default: a profile beside the executable.
        var page = File.ReadAllText(Path.Combine(TestRepository.Root(), "src", "Nendo.Desktop", "MainPage.xaml.cs"));
        Assert.IsFalse(page.Contains("EnsureCoreWebView2Async()", StringComparison.Ordinal),
            "MainPage starts a browser without an environment, so its profile goes beside the executable.");
        StringAssert.Contains(page, "DesktopBrowserProfile.CreateEnvironmentAsync()");
    }
}
