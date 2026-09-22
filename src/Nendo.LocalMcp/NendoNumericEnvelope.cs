using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>Client-neutral transport decoding before canonical operation construction.</summary>
internal static class NendoNumericEnvelope
{
    internal static JsonElement Decode(JsonElement value)
    {
        try
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream)) Write(writer, value);
            using var document = JsonDocument.Parse(stream.ToArray());
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new NendoValidationException("A numeric envelope must contain exactly one $nendoNumber string with a valid JSON number (1–128 characters).");
        }
    }

    private static void Write(Utf8JsonWriter writer, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            if (value.TryGetProperty("$nendoNumber", out var number))
            {
                if (value.EnumerateObject().Count() != 1 || number.ValueKind != JsonValueKind.String ||
                    number.GetString() is not { Length: > 0 and <= 128 } lexeme) throw new JsonException();
                using var parsed = JsonDocument.Parse(lexeme);
                if (parsed.RootElement.ValueKind != JsonValueKind.Number) throw new JsonException();
                parsed.RootElement.WriteTo(writer);
                return;
            }
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject()) { writer.WritePropertyName(property.Name); Write(writer, property.Value); }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray(); foreach (var item in value.EnumerateArray()) Write(writer, item); writer.WriteEndArray();
        }
        else value.WriteTo(writer);
    }
}
