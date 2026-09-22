using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class PagedResourceTests
{
    [TestMethod]
    public async Task OfficialClientRejectsRecordAndHistoryContinuationAfterInsertBeforeCursor()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var recordsUri = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records";
        var first = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ProtocolResourceTests.ReadTextAsync(client, $"{recordsUri}?limit=1"));
        var history = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=1"));
        var original = (await workspace.Service.GetSnapshotAsync()).Records.First();
        await workspace.Service.CreateRecordAsync(new(original.EntityId, "000-before", original.Values.ToDictionary(
            pair => pair.Key, pair => (object?)pair.Value.Clone()), new("paging", "insert", "test")));
        foreach (var uri in new[] { $"{recordsUri}?cursor={Uri.EscapeDataString(first.NextCursor!)}&limit=1",
            $"nendo://application/history?cursor={Uri.EscapeDataString(history.NextCursor!)}&limit=1" })
        {
            var error = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, uri));
            StringAssert.Contains(error.Message, "NENDO_STALE_CURSOR");
        }
    }

    /// <summary>
    /// A limit the binder could not turn into an integer — letters, a fraction, a
    /// value past what an integer holds, nothing at all — reached the client as a
    /// bare internal error, while 0 and 101 were refused by name. Every malformed
    /// limit is now the same refusal as an out-of-range one, and says what a limit is.
    /// </summary>
    [TestMethod]
    public async Task AMalformedLimitIsRefusedByNameNotAsAnInternalError()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var recordsUri = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records";
        foreach (var limit in new[] { "abc", "1.5", "2147483648", "", "-1", "0", "101" })
        {
            foreach (var uri in new[] { $"nendo://application/history?limit={limit}", $"{recordsUri}?limit={limit}" })
            {
                var error = await Assert.ThrowsExactlyAsync<McpProtocolException>(
                    () => ProtocolResourceTests.ReadTextAsync(client, uri), uri);
                StringAssert.Contains(error.Message, "NENDO_INVALID_LIMIT", uri);
                StringAssert.Contains(error.Message, "whole numbers from 1 to 100", uri);
                Assert.AreEqual(McpErrorCode.InvalidParams, error.ErrorCode, uri);
            }
        }

        // No limit at all still pages at the default.
        var page = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history"));
        Assert.IsNotEmpty(page.Items);
    }
}
