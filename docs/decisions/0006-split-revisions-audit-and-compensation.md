# ADR-0006: Split revisions and use explicit compensating history

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0004 result and EX-0007 result
- **Depends on:** ADR-0003 storage boundary and ADR-0005 write coordinator
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

With a single global version, unrelated record entry would make every
application proposal stale. If Nendo rewound the database to implement “undo”,
it would erase later history. It would also overstate reversibility for lossy or
identity-changing operations. Nendo needs ordered audit evidence, and definition
work and unrelated data work must be able to proceed independently.

## Decision drivers

1. Relevant conflicts must fail without invalidating unrelated work.
2. Every accepted mutation needs attributable ordered history.
3. Retried requests must not duplicate effects or revisions.
4. Reversibility claims must match available inverse evidence.
5. Recovery must preserve history and must not rewrite it.

## Options considered

### Split revision lineages plus per-record versions

Track definition and data lineages independently. Order all changes with a
monotonic sequence, and use touched-record versions for fine-grained conflicts.

### One global revision

This option is simple to compare. But ordinary data entry would make unrelated
UI proposals permanently stale.

### Snapshot rewind as universal undo

Restore an earlier file or revision as a whole. This option can erase later
accepted work, and it cannot correctly invert every operation.

## Decision

Nendo uses separate revision lineages with one ordered semantic audit stream.

- `definition_revision` advances for schema, semantic UI, constraints, commands
  and application settings.
- `data_revision` advances for record-state transactions.
- `change_sequence` monotonically orders accepted revisions across both lanes.
- Every record carries a version for touched-record optimistic concurrency.
- An accepted semantic transaction appends one attributable revision. The
  revision contains its lane, canonical operations, stable operation digest,
  origin, time and declared reversibility evidence.
- Idempotency keys are scoped to the appropriate authority/session. For an exact
  replay, they return the original committed outcome. Reuse with a different
  payload fails.
- A proposal checks its required definition revision. It also checks the versions
  of only the records that it reads or transforms. Unrelated record changes do
  not make UI-only work stale.
- Every operation type is classified `reversible`,
  `reversible-with-retained-state` or `irreversible-declared`. (Note,
  2026-09-22: the code names these classes `Reversible`,
  `ReversibleWithRetainedState` and `IrreversibleDeclared`. MCP payloads carry
  them in camelCase.)
- Compensation is a new typed transaction linked to the original revision. It
  advances history and current versions. It never deletes or rewinds audit
  evidence.
- Nendo offers an inverse only when preconditions and retained state prove that
  it is safe. Backups do not turn an irreversible operation into a reversible one.

## Evidence and validation obligations

- EX-0001 proved unrelated-data, changed-definition and touched-record proposal
  outcomes, exact idempotent replay and two bounded compensation classes.
- EX-0004/7 proved exact-once mutation and ordered coordinator writes under
  response loss, concurrency and native SQLite rollback.
- Production must test the lane, digest, conflict rules, reversibility class and
  inverse evidence of each operation.
- Regression tests for delayed mutation and compensation replay, and for
  [one-revision form saves and retained-state form compensation](../contracts/operation-outcomes.md),
  now verify original receipts after intervening changes. They do not discard the
  current authority or bypass outside-change refusal.
- Multi-operation compensation, deletion, field retirement, relationships and
  lossy conversion require explicit operation-specific tests before UI claims.

## Consequences

### Positive

- Ordinary data entry does not invalidate unrelated semantic work.
- Audit order remains total, and conflicts stay appropriately narrow.
- Undo language can be accurate and operation-specific.

### Negative

- Callers must understand multiple counters and per-record versions.
- Compensation can itself conflict and is not universal.
- Nendo retains more protected evidence than a simple last-state store does.

## Rejected alternatives

A global revision and universal snapshot rewind are rejected. Each one either
discards useful concurrency or erases/overstates history.

## Revisit triggers

- Multi-user collaboration requires vector/causal semantics.
- The split counters cannot express a required cross-lane invariant.
- Retained inverse evidence grows beyond the bounded local-file budget.
