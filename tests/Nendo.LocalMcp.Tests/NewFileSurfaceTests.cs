using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// ADR-0022 (W-129). An agent that builds an application says what a new file of it keeps: a
/// record type's default in a change set, a record's own mark with a tool or on create, and the
/// name the File menu gives a new file. It reads all three back, and what a new file would keep,
/// from the reads it already uses.
/// </summary>
[TestClass]
public sealed class NewFileSurfaceTests
{
    [TestMethod]
    public async Task AnAgentMarksWhatTheApplicationShipsWithAndReadsWhatANewFileWouldKeep()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var lease = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value;
        var session = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.GetProperty("applicationHandle").GetString(),
            ["leaseId"] = lease.GetProperty("leaseId").GetString(),
        };
        var begun = Result(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session)
        {
            ["title"] = "Kinds and folders",
            ["idempotencyKey"] = "begin",
        }));
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.GetProperty("changeSetId").GetString() };
        Result(await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Kinds and folders",
                [
                    Operation("schema.createEntity", new { entityId = "kinds", displayName = "Kinds" }),
                    Operation("schema.addField", new { entityId = "kinds", fieldId = "kindName", displayName = "Name", storageKind = "text", required = true }),
                    Operation("schema.createEntity", new { entityId = "folders", displayName = "Folders" }),
                    Operation("schema.addField", new { entityId = "folders", fieldId = "folderName", displayName = "Name", storageKind = "text", required = true }),
                ]),
                new NendoAgentMutationInput("What a new file keeps",
                [
                    Operation("schema.setKeptInNewFiles", new { entityId = "kinds", kept = true }),
                    Operation("application.setNewFileLabel", new { label = "Test model" }),
                ]),
            },
            ["idempotencyKey"] = "add",
        }));
        var validated = Result(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped)
        {
            ["idempotencyKey"] = "validate",
        })).Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!;
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);
        Assert.IsTrue(validated.SemanticDiff.Any(entry => entry.Summary == "Keep Kinds records in a new file of this application, unless a record says otherwise."),
            string.Join(" / ", validated.SemanticDiff.Select(entry => entry.Summary)));
        Assert.IsTrue(validated.SemanticDiff.Any(entry => entry.Summary == "Offer a new file of this application as \"New Test model…\"."));
        Result(await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "accept" }));

        Result(await client.CallToolAsync("nendo.data.create_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "kinds",
            ["records"] = new[]
            {
                new NendoRecordInput("actor", new(JsonSerializer.SerializeToElement(new { kindName = "Actor" }))),
                new NendoRecordInput("role", new(JsonSerializer.SerializeToElement(new { kindName = "Role" }))),
            },
            ["idempotencyKey"] = "kinds",
        }));
        Result(await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "folders",
            ["recordId"] = "top",
            ["values"] = new { folderName = "Business" },
            ["keptInNewFiles"] = true,
            ["idempotencyKey"] = "top",
        }));
        Result(await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "folders",
            ["recordId"] = "mine",
            ["values"] = new { folderName = "Mine" },
            ["idempotencyKey"] = "mine",
        }));
        var marked = Result(await client.CallToolAsync("nendo.data.set_kept_in_new_files", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "folders",
            ["recordId"] = "mine",
            ["kept"] = false,
            ["idempotencyKey"] = "leave-mine",
        }));
        Assert.IsTrue(marked.GetProperty("recordIds").EnumerateArray().Select(id => id.GetString()).SequenceEqual(["mine"]));
        Result(await client.CallToolAsync("nendo.data.set_kept_in_new_files", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "folders",
            ["recordId"] = "mine",
            ["kept"] = null,
            ["idempotencyKey"] = "follow-mine",
        }));

        var described = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe")).RootElement;
        var kinds = described.GetProperty("entities").EnumerateArray().Single(entity => entity.GetProperty("entityId").GetString() == "kinds");
        Assert.IsTrue(kinds.GetProperty("keptInNewFiles").GetBoolean());
        Assert.AreEqual("Test model", described.GetProperty("manifest").GetProperty("newFileLabel").GetString());
        var newFile = described.GetProperty("newFile");
        Assert.AreEqual("New Test model…", newFile.GetProperty("menuLabel").GetString());
        Assert.AreEqual(0, newFile.GetProperty("conflictCount").GetInt64());
        var types = newFile.GetProperty("types").EnumerateArray().ToDictionary(
            type => type.GetProperty("entityId").GetString()!, type => (type.GetProperty("kept").GetInt64(), type.GetProperty("leftOut").GetInt64()));
        Assert.AreEqual((2L, 0L), types["kinds"]);
        Assert.AreEqual((1L, 1L), types["folders"]);

        var folders = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/folders/records"))
            .RootElement.GetProperty("items").EnumerateArray().ToDictionary(record => record.GetProperty("recordId").GetString()!);
        Assert.IsTrue(folders["top"].GetProperty("keptInNewFiles").GetBoolean());
        Assert.IsFalse(folders["mine"].TryGetProperty("keptInNewFiles", out _), "A record that follows its type carries no mark.");
        Assert.AreEqual(1, folders["top"].GetProperty("recordVersion").GetInt64(), "A mark moved the record's version.");
    }

    private static NendoAgentOperationInput Operation(string type, object payload) => new(type, JsonSerializer.SerializeToElement(payload));

    private static JsonElement Result(ModelContextProtocol.Protocol.CallToolResult result)
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value;
    }
}
