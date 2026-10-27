using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;
using Nendo.Engine.Tests;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Icons from Nendo's set (ADR-0038) as an agent meets them: the set is a read of its own, a
/// record type's icon is in its schema and in describe, and the agent gives one through the same
/// reviewed change set as anything else, where a name the set does not hold is refused.
/// </summary>
[TestClass]
public sealed class EntityIconSurfaceTests
{
    [TestMethod]
    public async Task TheIconsReadListsEveryIconWithItsGroupAndWords()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        using var icons = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, NendoIconSet.ResourceUri));
        var list = icons.RootElement.GetProperty("icons");
        Assert.AreEqual(NendoIconSet.Icons.Count, list.GetArrayLength());
        Assert.AreEqual(NendoIconSet.Icons.Count, icons.RootElement.GetProperty("count").GetInt32());
        StringAssert.StartsWith(icons.RootElement.GetProperty("source").GetString(), "lucide");
        var folder = list.EnumerateArray().Single(icon => icon.GetProperty("name").GetString() == "folder");
        Assert.IsFalse(string.IsNullOrEmpty(folder.GetProperty("group").GetString()));
        StringAssert.Contains(folder.GetProperty("words").GetString(), "directory");

        using var vocabulary = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary?include=icons"));
        Assert.AreEqual(NendoIconSet.ResourceUri, vocabulary.RootElement.GetProperty("icons").GetProperty("resource").GetString());
        Assert.Contains(NendoIconSet.ResourceUri, NendoMcpResources.StaticForBuild, "the set describes the build, not the file");
    }

    [TestMethod]
    public async Task AnAgentGivesARecordTypeAnIconAndReadsItInTheSchemaAndDescribe()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var schemaUri = $"nendo://application/entity/{IdeaGarden.IdeaEntityId}/schema";
        var before = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, schemaUri)).RootElement;
        Assert.IsTrue(!before.TryGetProperty("icon", out var none) || none.ValueKind == JsonValueKind.Null, "no icon was chosen");

        var lease = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value;
        var session = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.GetProperty("applicationHandle").GetString(),
            ["leaseId"] = lease.GetProperty("leaseId").GetString(),
        };

        async Task<JsonElement> ValidateAsync(string key, string icon)
        {
            var begun = Result(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session)
            {
                ["title"] = "An icon for ideas", ["idempotencyKey"] = "begin-" + key,
            }));
            var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.GetProperty("changeSetId").GetString() };
            var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
            {
                ["mutations"] = new[] { new NendoAgentMutationInput("An icon for ideas",
                    [new NendoAgentOperationInput("schema.setEntityIcon",
                        JsonSerializer.SerializeToElement(new { entityId = IdeaGarden.IdeaEntityId, icon }))]) },
                ["idempotencyKey"] = "add-" + key,
            });
            if (added.IsError == true) return JsonSerializer.SerializeToElement(added);
            var validated = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped)
            {
                ["idempotencyKey"] = "validate-" + key,
            });
            if (validated.IsError == true || validated.StructuredContent!.Value.GetProperty("state").GetString() != "previewable")
                return JsonSerializer.SerializeToElement(validated);
            Result(await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "accept-" + key }));
            return validated.StructuredContent!.Value;
        }

        var refused = await ValidateAsync("unknown", "not-an-icon");
        StringAssert.Contains(refused.GetProperty("content")[0].GetProperty("text").GetString(), "'not-an-icon' is not an icon in Nendo's set");

        var given = await ValidateAsync("give", "lightbulb");
        Assert.IsTrue(given.GetProperty("semanticDiff").EnumerateArray().Any(entry =>
            entry.GetProperty("summary").GetString()!.EndsWith(" with the icon lightbulb.", StringComparison.Ordinal)), given.GetRawText());
        var schema = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, schemaUri)).RootElement;
        Assert.AreEqual("lightbulb", schema.GetProperty("icon").GetString());
        var described = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=entities")).RootElement;
        Assert.AreEqual("lightbulb", described.GetProperty("entities").EnumerateArray()
            .Single(entity => entity.GetProperty("entityId").GetString() == IdeaGarden.IdeaEntityId).GetProperty("icon").GetString());
        var manifest = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/manifest")).RootElement;
        Assert.AreEqual(NendoFormat.IconsMinimumHostVersion, manifest.GetProperty("minimumHostVersion").GetString());
    }

    private static JsonElement Result(ModelContextProtocol.Protocol.CallToolResult result)
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value;
    }
}
