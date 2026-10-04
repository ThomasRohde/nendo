using System.Security.Cryptography;
using System.Text;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

internal static class NendoTransportIdentity
{
    internal static string Pseudonym(string applicationHandle)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationHandle);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(applicationHandle));
        return $"agent-{Convert.ToHexString(digest.AsSpan(0, 6)).ToLowerInvariant()}";
    }

    internal static string DisplayName(Implementation? clientInfo)
    {
        // A handshake-era client names itself only in initialize, and the host is stateless,
        // so every later request named it "Local agent". The HTTP User-Agent is on every
        // request, and its first product token is the client's name (W-150).
        if (string.IsNullOrWhiteSpace(clientInfo?.Name) && RequestUserAgent.Value is { } agent)
        {
            return agent;
        }
        var name = Sanitize(clientInfo?.Name, 60, "Local agent");
        var version = Sanitize(clientInfo?.Version, 24, string.Empty);
        return string.IsNullOrEmpty(version) ? name : $"{name} {version}";
    }

    private static readonly AsyncLocal<string?> RequestUserAgent = new();

    /// <summary>
    /// Holds the request's User-Agent, as a display name, for the request's duration: the
    /// first product token, <c>name/version</c>, sanitised as a client name is. Null when
    /// the header is absent or says nothing usable, so the fallback stays "Local agent".
    /// </summary>
    internal static IDisposable FromUserAgent(string? userAgent)
    {
        string? display = null;
        if (!string.IsNullOrWhiteSpace(userAgent))
        {
            var token = userAgent.Trim().Split(' ', 2)[0];
            var slash = token.IndexOf('/', StringComparison.Ordinal);
            var name = Sanitize(slash < 0 ? token : token[..slash], 60, string.Empty);
            var version = Sanitize(slash < 0 ? null : token[(slash + 1)..], 24, string.Empty);
            display = name.Length == 0 ? null : string.IsNullOrEmpty(version) ? name : $"{name} {version}";
        }
        return new Scope(display);
    }

    private sealed class Scope : IDisposable
    {
        private readonly string? _previous;
        internal Scope(string? display) { _previous = RequestUserAgent.Value; RequestUserAgent.Value = display; }
        public void Dispose() => RequestUserAgent.Value = _previous;
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
