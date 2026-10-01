using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-083. Measured on 2026-09-27 against the installed host: a missing required argument
/// was answered "An error occurred invoking 'nendo.data.set_field'." and nothing else; an
/// unknown key was refused without its name, and an unknown key inside a record was dropped
/// without a word; a tool served one level up was "Unknown tool", so the level codes Help
/// documents could not occur; and an unknown tool was a tool error, where the specification
/// asks for a protocol error.
/// </summary>
[TestClass]
public sealed class ToolRefusalTests
{
    [TestMethod]
    public async Task EveryWrongShapeIsRefusedNamingTheArgumentAndWhatIsAccepted()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        var entity = NendoApplicationService.IdeaEntityId;
        Dictionary<string, object?> Owned(params (string Key, object? Value)[] values)
        {
            var arguments = new Dictionary<string, object?>
            {
                ["applicationHandle"] = grant.ApplicationHandle,
                ["leaseId"] = grant.LeaseId,
            };
            foreach (var (key, value) in values) arguments[key] = value;
            return arguments;
        }
        static Dictionary<string, object?> Replace(Dictionary<string, object?> arguments, string key, object? value)
        {
            arguments[key] = value;
            return arguments;
        }
        (string, object?)[] SetField(object? version) =>
        [
            ("entityId", entity), ("recordId", "idea-absent"), ("fieldId", "field-absent"),
            ("expectedRecordVersion", version), ("value", "x"), ("idempotencyKey", "set-field-shape"),
        ];

        var cases = new (string Tool, Dictionary<string, object?> Arguments, string[] Sentences)[]
        {
            // F-171: a missing required argument had no sentence and no code.
            ("nendo.data.set_field", Owned([.. SetField(1).Where(pair => pair.Item1 != "idempotencyKey")]),
                ["NENDO_INVALID_REQUEST: nendo.data.set_field was not called.", "It requires idempotencyKey."]),
            // F-172: an unknown key named neither itself nor what is accepted.
            ("nendo.data.set_field", Owned([.. SetField(1), ("expectedRecordVerison", 1)]),
                ["It does not take 'expectedRecordVerison'; it takes applicationHandle, leaseId, entityId, recordId, " +
                 "fieldId, expectedRecordVersion, value and idempotencyKey, and optionally expectedTargetRecordVersion."]),
            // F-172: an unknown key inside a record was dropped, and the write went ahead without it.
            ("nendo.data.create_records", Owned(("entityId", entity), ("idempotencyKey", "nested-record"), ("records", new object[]
                {
                    new Dictionary<string, object?> { ["recordId"] = "idea-new", ["values"] = new { }, ["expectedTargetVersionz"] = new { } },
                })),
                ["records[0] does not take 'expectedTargetVersionz'; a record takes recordId and values, and optionally expectedTargetVersions and keptInNewFiles."]),
            ("nendo.change_set.add_operations", Owned(("changeSetId", "change-set-absent"), ("idempotencyKey", "nested-operation"), ("mutations", new object[]
                {
                    new Dictionary<string, object?>
                    {
                        ["description"] = "A mutation with a misspelt key.",
                        ["operationz"] = 1,
                        ["operations"] = new object[]
                        {
                            new Dictionary<string, object?> { ["operationType"] = "schema.createEntity", ["payload"] = new { }, ["extra"] = true },
                        },
                    },
                })),
                ["mutations[0] does not take 'operationz'; a mutation takes description and operations.",
                 "mutations[0].operations[0] does not take 'extra'; an operation takes operationType and payload."]),
            ("nendo.data.create_records", Owned(("entityId", entity), ("idempotencyKey", "nested-missing"), ("records", new object[]
                {
                    new Dictionary<string, object?> { ["values"] = new { } },
                })),
                ["records[0] requires recordId."]),
            // A value of the wrong kind is named, with what it must be.
            ("nendo.data.set_field", Owned(SetField("one")),
                ["expectedRecordVersion must be a whole number; it was a string."]),
            ("nendo.data.set_field", Replace(Owned(SetField(1)), "applicationHandle", null),
                ["applicationHandle must be a string; it was null."]),
            ("nendo.data.import_records", Owned(("entityId", entity), ("format", "csv"), ("idempotencyKey", "mapping-kind"), ("csv", "a\n1"),
                ("columnMappings", new object[] { new Dictionary<string, object?> { ["column"] = "first", ["fieldId"] = "field-a" } })),
                ["columnMappings[0].column must be a whole number; it was a string."]),
            ("nendo.data.create_record", Owned(("entityId", entity), ("recordId", "idea-new"), ("values", new { }), ("idempotencyKey", "map-kind"),
                ("expectedTargetVersions", new Dictionary<string, object?> { ["field-ref"] = "latest" })),
                ["expectedTargetVersions.field-ref must be a whole number; it was a string."]),
        };
        foreach (var (tool, arguments, sentences) in cases)
        {
            var result = await client.CallToolAsync(tool, arguments);
            var text = Text(result);
            Assert.IsTrue(result.IsError, $"{tool} was not refused: {text}");
            foreach (var sentence in sentences) StringAssert.Contains(text, sentence, $"{tool}: {text}");
        }

