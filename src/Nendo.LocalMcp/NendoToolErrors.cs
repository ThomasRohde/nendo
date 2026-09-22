using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal static class NendoToolErrors
{
    /// <summary>
    /// Translate a refusal, and append a cause the caller can act on when one is
    /// available. The advisory is evaluated only on the failing path.
    /// </summary>
    internal static McpException Translate(Exception exception, Func<string?>? cause)
    {
        var error = Translate(exception);
        if (cause is null || !ExplainedByPendingProposal(exception)) return error;
        var advisory = cause();
        return string.IsNullOrWhiteSpace(advisory) ? error : new McpException($"{error.Message} {advisory}");
    }

    /// <summary>
    /// The refusals an outstanding proposal is the most likely explanation for:
    /// the record type, the field or the command the write names exists in a
    /// proposal and not yet in the file.
    /// </summary>
    private static bool ExplainedByPendingProposal(Exception exception) =>
        exception is NendoPreconditionException precondition &&
        precondition.Code is "entity-not-found" or "field-not-found" or "command-unavailable";

    internal static McpException Translate(Exception exception) => exception switch
    {
        McpException mcp => mcp,
        NendoAgentAuthorityException authority => Error(
            $"NENDO_{authority.Code}",
            AuthorityMessage(authority.Code)),
        NendoAgentAuthoringException authoring => Error(
            $"NENDO_{authoring.Code}",
            DiagnosableAuthoringCodes.Contains(authoring.Code)
                ? authoring.Message
                : "The application change set could not be completed."),
        NendoIdempotencyConflictException => Error(
            "NENDO_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different request."),
        NendoRecoveryRequiredException => Error(
            "NENDO_RECOVERY_REQUIRED",
            "The file requires recovery before it can be changed."),
        NendoPreconditionException precondition => Error(
            $"NENDO_{Normalize(precondition.Code)}",
            DiagnosablePreconditions.Contains(precondition.Code)
                ? precondition.Message
                : "The semantic precondition was not met."),
        // A calculation message is a constant template naming a definition, a step
        // or a ceiling; it reached the wire as an internal error until now.
        NendoCalculationException calculation => Error(
            $"NENDO_{Normalize(calculation.Code)}",
            calculation.Message),
        // Every engine validation message is a constant template that interpolates
        // stable IDs, operation types, property names, declared choice IDs or counts —
        // never a path and never a stored value. One blind "arguments are invalid" stood
        // in for all of them and cost an outside reviewer a rebuilt change set per
        // guess at a payload key the message already named.
        NendoValidationException validation => Error(
            "NENDO_INVALID_REQUEST",
            validation.Message),
        ArgumentException argument => Error(
            "NENDO_INVALID_REQUEST",
            argument.ParamName is { Length: > 0 } name
                ? $"The request argument '{name}' is invalid."
                : "The request arguments are invalid."),
        // The exception's type is named and nothing else: enough for a maintainer to
        // find it, and no engine text that was never written for a client.
        _ => Error(
            "NENDO_INTERNAL_ERROR",
            $"The local Nendo request failed ({exception.GetType().Name})."),
    };

    // A precondition message reaches the caller only when its template has been read
    // and carries nothing but stable IDs, display names from the definition, and
    // integers. `aggregate-not-exact` stays withheld: it echoes a stored value.
    // `field-calculated` names the field, the entity and the calculation: a write to a
    // calculated field used to be refused as a field that did not exist, while the
    // schema read listed it.
    private static readonly HashSet<string> DiagnosablePreconditions =
        new([
            "definition-version-conflict", "required-field-needs-migration", "required-backfill-needed",
            "record-referenced", "entity-referenced", "behaviour-not-approved", "choice-retired",
            "reference-unbound", "target-version-required", "target-not-found", "target-version-conflict",
            "record-version-conflict", "record-not-found", "field-not-found", "field-calculated",
            "aggregate-not-representable",
        ], StringComparer.Ordinal);

    // These authoring messages are written here and carry only bounded counters and
    // identifiers the caller already sent. Withholding them left NENDO_CHANGE_SET_LIMIT
    // naming neither the limit, the current usage, nor which dimension bound, and
    // NENDO_CHANGE_SET_NOT_FOUND saying neither "does not exist" nor "not yours".
    private static readonly HashSet<string> DiagnosableAuthoringCodes =
        new([
            "CHANGE_SET_LIMIT", "CHANGE_SET_ORDINAL", "DRAFT_LIMIT", "CHANGE_SET_EMPTY", "CHANGE_SET_FROZEN",
            "CHANGE_SET_NOT_FOUND", "CHANGE_SET_NOT_VALIDATED", "UNKNOWN_OPERATION",
        ], StringComparer.Ordinal);

    private static McpException Error(string code, string message) =>
        new($"{code}: {message}");

    private static string AuthorityMessage(string code) => code switch
    {
        "EDIT_DATA_REQUIRED" => "Edit data access is required.",
        "SHAPE_APP_REQUIRED" => "Shape app access is required.",
        "UNATTENDED_REQUIRED" => "Unattended access is required.",
        "LEASE_HELD" => "Another local agent currently has edit access.",
        "LEASE_EXPIRED" => "The edit lease expired.",
        "INVALID_LEASE" => "A valid application handle and edit lease are required.",
        _ => "Agent authority rejected the request.",
    };

    private static string Normalize(string value) => new(
        value.Select(character => char.IsAsciiLetterOrDigit(character)
            ? char.ToUpperInvariant(character)
            : '_').ToArray());
}
