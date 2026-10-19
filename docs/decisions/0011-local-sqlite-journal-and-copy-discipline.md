# ADR-0011: Use local rollback journaling and host-owned copy discipline

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `StorageReviewTests`, `BackupTests`, `FormatAndLifecycleTests` and `ReviewStorageRegressionTests` (Engine)

## Context

Rollback DELETE and WAL both preserved Nendo's typed state in measurement. WAL gave
better reader coexistence and throughput, but a much larger writer tail, and it
keeps a multi-file set while the file is open. Nendo values a simple one-file-at-rest
artefact and predictable single-user edits over maximum concurrent reads. Cloud sync
is out of scope, and the decision makes no provider or physical-device guarantee.

## Decision

Local storage uses SQLite rollback journaling in `DELETE` mode.

- Every writable connection and every relevant read connection applies and verifies
  the host profile rather than relying on ambient defaults: `journal_mode = DELETE`,
  `synchronous = FULL`, `busy_timeout = 2000` ms. Busy outcomes are bounded typed
  service errors; callers do not spin.
- The [ADR-0005](0005-host-application-services-and-write-coordinator.md)
  coordinator admits every write. UI and MCP clients cannot choose journal modes,
  PRAGMAs or connection settings.
- The rollback journal is a transient derivative. A clean close leaves one canonical
  `.nendo` file at rest. A journal left by an interrupted writer is handled as
  [ADR-0012](0012-safe-mode-compatibility-and-migration.md) says.
- While a file is open, Backup, Duplicate, Fork, New and Restore staging use the
  SQLite backup API or an equivalent storage-owned snapshot and validate semantic
  state. Independent copy connections compare complete content digests.
- A raw main-file copy is described as current only after a coordinated clean close;
  currency is never inferred from the main file's bytes alone.
- Known sync-managed locations are unsupported for writable use and get a warning
  where practical. No cloud-provider or sync-safety claim is made.
- Connection lifetime and pooling are implementation choices behind the profile. See
  the [read and authority contract](../contracts/reads-and-authority.md).
- Physical power loss, torn sectors, real full-device behaviour, network shares and
  live sync clients are unqualified.

WAL remains a documented alternative. Selecting it needs a new measured workload and
an explicit derivative and checkpoint lifecycle.

## Consequences

### Positive

- The profile matches the one-file-at-rest product model.
- Copy and backup rules are simpler than for an always-open WAL set.
- Settings and busy behaviour are explicit and testable.

### Negative

- A long reader can delay a writer more than under WAL.
- Read-heavy Studio workloads may outgrow the profile.
- `FULL` synchronous gives up some throughput for durability.

## Rejected alternatives

- Provider-default journal mode: not a stable product contract.
- WAL for the first profile: failed the predeclared writer-tail allowance despite its
  reader benefits.

## Revisit triggers

- Studio workloads contain long reads or show unacceptable blocked edit latency.
- A different connection or checkpoint strategy repeatably improves WAL writer tails.
- Cloud sync, network shares or cross-platform filesystems enter supported scope.
- Physical-device testing contradicts the durability assumptions.
