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

    internal static McpProtocolException ReadInterrupted(int attempts) => Invalid(
        "NENDO_READ_INTERRUPTED",
        $"The file changed during each of {attempts} attempts at this read, so no answer from one moment of it was put together. Read it again.");

    /// <summary>
    /// The admission check a list, a read or a skills call makes, refused by code and sentence.
    /// The bare exception reached the client as a code-less internal error (MHS-10).
    /// </summary>
    internal static void RequireActive(NendoHostAuthority authority)
    {
        try
        {
            authority.RequireActive();
        }
        catch (NendoAgentAuthorityException closed)
        {
            throw Translate(closed);
        }
    }

    /// <summary>The same check in a tool call, refused as a tool result with the code in <c>_meta</c>.</summary>
    internal static void RequireActiveForTool(NendoHostAuthority authority)
    {
        try
        {
            authority.RequireActive();
        }
        catch (NendoAgentAuthorityException closed)
        {
            throw NendoToolErrors.Translate(closed);
        }
    }

    internal static McpProtocolException Translate(Exception exception) => exception switch
    {
        McpProtocolException protocol => protocol,
        // The tool path's sentences, which say what to do next (MHS-10): every authority code
        // used to read "Agent authority rejected the request." here.
        NendoAgentAuthorityException authority => Invalid(
            $"NENDO_{authority.Code}",
            NendoToolErrors.AuthorityMessage(authority.Code)),
        NendoRecoveryRequiredException => Invalid(
            "NENDO_RECOVERY_REQUIRED",
            "The file requires recovery before it can be inspected."),
        // The one audited list the tool path keeps (MTD-05): a read's refusal said only that a
        // precondition failed, though its sentence names the remedy and the tools showed it.
        NendoPreconditionException precondition => Invalid(
            $"NENDO_{NendoText.ErrorCode(precondition.Code)}",
            NendoToolErrors.IsDiagnosable(precondition.Code) ? precondition.Message : "The semantic precondition was not met."),
        NendoCalculationException calculation => Invalid(
            $"NENDO_{NendoText.ErrorCode(calculation.Code)}",
            calculation.Message),
        // Engine validation messages name IDs, property names and counts, never a
        // path or a stored value; see the same arm in NendoToolErrors.
        NendoValidationException validation => Invalid(
            "NENDO_INVALID_REQUEST",
            validation.Message),
        _ => new McpProtocolException(
            $"NENDO_INTERNAL_ERROR: The local Nendo request could not be completed ({exception.GetType().Name}; " +
            $"failure {NendoAgentFailures.Report(exception)}).",
            McpErrorCode.InternalError),
    };

    private static McpProtocolException Invalid(string code, string message) =>
        new($"{code}: {message}", McpErrorCode.InvalidParams);
}
