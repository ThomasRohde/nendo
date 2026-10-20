using System.Text.Json;
using System.Text.Json.Nodes;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchRecordWindowTests
{
    [TestMethod]
    public async Task WindowsUseTheTypedServiceAndRefuseStaleTokensAndWrongSessions()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var initial = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        for (var i = 0; i < 4; i++) await session.CreateIdeaRecordAsync($"r-{i}", $"Title {i}", $"seed-{i}");
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var query = new NendoRecordQuery(IdeaGarden.IdeaEntityId) { SortFieldId = IdeaGarden.IdeaTitleFieldId, Descending = true };
        var response = await handler.HandleAsync(Request(new(query, 2, 2)));
        Assert.IsTrue(response.Ok, response.Error?.Message);
        var block = (NendoRecordWindow)response.Result!;
        CollectionAssert.AreEqual(new[] { "r-1", "r-0" }, block.Items.Select(row => row.RecordId).ToArray());
        Assert.IsFalse(block.HasMore);
        var locate = await handler.HandleAsync(Request(new(query, 0, 2, block.QueryToken, "r-1")));
        Assert.IsTrue(locate.Ok, locate.Error?.Message);
        Assert.AreEqual(2, ((NendoRecordWindow)locate.Result!).LocatedIndex);
        var wrong = await handler.HandleAsync(Request(new(query), "another-session"));
        Assert.IsFalse(wrong.Ok);
        var actor = JsonNode.Parse(Request(new(query)))!;
        actor["payload"]!["actor"] = "extension:untrusted";
        var forbidden = await handler.HandleAsync(actor.ToJsonString());
        Assert.IsFalse(forbidden.Ok);
        Assert.AreEqual("actor-not-allowed", forbidden.Error?.Code);
        await session.CreateIdeaRecordAsync("r-new", "New", "append");
        var stale = await handler.HandleAsync(Request(new(query, 0, 2, block.QueryToken)));
        Assert.IsFalse(stale.Ok);
        Assert.AreEqual("stale-cursor", stale.Error?.Code);

        string Request(NendoRecordWindowQuery payload, string? fileSession = null) => JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = Guid.NewGuid().ToString("N"),
            method = WorkbenchMethods.DataQueryRecordWindow,
            fileSessionId = fileSession ?? initial.FileSessionId,
            boundedRead = true,
            payload,
        });
    }
}
