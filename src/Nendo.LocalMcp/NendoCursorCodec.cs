using System.Security.Cryptography;
using System.Text;

namespace Nendo.LocalMcp;

internal sealed class NendoCursorCodec(byte[] key)
{
    private readonly byte[] _key = key?.Length >= 32
        ? [.. key]
        : throw new ArgumentException("Cursor keys require at least 256 bits.", nameof(key));

    internal string Encode(string scope, string continuation)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        ArgumentException.ThrowIfNullOrWhiteSpace(continuation);
        var payload = Encoding.UTF8.GetBytes($"{scope}\n{continuation}");
        var signature = HMACSHA256.HashData(_key, payload);
        return $"{Base64Url(payload)}.{Base64Url(signature)}";
    }

    internal string? Decode(string? cursor, string expectedScope)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedScope);
        if (cursor is null)
        {
            return null;
        }
        if (cursor.Length is 0 or > 8192) throw NendoMcpErrors.InvalidCursor();

        var parts = cursor.Split('.', StringSplitOptions.None);
        if (parts.Length != 2 ||
            !TryBase64Url(parts[0], out var payload) ||
            !TryBase64Url(parts[1], out var signature))
        {
            throw NendoMcpErrors.InvalidCursor();
        }

        var expectedSignature = HMACSHA256.HashData(_key, payload);
        if (!CryptographicOperations.FixedTimeEquals(signature, expectedSignature))
        {
            throw NendoMcpErrors.InvalidCursor();
        }

        var text = Encoding.UTF8.GetString(payload);
        var separator = text.LastIndexOf('\n');
        if (separator <= 0 ||
            !string.Equals(text[..separator], expectedScope, StringComparison.Ordinal) ||
            separator == text.Length - 1)
        {
            throw NendoMcpErrors.InvalidCursor();
        }
        return text[(separator + 1)..];
    }

    private static string Base64Url(ReadOnlySpan<byte> value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static bool TryBase64Url(string value, out byte[] bytes)
    {
        bytes = [];
        if (value.Length == 0 || value.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
        {
            return false;
        }
        var standard = value.Replace('-', '+').Replace('_', '/');
        standard = standard.PadRight(standard.Length + ((4 - standard.Length % 4) % 4), '=');
        try
        {
            bytes = Convert.FromBase64String(standard);
            if (string.Equals(Base64Url(bytes), value, StringComparison.Ordinal))
            {
                return true;
            }
            bytes = [];
            return false;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
