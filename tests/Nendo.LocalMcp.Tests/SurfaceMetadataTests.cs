using System.Text.Json;
using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-084. What the wire said on 2026-09-27: no title on any of the twenty tools or
/// seventeen resources, no description on any output property, three tools that overwrite
/// stored values advertising <c>destructiveHint</c> false, a <c>serverInfo</c> with neither
/// title nor website, <c>Server: Kestrel</c> on every response, the two build-static reads
/// served with a zero time to live, a nullable list parameter whose entries and IDs were
/// nullable too, and a page read that refused <c>cursor=</c> and the other parameter order.
/// </summary>
[TestClass]
public sealed class SurfaceMetadataTests
{
    // The tools that overwrite or remove what is stored. The specification reserves
    // destructiveHint false for additive updates.
    private static readonly string[] Destructive =
    [
        "nendo.data.set_field", "nendo.data.move_record", "nendo.data.execute_command", "nendo.data.delete_record",
        "nendo.data.set_kept_in_new_files", "nendo.data.update_record", "nendo.data.apply_writes", "nendo.data.undo_revision",
        "nendo.change_set.amend", "nendo.change_set.reject", "nendo.change_set.accept", "nendo.change_set.revalidate",
    ];

    [TestMethod]
    public async Task EveryToolAndResourceIsTitledAndEveryOutputPropertyDescribed()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var tools = await client.ListToolsAsync();
        Assert.HasCount(25, tools);
        var untitled = tools.Where(tool => string.IsNullOrWhiteSpace(tool.ProtocolTool.Title)).Select(tool => tool.Name).ToList();
        var resources = await client.ListResourcesAsync();
        var templates = await client.ListResourceTemplatesAsync();
        untitled.AddRange(resources.Where(resource => string.IsNullOrWhiteSpace(resource.ProtocolResource.Title)).Select(resource => resource.Name));
        untitled.AddRange(templates.Where(template => string.IsNullOrWhiteSpace(template.ProtocolResourceTemplate.Title)).Select(template => template.Name));
        Assert.AreEqual(25, resources.Count + templates.Count);
        Assert.IsEmpty(untitled, "Untitled: " + string.Join(", ", untitled));

        var undescribed = new List<string>();
        var described = 0;
        foreach (var tool in tools)
        {
            Assert.IsNotNull(tool.ProtocolTool.OutputSchema, tool.Name);
            described += Walk(tool.ProtocolTool.OutputSchema.Value, $"{tool.Name}:outputSchema", undescribed);
        }
        Assert.IsEmpty(undescribed, "Output properties with no description:\n" + string.Join('\n', undescribed));
        Assert.IsGreaterThan(300, described, "Every output property of every tool was walked.");

        CollectionAssert.AreEquivalent(
            Destructive,
            tools.Where(tool => tool.ProtocolTool.Annotations?.DestructiveHint is true).Select(tool => tool.Name).ToArray(),
            "destructiveHint is true exactly where a tool overwrites or removes what is stored.");

        var acquire = tools.Single(tool => tool.Name == "nendo.lease.acquire").Description ?? string.Empty;
        StringAssert.Contains(acquire, "The lease lasts until you release it", "A tool that hands out a handle states how long it lives.");

        // Named for the file since W-089, so two registered files are two names in a client.
        Assert.AreEqual("Nendo · fixture", client.ServerInfo.Title);
        Assert.AreEqual("https://thomasrohde.github.io/nendo/", client.ServerInfo.WebsiteUrl);

