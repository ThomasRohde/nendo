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

/// <summary>The shapes the two argument types advertise, applied through the schema exporter's transform hook.</summary>
internal static class NendoJsonInputs
{
    internal static JsonNode Advertise(AIJsonSchemaCreateContext context, JsonNode node)
    {
        var type = context.TypeInfo.Type;
        if (type == typeof(NendoObjectInput)) return Merge(node, ObjectShape());
        if (type == typeof(NendoScalarInput)) return Merge(node, ScalarShape());
        return node;
    }

    internal static void Write(Utf8JsonWriter writer, JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Undefined) writer.WriteNullValue();
        else element.WriteTo(writer);
    }

    private static JsonObject ObjectShape() => new()
    {
        ["type"] = "object",
        ["additionalProperties"] = true,
    };

    private static JsonObject ScalarShape() => new()
    {
        ["anyOf"] = new JsonArray(
            new JsonObject { ["type"] = new JsonArray("string", "number", "boolean", "null") },
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
