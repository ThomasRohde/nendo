using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A package's settings as an agent meets them (ADR-0038): the declarations and the values the
/// file keeps are in the extensions read and in describe, and the agent changes a shared value
/// only in a reviewed change set, through package.setSetting. A personal value is never there.
/// </summary>
[TestClass]
public sealed class PackageSettingSurfaceTests
{
    private const string PackageId = "org.example.map";

    [TestMethod]
    public async Task AnAgentDeclaresSettingsKeepsASharedValueAndReadsBoth()
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

        async Task<JsonElement> ApplyAsync(string key, params NendoAgentOperationInput[] operations)
        {
            var begun = Result(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session)
            {
                ["title"] = "Map settings", ["idempotencyKey"] = "begin-" + key,
            }));
            var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.GetProperty("changeSetId").GetString() };
            var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
            {
                ["mutations"] = new[] { new NendoAgentMutationInput("Map settings", operations) },
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

        var settings = JsonDocument.Parse("""
            [
              { "id": "zoom", "title": "Zoom", "type": "number", "default": 3, "min": 1, "max": 9, "layers": "both" },
              { "id": "labels", "title": "Labels", "type": "toggle", "default": true, "layers": "personal" }
            ]
            """).RootElement;
        var declared = await ApplyAsync("declare",
            new NendoAgentOperationInput("extension.setPackage", JsonSerializer.SerializeToElement(new { packageId = PackageId, title = "Map", settings })),
            new NendoAgentOperationInput("extension.putFile", JsonSerializer.SerializeToElement(new { packageId = PackageId, path = "index.html", text = "<p>map</p>" })));
        Assert.IsTrue(declared.TryGetProperty("semanticDiff", out _), declared.GetRawText());

        var set = await ApplyAsync("set", new NendoAgentOperationInput("package.setSetting",
            JsonSerializer.SerializeToElement(new { packageId = PackageId, settingId = "zoom", value = 6 })));
        Assert.IsTrue(set.GetProperty("semanticDiff").EnumerateArray().Any(entry =>
            entry.GetProperty("summary").GetString() == "Set Zoom in the package Map to 6 for everyone who opens this file."), set.GetRawText());

        var personal = await ApplyAsync("personal", new NendoAgentOperationInput("package.setSetting",
            JsonSerializer.SerializeToElement(new { packageId = PackageId, settingId = "labels", value = false })));
        StringAssert.Contains(personal.GetRawText(), "kept on each computer, never in the file");

        using var extensions = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/extensions"));
        var root = extensions.RootElement;
        var package = (root.ValueKind == JsonValueKind.Array ? root : root.GetProperty("packages")).EnumerateArray().Single();
        var zoom = package.GetProperty("settings")[0];
        Assert.AreEqual(("zoom", "number", "both", 9d), (zoom.GetProperty("id").GetString(), zoom.GetProperty("type").GetString(),
            zoom.GetProperty("layers").GetString(), zoom.GetProperty("max").GetDouble()));
        Assert.AreEqual(JsonValueKind.Null, zoom.GetProperty("options").ValueKind, "a field the type does not take is null");
        Assert.AreEqual(6d, package.GetProperty("sharedSettings").GetProperty("zoom").GetDouble());
        Assert.IsFalse(package.GetProperty("sharedSettings").TryGetProperty("labels", out _), "a personal setting has no value here");

        using var described = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=extensions"));
        var describedPackage = described.RootElement.GetProperty("extensions").EnumerateArray().Single();
        Assert.AreEqual(2, describedPackage.GetProperty("settings").GetArrayLength());
        Assert.AreEqual(6d, describedPackage.GetProperty("sharedSettings").GetProperty("zoom").GetDouble());
    }

    private static JsonElement Result(ModelContextProtocol.Protocol.CallToolResult result)
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value;
    }
}
