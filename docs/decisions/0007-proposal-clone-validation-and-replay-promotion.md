# ADR-0007: Validate application proposals on a clone and promote by replay

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0002 result and EX-0005 result
- **Depends on:** ADR-0004 semantic UI contract, ADR-0005 write coordinator and ADR-0006 revision model
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Agent-authored schema and semantic-surface changes need realistic validation and
human review without mutating the active file. Replacing the active file with a
proposal clone would discard legitimate work committed after the clone was
created and make file identity ambiguous.

## Decision drivers

1. Physical isolation of unaccepted application changes.
2. Semantic, reviewable diff derived from canonical operations.
3. Preservation of active work after proposal creation.
4. Exact preview/promotion equivalence.
5. Relevant conflict detection and all-or-nothing active mutation.
6. Bounded cleanup and recovery of proposal derivatives.

## Options considered

### SQLite backup clone plus operation replay

Apply canonical operations to a host-owned clone, validate and preview them,
then replay the exact digest against the active file after precondition checks.

### Replace the active file with the validated clone

Simple activation, but it can overwrite post-clone work and changes instance/
path authority outside the typed operation model.

### Preview without a physical clone

Simulate against an in-memory model. This is cheaper but may miss real storage,
migration and validation failures.

## Decision

Agent-authored application changes use a host-owned proposal workspace and reach
the active file only by exact operation replay.

- The lifecycle is Draft → Validating → Invalid or Previewable → Rejected,
  Stale or Applying → Active or Failed, with later compensation only where the
  accepted operations support it.
- A proposal binds application/instance identity, required definition revision,
  touched-record versions, canonical operations, operation/interpreter version,
  validation evidence, semantic diff and operation digest.
- The host creates the clone through SQLite backup into a protected proposal
  workspace, applies the canonical operations there and validates the complete
  result.
- Preview is derived from the same canonical operation stream used for clone
  application, semantic diff, history and eventual promotion.
- Acceptance is an explicit host-owned user action. An agent or MCP adapter
  cannot call a generic promotion escape hatch.
- Promotion rechecks identity, interpreter version, definition revision and
  touched-record versions, then replays the exact validated operation digest in
  one coordinator-owned active-file transaction.
- Promotion never replaces the active file with the clone.
- Invalid, stale or failed proposals leave active semantic state unchanged.
- Proposal workspaces contain user data and use host-owned ACL, retention and
  explicit cleanup. The MVP does not promise cross-process proposal resume;
  abandoned work may be listed for recovery and rejected/recreated safely.

## Evidence and validation obligations

- EX-0001 proved clone isolation, semantic diff, exact digest replay, preservation
  of a post-clone record edit, relevant staleness and promotion rollback.
- EX-0002 proved all-or-nothing semantic compilation and actionable diagnostics.
- EX-0005 proved explicit begin/add/validate/preview/reject authoring without a
  promotion tool through the installed Codex path.
- Production must test cleanup, restart-abandoned proposals, schema migration,
  relationships, cancellation, large proposals and every typed operation class.
- Human review must show affected semantics, records, validation and
  reversibility before acceptance.

## Consequences

The 2026-09-05 review remediation
adds bounded production evidence for canonical proposal receipts after process
loss, repeated promotion after reopen and retryable derivative cleanup. The
receipt comes from existing proposal-tagged revisions; no clone replacement,
second commit log or durable continuation of unaccepted proposals is introduced.
The disposition records R03 transport/lifecycle qualification and its limits.
Schema-only proposals now validate on the same physical clone and reach Studio
without requiring a custom surface. Present custom definitions must still compile
fully; malformed or partial custom trees remain invalid. This permits the
empty/schema-only file boundary, not a partial render plan or a new UI vocabulary.

### Positive

- Unaccepted work cannot partially mutate the active application.
- Active changes after clone creation survive promotion when not relevant.
- Preview and applied history share one canonical evidence stream.

### Negative

- Proposal clones consume temporary storage and may contain sensitive data.
- Large proposals require progress, cancellation and cleanup behavior.
- The MVP may discard abandoned in-progress proposal sessions after restart.

## Rejected alternatives

Clone replacement is rejected because it loses post-clone authority and bypasses
typed history. In-memory-only preview is rejected as the sole validator because
it cannot exercise the actual SQLite/schema result.

## Revisit triggers

- Cross-device or multi-user proposal continuation becomes product scope.
- Clone cost is unacceptable for the intended modest local datasets.
- A deterministic storage-level sandbox can prove equivalent isolation with
  materially lower complexity.
