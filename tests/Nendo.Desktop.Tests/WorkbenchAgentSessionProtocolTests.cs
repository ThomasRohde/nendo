using System.Text.Json;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// ADR-0030 on the bridge: the conversation tab's methods name the file session they belong to,
/// run away from the UI thread, and are refused as the Agent page would refuse them.
/// </summary>
[TestClass]
public sealed class WorkbenchAgentSessionProtocolTests
{
    [TestMethod]
    public async Task TheConversationMethodsBelongToTheFileSessionAndTheAccessLevel()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "protocol-discovery")),
            workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;

        var listed = await handler.HandleAsync(Request("list", WorkbenchMethods.AgentSessionList, fileSessionId));
        Assert.IsTrue(listed.Ok, listed.Error?.Message);
        var offered = (DesktopLaunchableAgents)listed.Result!;
        Assert.IsFalse(offered.CanLaunch, "Launch was offered with agent access off.");
        Assert.DoesNotContain(workspace.FilePath, WorkbenchProtocolHandler.Serialize(listed), StringComparison.OrdinalIgnoreCase);

        var refused = await handler.HandleAsync(Request("launch", WorkbenchMethods.AgentSessionLaunch, fileSessionId, new { agentId = "custom" }));
        Assert.IsFalse(refused.Ok);
        Assert.AreEqual("agent-launch-unavailable", refused.Error!.Code);

        var none = await handler.HandleAsync(Request("read", WorkbenchMethods.AgentSessionRead, fileSessionId, new { after = 0 }));
        Assert.IsTrue(none.Ok, none.Error?.Message);
        Assert.IsFalse(((DesktopLaunchedAgentView)none.Result!).Exists);

        var stale = await handler.HandleAsync(Request("stale", WorkbenchMethods.AgentSessionRead, "file-session-of-another-file", new { after = 0 }));
        Assert.IsFalse(stale.Ok);
        Assert.AreEqual("stale-file-session", stale.Error!.Code);

        var prompt = await handler.HandleAsync(Request("prompt", WorkbenchMethods.AgentSessionPrompt, fileSessionId, new { text = "hello" }));
        Assert.IsFalse(prompt.Ok);
        Assert.AreEqual("agent-not-launched", prompt.Error!.Code);

        foreach (var method in WorkbenchMethods.AgentSessionMethods)
        {
            Assert.IsTrue(WorkbenchProtocolHandler.RunsOffUiThread(Request("routing", method, fileSessionId)),
                $"{method} would run on the UI thread.");
        }
    }

    [TestMethod]
    public async Task AnAgentHiddenOnThisDeviceStaysHiddenAndComesBack()
    {
        // W-199, the owner: "at work we only have Copilot". Hiding is this device's choice, kept
        // beside the person's own command and never in the file.
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "protocol-discovery")),
            workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;
        var changesBefore = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        foreach (var id in new[] { "claude", "codex", "custom" })
        {
            var hid = await handler.HandleAsync(Request($"hide-{id}", WorkbenchMethods.AgentSessionSetHidden, fileSessionId, new { agentId = id, hidden = true }));
            Assert.IsTrue(hid.Ok, hid.Error?.Message);
        }
        var shown = await handler.HandleAsync(Request("show-codex", WorkbenchMethods.AgentSessionSetHidden, fileSessionId, new { agentId = "codex", hidden = false }));
        Assert.IsTrue(shown.Ok, shown.Error?.Message);
        CollectionAssert.AreEqual(new[] { "claude", "custom" }, ((DesktopLaunchableAgents)shown.Result!).Hidden.ToArray());
        Assert.IsTrue(((DesktopLaunchableAgents)shown.Result!).Agents.Any(agent => agent.Id == "claude"), "A hidden agent left the list, so it could not be shown again.");

        // The person's own command comes and goes without touching what they hid.
        await handler.HandleAsync(Request("command", WorkbenchMethods.AgentSessionSetCommand, fileSessionId, new { commandLine = "my-agent --acp" }));
        await handler.HandleAsync(Request("forget", WorkbenchMethods.AgentSessionSetCommand, fileSessionId, new { commandLine = "" }));
        CollectionAssert.AreEqual(new[] { "claude", "custom" }, new DesktopAgentLaunchStore(workspace.FileHistoryRoot).Hidden.ToArray(),
            "What the person hid did not survive their own command changing, or a restart.");

        var unknown = await handler.HandleAsync(Request("unknown", WorkbenchMethods.AgentSessionSetHidden, fileSessionId, new { agentId = "../agent", hidden = true }));
        Assert.IsFalse(unknown.Ok);
        Assert.AreEqual("validation", unknown.Error!.Code, unknown.Error.Message);
        var stale = await handler.HandleAsync(Request("stale", WorkbenchMethods.AgentSessionSetHidden, "file-session-of-another-file", new { agentId = "claude", hidden = false }));
        Assert.AreEqual("stale-file-session", stale.Error?.Code);
        Assert.AreEqual(changesBefore, (await session.GetViewAsync()).Manifest!.ChangeSequence, "Hiding an agent wrote to the file.");
    }

    private static string Request(string requestId, string method, string fileSessionId, object? payload = null) =>
        JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId,
            method,
            fileSessionId,
            payload = payload ?? new { },
        });
}
