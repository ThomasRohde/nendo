using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// An agent reads what the open file's custom views did when they ran in this Nendo, and
/// nothing wider. Billable's agent could not see a thrown error or a refused call from MCP at all.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class ViewEventsResourceTests
{
    [TestMethod]
    public async Task AnAgentReadsAViewsErrorsAndRefusalsWithTheirCodes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var at = new DateTimeOffset(2026, 10, 18, 9, 0, 0, TimeSpan.Zero);
        workspace.Service.ViewEvents.Record("org.example.board", new(at, NendoViewEventKind.Loaded, "view.board", null, null, null));
        workspace.Service.ViewEvents.Record("org.example.board", new(at, NendoViewEventKind.Error, "view.board", null, null, "TypeError: lines is undefined"));
        workspace.Service.ViewEvents.Record("org.example.board", new(at, NendoViewEventKind.Refused, "view.board", "records.batch", "stale-version", "The record changed since it was read."));
        workspace.Service.ViewEvents.Record("org.example.board", new(at, NendoViewEventKind.Refused, "view.board", "ui.toolbar", "invalid-params", "A toolbar item needs a label."));
        workspace.Service.ViewEvents.Record("org.example.chart", new(at, NendoViewEventKind.Loaded, "view.chart", null, null, null));
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        using var all = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extension-events"));
        StringAssert.StartsWith(all.RootElement.GetProperty("source").GetString(), "embedded host",
            "The read does not say which kind of evidence it is.");
        Assert.AreEqual(2, all.RootElement.GetProperty("packages").GetArrayLength());

        using var board = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extension-events?packageId=org.example.board"));
        var package = board.RootElement.GetProperty("packages").EnumerateArray().Single();
        Assert.AreEqual("org.example.board", package.GetProperty("packageId").GetString());
        var events = package.GetProperty("events").EnumerateArray().ToArray();
        CollectionAssert.AreEqual(new[] { "loaded", "error", "refused", "refused" }, events.Select(item => item.GetProperty("kind").GetString()).ToArray());
        Assert.AreEqual("TypeError: lines is undefined", events[1].GetProperty("text").GetString());
        Assert.AreEqual(("records.batch", "stale-version"), (events[2].GetProperty("method").GetString(), events[2].GetProperty("code").GetString()));
        Assert.AreEqual(("ui.toolbar", "invalid-params"), (events[3].GetProperty("method").GetString(), events[3].GetProperty("code").GetString()));
    }

    [TestMethod]
    public async Task AnotherFilesViewsAreNotReadFromThisOne()
    {
        await using var one = new LocalMcpTestWorkspace();
        await one.CreateIdeaGardenAsync();
        await using var other = new LocalMcpTestWorkspace();
        await other.CreateIdeaGardenAsync();
        other.Service.ViewEvents.Record("org.example.board", new(DateTimeOffset.UtcNow, NendoViewEventKind.Error, "view.board", null, null, "Elsewhere."));
        await using var host = await NendoLocalMcpHost.StartAsync(one.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(one.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        using var read = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extension-events"));
        Assert.AreEqual(0, read.RootElement.GetProperty("packages").GetArrayLength(), "Another open file's view events were read from this file's host.");
    }
}