        // A refusal is never stricter than the binder: a whole number sent as a string binds,
        // so it is not refused here, and the call reaches Nendo.
        var lenient = Text(await client.CallToolAsync("nendo.data.set_field", Owned(SetField("1"))));
        Assert.DoesNotContain("expectedRecordVersion must be", lenient, StringComparison.Ordinal);
        Assert.DoesNotContain("NENDO_INVALID_REQUEST: nendo.data.set_field was not called", lenient, StringComparison.Ordinal);
    }

    [TestMethod]
    [DataRow(AgentAccessMode.ReadOnly, "nendo.lease.acquire", "NENDO_EDIT_DATA_REQUIRED", "Edit data", "Inspect")]
    [DataRow(AgentAccessMode.DataMutation, "nendo.change_set.begin", "NENDO_SHAPE_APP_REQUIRED", "Shape app", "Edit data")]
    [DataRow(AgentAccessMode.ApplicationAuthoring, "nendo.change_set.accept", "NENDO_UNATTENDED_REQUIRED", "Unattended", "Shape app")]
    public async Task AToolFromAHigherLevelNamesThatLevelAndAnUnknownToolIsAProtocolError(
        AgentAccessMode mode, string tool, string code, string served, string current)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            mode,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var refused = await Assert.ThrowsExactlyAsync<McpProtocolException>(
            () => client.CallToolAsync(tool, new Dictionary<string, object?>()).AsTask());
        Assert.AreEqual(McpErrorCode.InvalidParams, refused.ErrorCode);
        StringAssert.Contains(refused.Message,
            $"{code}: {tool} is served from {served}, and this file session is at {current}. " +
            $"Ask the person to raise agent access to {served} on the Agent page in Nendo.");

        var unknown = await Assert.ThrowsExactlyAsync<McpProtocolException>(
            () => client.CallToolAsync("nendo.sql.execute", new Dictionary<string, object?>()).AsTask());
        Assert.AreEqual(McpErrorCode.InvalidParams, unknown.ErrorCode);
        StringAssert.Contains(unknown.Message, "NENDO_TOOL_UNAVAILABLE: No tool is named 'nendo.sql.execute'.");
    }

    /// <summary>
    /// The contract the boundary enforces is read from the tool methods; the schema a client
    /// reads is generated from the same methods by the SDK. This holds them equal, key by
    /// key and level by level, so neither can move without the other.
    /// </summary>
    [TestMethod]
    public async Task TheArgumentContractIsWhatEveryToolAdvertises()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var tools = await client.ListToolsAsync();
        CollectionAssert.AreEquivalent(NendoToolBoundary.Tools.Keys.ToArray(), tools.Select(tool => tool.Name).ToArray());

        var findings = new List<string>();
        var compared = 0;
        foreach (var tool in tools)
        {
            compared += Compare(NendoToolBoundary.Tools[tool.Name].Arguments, tool.ProtocolTool.InputSchema, tool.Name, findings);
        }
        Assert.IsEmpty(findings, "The enforced contract and the advertised schema differ:\n" + string.Join('\n', findings));
        Assert.IsGreaterThan(100, compared, "Every argument and every closed record key was compared.");
    }

    private static int Compare(IReadOnlyList<NendoToolBoundary.Member> members, JsonElement schema, string path, List<string> findings)
    {
        if (!schema.TryGetProperty("additionalProperties", out var additional) || additional.ValueKind != JsonValueKind.False)
        {
            findings.Add($"{path}: the schema does not declare the object closed.");
        }
        var properties = schema.GetProperty("properties").EnumerateObject().ToDictionary(property => property.Name, property => property.Value);
        var required = schema.TryGetProperty("required", out var declared)
            ? declared.EnumerateArray().Select(name => name.GetString()!).ToHashSet(StringComparer.Ordinal)
            : [];
        var compared = 0;
        foreach (var name in properties.Keys.Except(members.Select(member => member.Name))) findings.Add($"{path}.{name}: advertised, not enforced.");
        foreach (var member in members)
        {
            compared++;
            if (!properties.TryGetValue(member.Name, out var property))
            {
                findings.Add($"{path}.{member.Name}: enforced, not advertised.");
                continue;
            }
            if (member.Required != required.Contains(member.Name)) findings.Add($"{path}.{member.Name}: required {member.Required} here, {!member.Required} in the schema.");
            compared += CompareShape(member.Shape, property, $"{path}.{member.Name}", findings);
        }
        return compared;
    }

    private static int CompareShape(NendoToolBoundary.Shape shape, JsonElement node, string path, List<string> findings)
    {
        if (shape is NendoToolBoundary.Open) return 0;
        var branches = node.TryGetProperty("anyOf", out var anyOf) ? anyOf.EnumerateArray().ToList() : [node];
        var types = branches.Select(branch => branch.GetProperty("type").GetString()).ToList();
        if (types.Contains("null") != shape.Nullable) findings.Add($"{path}: nullable {shape.Nullable} here, not in the schema.");
        var value = branches.Single(branch => branch.GetProperty("type").GetString() != "null");
        switch (shape)
        {
            case NendoToolBoundary.Scalar scalar:
                var expected = scalar.Kind is "int32" ? "integer" : scalar.Kind;
                if (value.GetProperty("type").GetString() != expected) findings.Add($"{path}: {expected} here, {value.GetProperty("type")} in the schema.");
                return 0;
            case NendoToolBoundary.ListOf list:
                return CompareShape(list.Item, value.GetProperty("items"), $"{path}[]", findings);
            case NendoToolBoundary.MapOf map:
                return CompareShape(map.Value, value.GetProperty("additionalProperties"), $"{path}{{}}", findings);
            case NendoToolBoundary.Closed closed:
                return Compare(closed.Members, value, path, findings);
            default:
                findings.Add($"{path}: no comparison for {shape}.");
                return 0;
        }
    }

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));
}
