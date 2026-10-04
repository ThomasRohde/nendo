using System.ComponentModel;
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

    internal static string Create(NendoHostAuthority host, string applicationHandle) => Prefix +
        Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new[]
        { host.ApplicationId, host.InstanceId, host.HostRunId, NendoTransportIdentity.Pseudonym(applicationHandle) }))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static NendoOperationIdentity Read(string context, string key, NendoHostAuthority host)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Length > 200)
            throw new NendoValidationException("A bounded receipt locator and idempotency key are required.");
        return new NendoOperationIdentity(ReadScope(context, host), key.Trim());
    }

    /// <summary>The data-write scope a locator names, once it has proved it belongs to this file.</summary>
    internal static string ReadScope(string context, NendoHostAuthority host)
    {
        if (string.IsNullOrWhiteSpace(context) || context.Length > 1200 || !context.StartsWith(Prefix, StringComparison.Ordinal))
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
        return $"mcp.data.{parts[2]}.{parts[3]}";
    }
}

public sealed record NendoDataOutcome(
    [property: Description("committed when the write reached the file; unresolved when this file state records no receipt for the key.")]
    string State,
    [property: Description("The original write's outcome when committed, else null. For an import or an accepted proposal, the last revision committed; revisions lists them all.")]
    NendoApplyResult? Receipt,
    [property: Description("What the state means and what is safe to do next. An unresolved receipt is not permission to resubmit with a new key.")]
    string Message)
{
    /// <summary>
    /// Every revision the key or proposal committed, in order: one per import batch, one per
    /// mutation of an accepted proposal, and the single revision of an ordinary write.
    /// </summary>
    [Description("Every revision committed under the key or by the proposal, in order: one per import batch, one per mutation of an accepted proposal, one for an ordinary write. Null when unresolved.")]
    public IReadOnlyList<NendoReceiptRevision>? Revisions { get; init; }
}

/// <summary>One committed revision named by a receipt, flat so a list of them stays a closed schema.</summary>
public sealed record NendoReceiptRevision(
    [property: Description("The History revision committed.")]
    string RevisionId,
    [property: Description("Digest of the canonical operations it committed.")]
    string OperationDigest,
    [property: Description("The file's definition revision after it.")]
    long DefinitionRevision,
    [property: Description("The file's data revision after it.")]
    long DataRevision,
    [property: Description("The file's change sequence after it.")]
    long ChangeSequence,
    [property: Description("Who committed it, as History names it, or null when the revision records no origin.")]
    string? Origin)
{
    internal static NendoReceiptRevision From(NendoApplyResult result) => new(
        result.RevisionId, result.OperationDigest, result.DefinitionRevision, result.DataRevision, result.ChangeSequence, result.Origin);
}
