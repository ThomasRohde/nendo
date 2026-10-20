using System.Text.Json;
using Nendo.Engine;
using Nendo.Transport;

namespace Nendo.LocalMcp;

/// <summary>Client-neutral transport decoding before canonical operation construction.</summary>
internal static class NendoNumericEnvelope
{
    internal static JsonElement Decode(JsonElement value)
    {
        try
        {
            return NumericEnvelopeJson.Decode(value);
        }
        catch (JsonException)
        {
            throw new NendoValidationException("A numeric envelope must contain exactly one $nendoNumber string with a valid JSON number (1–128 characters).");
        }
    }
}
