namespace Nendo.Desktop.Tests;

/// <summary>
/// W-126 (ADR-0009, 2026-09-29): a file opens again at the access level last chosen for it on
/// this device; Off forgets it; another instance of the file and a read-only open begin at Off.
/// </summary>
[TestClass]
public sealed class DesktopAgentModeMemoryTests
{
    [TestMethod]
    public async Task AFileOpensAgainAtTheLevelLastChosenForItAndOffForgetsIt()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "remembered.nendo");

        await using (var first = Controller(deviceRoot, "one"))
        {
            await first.CreateAsync(path);
            var on = await first.SetAgentModeAsync("shapeApp");
            Assert.AreEqual("shapeApp", on.Mode);
            Assert.IsTrue(on.Remembered, "The Agent page is not told the level is remembered.");
        }

        await using (var second = Controller(deviceRoot, "two"))
        {
            await second.OpenAsync(path);
            var status = await second.GetAgentStatusAsync();
            Assert.AreEqual("shapeApp", status.Mode, "The file did not open again at the level last chosen for it.");
            Assert.AreEqual("ready", status.State);
            Assert.IsTrue(status.Remembered);
            Assert.IsNotNull(status.Endpoint, "The remembered level did not start a listener.");
            await second.SetAgentModeAsync("off");
        }

        await using (var third = Controller(deviceRoot, "three"))
        {
            await third.OpenAsync(path);
            Assert.AreEqual("off", (await third.GetAgentStatusAsync()).Mode, "Off did not forget the level.");
        }
    }

    /// <summary>
    /// R2SP-05: Off was remembered only after the listener's cleanup succeeded, so a cleanup that
    /// threw (here, a reader holding the discovery entry open without sharing delete, as every
    /// reader did) brought the old level back on the next open.
    /// </summary>
    [TestMethod]
    public async Task OffStaysOffWhenTheListenersCleanupFails()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "switched-off.nendo");

        await using (var first = Controller(deviceRoot, "one"))
        {
            await first.CreateAsync(path);
            await first.SetAgentModeAsync("editData");
            var entry = Directory.GetFiles(Path.Combine(deviceRoot, "discovery-one"), "*.json").Single();
            using (new FileStream(entry, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                // The stop itself may say its cleanup did not finish; what matters is what is remembered.
                try { await first.SetAgentModeAsync("off"); }
                catch (IOException) { }
                catch (Nendo.Engine.NendoException) { }
            }
            Assert.AreEqual("off", (await first.GetAgentStatusAsync()).Mode);
        }

        await using (var second = Controller(deviceRoot, "two"))
        {
            await second.OpenAsync(path);
            Assert.AreEqual("off", (await second.GetAgentStatusAsync()).Mode,
                "The file opened again at the level the person had turned off, because the stop's cleanup failed.");
        }
    }

    [TestMethod]
    public async Task AReadOnlyOpenAndAnotherInstanceBeginAtOff()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "kept.nendo");

        string applicationId;
        await using (var first = Controller(deviceRoot, "one"))
        {
            await first.CreateAsync(path);
            await first.SetAgentModeAsync("inspect");
            applicationId = (await first.GetViewAsync()).Manifest!.ApplicationId;
        }

        await using (var readOnly = Controller(deviceRoot, "two"))
        {
            await readOnly.OpenReadOnlyAsync(path);
            Assert.AreEqual("off", (await readOnly.GetAgentStatusAsync()).Mode, "A read-only open came back with agent access on.");
        }

        // A copy, a Duplicate or a Fork is another instance: the level stays with the one it was chosen for.
        var modes = new DesktopAgentModeStore(deviceRoot);
        Assert.IsNull(modes.Recall(applicationId, "instance-of-a-copy"), "Another instance of the file was given its level.");
        Assert.AreEqual("inspect", modes.Recall(applicationId, (await ReadInstanceAsync(deviceRoot, path))!));
    }

    /// <summary>
    /// DSH-10: the level was kept in one slot per application ID, so choosing a level, or Off, for a
    /// Duplicate or a new file of the same application replaced or erased the original's.
    /// </summary>
    [TestMethod]
    public void ALevelChosenForAnotherInstanceLeavesTheOriginalsAlone()
    {
        var root = Path.Combine(Path.GetTempPath(), "nendo-agent-modes", Guid.NewGuid().ToString("N"));
        try
        {
            var modes = new DesktopAgentModeStore(root);
            modes.Remember("app-one", "original", "Plan.nendo", "editData");
            modes.Remember("app-one", "duplicate", "Plan duplicate.nendo", "inspect");
            Assert.AreEqual("editData", modes.Recall("app-one", "original"), "A Duplicate's level replaced the original's.");
            Assert.AreEqual("inspect", modes.Recall("app-one", "duplicate"));
            modes.Remember("app-one", "duplicate", "Plan duplicate.nendo", "off");
            Assert.AreEqual("editData", modes.Recall("app-one", "original"), "Off for a Duplicate erased the original's level.");
            Assert.IsNull(modes.Recall("app-one", "duplicate"));

            // A document from before the instance joined the key: still this file's level, moved on its next change.
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "agent-modes.json"),
                """{"Version":1,"Files":{"app-two":{"Mode":"shapeApp","Instance":"kept","Name":null,"UsedAt":"2026-10-01T00:00:00+00:00"}}}""");
            Assert.AreEqual("shapeApp", modes.Recall("app-two", "kept"));
            Assert.IsNull(modes.Recall("app-two", "other"));
            modes.Remember("app-two", "other", null, "off");
            Assert.AreEqual("shapeApp", modes.Recall("app-two", "kept"), "Off for another instance erased an older document's entry.");
            modes.Remember("app-two", "kept", null, "off");
            Assert.IsNull(modes.Recall("app-two", "kept"));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    /// <summary>
    /// W-136: the tray menu, tooltip and notifications name the level as the Agent page
    /// does, from the one table in LocalMcp.
    /// </summary>
    [TestMethod]
    public async Task TheShellStateNamesTheLevelAsTheAgentPageDoes()
    {
        await using var workspace = new DesktopTestWorkspace();
        var deviceRoot = workspace.FileHistoryRoot;
        var path = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "named.nendo");

        await using var controller = Controller(deviceRoot, "named");
        await controller.CreateAsync(path);
        Assert.AreEqual("Off", controller.DescribeShellState().AgentAccess);
        foreach (var (mode, label) in new[] { ("inspect", "Inspect"), ("editData", "Edit data"), ("shapeApp", "Shape app") })
        {
            await controller.SetAgentModeAsync(mode);
            Assert.AreEqual(label, controller.DescribeShellState().AgentAccess, $"The shell names {mode} differently from the Agent page.");
        }
        await controller.SetAgentModeAsync("off");
        Assert.AreEqual("Off", controller.DescribeShellState().AgentAccess);
        Assert.AreEqual("Off", DesktopShellState.None.AgentAccess);
    }

    private static async Task<string?> ReadInstanceAsync(string deviceRoot, string path)
    {
        await using var controller = Controller(deviceRoot, "read");
        return (await controller.OpenReadOnlyAsync(path)).Manifest?.InstanceId;
    }

    private static DesktopSessionController Controller(string deviceRoot, string name) =>
        new(new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, $"discovery-{name}")),
            Path.Combine(deviceRoot, $"history-{name}"), deviceStateRoot: deviceRoot);
}
