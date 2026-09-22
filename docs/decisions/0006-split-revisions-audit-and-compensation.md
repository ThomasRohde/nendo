# ADR-0006: Split revisions and use explicit compensating history

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0004 result and EX-0007 result
- **Depends on:** ADR-0003 storage boundary and ADR-0005 write coordinator
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

A single global version would stale every application proposal after unrelated
record entry. Rewinding the database to implement “undo” would erase later
history and overstate reversibility for lossy or identity-changing operations.
Nendo needs ordered audit evidence while allowing definition and unrelated data
work to proceed independently.

## Decision drivers

1. Relevant conflicts must fail without invalidating unrelated work.
2. Every accepted mutation needs attributable ordered history.
3. Retried requests must not duplicate effects or revisions.
4. Reversibility claims must match available inverse evidence.
5. Recovery must preserve history rather than rewrite it.

## Options considered

### Split revision lineages plus per-record versions

Track definition and data lineages independently, order all changes with a
monotonic sequence and use touched-record versions for fine-grained conflicts.

### One global revision

Simple to compare, but ordinary data entry would make unrelated UI proposals
perpetually stale.

### Snapshot rewind as universal undo

Restore an earlier file or revision wholesale. This can erase later accepted
work and cannot honestly invert every operation.

## Decision

Nendo uses separate revision lineages with one ordered semantic audit stream.

- `definition_revision` advances for schema, semantic UI, constraints, commands
  and application settings.
- `data_revision` advances for record-state transactions.
- `change_sequence` monotonically orders accepted revisions across both lanes.
- Every record carries a version used for touched-record optimistic concurrency.
- An accepted semantic transaction appends one attributable revision containing
  its lane, canonical operations, stable operation digest, origin, time and
  declared reversibility evidence.
- Idempotency keys are scoped to the appropriate authority/session and return
  the original committed outcome for an exact replay. Reuse with a different
  payload fails.
- A proposal checks its required definition revision and only the versions of
  records it actually reads or transforms. Unrelated record changes do not stale
  UI-only work.
- Every operation type is classified `reversible`,
  `reversible-with-retained-state` or `irreversible-declared`.
- Compensation is a new typed transaction linked to the original revision. It
  advances history and current versions; it never deletes or rewinds audit
  evidence.
- An inverse is offered only when preconditions and retained state prove it is
  safe. Backups do not turn an irreversible operation into a reversible one.

## Evidence and validation obligations

- EX-0001 proved unrelated-data, changed-definition and touched-record proposal
  outcomes, exact idempotent replay and two bounded compensation classes.
- EX-0004/7 proved exact-once mutation and ordered coordinator writes under
  response loss, concurrency and native SQLite rollback.
- Production must test each operation's lane, digest, conflict rules,
  reversibility class and inverse evidence.
- Delayed mutation and compensation replay regressions
- [One-revision form saves and retained-state form compensation](../contracts/operation-outcomes.md)
  now verify original receipts after intervening changes without discarding the
  current authority or bypassing outside-change refusal.
- Multi-operation compensation, deletion, field retirement, relationships and
  lossy conversion require explicit operation-specific tests before UI claims.

## Consequences

### Positive

- Ordinary data entry does not invalidate unrelated semantic work.
- Audit order remains total while conflicts stay appropriately narrow.
- Undo language can be honest and operation-specific.

### Negative

- Callers must understand multiple counters and per-record versions.
- Compensation can itself conflict and is not universal.
- More protected evidence is retained than in a simple last-state store.

## Rejected alternatives

A global revision and universal snapshot rewind are rejected because they either
discard useful concurrency or erase/overstate history.

## Revisit triggers

- Multi-user collaboration requires vector/causal semantics.
- The split counters cannot express a required cross-lane invariant.
- Retained inverse evidence grows beyond the bounded local-file budget.
