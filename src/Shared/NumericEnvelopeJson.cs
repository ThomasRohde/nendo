using System.Text.Json;

namespace Nendo.Transport;

/// <summary>Shared transport grammar; application services receive only decoded JSON scalars.</summary>
/// <remarks>
/// Desktop and LocalMcp each compile a copy, and Nendo.Desktop.Tests sees both, so a test that
/// names this type cannot resolve it. Tests reach it through each adapter's own entry point.
/// </remarks>
internal static class NumericEnvelopeJson
{
    internal static JsonElement Decode(JsonElement value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) Write(writer, value);
        using var document = JsonDocument.Parse(stream.ToArray());
        return document.RootElement.Clone();
    }

    private static void Write(Utf8JsonWriter writer, JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            if (value.TryGetProperty("$nendoNumber", out var number))
            {
                if (value.EnumerateObject().Count() != 1 || number.ValueKind != JsonValueKind.String ||
                    number.GetString() is not { Length: > 0 and <= 128 } lexeme)
                    throw new JsonException("Invalid numeric envelope.");
                using var parsed = JsonDocument.Parse(lexeme);
                if (parsed.RootElement.ValueKind != JsonValueKind.Number)
                    throw new JsonException("Numeric envelope requires a JSON number.");
                parsed.RootElement.WriteTo(writer);
                return;
            }
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject())
            {
                writer.WritePropertyName(property.Name);
                Write(writer, property.Value);
            }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray();
            foreach (var item in value.EnumerateArray()) Write(writer, item);
            writer.WriteEndArray();
        }
        else value.WriteTo(writer);
    }
}
