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
        Assert.HasCount(26, tools);
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
        // the exact-number envelope — not an object of anything. One type per branch,
        // so a client that reads type as a single string takes each as written.
        var value = Node(schemas["nendo.data.set_field"], "value");
        var alternatives = value.GetProperty("anyOf").EnumerateArray().ToArray();
        Assert.HasCount(5, alternatives);
        CollectionAssert.AreEqual(
            new[] { "string", "number", "boolean", "null" },
            alternatives.Take(4).Select(alternative => alternative.GetProperty("type").GetString()).ToArray());
        Assert.AreEqual("object", alternatives[4].GetProperty("type").GetString());
        Assert.IsTrue(alternatives[4].GetProperty("properties").TryGetProperty("$nendoNumber", out _));
        Assert.IsFalse(alternatives[4].GetProperty("additionalProperties").GetBoolean());
        Assert.IsFalse(string.IsNullOrWhiteSpace(value.GetProperty("description").GetString()));
    }

    /// <summary>
    /// The MCP Inspector lints every tool's input and output schema with four rules:
    /// a bare boolean where a schema belongs (an error), a <c>type</c> array, a node with
    /// no validation keyword, and a <c>$ref</c> outside the document. On 2026-09-27 the
    /// twenty tools carried seventy-seven type arrays — every nullable member, in and
    /// out, exported as <c>["integer", "null"]</c> — and the Inspector warned on each.
    /// The same four rules run here over the same schemas, so a warning cannot return
    /// without failing the build. The rules are the Inspector's own
    /// (<c>core/json/schemaLint.ts</c>), ported rather than approximated.
    /// </summary>
    [TestMethod]
    public async Task EveryAdvertisedSchemaPassesTheInspectorLint()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        // Unattended lists every tool, including the one served only there.
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var tools = await client.ListToolsAsync();
        Assert.HasCount(27, tools);
        var findings = new List<string>();
        var nullableMembers = 0;
        foreach (var tool in tools)
        {
            Lint(tool.ProtocolTool.InputSchema, $"{tool.Name}:inputSchema", underNot: false, findings);
            var output = tool.ProtocolTool.OutputSchema;
            if (tool.Name == OutputSchemaContractTests.TextOnlyTool && output is null) continue;
            Assert.IsNotNull(output, $"{tool.Name} advertises no output schema.");
            Lint(output.Value, $"{tool.Name}:outputSchema", underNot: false, findings);
            nullableMembers += CountNullBranches(output.Value);
        }
        Assert.IsEmpty(findings, "The Inspector would report:\n" + string.Join("\n", findings));
        // The split kept the nullable members nullable rather than dropping the null
        // alternative: a lint that passed because every member became required would
        // have traded one refusal for another.
        Assert.IsGreaterThan(50, nullableMembers, "Output schemas no longer advertise their nullable members.");
    }

    private static readonly string[] InspectorConstraining =
    [
        "type", "$ref", "enum", "const", "anyOf", "oneOf", "allOf", "not", "properties", "items", "prefixItems",
        "additionalProperties", "patternProperties", "contains", "minimum", "maximum", "exclusiveMinimum",
        "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
        "uniqueItems", "required", "minProperties", "maxProperties", "if", "then", "else", "dependentSchemas",
        "dependentRequired", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "$dynamicRef",
    ];

    private static void Lint(JsonElement node, string path, bool underNot, List<string> findings)
    {
        if (node.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            findings.Add($"{path}: boolean-schema (error): a bare {node.GetRawText()} where a schema object belongs.");
            return;
        }
        if (node.ValueKind != JsonValueKind.Object) return;
        if (node.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.Array)
        {
            findings.Add($"{path}: type-union (warning): type is the array {type.GetRawText()}.");
        }
        if (!underNot && !InspectorConstraining.Any(keyword => node.TryGetProperty(keyword, out _)))
        {
            findings.Add($"{path}: untyped-schema (warning): no validation keyword.");
        }
        if (node.TryGetProperty("$ref", out var reference) &&
            reference.ValueKind == JsonValueKind.String &&
            reference.GetString() is { Length: > 0 } pointer &&
            !pointer.StartsWith('#'))
        {
            findings.Add($"{path}: remote-ref (warning): {pointer}.");
        }
        foreach (var property in node.EnumerateObject())
        {
            switch (property.Name)
            {
                case "properties" or "patternProperties" or "$defs" or "definitions" or "dependentSchemas":
                    if (property.Value.ValueKind != JsonValueKind.Object) break;
                    foreach (var child in property.Value.EnumerateObject())
                    {
                        Lint(child.Value, $"{path}/{property.Name}/{child.Name}", underNot, findings);
                    }
                    break;
                case "additionalProperties" or "unevaluatedProperties" or "unevaluatedItems" or "additionalItems"
                    when property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                    // Boolean-valued by the specification; the Inspector exempts these.
                    break;
                case "items" or "contains" or "not" or "if" or "then" or "else" or "propertyNames"
                    or "additionalProperties" or "unevaluatedProperties" or "unevaluatedItems" or "additionalItems":
                    Lint(property.Value, $"{path}/{property.Name}", underNot || property.Name == "not", findings);
                    break;
                case "anyOf" or "oneOf" or "allOf" or "prefixItems":
                    if (property.Value.ValueKind != JsonValueKind.Array) break;
                    var index = 0;
                    foreach (var alternative in property.Value.EnumerateArray())
                    {
                        Lint(alternative, $"{path}/{property.Name}/{index++}", underNot, findings);
                    }
                    break;
            }
        }
    }

    /// <summary>How many <c>anyOf</c> groups in the schema carry a <c>{"type": "null"}</c> branch.</summary>
    private static int CountNullBranches(JsonElement node)
    {
        if (node.ValueKind == JsonValueKind.Array) return node.EnumerateArray().Sum(CountNullBranches);
        if (node.ValueKind != JsonValueKind.Object) return 0;
        var count = 0;
        if (node.TryGetProperty("anyOf", out var alternatives) &&
            alternatives.ValueKind == JsonValueKind.Array &&
            alternatives.EnumerateArray().Any(alternative =>
                alternative.ValueKind == JsonValueKind.Object &&
                alternative.TryGetProperty("type", out var type) &&
                type.ValueKind == JsonValueKind.String &&
                type.GetString() == "null"))
        {
            count++;
        }
        return count + node.EnumerateObject().Sum(property => CountNullBranches(property.Value));
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
        StringAssert.Contains(values, "NENDO_INVALID_REQUEST: Record values must be a JSON object keyed by field ID.");

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