        // A list parameter that may be omitted takes entries that may not be null.
        var import = tools.Single(tool => tool.Name == "nendo.data.import_records").ProtocolTool.InputSchema;
        foreach (var (parameter, member) in new[] { ("records", "recordId"), ("columnMappings", "fieldId") })
        {
            var items = Branch(import.GetProperty("properties").GetProperty(parameter), "array").GetProperty("items");
            Assert.IsFalse(items.TryGetProperty("anyOf", out _), $"{parameter} advertises entries that may be null: {items}");
            Assert.AreEqual("object", items.GetProperty("type").GetString(), $"{parameter}: {items}");
            Assert.AreEqual("string", items.GetProperty("properties").GetProperty(member).GetProperty("type").GetString(),
                $"{parameter}.{member}: {items}");
        }
    }

    [TestMethod]
    public async Task ResponsesDoNotNameTheWebServerAndBuildStaticReadsMayBeKept()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = LatestProtocolTests.Client(host);
        using (var response = await http.PostAsync(http.BaseAddress, new StringContent("{}")))
        {
            Assert.IsFalse(response.Headers.Contains("Server"), $"Server: {string.Join(',', response.Headers.TryGetValues("Server", out var named) ? named : [])}");
        }

        foreach (var (uri, ttl) in new[]
                 {
                     ("nendo://application/vocabulary", 3_600_000L),
                     ("nendo://application/examples", 3_600_000L),
                     ("nendo://application/manifest", 0L),
                     ("nendo://application/describe", 0L),
                 })
        {
            var result = (await LatestProtocolTests.Send(http, "resources/read", new() { ["uri"] = uri })).GetProperty("result");
            Assert.AreEqual(ttl, result.GetProperty("ttlMs").GetInt64(), uri);
            Assert.AreEqual("private", result.GetProperty("cacheScope").GetString(), uri);
        }
    }

    [TestMethod]
    public async Task APageQueryIsASetAndAnEmptyCursorIsTheFirstPage()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 5);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var records = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records";

        var expected = Ids(await ProtocolResourceTests.ReadTextAsync(client, $"{records}?limit=2"));
        Assert.HasCount(2, expected);
        foreach (var query in new[] { "?limit=2&cursor=", "?cursor=&limit=2", "?limit=2&", "?&limit=2" })
        {
            CollectionAssert.AreEqual(expected, Ids(await ProtocolResourceTests.ReadTextAsync(client, records + query)), query);
        }
        var history = Ids(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=1&cursor="), "revisionId");
        Assert.HasCount(1, history);

        foreach (var (uri, sentence) in new[]
                 {
                     ($"{records}?limit=2&limt=3", "takes cursor, limit, recordId, sort, desc, filter and fields; 'limt' is not one of them."),
                     ($"{records}?limit=2&limit=3", "takes cursor, limit, recordId, sort, desc, filter and fields; 'limit' is given twice."),
                     ("nendo://application/manifest?limit=2", "nendo://application/manifest takes no query parameters; remove 'limit'."),
                 })
        {
            var error = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, uri), uri);
            Assert.AreEqual(McpErrorCode.InvalidParams, error.ErrorCode, uri);
            StringAssert.Contains(error.Message, "NENDO_INVALID_REQUEST", uri);
            StringAssert.Contains(error.Message, sentence, uri);
        }
    }

    private static string[] Ids(string page, string member = "recordId") =>
        [.. JsonDocument.Parse(page).RootElement.GetProperty("items").EnumerateArray().Select(item => item.GetProperty(member).GetString()!)];

    private static JsonElement Branch(JsonElement node, string type)
    {
        if (node.TryGetProperty("type", out var declared) && declared.GetString() == type) return node;
        return node.GetProperty("anyOf").EnumerateArray().Single(branch => branch.GetProperty("type").GetString() == type);
    }

    // Every property node, followed through anyOf branches, array items and map values.
    // Returns how many were walked.
    private static int Walk(JsonElement node, string path, List<string> undescribed)
    {
        if (node.ValueKind != JsonValueKind.Object) return 0;
        var walked = 0;
        if (node.TryGetProperty("properties", out var properties))
        {
            foreach (var property in properties.EnumerateObject())
            {
                walked++;
                if (!property.Value.TryGetProperty("description", out var description) ||
                    string.IsNullOrWhiteSpace(description.GetString()))
                {
                    undescribed.Add($"{path}/{property.Name}");
                }
                walked += Walk(property.Value, $"{path}/{property.Name}", undescribed);
            }
        }
        if (node.TryGetProperty("anyOf", out var branches))
        {
            foreach (var branch in branches.EnumerateArray()) walked += Walk(branch, path, undescribed);
        }
        if (node.TryGetProperty("items", out var items)) walked += Walk(items, $"{path}[]", undescribed);
        if (node.TryGetProperty("additionalProperties", out var values)) walked += Walk(values, $"{path}{{}}", undescribed);
        return walked;
    }
}
