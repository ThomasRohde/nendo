using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// ADR-0020 over MCP: the schema read says which fields are unique, and a duplicate reaches the
/// agent with its code and the record that already holds the value.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class FieldUniqueProtocolTests
{
    [TestMethod]
    public async Task ADuplicateNamesTheRecordThatHoldsTheValue()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Items", "test", new([
            new("test", "schema", "test", "Items", [
                new CreateEntityOperation("e", "items", "Items", "items"),
                new AddFieldOperation("f-title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("f-code", "items", "code", "Reference", "code", NendoStorageKind.Text, false),
                new SetFieldUniqueOperation("unique", "items", "code", true, 0),
            ]),
        ])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("items", "a", new Dictionary<string, object?> { ["title"] = "A", ["code"] = "W-001" },
            new("test", "a", "test")));

        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var read = await client.ReadResourceAsync("nendo://application/entity/items/schema");
        using (var document = JsonDocument.Parse(read.Contents.OfType<TextResourceContents>().Single().Text))
        {
            var fields = document.RootElement.GetProperty("fields").EnumerateArray().ToDictionary(field => field.GetProperty("fieldId").GetString()!);
            Assert.IsTrue(fields["code"].GetProperty("unique").GetBoolean());
            Assert.IsFalse(fields["title"].GetProperty("unique").GetBoolean());
        }

        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var refused = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "items", ["recordId"] = "b", ["idempotencyKey"] = "dup",
            ["values"] = new Dictionary<string, object?> { ["title"] = "B", ["code"] = "w-001" },
        });

        Assert.IsTrue(refused.IsError);
        var text = string.Join("\n", refused.Content.OfType<TextContentBlock>().Select(block => block.Text));
        StringAssert.Contains(text, "NENDO_VALUE_NOT_UNIQUE");
        StringAssert.Contains(text, "already used by a");
    }

    [TestMethod]
    public async Task ACreateWithoutACodeReturnsTheOneTheHostAssigned()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Items", "test", new([
            new("test", "schema", "test", "Items", [
                new CreateEntityOperation("e", "items", "Items", "items"),
                new AddFieldOperation("f-title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("f-code", "items", "code", "Reference", "code", NendoStorageKind.Text, false),
                new SetFieldUniqueOperation("unique", "items", "code", true, 0),
                new SetFieldSequenceOperation("sequence", "items", "code", "W-", 3, 0),
            ]),
        ])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);

        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var created = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "items", ["recordId"] = "a", ["idempotencyKey"] = "first",
            ["values"] = new Dictionary<string, object?> { ["title"] = "A" },
        });
        Assert.AreNotEqual(true, created.IsError, string.Join(" ", created.Content.OfType<TextContentBlock>().Select(block => block.Text)));
        var assigned = created.StructuredContent!.Value.GetProperty("assigned").EnumerateArray().Single();
        Assert.AreEqual("a", assigned.GetProperty("recordId").GetString());
        Assert.AreEqual("code", assigned.GetProperty("fieldId").GetString());
        Assert.AreEqual("W-001", assigned.GetProperty("value").GetString());
    }

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
