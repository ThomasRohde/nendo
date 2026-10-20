using System.Text.Json;
using System.Text.Json.Serialization;
using Nendo.Transport;

namespace Nendo.Desktop;

/// <summary>Bridge-only numeric envelopes. The application service still receives JSON scalars.</summary>
internal sealed class WorkbenchScalarJsonConverter : JsonConverter<JsonElement>
{
    public override JsonElement Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return NumericEnvelopeJson.Decode(document.RootElement);
    }

    public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options) =>
        WriteEncoded(writer, value);

    private static void WriteEncoded(Utf8JsonWriter writer, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number)
        {
            writer.WriteStartObject();
            writer.WriteString("$nendoNumber", value.GetRawText());
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject())
            {
                writer.WritePropertyName(property.Name);
                WriteEncoded(writer, property.Value);
            }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray();
            foreach (var item in value.EnumerateArray()) WriteEncoded(writer, item);
            writer.WriteEndArray();
        }
        else value.WriteTo(writer);
    }
}
