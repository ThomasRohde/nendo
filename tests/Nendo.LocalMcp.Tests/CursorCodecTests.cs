using ModelContextProtocol;

namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class CursorCodecTests
{
    [TestMethod]
    [DataRow(0)]
    [DataRow(1)]
    public void NonCanonicalEncodingFailsEvenWhenItDecodesToTheSameBytes(int partIndex)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        var codec = new NendoCursorCodec(new byte[32]);
        var cursor = codec.Encode("scope", "1");
        Assert.AreEqual("1", codec.Decode(cursor, "scope"));
        var parts = cursor.Split('.');
        var canonical = parts[partIndex];
        var finalIndex = alphabet.IndexOf(canonical[^1]);
        Assert.AreEqual(0, finalIndex % 4);
        var alias = canonical[..^1] + alphabet[finalIndex + 1];
        CollectionAssert.AreEqual(DecodeBase64Url(canonical), DecodeBase64Url(alias));
        parts[partIndex] = alias;

        var error = Assert.ThrowsExactly<McpProtocolException>(() =>
            codec.Decode(string.Join('.', parts), "scope"));

        StringAssert.Contains(error.Message, "NENDO_INVALID_CURSOR");
    }

    private static byte[] DecodeBase64Url(string value)
    {
        var standard = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(
            standard.PadRight(standard.Length + ((4 - standard.Length % 4) % 4), '='));
    }
}
