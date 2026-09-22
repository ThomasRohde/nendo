using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ScalarProtocolTests
{
    [TestMethod]
    public async Task ExactNumericStringsSurviveSdkCreateReadEditAndInvalidEnvelopes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposal = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Scalars", "test",
            new([new("test", "schema", "test", "Scalar schema", [
                new CreateEntityOperation("entity", "entry", "Entry", "entries"),
                new AddFieldOperation("whole", "entry", "whole", "Whole", "whole", NendoStorageKind.Integer, false),
                new AddFieldOperation("precise", "entry", "precise", "Precise", "precise", NendoStorageKind.Decimal, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var created = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "entry", ["recordId"] = "record", ["idempotencyKey"] = "create",
            ["values"] = new Dictionary<string, object?> { ["whole"] = Number("9223372036854775807"), ["precise"] = Number("0.1234567890123456789012345678") },
        });
        Assert.IsFalse(created.IsError ?? false);
        var resource = await client.ReadResourceAsync("nendo://application/entity/entry/records");
        using var json = JsonDocument.Parse(((TextResourceContents)resource.Contents[0]).Text);
        var row = json.RootElement.GetProperty("items")[0];
        Assert.AreEqual("9223372036854775807", row.GetProperty("numericLexemes").GetProperty("whole").GetString());
        Assert.AreEqual("0.1234567890123456789012345678", row.GetProperty("numericLexemes").GetProperty("precise").GetString());
        Assert.AreEqual("9223372036854775807", row.GetProperty("values").GetProperty("whole").GetRawText());
        var edit = new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = "entry", ["recordId"] = "record", ["fieldId"] = "whole",
            ["expectedRecordVersion"] = 1, ["idempotencyKey"] = "edit", ["value"] = Number("-9223372036854775808"),
        };
        Assert.IsFalse((await client.CallToolAsync("nendo.data.set_field", edit)).IsError ?? false);
        var unchanged = (await workspace.Service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(long.MinValue, unchanged.Values["whole"].GetInt64());
        Assert.AreEqual("0.1234567890123456789012345678", unchanged.Values["precise"].GetRawText());
        foreach (var invalid in new object[] { Number("NaN"), Number("1e-29"), new Dictionary<string, object?> { ["$nendoNumber"] = "1", ["extra"] = true } })
        {
            edit["fieldId"] = "precise"; edit["expectedRecordVersion"] = 2; edit["idempotencyKey"] = Guid.NewGuid().ToString(); edit["value"] = invalid;
            Assert.IsTrue((await client.CallToolAsync("nendo.data.set_field", edit)).IsError ?? false);
        }
        Assert.AreEqual(2L, (await workspace.Service.GetSnapshotAsync()).Records.Single().RecordVersion);
        await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
    }

    [TestMethod]
    public void NestedAuthoringValuesDecodeWithoutChangingText()
    {
        var input = JsonSerializer.SerializeToElement(new { values = new Dictionary<string, object?> {
            ["amount"] = Number("79228162514264337593543950335"), ["text"] = "  1.00\n", ["empty"] = "", ["missing"] = null,
        } });
        var result = NendoNumericEnvelope.Decode(input).GetProperty("values");
        Assert.AreEqual("79228162514264337593543950335", result.GetProperty("amount").GetRawText());
        Assert.AreEqual("  1.00\n", result.GetProperty("text").GetString());
        Assert.AreEqual("", result.GetProperty("empty").GetString());
        Assert.AreEqual(JsonValueKind.Null, result.GetProperty("missing").ValueKind);
    }

    private static Dictionary<string, string> Number(string text) => new() { ["$nendoNumber"] = text };
    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(
        result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
