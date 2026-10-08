using System.Net.Http.Json;
using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The Tasks extension (SEP-2663) is not served since 2026-10-08. W-152 ran validate, import
/// and the integrity scan as tasks for a client that declared it; GitHub Copilot CLI declares
/// it on every request, refuses the CreateTaskResult it is then sent ("expected CallToolResult
/// from tools/call, got CreateTaskResult"), and never polls, so its agent lost every
/// validate's diagnostics. Each of the three is now answered within its request, whatever the
/// client declares, and discover no longer offers the extension.
/// </summary>
[TestClass]
public sealed class TasksExtensionTests
{
    private const string TasksExtension = "io.modelcontextprotocol/tasks";

    [TestMethod]
    public async Task AClientThatDeclaresTheTasksExtensionIsAnsweredWithinEveryRequest()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = LatestProtocolTests.Client(host);
        var capabilities = (await LatestProtocolTests.Send(http, "server/discover", new())).GetProperty("result").GetProperty("capabilities");
        Assert.IsFalse(capabilities.TryGetProperty("extensions", out var extensions) && extensions.TryGetProperty(TasksExtension, out _),
            $"Discover still offers the Tasks extension: {capabilities}");

        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        // Validate, as GitHub Copilot CLI sends it: the extension declared on the request.
        var scoped = await BeginNotesAsync(client, session);
        var validated = await CallDeclaringTasksAsync(http, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "validate" });
        var preview = validated.GetProperty("structuredContent").Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!;
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, validated.ToString());
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);

        var imported = await CallDeclaringTasksAsync(http, "nendo.data.import_records", new(session)
        {
            ["entityId"] = "notes",
            ["format"] = "json",
            ["records"] = Enumerable.Range(1, 60).Select(index => new { recordId = $"n{index:D3}", values = new Dictionary<string, object?> { ["notes.label"] = $"Row {index}" } }).ToArray(),
            ["idempotencyKey"] = "import",
        });
        Assert.AreEqual(60, imported.GetProperty("structuredContent").Deserialize<NendoImportResult>(NendoMcpJson.Options)!.Committed);

        var verified = await CallDeclaringTasksAsync(http, "nendo.health.verify_integrity", new());
        StringAssert.Contains(verified.GetProperty("structuredContent").ToString(), "\"ok\"", StringComparison.Ordinal);
    }

    /// <summary>
    /// One tools/call with the client capabilities GitHub Copilot CLI 1.0.93 sends, the Tasks
    /// extension among them, answered as a CallToolResult and not a CreateTaskResult.
    /// </summary>
    private static async Task<JsonElement> CallDeclaringTasksAsync(HttpClient http, string name, Dictionary<string, object?> arguments)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, http.BaseAddress);
        request.Headers.Add("MCP-Protocol-Version", "2026-07-28");
        request.Headers.Add("Mcp-Method", "tools/call");
        request.Headers.Add("Mcp-Name", name);
        request.Content = JsonContent.Create(new
        {
            jsonrpc = "2.0",
            id = 7,
            method = "tools/call",
            @params = new Dictionary<string, object?>
            {
                ["name"] = name,
                ["arguments"] = arguments,
                ["_meta"] = new Dictionary<string, object?>
                {
                    ["io.modelcontextprotocol/protocolVersion"] = "2026-07-28",
                    ["io.modelcontextprotocol/clientInfo"] = new { name = "copilot-cli", version = "1.0.93" },
                    ["io.modelcontextprotocol/clientCapabilities"] = new Dictionary<string, object?>
                    {
                        ["extensions"] = new Dictionary<string, object?> { [TasksExtension] = new { }, ["io.modelcontextprotocol/ui"] = new { mimeTypes = new[] { "text/html;profile=mcp-app" } } },
                        ["sampling"] = new { },
                        ["elicitation"] = new { form = new { }, url = new { } },
                    },
                },
            },
        }, options: NendoMcpJson.Options);
        using var response = await http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (text.StartsWith("event:", StringComparison.Ordinal) || text.StartsWith("data:", StringComparison.Ordinal))
            text = text.Split('\n').First(line => line.StartsWith("data:", StringComparison.Ordinal))[5..].Trim();
        var result = JsonDocument.Parse(text).RootElement.GetProperty("result").Clone();
        Assert.IsFalse(result.TryGetProperty("resultType", out var kind) && kind.GetString() == "task",
            $"{name} was answered with a task, which a client that cannot take one loses: {result}");
        Assert.AreNotEqual(true, result.TryGetProperty("isError", out var isError) && isError.GetBoolean(), $"{name}: {result}");
        return result;
    }

    private static async Task<Dictionary<string, object?>> BeginNotesAsync(McpClient client, Dictionary<string, object?> session)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "Notes", ["idempotencyKey"] = "begin" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create notes",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId = "notes", fieldId = "notes.label", displayName = "Label", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = "add",
        });
        return scoped;
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
