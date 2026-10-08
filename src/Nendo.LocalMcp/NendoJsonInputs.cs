using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.AI;

namespace Nendo.LocalMcp;

/// <summary>
/// A JSON object sent as a tool argument: an operation payload or a record's value map.
/// <para>
/// It binds any JSON, exactly as the <see cref="JsonElement"/> it wraps did, so a
/// value of the wrong shape is still refused by Nendo with a sentence that names the
/// operation or the field — not by the SDK's binder with "An error occurred invoking".
/// What changes is what the tool list says: a <see cref="JsonElement"/> exports as the
/// schema that accepts anything, which the MCP Inspector flags because some clients
/// refuse a node with no validation keyword. This type advertises <c>object</c>.
/// </para>
/// </summary>
[JsonConverter(typeof(NendoObjectInput.Converter))]
public readonly record struct NendoObjectInput(JsonElement Element)
{
    public static implicit operator NendoObjectInput(JsonElement element) => new(element);

    internal sealed class Converter : JsonConverter<NendoObjectInput>
    {
        public override bool HandleNull => true;

        public override NendoObjectInput Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            new(JsonElement.ParseValue(ref reader));

        public override void Write(Utf8JsonWriter writer, NendoObjectInput value, JsonSerializerOptions options) =>
            NendoJsonInputs.Write(writer, value.Element);
    }
}

/// <summary>
/// One field value sent as a tool argument: a JSON scalar, <c>null</c>, or the
/// <c>{"$nendoNumber": "…"}</c> envelope that carries an exact number. Binds any JSON
/// for the same reason <see cref="NendoObjectInput"/> does, and advertises exactly
/// those alternatives.
/// </summary>
[JsonConverter(typeof(NendoScalarInput.Converter))]
public readonly record struct NendoScalarInput(JsonElement Element)
{
    public static implicit operator NendoScalarInput(JsonElement element) => new(element);

    internal sealed class Converter : JsonConverter<NendoScalarInput>
    {
        public override bool HandleNull => true;

        public override NendoScalarInput Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            new(JsonElement.ParseValue(ref reader));

        public override void Write(Utf8JsonWriter writer, NendoScalarInput value, JsonSerializerOptions options) =>
            NendoJsonInputs.Write(writer, value.Element);
    }
}

/// <summary>
/// What the advertised schemas say, applied through the schema exporter's transform hook,
/// which visits every node of every input and output schema: the shapes of the two
/// argument types above, and one rule for every other node — it names one type.
/// </summary>
internal static class NendoJsonInputs
{
    internal static JsonNode Advertise(AIJsonSchemaCreateContext context, JsonNode node)
    {
        var type = context.TypeInfo.Type;
        if (type == typeof(NendoObjectInput)) return Merge(node, ObjectShape());
        if (type == typeof(NendoScalarInput)) return Merge(node, ScalarShape());
        NendoWireDescriptions.Describe(context, node);
        var advertised = OneTypePerNode(node);
        if (ClosedInputs.Contains(type))
        {
            // A list parameter that may be omitted exported its items, and their members,
            // as nullable too: import_records advertised records whose entries and IDs could
            // be null. No entry of any list a tool takes is null, and a closed record takes
            // no key it does not declare.
            advertised = WithoutNull(advertised);
            if (advertised is JsonObject closed) closed["additionalProperties"] = false;
        }
        else if (context.PropertyInfo?.AttributeProvider is PropertyInfo member &&
                 member.DeclaringType is { } declaring && ClosedInputs.Contains(declaring) &&
                 !member.PropertyType.IsValueType &&
                 new NullabilityInfoContext().Create(member).ReadState == NullabilityState.NotNull)
        {
            advertised = WithoutNull(advertised);
        }
        return advertised;
    }

    /// <summary>
    /// The records a tool takes inside its arguments. Each is closed: the argument contract
    /// refuses a key it does not declare, and the advertised schema says so.
    /// </summary>
    internal static readonly IReadOnlySet<Type> ClosedInputs = new HashSet<Type>
    {
        typeof(NendoRecordInput),
        typeof(NendoReferenceInput),
        typeof(NendoRecordWriteInput),
        typeof(NendoRecordKeyInput),
        typeof(NendoCsvColumnMapping),
        typeof(NendoAgentMutationInput),
        typeof(NendoAgentOperationInput),
    };

