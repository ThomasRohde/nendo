using System.Text.Json;

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
        var oldResponse = WorkbenchProtocolHandler.Serialize(new(5, "old", true, document.RootElement, null));
        Assert.DoesNotContain("$nendoNumber", oldResponse);
        var newResponse = WorkbenchProtocolHandler.Serialize(new(6, "new", true, document.RootElement, null));
        StringAssert.Contains(newResponse, "$nendoNumber");
    }

    [TestMethod]
    public void NumericEnvelopesCannotSmuggleObjectsOrAdditionalProperties()
    {
        foreach (var json in new[] { "{\"$nendoNumber\":\"{}\"}", "{\"$nendoNumber\":\"1\",\"extra\":2}", "{\"$nendoNumber\":true}", "{\"$nendoNumber\":\"NaN\"}" })
            Assert.ThrowsExactly<JsonException>(() => JsonSerializer.Deserialize<JsonElement>(json, Options));
    }
}
