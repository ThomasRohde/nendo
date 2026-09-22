using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// An unprivileged, file-bound history locator, not a writable context. The
/// current endpoint generation still governs reads. Only the server-minted
/// application handle can supply a mutation context.
/// </summary>
internal static class NendoReceiptContext
{
    private const string Prefix = "receipt-v1.";

    internal static string Create(NendoHostAuthority host, string sessionId) => Prefix +
        Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new[]
        { host.ApplicationId, host.InstanceId, host.HostRunId, NendoTransportIdentity.Pseudonym(sessionId) }))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static NendoOperationIdentity Read(string context, string key, NendoHostAuthority host)
    {
        if (string.IsNullOrWhiteSpace(context) || context.Length > 1200 || !context.StartsWith(Prefix, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(key) || key.Length > 200)
            throw new NendoValidationException("A bounded receipt locator and idempotency key are required.");
        string[] parts;
        try
        {
            var encoded = context[Prefix.Length..];
            if (encoded.Any(value => !char.IsAsciiLetterOrDigit(value) && value is not ('-' or '_')))
                throw new FormatException();
            var padded = encoded.Replace('-', '+').Replace('_', '/');
            padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
            using var document = JsonDocument.Parse(Convert.FromBase64String(padded), new JsonDocumentOptions { MaxDepth = 3 });
            if (document.RootElement.ValueKind != JsonValueKind.Array || document.RootElement.GetArrayLength() != 4)
                throw new FormatException();
            parts = document.RootElement.EnumerateArray().Select(value =>
                value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new FormatException()).ToArray();
            if (parts.Any(value => value.Length is < 1 or > 200) || parts[2].Length > 80 ||
                parts[2].Any(value => !char.IsAsciiLetterOrDigit(value) && value != '-') ||
                parts[3].Length != 18 || !parts[3].StartsWith("agent-", StringComparison.Ordinal) ||
                parts[3][6..].Any(value => !char.IsAsciiHexDigitLower(value)))
                throw new FormatException();
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            throw new NendoValidationException("The receipt locator is invalid.");
        }
        if (parts[0] != host.ApplicationId || parts[1] != host.InstanceId)
            throw new NendoPreconditionException("receipt-file-mismatch", "The receipt locator belongs to a different file identity.");
        return new NendoOperationIdentity($"mcp.data.{parts[2]}.{parts[3]}", key.Trim());
    }
}

public sealed record NendoDataOutcome(string State, NendoApplyResult? Receipt, string Message);
