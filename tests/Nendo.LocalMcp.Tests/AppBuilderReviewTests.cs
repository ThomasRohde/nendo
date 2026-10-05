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

    /// <summary>
    /// W-165: the byte caps on record values are published, counted as stored rather than as
    /// sent, and refused with a code that names the cap and the size.
    /// </summary>
    [TestMethod]
    public async Task RecordValueByteCapsArePublishedAndRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareTextsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var limits = JsonDocument.Parse((await client.ReadResourceAsync("nendo://application/vocabulary"))
            .Contents.OfType<TextResourceContents>().Single().Text).RootElement.GetProperty("limits");
        Assert.AreEqual(32 * 1024, limits.GetProperty("recordValueBytes").GetInt32());
        Assert.AreEqual(64 * 1024, limits.GetProperty("recordValuesBytes").GetInt32());
        Assert.AreEqual(256 * 1024, limits.GetProperty("requestBodyBytes").GetInt32());
        var session = await AcquireAsync(client);

        // 16,384 × ø is exactly 32 KiB as stored, whatever escaping the client's serializer used.
        await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "texts", ["recordId"] = "at-cap", ["values"] = new { a = new string('ø', 16 * 1024) }, ["idempotencyKey"] = "at-cap",
        });
        var over = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "texts", ["recordId"] = "over-cap", ["values"] = new { a = new string('ø', 16 * 1024 + 1) }, ["idempotencyKey"] = "over-cap",
        });
        Assert.IsTrue(over.IsError);
        StringAssert.Contains(Text(over), "NENDO_VALUE_TOO_LARGE: The value of a is 32770 bytes, and a value may hold at most 32768", StringComparison.Ordinal);

        var ascii = new string('x', 30 * 1024);
        await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "texts", ["recordId"] = "two", ["values"] = new { a = ascii, b = ascii }, ["idempotencyKey"] = "two",
        });
        var three = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "texts", ["recordId"] = "three", ["values"] = new { a = ascii, b = ascii, c = ascii }, ["idempotencyKey"] = "three",
        });
        Assert.IsTrue(three.IsError);
        StringAssert.Contains(Text(three), "NENDO_VALUES_TOO_LARGE: The values of this write hold more than 65536 bytes together", StringComparison.Ordinal);
    }

    /// <summary>W-165: a tool call over the request body cap is a refused tool result under its own id, not a transport failure.</summary>
    [TestMethod]
    public async Task AToolCallOverTheBodyCapIsARefusedToolResult()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareTextsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var chunk = new string('x', 30 * 1024);
        var writes = Enumerable.Range(0, 10).Select(index => new
        {
            kind = "create", entityId = "texts", recordId = $"big-{index}", values = new { a = chunk },
        }).ToArray();

        var refused = await client.CallToolAsync("nendo.data.apply_writes", new Dictionary<string, object?>(session)
        {
            ["writes"] = writes, ["idempotencyKey"] = "too-big",
        });
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        StringAssert.Contains(Text(refused), "NENDO_REQUEST_TOO_LARGE: This request body is", StringComparison.Ordinal);
        StringAssert.Contains(Text(refused), "this host reads at most 262144 (limits.requestBodyBytes)", StringComparison.Ordinal);
        Assert.IsNotNull(refused.Meta);
        Assert.AreEqual("NENDO_REQUEST_TOO_LARGE",
            refused.Meta[NendoToolRefusal.MetaKey]!["code"]!.GetValue<string>());

        // The connection is still usable afterwards.
        await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "texts", ["recordId"] = "after", ["values"] = new { a = "fine" }, ["idempotencyKey"] = "after",
        });
    }

    /// <summary>
    /// W-169: an outside author asked for a per-user list of running instances and a stable port,
    /// both of which existed unannounced. The public guide names the folder the host actually
    /// writes; the skill and the instances read point at that guide, since the protocol carries no
    /// path of any kind.
    /// </summary>
    [TestMethod]
    public async Task TheSkillAndTheInstancesReadPointAtTheGuideThatNamesTheDiscoveryFolder()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var directory = "%LOCALAPPDATA%\\" + Path.GetRelativePath(local, NendoLocalMcpHostOptions.CreateDefault().DiscoveryRoot) + "\\";
        var guide = File.ReadAllText(Path.Combine(TestRepository.Root(), "site", "src", "content", "docs", "agents.md"));
        StringAssert.Contains(guide, $"`{directory}`", StringComparison.Ordinal);

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var skill = await ProtocolResourceTests.ReadTextAsync(client, "skill://nendo-authoring/SKILL.md");
        StringAssert.Contains(skill, NendoHostSkill.AgentsGuide, StringComparison.Ordinal);
        StringAssert.Contains(skill, $"{NendoLocalMcpHostOptions.StandardPort} for the first", StringComparison.Ordinal);
        StringAssert.Contains(skill, $"One field value holds at most {NendoAuthoringLimits.Current.RecordValueBytes} bytes", StringComparison.Ordinal);
        var templates = await client.ListResourceTemplatesAsync();
        var resources = await client.ListResourcesAsync();
        var instances = resources.Select(resource => resource.Description).Concat(templates.Select(template => template.Description))
            .Single(description => description?.StartsWith("Every Nendo running on this device", StringComparison.Ordinal) == true)!;
        StringAssert.Contains(instances, NendoHostSkill.AgentsGuide, StringComparison.Ordinal);
        Assert.IsLessThanOrEqualTo(2048, instances.Length, "Claude Code cuts a description at 2,048 characters.");
    }

    private static async Task PrepareTextsAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Texts", "test",
            new([new("test", "schema", "test", "Texts", [
                new CreateEntityOperation("texts", "texts", "Texts", "texts"),
                new AddFieldOperation("t-a", "texts", "a", "A", "a", NendoStorageKind.Text, false),
                new AddFieldOperation("t-b", "texts", "b", "B", "b", NendoStorageKind.Text, false),
                new AddFieldOperation("t-c", "texts", "c", "C", "c", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied, JsonSerializer.Serialize(schema.Diagnostics));
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
