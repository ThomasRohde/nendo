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
    /// Review R-008: the history read was hard-coded oldest first, so the last change cost a
    /// walk over every older page. newestFirst=true answers it in one read; the default stays
    /// oldest first, and a cursor continues only the direction it came from.
    /// </summary>
    [TestMethod]
    public async Task NewestFirstHistoryAnswersTheLastChangesInOneRead()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(25);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var latest = ProtocolResourceTests.Deserialize<NendoMcpManifest>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/manifest")).ChangeSequence;

        var newest = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?newestFirst=true&limit=10"));
        CollectionAssert.AreEqual(Enumerable.Range(0, 10).Select(offset => latest - offset).ToArray(),
            newest.Items.Select(revision => revision.ChangeSequence).ToArray(), "The newest ten revisions arrive in one read, newest first.");
        Assert.IsNotNull(newest.NextCursor);

        var older = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(await ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/history?newestFirst=true&limit=10&cursor={Uri.EscapeDataString(newest.NextCursor)}"));
        CollectionAssert.AreEqual(Enumerable.Range(10, 10).Select(offset => latest - offset).ToArray(),
            older.Items.Select(revision => revision.ChangeSequence).ToArray(), "The next page is the ten before, with no repeat.");

        var turned = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/history?limit=10&cursor={Uri.EscapeDataString(newest.NextCursor)}"));
        StringAssert.Contains(turned.Message, "NENDO_INVALID_CURSOR", StringComparison.Ordinal);

        var oldest = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=10"));
        Assert.IsTrue(oldest.Items.Zip(oldest.Items.Skip(1)).All(pair => pair.First.ChangeSequence < pair.Second.ChangeSequence),
            "Without newestFirst the history still reads oldest first.");
        Assert.IsLessThan(newest.Items[^1].ChangeSequence, oldest.Items[^1].ChangeSequence);

        var word = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client,
            "nendo://application/history?newestFirst=yes"));
        StringAssert.Contains(word.Message, "newestFirst is true or false.", StringComparison.Ordinal);
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
