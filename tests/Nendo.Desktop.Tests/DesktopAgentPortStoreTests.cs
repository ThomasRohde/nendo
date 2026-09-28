using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-089. There was one agent port for the device, and the first file to switch access on
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
        Assert.AreEqual(41763, store.Claim("application-planner", "Nendo.nendo", 41763), "The first file keeps the device's port.");
        Assert.AreEqual(41764, store.Claim("application-bcm", "BCM.nendo", 41763), "The next file keeps the next one.");

        // Another process, another day, the files asking the other way round.
        var later = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        Assert.AreEqual(41764, later.Claim("application-bcm", "BCM.nendo", 41763));
        Assert.AreEqual(41763, later.Claim("application-planner", "Nendo.nendo", 41763));
        Assert.AreEqual(41765, later.Peek("application-station", 41763), "A file that has not asked is told what it would get.");
        Assert.AreEqual(41765, later.Peek("application-station", 41763), "Asking without claiming keeps nothing.");
        Assert.AreEqual(41765, later.Claim("application-station", "Nendo Station.nendo", 41763));
    }

    [TestMethod]
    public async Task APortAnotherFileKeepsIsRefusedByItsName()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentPortStore(workspace.FileHistoryRoot);
        store.Claim("application-planner", "Nendo.nendo", 41763);
        store.Claim("application-bcm", "BCM.nendo", 41763);

        var refused = Assert.ThrowsExactly<NendoValidationException>(() => store.Set("application-bcm", "BCM.nendo", 41763));
        Assert.AreEqual("Port 41763 is kept for Nendo.nendo. Choose another port, or give Nendo.nendo a different one first.", refused.Message);
        Assert.AreEqual(41764, store.Peek("application-bcm", 41763), "A refused port changes nothing.");

        store.Set("application-bcm", "BCM.nendo", 50123);
        Assert.AreEqual(50123, new DesktopAgentPortStore(workspace.FileHistoryRoot).Claim("application-bcm", "BCM.nendo", 41763));
        store.Set("application-planner", "Nendo.nendo", 41763);
        Assert.AreEqual(41764, store.Claim("application-station", null, 41763), "A port given up is free again.");
        Assert.ThrowsExactly<NendoValidationException>(() => store.Set("application-bcm", null, 80));
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("{\"Version\":2,\"Files\":{}}")]
    [DataRow("{\"Version\":1,\"Files\":{\"application-x\":{\"Port\":80}}}")]
    public async Task AnUnreadableListStartsAgainFromTheDevicePort(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "agent-ports.json"), text);
        Assert.AreEqual(41763, new DesktopAgentPortStore(workspace.FileHistoryRoot).Claim("application-planner", "Nendo.nendo", 41763));
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

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return Math.Min(port, 65000);
    }
}
