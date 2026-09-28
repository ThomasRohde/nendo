using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-089. A file's look — the tone and letter of the badge its icons carry — is the file's own,
/// so an agent reads it with the manifest and can give the file one through the same reviewed
/// change set as anything else it authors.
/// </summary>
[TestClass]
public sealed class FileLookSurfaceTests
{
    [TestMethod]
    public async Task AnAgentReadsTheLookAsDrawnAndCanGiveTheFileItsOwn()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var manifest = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/manifest")).RootElement;
        var look = manifest.GetProperty("look");
        Assert.AreEqual(NendoLook.DefaultTone(manifest.GetProperty("applicationId").GetString()!), look.GetProperty("tone").GetString(),
            "A file that chose nothing is drawn in the tone its application ID gives it.");
        Assert.AreEqual("F", look.GetProperty("letter").GetString(), "…and with the first letter of its name.");
        Assert.IsFalse(look.GetProperty("toneChosen").GetBoolean());
        Assert.IsFalse(look.GetProperty("letterChosen").GetBoolean());

        var lease = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value;
        var session = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.GetProperty("applicationHandle").GetString(),
            ["leaseId"] = lease.GetProperty("leaseId").GetString(),
        };
        var begun = Result(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session)
        {
            ["title"] = "Give the file its own look",
            ["idempotencyKey"] = "begin-look",
        }));
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.GetProperty("changeSetId").GetString() };
        Result(await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Give the file its own look",
                [
                    new NendoAgentOperationInput("application.setLook", JsonSerializer.SerializeToElement(new { tone = "violet", letter = "q" })),
                ]),
            },
            ["idempotencyKey"] = "add-look",
        }));
        var validated = Result(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped)
        {
            ["idempotencyKey"] = "validate-look",
        })).Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!;
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);
        Assert.IsNull(validated.Preview.LookBefore, "The review says the file chose nothing before…");
        Assert.AreEqual(new NendoAgentLook("violet", "Q"), validated.Preview.LookAfter, "…and what it would choose.");
        Assert.IsTrue(validated.SemanticDiff.Any(entry => entry.Summary == "Give this file its own icon: violet, the letter Q."));

        Result(await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(scoped)
        {
            ["idempotencyKey"] = "accept-look",
        }));
        var after = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/manifest")).RootElement.GetProperty("look");
        Assert.AreEqual("violet", after.GetProperty("tone").GetString());
        Assert.AreEqual("Q", after.GetProperty("letter").GetString());
        Assert.IsTrue(after.GetProperty("toneChosen").GetBoolean());
        Assert.IsTrue(after.GetProperty("letterChosen").GetBoolean());
    }

    private static JsonElement Result(ModelContextProtocol.Protocol.CallToolResult result)
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value;
    }
}
