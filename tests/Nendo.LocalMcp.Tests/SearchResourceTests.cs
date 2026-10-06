using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The search resource (ADR-0028): refused until the file has an index, then finding records by
/// any word in their text for a read-only agent, narrowed by record type and field, with an
/// excerpt and a cursor that pages the same search.
/// </summary>
[TestClass]
public sealed class SearchResourceTests
{
    [TestMethod]
    public async Task AReadOnlyAgentSearchesTheIndexAndIsToldWhenThereIsNone()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var missing = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ProtocolResourceTests.ReadTextAsync(client, "nendo://application/search?q=fixture"));
        StringAssert.Contains(missing.Message, "NENDO_SEARCH_INDEX_MISSING", StringComparison.Ordinal);

        await workspace.Service.BuildSearchIndexAsync(new NendoRequestContext("test.search", "build", "test"));

        var all = Read(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/search?q=fixture"));
        CollectionAssert.AreEquivalent(new[] { "idea-001", "idea-002", "idea-003" }, all.Items.Select(hit => hit.RecordId).ToArray());
        var hit = all.Items.Single(item => item.RecordId == "idea-002");
        Assert.AreEqual("Idea 02", hit.Label);
        var notes = hit.Fields.Single(field => field.FieldId == NendoApplicationService.IdeaNotesFieldId);
        Assert.AreEqual("Fixture", notes.Snippet.Substring(notes.Ranges[0].Start, notes.Ranges[0].Length));

        var narrowed = Read(await ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/search?q={Uri.EscapeDataString("step 02")}&entity={NendoApplicationService.IdeaEntityId}&field={NendoApplicationService.IdeaNextActionFieldId}"));
        Assert.AreEqual("idea-002", narrowed.Items.Single().RecordId);

        var first = Read(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/search?q=fixture&limit=2"));
        Assert.HasCount(2, first.Items);
        Assert.IsNotNull(first.NextCursor);
        var second = Read(await ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/search?q=fixture&limit=2&cursor={Uri.EscapeDataString(first.NextCursor)}"));
        Assert.HasCount(1, second.Items);
        CollectionAssert.AreEquivalent(new[] { "idea-001", "idea-002", "idea-003" },
            first.Items.Concat(second.Items).Select(item => item.RecordId).ToArray());

        var empty = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ProtocolResourceTests.ReadTextAsync(client, "nendo://application/search"));
        StringAssert.Contains(empty.Message, "NENDO_INVALID_REQUEST", StringComparison.Ordinal);
    }

    private static NendoMcpPage<NendoSearchHit> Read(string text) => ProtocolResourceTests.Deserialize<NendoMcpPage<NendoSearchHit>>(text);
}