    // The null branch goes; a single branch left is folded back into the node, so the node
    // reads as it would have had the exporter never made it nullable.
    private static JsonNode WithoutNull(JsonNode node)
    {
        if (node is not JsonObject target || target["anyOf"] is not JsonArray branches) return node;
        var kept = branches
            .Where(branch => !(branch is JsonObject candidate && candidate.Count == 1 &&
                               candidate["type"]?.GetValue<string>() == "null"))
            .ToList();
        if (kept.Count == branches.Count) return node;
        target.Remove("anyOf");
        if (kept.Count == 1 && kept[0] is JsonObject only)
        {
            foreach (var (key, value) in only.ToList())
            {
                only.Remove(key);
                target[key] = value;
            }
            return target;
        }
        var remaining = new JsonArray();
        foreach (var branch in kept)
        {
            branch!.Parent?.AsArray().Remove(branch);
            remaining.Add(branch);
        }
        target["anyOf"] = remaining;
        return target;
    }

    /// <summary>A tool's arguments object, declared closed.</summary>
    internal static JsonElement Closed(JsonElement inputSchema)
    {
        var schema = JsonNode.Parse(inputSchema.GetRawText())!.AsObject();
        schema["additionalProperties"] = false;
        return JsonSerializer.SerializeToElement(schema);
    }

    internal static void Write(Utf8JsonWriter writer, JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Undefined) writer.WriteNullValue();
        else element.WriteTo(writer);
    }

    /// <summary>
    /// The exporter writes a nullable member as <c>"type": ["integer", "null"]</c>. That is
    /// valid JSON Schema, and the MCP Inspector warns on every such node: a client that maps
    /// tool schemas onto a single-type dialect, as the OpenAPI subset some model providers
    /// use does, drops the constraint or refuses the whole tool. Seventy-seven nodes across
    /// the twenty tools carried it, in and out. The array becomes one <c>anyOf</c> branch per
    /// type, each carrying the keywords that belong to that type, while the description and
    /// the default stay on the node.
    /// </summary>
    internal static JsonNode OneTypePerNode(JsonNode node)
    {
        if (node is not JsonObject target ||
            !target.TryGetPropertyValue("type", out var declared) ||
            declared is not JsonArray types)
        {
            return node;
        }
        var names = types
            .Select(entry => entry is JsonValue value && value.TryGetValue<string>(out var name) ? name : null)
            .ToArray();
        if (names.Length == 0 || names.Any(name => name is null))
        {
            return node;
        }
        target.Remove("type");
        var branches = new JsonArray();
        foreach (var name in names.Distinct(StringComparer.Ordinal))
        {
            var branch = new JsonObject { ["type"] = name };
            foreach (var keyword in KeywordsOf(name!))
            {
                if (target.TryGetPropertyValue(keyword, out var owned))
                {
                    target.Remove(keyword);
                    branch[keyword] = owned;
                }
            }
            branches.Add(branch);
        }
        target["anyOf"] = branches;
        return target;
    }

    // The keywords JSON Schema 2020-12 scopes to one type. Each moves into the branch of
    // that type, so a branch says everything about the instance it accepts.
    private static readonly string[] ObjectKeywords =
    [
        "properties", "required", "additionalProperties", "patternProperties", "propertyNames",
        "minProperties", "maxProperties", "dependentRequired", "dependentSchemas", "unevaluatedProperties",
    ];

    private static readonly string[] ArrayKeywords =
    [
        "items", "prefixItems", "contains", "minItems", "maxItems", "uniqueItems",
        "minContains", "maxContains", "unevaluatedItems",
    ];

    private static readonly string[] StringKeywords =
    [
        "minLength", "maxLength", "pattern", "format", "contentEncoding", "contentMediaType",
    ];

    private static readonly string[] NumberKeywords =
    [
        "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    ];

    private static string[] KeywordsOf(string type) => type switch
    {
        "object" => ObjectKeywords,
        "array" => ArrayKeywords,
        "string" => StringKeywords,
        "number" or "integer" => NumberKeywords,
        _ => [],
    };

    private static JsonObject ObjectShape() => new()
    {
        ["type"] = "object",
        ["additionalProperties"] = true,
    };

    // One type per branch here too: a client that reads type as a single string
    // takes each alternative as written.
    private static JsonObject ScalarShape() => new()
    {
        ["anyOf"] = new JsonArray(
            new JsonObject { ["type"] = "string" },
            new JsonObject { ["type"] = "number" },
            new JsonObject { ["type"] = "boolean" },
            new JsonObject { ["type"] = "null" },
            new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject { ["$nendoNumber"] = new JsonObject { ["type"] = "string" } },
                ["required"] = new JsonArray("$nendoNumber"),
                ["additionalProperties"] = false,
            }),
    };

    // The exporter has already placed the description on the node; the shape is
    // added beside it rather than replacing it.
    private static JsonNode Merge(JsonNode node, JsonObject shape)
    {
        var target = node as JsonObject ?? new JsonObject();
        foreach (var (key, value) in shape)
        {
            target[key] = value?.DeepClone();
        }
        return target;
    }
}
