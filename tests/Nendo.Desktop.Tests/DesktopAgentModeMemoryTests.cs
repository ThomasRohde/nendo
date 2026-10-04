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
