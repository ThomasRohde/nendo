# ADR-0006: Split revisions and use explicit compensating history

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `IdempotentReplayTests`, `CompensationAndIdeaServiceTests`, `RecordWritesUndoTests`, `HistoryFoldTests` (Engine) and `UndoRevisionToolTests` (LocalMcp)

## Context

With one global version, ordinary record entry would make every application proposal
stale. Rewinding the database as "undo" would erase later history and overstate
reversibility for lossy or identity-changing operations. Nendo needs ordered audit
evidence while definition work and unrelated data work proceed independently.

## Decision

Nendo keeps separate revision lineages and one ordered semantic audit stream.

- `definition_revision` advances for schema, semantic UI, constraints, commands and
  application settings. `data_revision` advances for record-state transactions.
  `change_sequence` orders accepted revisions across both lanes.
- Every record carries a version for touched-record optimistic concurrency.
- An accepted transaction appends one attributable revision with its lane, canonical
  operations, stable operation digest, origin, time and declared reversibility
  evidence.
- Idempotency keys are scoped to their authority and session. An exact replay returns
  the original committed outcome, including after intervening changes; reuse with a
  different payload fails. A replay never bypasses current authority or outside-change
  refusal.
- A proposal checks its required definition revision and the versions of only the
  records it reads or transforms, so unrelated record changes do not make UI-only
  work stale.
- Every operation type declares a reversibility class: `Reversible`,
  `ReversibleWithRetainedState` or `IrreversibleDeclared` (camelCase on MCP).
- Compensation is a new typed transaction linked to the original revision. It
  advances history and current versions and never deletes or rewinds audit evidence.
  An inverse is offered only when preconditions and retained state prove it safe;
  backups do not make an irreversible operation reversible.
- A record revision is compensated as a whole, its creates and restores included
  (each by a version-checked delete), up to 12,800 operations. A compensation of
  record changes can itself be compensated, which is redo. A compensated create
  leaves its record ID reserved ([ADR-0023](0023-a-view-undoes-its-own-revisions.md)).
- An agent at Edit data may compensate a record revision its own session committed
  with `nendo.data.undo_revision`, by the same mechanism History and a view use
  ([ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)). The Engine
  refuses a revision another origin committed (`revision-not-yours`), a definition
  revision, and one whose operations are not all compensable.
- A person may fold older history into one checkpoint revision after a backup
  ([ADR-0021](0021-folding-old-history.md)). Exact replay and compensation then reach
  the revisions after the checkpoint; a folded revision's operations are kept in the
  backup. History is still never rewound by a write.

Outcomes per operation are in the
[operation-outcomes contract](../contracts/operation-outcomes.md).

## Consequences

### Positive

- Ordinary data entry does not invalidate unrelated semantic work.
- Audit order stays total and conflicts stay narrow.
- Undo language is accurate and operation-specific.

### Negative

- Callers handle several counters and per-record versions.
- Compensation can itself conflict and is not universal.
- Nendo keeps more protected evidence than a last-state store.

## Rejected alternatives

- One global revision: ordinary data entry would make unrelated proposals stale.
- Snapshot rewind as universal undo: erases later accepted work and cannot invert
  every operation.

## Revisit triggers

- Multi-user collaboration needs vector or causal semantics.
- The split counters cannot express a required cross-lane invariant.
- Retained inverse evidence grows beyond the local-file budget.
