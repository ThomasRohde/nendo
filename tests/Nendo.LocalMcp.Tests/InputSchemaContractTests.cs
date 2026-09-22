using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// What the tool list promises about its arguments. A <c>JsonElement</c> parameter
/// exported as a schema carrying a description and no validation keyword, which the
/// MCP Inspector flags as a portability warning: some clients refuse a node that says
/// nothing about its type. Five nodes were unconstrained — the operation payload on
/// add_operations and amend, the value map on create_record and on each create_records
/// entry, and the value on set_field. Every node now declares what it accepts, and a
/// wrong shape is still refused by Nendo with a sentence, not by the binder without one.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class InputSchemaContractTests
{
    private static readonly string[] Constraining = ["type", "$ref", "enum", "const", "anyOf", "oneOf", "allOf", "properties", "items"];

    [TestMethod]
    public async Task EveryInputSchemaNodeDeclaresWhatItAccepts()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var tools = await client.ListToolsAsync();
        Assert.HasCount(18, tools);
        var unconstrained = new List<string>();
        var schemas = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var tool in tools)
        {
            schemas[tool.Name] = tool.ProtocolTool.InputSchema;
            Walk(tool.ProtocolTool.InputSchema, tool.Name, unconstrained);
        }
        Assert.IsEmpty(unconstrained, "Nodes with no validation keyword:\n" + string.Join("\n", unconstrained));

        // The four object-only maps advertise an object and keep their description.
        foreach (var (tool, path) in new[]
                 {
                     ("nendo.change_set.add_operations", "mutations/items/operations/items/payload"),
                     ("nendo.change_set.amend", "mutations/items/operations/items/payload"),
                     ("nendo.data.create_record", "values"),
                     ("nendo.data.create_records", "records/items/values"),
                 })
        {
            var node = Node(schemas[tool], path);
            Assert.AreEqual("object", node.GetProperty("type").GetString(), $"{tool}/{path}");
            Assert.IsTrue(node.GetProperty("additionalProperties").GetBoolean(), $"{tool}/{path}");
            Assert.IsFalse(string.IsNullOrWhiteSpace(node.GetProperty("description").GetString()), $"{tool}/{path} lost its description.");
        }

        // A field value advertises exactly what the runtime takes: a scalar, null, or
        // the exact-number envelope — not an object of anything.
        var value = Node(schemas["nendo.data.set_field"], "value");
        var alternatives = value.GetProperty("anyOf").EnumerateArray().ToArray();
        Assert.HasCount(2, alternatives);
        CollectionAssert.AreEquivalent(
            new[] { "string", "number", "boolean", "null" },
            alternatives[0].GetProperty("type").EnumerateArray().Select(item => item.GetString()).ToArray());
        Assert.AreEqual("object", alternatives[1].GetProperty("type").GetString());
        Assert.IsTrue(alternatives[1].GetProperty("properties").TryGetProperty("$nendoNumber", out _));
        Assert.IsFalse(alternatives[1].GetProperty("additionalProperties").GetBoolean());
        Assert.IsFalse(string.IsNullOrWhiteSpace(value.GetProperty("description").GetString()));
    }

    /// <summary>
    /// The typed schema did not move validation into the binder. A payload that is not
    /// an object, a value map that is not a map and a field value that is an object are
    /// each refused where they were before, naming the operation or the rule.
    /// </summary>
    [TestMethod]
    public async Task AWrongShapeIsStillRefusedByNendoWithASentence()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Structured<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
        var begun = Structured<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Wrong shapes", ["idempotencyKey"] = "shape-begin" }));

        var payload = await RefusalAsync(client, "nendo.change_set.add_operations", new(owned)
        {
            ["changeSetId"] = begun.ChangeSetId,
            ["mutations"] = JsonSerializer.SerializeToElement(new[]
            {
                new { description = "Not an object", operations = new[] { new { operationType = "schema.createEntity", payload = 5 } } },
            }),
            ["idempotencyKey"] = "shape-payload",
        });
        StringAssert.Contains(payload, "NENDO_INVALID_REQUEST");
        StringAssert.Contains(payload, "The payload of schema.createEntity must be a JSON object.");

        var values = await RefusalAsync(client, "nendo.data.create_record", new(owned)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["recordId"] = "shape-values",
            ["values"] = "not a map",
            ["idempotencyKey"] = "shape-values",
        });
        StringAssert.Contains(values, "NENDO_INVALID_REQUEST: Record values must be a bounded JSON object.");

        var value = await RefusalAsync(client, "nendo.data.set_field", new(owned)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["recordId"] = "any",
            ["fieldId"] = NendoApplicationService.IdeaTitleFieldId,
            ["expectedRecordVersion"] = 1L,
            ["value"] = new Dictionary<string, object?> { ["not"] = "a scalar" },
            ["idempotencyKey"] = "shape-value",
        });
        StringAssert.Contains(value, "NENDO_INVALID_REQUEST: Field values must be scalar JSON values.");
    }

    /// <summary>
    /// Every schema object must say something about what it accepts. The keyword lists
    /// are recursed rather than trusted, so a bare node three levels down is found.
    /// </summary>
    private static void Walk(JsonElement node, string path, List<string> unconstrained)
    {
        if (node.ValueKind != JsonValueKind.Object) return;
        if (!Constraining.Any(keyword => node.TryGetProperty(keyword, out _)))
        {
            unconstrained.Add($"{path}: {node.GetRawText()}");
        }
        if (node.TryGetProperty("properties", out var properties))
        {
            foreach (var property in properties.EnumerateObject())
            {
                Walk(property.Value, $"{path}/{property.Name}", unconstrained);
            }
        }
        foreach (var keyword in new[] { "items", "additionalProperties", "not" })
        {
            if (node.TryGetProperty(keyword, out var child)) Walk(child, $"{path}/{keyword}", unconstrained);
        }
        foreach (var keyword in new[] { "anyOf", "oneOf", "allOf" })
        {
            if (!node.TryGetProperty(keyword, out var alternatives)) continue;
            var index = 0;
            foreach (var alternative in alternatives.EnumerateArray())
            {
                Walk(alternative, $"{path}/{keyword}/{index++}", unconstrained);
            }
        }
        foreach (var keyword in new[] { "$defs", "definitions" })
        {
            if (!node.TryGetProperty(keyword, out var definitions)) continue;
            foreach (var definition in definitions.EnumerateObject())
            {
                Walk(definition.Value, $"{path}/{keyword}/{definition.Name}", unconstrained);
            }
        }
    }

    /// <summary>
    /// Walks a property path: a name steps into <c>properties</c>, <c>items</c> steps
    /// into the array item schema, and a local reference is followed from the root.
    /// </summary>
    private static JsonElement Node(JsonElement root, string path)
    {
        var current = root;
        foreach (var segment in path.Split('/'))
        {
            current = Resolve(root, current);
            current = segment == "items"
                ? current.GetProperty("items")
                : current.GetProperty("properties").GetProperty(segment);
        }
        return Resolve(root, current);
    }

    private static JsonElement Resolve(JsonElement root, JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object ||
            !node.TryGetProperty("$ref", out var reference) ||
            reference.GetString() is not { } pointer ||
            !pointer.StartsWith("#/", StringComparison.Ordinal))
        {
            return node;
        }
        var current = root;
        foreach (var segment in pointer[2..].Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            current = current.GetProperty(segment.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal));
        }
        return current;
    }

    private static async Task<string> RefusalAsync(McpClient client, string name, Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.IsTrue(result.IsError, $"{name} was expected to be refused: {JsonSerializer.Serialize(result)}");
        return string.Join(' ', result.Content.OfType<ModelContextProtocol.Protocol.TextContentBlock>().Select(block => block.Text));
    }

    private static T Structured<T>(ModelContextProtocol.Protocol.CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
