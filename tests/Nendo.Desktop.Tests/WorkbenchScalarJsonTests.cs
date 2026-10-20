using System.Text.Json;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchScalarJsonTests
{
    private static JsonSerializerOptions Options => new() { Converters = { new WorkbenchScalarJsonConverter() } };

    [TestMethod]
    public void NumericEnvelopesRoundTripWithoutBinaryFloatingPoint()
    {
        const string source = "{\"large\":9223372036854775807,\"small\":-9223372036854775808,\"decimal\":0.1234567890123456789012345678,\"empty\":\"\",\"null\":null}";
        using var document = JsonDocument.Parse(source);
        var encoded = JsonSerializer.Serialize(document.RootElement, Options);
        StringAssert.Contains(encoded, "\"$nendoNumber\":\"9223372036854775807\"");
        var decoded = JsonSerializer.Deserialize<JsonElement>(encoded, Options);
        Assert.AreEqual(source, decoded.GetRawText());
        // Every response is at the one bridge version, and every number in it is enveloped.
        var response = WorkbenchProtocolHandler.Serialize(new(DesktopShellContract.BridgeProtocolVersion, "current", true, document.RootElement, null));
        StringAssert.Contains(response, "\"$nendoNumber\":\"-9223372036854775808\"");
    }

    [TestMethod]
    public void NumericEnvelopesCannotSmuggleObjectsOrAdditionalProperties()
    {
        foreach (var json in new[] { "{\"$nendoNumber\":\"{}\"}", "{\"$nendoNumber\":\"1\",\"extra\":2}", "{\"$nendoNumber\":true}", "{\"$nendoNumber\":\"NaN\"}" })
            Assert.ThrowsExactly<JsonException>(() => JsonSerializer.Deserialize<JsonElement>(json, Options));
    }

    [TestMethod]
    public void BothTransportsDecodeNestedEnvelopesWithTheSameExactLexemes()
    {
        foreach (var lexeme in new[] { "0", "-0", "9223372036854775807", "-9223372036854775808",
            "0.1234567890123456789012345678", "1.2300E-10", "1e+28", new string('9', 128) })
        {
            var source = $"[{{\"value\":{{\"$nendoNumber\":{JsonSerializer.Serialize(lexeme)}}}}},\" 1.00\\n\",null,true,{{}},[]]";
            using var input = JsonDocument.Parse(source);
            var expected = $"[{{\"value\":{lexeme}}},\" 1.00\\n\",null,true,{{}},[]]";
            Assert.AreEqual(expected, JsonSerializer.Deserialize<JsonElement>(source, Options).GetRawText(), lexeme);
            Assert.AreEqual(expected, NendoNumericEnvelope.Decode(input.RootElement).GetRawText(), lexeme);
        }
    }

    [TestMethod]
    public void BothTransportsRejectMalformedEnvelopesWithTheirOwnErrorContract()
    {
        var malformed = new[] { "", "NaN", "Infinity", "01", "1e", "1 2", "{}", "[1]", "\"1\"", new string('9', 129) }
            .Select(lexeme => $"{{\"$nendoNumber\":{JsonSerializer.Serialize(lexeme)}}}")
            .Concat(["{\"$nendoNumber\":null}", "{\"$nendoNumber\":1}", "{\"$nendoNumber\":true}",
                "{\"$nendoNumber\":\"1\",\"extra\":2}", "{\"$nendoNumber\":\"1\",\"$nendoNumber\":\"2\"}"]);
        foreach (var envelope in malformed)
        {
            var nested = $"{{\"values\":[{envelope}]}}";
            using var input = JsonDocument.Parse(nested);
            Assert.ThrowsExactly<JsonException>(() => JsonSerializer.Deserialize<JsonElement>(nested, Options), envelope);
            var error = Assert.ThrowsExactly<NendoValidationException>(() => NendoNumericEnvelope.Decode(input.RootElement), envelope);
            Assert.AreEqual("A numeric envelope must contain exactly one $nendoNumber string with a valid JSON number (1–128 characters).", error.Message);
        }
        var shape = Assert.ThrowsExactly<JsonException>(() => JsonSerializer.Deserialize<JsonElement>("{\"$nendoNumber\":null}", Options));
        StringAssert.StartsWith(shape.Message, "Invalid numeric envelope.");
        var scalar = Assert.ThrowsExactly<JsonException>(() => JsonSerializer.Deserialize<JsonElement>("{\"$nendoNumber\":\"{}\"}", Options));
        StringAssert.StartsWith(scalar.Message, "Numeric envelope requires a JSON number.");
    }
}
