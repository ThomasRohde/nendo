# ADR-0007: Validate application proposals on a clone and promote by replay

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `ProposalLifecycleTests`, `ProposalOutcomeTests`, `ProposalOutcomeProcessTests`, `SchemaOnlyProposalTests` (Engine), `RevalidateTests` and `UnattendedAcceptanceTests` (LocalMcp)

## Context

Agent-authored schema and surface changes need realistic validation and human
review without touching the active file. Replacing the active file with a proposal
clone would discard work committed after the clone was made and make file identity
ambiguous.

## Decision

Agent-authored application changes are validated in a host-owned proposal workspace
and reach the active file only by exact operation replay.

- The lifecycle is Draft → Validating → Invalid or Previewable → Rejected, Stale or
  Applying → Active or Failed. Later compensation happens only where the accepted
  operations support it.
- A proposal binds application and instance identity, the required definition
  revision, touched-record versions, canonical operations, operation and interpreter
  version, validation evidence, semantic diff and operation digest.
- The host clones the file by SQLite backup into a protected workspace, applies the
  canonical operations there and validates the complete result. Schema-only proposals
  validate on the same clone and reach Studio without a custom surface; custom
  definitions that are present must still compile fully.
- Preview, semantic diff, history and promotion all come from the same canonical
  operation stream.
- Acceptance is an explicit host-owned action of the person. Below the Unattended
  access level, MCP has no promotion tool. At Unattended, `nendo.change_set.accept`
  promotes a proposal the same session validated, pinned to its reviewed digest,
  through the same promotion service as the person's Accept
  ([ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)).
- Promotion rechecks identity, interpreter version, definition revision and
  touched-record versions, then replays the exact validated digest in one
  coordinator-owned transaction. It never replaces the active file with the clone.
- Invalid, stale and failed proposals leave the active semantic state unchanged.
- `nendo.change_set.revalidate` rejects a proposal and validates the same canonical
  operations again as a draft captured at the current definition revision. It is not
  a rebase; merging two concurrent proposals would need its own ADR.
- Proposal workspaces hold user data and use host-owned ACLs and cleanup. A proposal
  is kept until it is accepted or rejected, or until its file closes or Nendo exits,
  which discards it.

## Consequences

### Positive

- Unaccepted work cannot partially change the active application.
- Active changes made after the clone survive promotion unless they conflict.
- Preview and applied history share one evidence stream.

### Negative

- Clones use temporary storage and may contain sensitive data.
- Large proposals need progress, cancellation and cleanup.
- An unaccepted proposal does not survive closing its file.

## Rejected alternatives

- Replacing the active file with the validated clone: loses post-clone work and
  bypasses typed history.
- In-memory preview as the only validator: cannot exercise the real SQLite and schema
  result.

## Revisit triggers

- Cross-device or multi-user proposal continuation becomes product scope.
- Clone cost becomes unacceptable for modest local datasets.
- A deterministic storage-level sandbox proves equivalent isolation more simply.
