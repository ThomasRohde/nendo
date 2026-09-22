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
human review, and they must not mutate the active file. If Nendo replaced the
active file with a proposal clone, it would discard legitimate work committed
after the host created the clone. It would also make file identity ambiguous.

## Decision drivers

1. Physical isolation of unaccepted application changes.
2. Semantic, reviewable diff derived from canonical operations.
3. Preservation of active work after proposal creation.
4. Exact preview/promotion equivalence.
5. Relevant conflict detection and all-or-nothing active mutation.
6. Bounded cleanup and recovery of proposal derivatives.

## Options considered

### SQLite backup clone plus operation replay

Apply canonical operations to a host-owned clone, and validate and preview them.
Then check the preconditions, and replay the exact digest against the active
file.

### Replace the active file with the validated clone

Activation is simple. But this option can overwrite post-clone work, and it
changes instance/path authority outside the typed operation model.

### Preview without a physical clone

Simulate against an in-memory model. This option costs less, but it may miss
real storage, migration and validation failures.

## Decision

Agent-authored application changes use a host-owned proposal workspace. They
reach the active file only by exact operation replay.

- The lifecycle is Draft → Validating → Invalid or Previewable → Rejected,
  Stale or Applying → Active or Failed. Later compensation occurs only where the
  accepted operations support it.
- A proposal binds application/instance identity, required definition revision,
  touched-record versions, canonical operations, operation/interpreter version,
  validation evidence, semantic diff and operation digest.
- The host creates the clone through SQLite backup into a protected proposal
  workspace. It applies the canonical operations there and validates the complete
  result.
- Preview comes from the same canonical operation stream that clone
  application, semantic diff, history and eventual promotion use.
- Acceptance is an explicit host-owned user action. An agent or MCP adapter
  cannot call a generic promotion escape hatch.
- Promotion rechecks identity, interpreter version, definition revision and
  touched-record versions. Then it replays the exact validated operation digest in
  one coordinator-owned active-file transaction.
- Promotion never replaces the active file with the clone.
- Invalid, stale or failed proposals leave the active semantic state unchanged.
- Proposal workspaces contain user data and use host-owned ACL, retention and
  explicit cleanup. The MVP does not promise cross-process proposal resume.
  Abandoned work may be listed for recovery and safely rejected/recreated.

## Evidence and validation obligations

- EX-0001 proved clone isolation, semantic diff, exact digest replay, preservation
  of a post-clone record edit, relevant staleness and promotion rollback.
- EX-0002 proved all-or-nothing semantic compilation and actionable diagnostics.
- EX-0005 proved explicit begin/add/validate/preview/reject authoring without a
  promotion tool through the installed Codex path.
- Production must test cleanup, restart-abandoned proposals, schema migration,
  relationships, cancellation, large proposals and every typed operation class.
- Before acceptance, human review must show the affected semantics, records,
  validation and reversibility.

## Consequences

The 2026-09-05 review remediation
adds bounded production evidence for three items: canonical proposal receipts
after process loss, repeated promotion after reopen, and retryable derivative
cleanup. The receipt comes from existing proposal-tagged revisions. The
remediation introduces no clone replacement, no second commit log and no durable
continuation of unaccepted proposals. The disposition records R03
transport/lifecycle qualification and its limits.

Schema-only proposals now validate on the same physical clone and reach Studio
without a custom surface. Custom definitions that are present must still compile
fully. Malformed or partial custom trees remain invalid. This change permits the
empty/schema-only file boundary. It does not permit a partial render plan or a
new UI vocabulary.

### Positive

- Unaccepted work cannot partially mutate the active application.
- If active changes made after clone creation are not relevant, they survive
  promotion.
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
