using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-164: the 2026-10-05 review by a team that built an app through MCP alone, without the
/// repository. One measuring guard per filed part.
/// </summary>
[TestClass]
public sealed class AppBuilderReviewTests
{
    /// <summary>W-167: validate says isValid on the wire, true when previewable and false when invalid.</summary>
    [TestMethod]
    public async Task ValidateSaysIsValidOnTheWire()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var valid = await ValidateRawAsync(client, session, "valid", EntityMutation("notes"));
        Assert.AreEqual("previewable", valid.GetProperty("state").GetString());
        Assert.IsTrue(valid.GetProperty("isValid").GetBoolean(), valid.ToString());

        // A field on a record type that does not exist: the Engine refuses it in the clone.
        var invalid = await ValidateRawAsync(client, session, "invalid", new NendoAgentMutationInput("A field on nothing",
        [
            new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new
            {
                entityId = "missing", fieldId = "missing.label", displayName = "Label", storageKind = "Text", required = false,
            })),
        ]));
        Assert.AreEqual("invalid", invalid.GetProperty("state").GetString());
        Assert.IsFalse(invalid.GetProperty("isValid").GetBoolean(), invalid.ToString());

        var listed = JsonDocument.Parse((await client.ReadResourceAsync("nendo://application/proposals"))
            .Contents.OfType<TextResourceContents>().Single().Text).RootElement;
        Assert.IsTrue(listed.EnumerateArray().Single().GetProperty("isValid").GetBoolean(), listed.ToString());
    }

    internal static NendoAgentMutationInput EntityMutation(string entityId) => new($"Create {entityId}",
    [
        new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId, displayName = entityId })),
        new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.label", displayName = "Label", storageKind = "Text", required = true })),
    ]);

    private static async Task<JsonElement> ValidateRawAsync(McpClient client, Dictionary<string, object?> session, string key, NendoAgentMutationInput mutation)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = key, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped) { ["mutations"] = new[] { mutation }, ["idempotencyKey"] = $"add-{key}" });
        var result = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        Assert.IsNotNull(result.StructuredContent);
        return result.StructuredContent.Value;
    }

    internal static Dictionary<string, object?> Session(NendoLeaseGrant grant) => new(StringComparer.Ordinal)
    {
        ["applicationHandle"] = grant.ApplicationHandle,
        ["leaseId"] = grant.LeaseId,
    };

    internal static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client) =>
        Session(await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire"));

    internal static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    internal static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
