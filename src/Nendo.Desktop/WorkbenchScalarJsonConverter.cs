using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Desktop;

/// <summary>Bridge-only numeric envelopes. The application service still receives JSON scalars.</summary>
internal sealed class WorkbenchScalarJsonConverter : JsonConverter<JsonElement>
{
    public override JsonElement Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) Transform(writer, document.RootElement, encode: false);
        using var decoded = JsonDocument.Parse(stream.ToArray());
        return decoded.RootElement.Clone();
    }

    public override void Write(Utf8JsonWriter writer, JsonElement value, JsonSerializerOptions options) =>
        Transform(writer, value, encode: true);

    private static void Transform(Utf8JsonWriter writer, JsonElement value, bool encode)
    {
        if (encode && value.ValueKind == JsonValueKind.Number)
        {
            writer.WriteStartObject();
            writer.WriteString("$nendoNumber", value.GetRawText());
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Object)
        {
            if (!encode && value.TryGetProperty("$nendoNumber", out var number))
            {
                if (value.EnumerateObject().Count() != 1 || number.ValueKind != JsonValueKind.String || number.GetString() is not { Length: > 0 and <= 128 } lexeme)
                    throw new JsonException("Invalid numeric envelope.");
                using var parsed = JsonDocument.Parse(lexeme);
                if (parsed.RootElement.ValueKind != JsonValueKind.Number) throw new JsonException("Numeric envelope requires a JSON number.");
                parsed.RootElement.WriteTo(writer);
                return;
            }
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject())
            {
                writer.WritePropertyName(property.Name);
                Transform(writer, property.Value, encode);
            }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray();
            foreach (var item in value.EnumerateArray()) Transform(writer, item, encode);
            writer.WriteEndArray();
        }
        else value.WriteTo(writer);
    }
}
