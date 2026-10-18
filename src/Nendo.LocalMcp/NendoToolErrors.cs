using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp;

internal static class NendoToolErrors
{
    /// <summary>
    /// Translate a refusal, and append a cause the caller can act on when one is
    /// available. The advisory is evaluated only on the failing path.
    /// </summary>
    internal static McpException Translate(Exception exception, Func<NendoPendingCause?>? cause)
    {
        var error = Translate(exception);
        if (cause is null || !ExplainedByPendingProposal(exception)) return error;
        var advisory = cause();
        if (advisory is null || string.IsNullOrWhiteSpace(advisory.Text)) return error;
        var separator = error.Message.IndexOf(": ", StringComparison.Ordinal);
        NendoToolRefusal.Record(error.Message[..separator], $"{error.Message[(separator + 2)..]} {advisory.Text}", advisory.ProposalId);
        return new McpException($"{error.Message} {advisory.Text}");
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
        NendoImportPartialException partial => Error(
            "NENDO_IMPORT_PARTIAL",
            $"committed={partial.Committed}; remaining={partial.Remaining}; " +
            $"firstUncommittedRow={partial.FirstUncommittedRow}; " +
            $"committedRevisions={string.Join(',', partial.RevisionIds)}; " +
            $"cause={Translate(partial.Cause).Message} " +
            "Retry the identical request with the same idempotency key; earlier batches replay without duplicates."),
        NendoIdempotencyConflictException => Error(
            "NENDO_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different request."),
        NendoRecoveryRequiredException => Error(
            "NENDO_RECOVERY_REQUIRED",
            "The file requires recovery before it can be changed."),
        // Reached only as the cause of a partial import: a tool rethrows its own cancellation.
        OperationCanceledException => Error(
            "NENDO_CANCELLED",
            "The request was cancelled before it finished."),
        NendoPreconditionException precondition => Error(
            $"NENDO_{NendoText.ErrorCode(precondition.Code)}",
            DiagnosablePreconditions.Contains(precondition.Code)
                ? precondition.Message
                : "The semantic precondition was not met."),
        // A calculation message is a constant template naming a definition, a step
        // or a ceiling; it reached the wire as an internal error until now.
        NendoCalculationException calculation => Error(
            $"NENDO_{NendoText.ErrorCode(calculation.Code)}",
            calculation.Message,
            NendoToolLimit.From(calculation)),
        // Every engine validation message is a constant template that interpolates
        // stable IDs, operation types, property names, declared choice IDs or counts, and
        // may echo what the caller itself sent, such as a CSV cell or header it is refused
        // over (ESQ-07, ESQ-12) — never a path and never a value the file stores. One blind
        // "arguments are invalid" stood in for all of them and cost an outside reviewer a
        // rebuilt change set per guess at a payload key the message already named.
        NendoValidationException validation => Error(
            "NENDO_INVALID_REQUEST",
            validation.Message),
        // An undo the Engine will not make: already undone, not record changes, a mark or a
        // record changed since, too many operations. Each message is a constant naming revision
        // and record IDs and operation types, never a stored value. It reached the agent as an
        // internal error and filled the device's failure record with refusals (R2RM-01).
        NendoCompensationNotSupportedException compensation => Error(
            "NENDO_COMPENSATION_NOT_SUPPORTED",
            compensation.Message),
        ArgumentException argument => Error(
            "NENDO_INVALID_REQUEST",
            argument.ParamName is { Length: > 0 } name
                ? $"The request argument '{name}' is invalid."
                : "The request arguments are invalid."),
        // The exception's type is named and nothing else: enough for a maintainer to
        // find it, and no engine text that was never written for a client. The reference
        // is the one the device's failure record keeps, with the frames the type alone
        // could not say.
        _ => Error(
            "NENDO_INTERNAL_ERROR",
            $"The local Nendo request failed ({exception.GetType().Name}; failure {NendoAgentFailures.Report(exception)})."),
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
            "reference-label-in-use", "reference-label-unchanged", "ui-property-absent",
            "reference-unbound", "target-version-required", "target-not-found", "target-version-conflict",
            "record-version-conflict", "record-not-found", "field-not-found", "field-calculated",
            "aggregate-not-representable",
            // ADR-0019: a hierarchy's refusals name records by stable ID and record types by
            // display name, and a loop as the chain of IDs that would close it.
            "hierarchy-cycle", "hierarchy-cycle-present", "hierarchy-too-deep",
            "hierarchy-parent-invalid", "hierarchy-parent-required", "hierarchy-order-invalid",
            "hierarchy-already-declared", "hierarchy-not-declared", "hierarchy-field-in-use",
            "hierarchy-order-not-declared", "hierarchy-sibling-not-found", "move-unchanged",
            // ADR-0020: a uniqueness refusal names the field, the value and the record holding it.
            "value-not-unique", "field-values-not-unique", "field-unique-invalid", "field-unique-unchanged",
            "field-sequence-invalid", "field-sequence-unchanged", "field-sequence-in-use",
            // ADR-0026: a link rule's refusals name links and kind records by stable ID, fields
            // and record types by display name, and a text kind by its field only.
            "link-not-allowed", "links-not-allowed", "link-rule-invalid", "link-rule-already-declared",
            "link-rule-not-declared", "link-rule-field-in-use",
            // W-153: an undo's refusals name a revision by ID and say whose it is, nothing stored.
            "revision-not-found", "not-an-undo", "revision-not-yours",
            // W-212: a restore or a backfill's undo that cannot run says why, by IDs and names only.
            "deletion-state-conflict", "field-not-retired",
            // ADR-0011: a save another program kept busy is a constant sentence; nothing changed.
            "file-busy",
            // W-165: a size refusal names the field the caller sent, the cap and the measured size.
            "value-too-large", "values-too-large",
            // W-209: a requirement change refused names the definition, the binding or step and the field;
            // an action that could never run names the action, step, binding or field, the record types
            // and the remedy, all from the definition and the schema.
            "field-requirement-in-use", "action-target-mismatch",
            // W-214 (R2AP-02, MTD-05): the rest of what a data write or read meets, read the same way.
            // Each names a record by stable ID, a record type or field by ID or display name, or a
            // ceiling by its number, and the person reads the same sentence in Nendo. A write-ceiling
            // refusal says nothing was changed and the file still opens.
            "record-id-reserved", "record-exists-or-invalid", "kept-in-new-files-unchanged", "new-file-reference-left-out",
            "entity-not-found", "entity-exists", "entity-retired", "field-retired", "retired-binding",
            "record-version-exhausted", "command-unavailable", "move-receipt-unavailable", "ui-node-not-found",
            "write-ceiling-bytes", "write-ceiling-rows", "write-ceiling-schema", "file-changed-before-open",
            "reference-conversion-required", "reference-conversion-incomplete", "reference-conversion-mismatch",
            "reference-conversion-too-large",
            "calculated-query-too-wide", "search-too-long", "search-too-many-terms", "search-index-missing",
            "stale-cursor", "invalid-limit", "data-unavailable", "history-unavailable", "reopen-to-verify",
            "read-only", "proposal-not-found", "receipt-file-mismatch",
            // W-221: a read-only session's file moved on (ECO-07, R2SMA-12), and a file marked
            // read-only that Nendo will not replace (R2SMA-10). Constant sentences, naming nothing.
            "read-only-file-changed", "replacement-target-read-only", "replacement-target-in-use",
            // ADR-0031: a picture's refusals name the field, the record by ID, the media types and
            // the bounds; none echoes the address or the bytes sent.
            "media-address-invalid", "media-missing", "media-type-mismatch", "media-too-large", "media-budget-exceeded",
            "field-not-media",
            // W-249: a total of a calculated number names the field and the reason its calculation
            // gave, as the record's own read shows it; a breakdown by a reference names the bound.
            "calculated-total-incomplete", "aggregate-too-many-groups",
        ], StringComparer.Ordinal);

    /// <summary>
    /// The precondition codes a data tool or a read can meet whose sentence stays withheld, each
    /// with the reason. A code a data path throws is on <see cref="DiagnosablePreconditions"/> or
    /// here; the walk in the Local MCP tests refuses one that is on neither (R2AP-02).
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> WithheldPreconditions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["aggregate-not-exact"] = "its sentence echoes a stored value, a floating-point number or a date text",
    };

    /// <summary>Whether a precondition's own sentence reaches an agent, on the tool path and the resource path alike.</summary>
    internal static bool IsDiagnosable(string code) => DiagnosablePreconditions.Contains(code);

    // These authoring messages are written here and carry only bounded counters and
    // identifiers the caller already sent. Withholding them left NENDO_CHANGE_SET_LIMIT
    // naming neither the limit, the current usage, nor which dimension bound, and
    // NENDO_CHANGE_SET_NOT_FOUND saying neither "does not exist" nor "not yours".
    private static readonly HashSet<string> DiagnosableAuthoringCodes =
        new([
            "CHANGE_SET_LIMIT", "CHANGE_SET_ORDINAL", "DRAFT_LIMIT", "PROPOSAL_LIMIT", "CHANGE_SET_EMPTY", "CHANGE_SET_FROZEN",
            "CHANGE_SET_NOT_FOUND", "CHANGE_SET_NOT_VALIDATED", "UNKNOWN_OPERATION",
            // Constants written in the adapter: they name no path and echo no value.
            "CHANGE_SET_STALE", "AUTHORITY_CHANGED", "IDEMPOTENCY_CONFLICT",
        ], StringComparer.Ordinal);

    private static McpException Error(string code, string message, NendoToolLimit? limit = null)
    {
        NendoToolRefusal.Record(code, message, limit: limit);
        return new McpException($"{code}: {message}");
    }

    // Each says what the agent can do next. NENDO_LEASE_HELD used to stop at "another
    // agent has edit access", which left an agent whose own acquire response was lost
    // unable to tell that the holder was itself (F-175).
    internal static string AuthorityMessage(string code) => code switch
    {
        "EDIT_DATA_REQUIRED" => NendoAccessLevels.RequiredMessage(AgentAccessMode.DataMutation),
        "SHAPE_APP_REQUIRED" => NendoAccessLevels.RequiredMessage(AgentAccessMode.ApplicationAuthoring),
        "UNATTENDED_REQUIRED" => NendoAccessLevels.RequiredMessage(AgentAccessMode.Unattended),
        "LEASE_HELD" =>
            "Another local agent currently has edit access. nendo.lease.status names its client. If your own acquire " +
            "response was lost, call nendo.lease.acquire again with the same idempotencyKey to receive the same " +
            "grant; that works until the lease is first used, for at most five minutes. Otherwise wait for the holder " +
            "to release the lease, or ask the person to revoke it on the Agent page in Nendo.",
        "HANDLE_UNKNOWN" =>
            "The resumeApplicationHandle was not minted by this host run, so there is nothing of yours to resume. " +
            "Acquire without it; a handle from before the file was reopened no longer counts.",
        "LEASE_EXPIRED" => "The edit lease expired because it was not renewed in time. Acquire a new one.",
        "INVALID_LEASE" =>
            "A valid application handle and edit lease are required. Pass the applicationHandle and leaseId from " +
            "nendo.lease.acquire; a lease released, revoked or from before the file was reopened no longer counts.",
        "HOST_CLOSED" => NendoHostAuthority.ClosedMessage,
        _ => "Agent authority rejected the request.",
    };
}
