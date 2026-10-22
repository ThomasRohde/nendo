using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// There was one agent port for the device, and the first file to switch access on
/// took it; every other file listened on a temporary port that changed each run, so an agent
/// registered as "nendo" reached whichever file had opened first and a second file could not
/// be registered at all.
/// </summary>
[TestClass]
public sealed class DesktopAgentPortStoreTests
{
    [TestMethod]
    public async Task EachFileKeepsItsOwnPortWhateverOrderTheyAskIn()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41763, store.Claim("application-planner", "instance-planner", "Nendo.nendo", 41763), "The first file keeps the device's port.");
        Assert.AreEqual(41764, store.Claim("application-bcm", "instance-bcm", "BCM.nendo", 41763), "The next file keeps the next one.");

        // Another process, another day, the files asking the other way round.
        var later = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41764, later.Claim("application-bcm", "instance-bcm", "BCM.nendo", 41763));
        Assert.AreEqual(41763, later.Claim("application-planner", "instance-planner", "Nendo.nendo", 41763));
        Assert.AreEqual(41765, later.Peek("application-station", "instance-station", 41763), "A file that has not asked is told what it would get.");
        Assert.AreEqual(41765, later.Peek("application-station", "instance-station", 41763), "Asking without claiming keeps nothing.");
        Assert.AreEqual(41765, later.Claim("application-station", "instance-station", "Nendo Station.nendo", 41763));
    }

    [TestMethod]
    public async Task APortAnotherFileKeepsIsRefusedByItsName()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        store.Claim("application-planner", "instance-planner", "Nendo.nendo", 41763);
        store.Claim("application-bcm", "instance-bcm", "BCM.nendo", 41763);

        var refused = Assert.ThrowsExactly<NendoValidationException>(() => store.Set("application-bcm", "instance-bcm", "BCM.nendo", 41763));
        Assert.AreEqual("Port 41763 is kept for Nendo.nendo. Choose another port, or give Nendo.nendo a different one first.", refused.Message);
        Assert.AreEqual(41764, store.Peek("application-bcm", "instance-bcm", 41763), "A refused port changes nothing.");

        store.Set("application-bcm", "instance-bcm", "BCM.nendo", 50123);
        Assert.AreEqual(50123, new DesktopAgentPortStore(workspace.FileHistoryRoot).Claim("application-bcm", "instance-bcm", "BCM.nendo", 41763));
        store.Set("application-planner", "instance-planner", "Nendo.nendo", 41763);
        Assert.AreEqual(41764, store.Claim("application-station", "instance-station", null, 41763), "A port given up is free again.");
        Assert.ThrowsExactly<NendoValidationException>(() => store.Set("application-bcm", "instance-bcm", null, 80));
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("{\"Version\":2,\"Files\":{}}")]
    [DataRow("{\"Version\":1,\"Files\":{\"application-x\":{\"Port\":80}}}")]
    public async Task AnUnreadableListStartsAgainFromTheDevicePort(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
        await File.WriteAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "ports.json"), text);
        Assert.AreEqual(41763, new DesktopAgentPortStore(workspace.FileHistoryRoot).Claim("application-planner", "instance-planner", "Nendo.nendo", 41763));
    }

    /// <summary>
    /// The whole path, through two file sessions on one device: what the Agent page shows as
    /// each file's port, and the port each listener was asked for.
    /// </summary>
    [TestMethod]
    public async Task TwoFilesOnOneDeviceListenOnTwoKeptPorts()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var basePort = FreePort();
        await using (var noFile = new DesktopSessionController(deviceStateRoot: deviceRoot))
        {
            await noFile.SetAgentSettingsAsync(false, 60, true, basePort);
        }

        var first = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "first.nendo");
        var second = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "second.nendo");
        await using var one = new DesktopSessionController(
            new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, "discovery-one")),
            Path.Combine(deviceRoot, "history-one"), deviceStateRoot: deviceRoot);
        await using var two = new DesktopSessionController(
            new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, "discovery-two")),
            Path.Combine(deviceRoot, "history-two"), deviceStateRoot: deviceRoot);
        await one.CreateAsync(first);
        await two.CreateAsync(second);

        var oneOn = await one.SetAgentModeAsync("inspect");
        var twoOn = await two.SetAgentModeAsync("inspect");
        Assert.AreEqual(basePort, oneOn.PortPreference, "The first file to switch access on keeps the device's port.");
        Assert.AreEqual(basePort + 1, twoOn.PortPreference, "The second keeps the next one, instead of a new one each run.");
        if (oneOn.UsingPreferredPort) Assert.AreEqual(basePort, new Uri(oneOn.Endpoint!).Port);
        if (twoOn.UsingPreferredPort) Assert.AreEqual(basePort + 1, new Uri(twoOn.Endpoint!).Port);

        // Off and on again, the other way round: each file is back on its own port.
        await one.SetAgentModeAsync("off");
        await two.SetAgentModeAsync("off");
        Assert.AreEqual(basePort + 1, (await two.SetAgentModeAsync("inspect")).PortPreference);
        Assert.AreEqual(basePort, (await one.SetAgentModeAsync("inspect")).PortPreference);
    }

    /// <summary>
    /// Files of one application -- a new file made with File, New file, or a Duplicate --
    /// shared one kept port: the second was handed the first's, could not bind it while the first
    /// listened, and a port chosen for either moved the other's as well.
    /// </summary>
    [TestMethod]
    public async Task TwoFilesOfOneApplicationKeepTwoPorts()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41763, store.Claim("application-reading", "instance-2025", "Reading 2025.nendo", 41763));
        Assert.AreEqual(41764, store.Claim("application-reading", "instance-2026", "Reading 2026.nendo", 41763),
            "A new file of the application was handed the port the first file keeps.");

        store.Set("application-reading", "instance-2026", "Reading 2026.nendo", 41770);
        var later = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41763, later.Claim("application-reading", "instance-2025", "Reading 2025.nendo", 41763),
            "Giving the new file a port moved the original's as well.");
        Assert.AreEqual(41770, later.Peek("application-reading", "instance-2026", 41763));
        var refused = Assert.ThrowsExactly<NendoValidationException>(
            () => later.Set("application-reading", "instance-2026", "Reading 2026.nendo", 41763));
        Assert.AreEqual("Port 41763 is kept for Reading 2025.nendo. Choose another port, or give Reading 2025.nendo a different one first.",
            refused.Message);
    }

    /// <summary>
    /// A list kept before the instance was part of the key holds one port per
    /// application. The first file of it to ask keeps that port; another is given its own.
    /// </summary>
    [TestMethod]
    public async Task AListKeptPerApplicationIsTakenOverByTheFirstFileToAsk()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
        await File.WriteAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "ports.json"),
            """{"Version":1,"Files":{"application-reading":{"Port":41763,"Name":"Reading 2025.nendo","UsedAt":"2026-10-01T00:00:00+00:00"}}}""");
        var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41763, store.Peek("application-reading", "instance-2025", 41763), "Asking without claiming keeps nothing.");
        Assert.AreEqual(41763, store.Claim("application-reading", "instance-2025", "Reading 2025.nendo", 41763));
        Assert.AreEqual(41764, store.Claim("application-reading", "instance-2026", "Reading 2026.nendo", 41763));
        Assert.AreEqual(41763, new DesktopAgentPortStore(workspace.FileHistoryRoot).Peek("application-reading", "instance-2025", 41763));
    }

    /// <summary>
    /// The older entry goes to the file it was evidently kept for, not to
    /// whichever file of the application asks first: the one the access-level list of the same era
    /// names, or else the one whose name the port was kept under.
    /// </summary>
    [TestMethod]
    public async Task AListKeptPerApplicationGoesToTheFileItWasKeptFor()
    {
        const string Legacy = """{"Version":1,"Files":{"application-reading":{"Port":41763,"Name":"Reading 2025.nendo","UsedAt":"2026-10-01T00:00:00+00:00"}}}""";
        await using (var workspace = new DesktopTestWorkspace())
        {
            Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
            await File.WriteAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "ports.json"), Legacy);
            var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
            Assert.AreEqual(41764, store.Peek("application-reading", "instance-2026", 41763, "Reading 2026.nendo"));
            Assert.AreEqual(41764, store.Claim("application-reading", "instance-2026", "Reading 2026.nendo", 41763),
                "The new file, asking first, took the port kept under the original's name.");
            Assert.AreEqual(41763, store.Claim("application-reading", "instance-2025", "Reading 2025.nendo", 41763));
        }
        await using (var workspace = new DesktopTestWorkspace())
        {
            Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
            await File.WriteAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "ports.json"), Legacy);
            // The access-level list of the same era kept one level per application, with its instance.
            await File.WriteAllTextAsync(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "access.json"),
                """{"Version":1,"Files":{"application-reading":{"Mode":"editData","Instance":"instance-2025","Name":null,"UsedAt":"2026-10-01T00:00:00+00:00"}}}""");
            var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
            // Renamed since, so the name no longer says; the level list still does.
            Assert.AreEqual(41764, store.Claim("application-reading", "instance-2026", "Reading 2025 (2).nendo", 41763),
                "A file the level list does not name took the port kept for the one it names.");
            Assert.AreEqual(41763, store.Claim("application-reading", "instance-2025", "Reading archive.nendo", 41763));
        }
    }

    /// <summary>
    /// A new file of the application, open beside the file it was
    /// made from, is told a port of its own and listens on it.
    /// </summary>
    [TestMethod]
    public async Task ANewFileOfTheApplicationListensOnAPortOfItsOwn()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var basePort = FreePort();
        await using (var noFile = new DesktopSessionController(deviceStateRoot: deviceRoot))
        {
            await noFile.SetAgentSettingsAsync(false, 60, true, basePort);
        }
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var original = Path.Combine(folder, "Reading 2025.nendo");
        var sibling = Path.Combine(folder, "Reading 2026.nendo");
        await using var one = new DesktopSessionController(
            new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, "discovery-one")),
            Path.Combine(deviceRoot, "history-one"), deviceStateRoot: deviceRoot);
        await using var two = new DesktopSessionController(
            new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, "discovery-two")),
            Path.Combine(deviceRoot, "history-two"), deviceStateRoot: deviceRoot);
        var first = await one.CreateAsync(original);
        await one.CreateNewFileAsync(sibling, $"new-file-{Guid.NewGuid():N}");
        var second = await two.OpenAsync(sibling);
        Assert.AreEqual(first.Manifest!.ApplicationId, second.Manifest!.ApplicationId, "A new file keeps the application.");

        var oneOn = await one.SetAgentModeAsync("inspect");
        var twoOn = await two.SetAgentModeAsync("inspect");
        Assert.AreEqual(basePort, oneOn.PortPreference);
        Assert.AreEqual(basePort + 1, twoOn.PortPreference, "The new file was told the port the file it was made from keeps.");
        if (twoOn.UsingPreferredPort) Assert.AreEqual(basePort + 1, new Uri(twoOn.Endpoint!).Port);
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return Math.Min(port, 65000);
    }
}
