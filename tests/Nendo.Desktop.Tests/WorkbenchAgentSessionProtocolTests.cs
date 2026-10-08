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
