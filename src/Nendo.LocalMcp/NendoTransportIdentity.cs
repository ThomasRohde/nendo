using System.Security.Cryptography;
using System.Text;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

internal static class NendoTransportIdentity
{
    internal static string Pseudonym(string sessionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(sessionId));
        return $"agent-{Convert.ToHexString(digest.AsSpan(0, 6)).ToLowerInvariant()}";
    }

    internal static string DisplayName(Implementation? clientInfo)
    {
        var name = Sanitize(clientInfo?.Name, 60, "Local agent");
        var version = Sanitize(clientInfo?.Version, 24, string.Empty);
        return string.IsNullOrEmpty(version) ? name : $"{name} {version}";
    }

    private static string Sanitize(string? value, int maximumLength, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }
        var result = new string(value
            .Where(character => !char.IsControl(character) &&
                (char.IsLetterOrDigit(character) || character is ' ' or '.' or '-' or '_' or '(' or ')'))
            .Take(maximumLength)
            .ToArray()).Trim();
        return result.Length == 0 ? fallback : result;
    }
}
