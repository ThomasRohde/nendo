using System.Text.Json;
using System.Text.Json.Nodes;

namespace Nendo.Session.Tests;

/// <summary>
/// The protocol as the browser host answers it (ADR-0036): the shared dispatch reads and writes a
/// file, and every method only the Windows host owns is refused by name rather than not known.
/// </summary>
[TestClass]
public sealed class SessionProtocolTests
{
    [TestMethod]
    public async Task TheSharedHandlerOpensAFileAndAnswersItsSnapshotAndCompile()
    {
        await using var workspace = new Workspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.DeviceState);
        var created = await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var snapshot = await AskAsync(handler, "session.getSnapshot", created.FileSessionId);
        Assert.IsTrue(snapshot["ok"]!.GetValue<bool>(), snapshot.ToJsonString());
        Assert.IsTrue(snapshot["result"]!["hasFile"]!.GetValue<bool>());

        var compiled = await AskAsync(handler, "semantic.compile", created.FileSessionId);
        Assert.IsTrue(compiled["ok"]!.GetValue<bool>(), compiled.ToJsonString());
    }

    [TestMethod]
    [DataRow("window.takeTab")]
    [DataRow("window.setTitleBarControls")]
    [DataRow("agent.getStatus")]
    [DataRow("agentSession.read")]
    [DataRow("diagnostics.titleBar")]
    [DataRow("downloads.show")]
    [DataRow("session.getRecentFiles")]
    public async Task AWindowsHostsMethodIsRefusedByName(string method)
    {
        await using var workspace = new Workspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.DeviceState);
        var created = await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var answer = await AskAsync(handler, method, created.FileSessionId);
        Assert.IsFalse(answer["ok"]!.GetValue<bool>());
        Assert.AreEqual("not-in-this-host", answer["error"]!["code"]!.GetValue<string>(), answer.ToJsonString());
    }

    [TestMethod]
    public async Task AMethodNoHostOwnsIsNotPartOfTheProtocol()
    {
        await using var workspace = new Workspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.DeviceState);
        var created = await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var answer = await AskAsync(handler, "data.makeCoffee", created.FileSessionId);
        Assert.AreEqual("unknown-method", answer["error"]!["code"]!.GetValue<string>(), answer.ToJsonString());
    }

    private static async Task<JsonNode> AskAsync(WorkbenchProtocolHandler handler, string method, string? fileSessionId)
    {
        var request = JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = method,
            fileSessionId,
            method,
            payload = new { },
        });
        return JsonNode.Parse(WorkbenchProtocolHandler.Serialize(await handler.HandleAsync(request)))!;
    }

    private sealed class Workspace : IAsyncDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "nendo-session-tests", Guid.NewGuid().ToString("N"));

        internal Workspace() => Directory.CreateDirectory(_root);

        internal string FilePath => Path.Combine(_root, "session.nendo");

        internal string DeviceState => Path.Combine(_root, "device-state");

        public ValueTask DisposeAsync()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
            return ValueTask.CompletedTask;
        }
    }
}
