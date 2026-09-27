using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// ADR-0019 over MCP: a move the hierarchy rule refuses reaches the agent with its code and the
/// loop it would have closed, rather than as a withheld error it cannot act on.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class HierarchyProtocolTests
{
    [TestMethod]
    public async Task ARefusedMoveNamesTheLoopItWouldClose()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "A tree", "test", new([
            new("test", "schema", "test", "A tree", [
                new CreateEntityOperation("e", "areas", "Areas", "areas"),
                new AddFieldOperation("f-name", "areas", "name", "Name", "name", NendoStorageKind.Text, true),
                new AddFieldOperation("f-parent", "areas", "parent", "Part of", "parent_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("bind", "areas", "parent", "areas", "name", 0),
                new DeclareHierarchyOperation("declare", "areas", "parent", null, 0),
            ]),
        ])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("areas", "a", new Dictionary<string, object?> { ["name"] = "A" }, new("test", "a", "test")));
        await workspace.Service.CreateRecordAsync(new("areas", "b", new Dictionary<string, object?> { ["name"] = "B", ["parent"] = "a" },
            new("test", "b", "test"), new Dictionary<string, long> { ["parent"] = 1 }));

        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var refused = await client.CallToolAsync("nendo.data.move_record", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "areas", ["recordId"] = "a", ["expectedRecordVersion"] = 1L,
            ["parentRecordId"] = "b", ["expectedParentVersion"] = 1L, ["idempotencyKey"] = "down",
        });

        Assert.IsTrue(refused.IsError);
        var text = string.Join("\n", refused.Content.OfType<TextContentBlock>().Select(block => block.Text));
        StringAssert.Contains(text, "NENDO_HIERARCHY_CYCLE");
        StringAssert.Contains(text, "a → b → a");
    }

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
