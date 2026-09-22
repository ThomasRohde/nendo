using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal static class NendoMcpErrors
{
    internal static McpProtocolException InvalidCursor() => Invalid(
        "NENDO_INVALID_CURSOR",
        "The page cursor is invalid or belongs to an earlier agent-access session.");

    internal static McpProtocolException InvalidLimit() => Invalid(
        "NENDO_INVALID_LIMIT",
        "Page limits are whole numbers from 1 to 100.");

    internal static McpProtocolException EntityNotFound() => Invalid(
        "NENDO_ENTITY_NOT_FOUND",
        "The requested entity does not exist.");

    internal static McpProtocolException Translate(Exception exception) => exception switch
    {
        McpProtocolException protocol => protocol,
        NendoAgentAuthorityException authority => Invalid(
            $"NENDO_{authority.Code}",
            "Agent authority rejected the request."),
        NendoRecoveryRequiredException => Invalid(
            "NENDO_RECOVERY_REQUIRED",
            "The file requires recovery before it can be inspected."),
        NendoPreconditionException precondition => Invalid(
            $"NENDO_{Normalize(precondition.Code)}",
            "The semantic precondition was not met."),
        NendoCalculationException calculation => Invalid(
            $"NENDO_{Normalize(calculation.Code)}",
            calculation.Message),
        // Engine validation messages name IDs, property names and counts, never a
        // path or a stored value; see the same arm in NendoToolErrors.
        NendoValidationException validation => Invalid(
            "NENDO_INVALID_REQUEST",
            validation.Message),
        _ => new McpProtocolException(
            "NENDO_INTERNAL_ERROR: The local Nendo request could not be completed.",
            McpErrorCode.InternalError),
    };

    private static McpProtocolException Invalid(string code, string message) =>
        new($"{code}: {message}", McpErrorCode.InvalidParams);

    private static string Normalize(string value) => new(
        value.Select(character => char.IsAsciiLetterOrDigit(character)
            ? char.ToUpperInvariant(character)
            : '_').ToArray());
}
