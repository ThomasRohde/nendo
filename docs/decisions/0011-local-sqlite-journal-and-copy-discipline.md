# ADR-0011: Use local rollback journaling and host-owned copy discipline

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0004 result, EX-0007 result, EX-0008 result and the owner cloud-sync scope correction
- **Depends on:** ADR-0001 local one-file boundary, ADR-0005 write coordinator and ADR-0010 lifecycle semantics
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

SQLite rollback DELETE and WAL both preserved Nendo's typed state in the bounded
experiments. WAL improved long-read coexistence and reader throughput, but the
tested profile had a much larger writer tail and requires a multi-file
operational set while open. Nendo's MVP values a simple local one-file-at-rest
artefact and modest single-user workloads over maximum concurrent read rate.

Cloud sync is outside the MVP. The decision must not make untested provider or
physical-device guarantees.

## Decision drivers

1. Exact transactional state, revisions, idempotency and integrity.
2. Predictable local writer latency for interactive edits.
3. One canonical file at rest with understandable copy behavior.
4. Current backups while the application is open.
5. One coordinator-owned connection policy with bounded busy behavior.
6. Honest unsupported-location and physical-failure boundaries.

## Options considered

### Rollback journal in DELETE mode

The rollback sidecar exists only during a transaction and the normal closed
state is one file. Readers can temporarily delay a writer.

### WAL

Readers and writers coexist better and measured read throughput was higher, but
committed current state can remain in `-wal`; a main-file-only copy may be valid
but stale, and the tested writer p95 regressed materially.

### Leave the mode provider-default

This avoids a decision but makes connection behavior, copy rules and evidence
dependent on ambient SQLite defaults.

## Decision

The first production local storage profile uses SQLite rollback journaling in
`DELETE` mode.

- Every writable and relevant read connection applies/verifies the bounded host
  profile rather than relying on ambient defaults.
- `synchronous=FULL` is required for the local MVP profile.
- The initial busy timeout is 2,000 ms. Busy outcomes remain bounded typed
  service errors; callers do not spin indefinitely.
- All writes are admitted by the ADR-0005 coordinator. UI and MCP clients cannot
  select journal modes, PRAGMAs or connection settings.
- A rollback journal is a host/SQLite-owned transient derivative. Clean close
  must leave one canonical `.nendo` file at rest.
- While a file is open, Backup/Duplicate/Fork/Restore staging uses the SQLite
  backup API or equivalent storage-owned snapshot and validates semantic state.
- Raw main-file copy is described as current only after coordinated clean close.
  The product does not infer currency from main-file bytes alone.
- Known sync-managed locations are unsupported for writable use and receive a
  warning where practical. No live cloud-provider or sync-safety claim follows.
- Connection lifetime and pooling remain implementation choices behind the
  profile. The disposable prototype's connection-per-call strategy is not
  promoted by this ADR.

WAL remains a documented alternative, not a rejected technology. It requires a
new measured workload and explicit derivative/checkpoint lifecycle before
selection.

## Evidence and validation obligations

- EX-0004 proved 150 abrupt child exits and bounded DELETE/WAL concurrency,
  backup/restore and replacement handling.
- EX-0007 proved native `SQLITE_FULL` rollback/retry and abrupt exit during an
  observed incomplete WAL checkpoint.
- EX-0008 ran three measured trials per mode. DELETE median reader/writer p95
  stayed below 100 ms and its controlled-read writer delay stayed inside the
  2,000 ms bound. WAL improved controlled-read delay by 91.15 percent and read
  throughput by about 47.75 percent, but its writer p95 regressed by 328.75
  percent and failed the predeclared selection rule.
- Production tests must inspect applied settings on all connection paths,
  transaction/cancellation cleanup, backup currency, clean close and no retained
  sidecars.
- The P4 production closure
  records the production profile/clean-close checks, coordinated current
  backups, native SQLITE_FULL rollback/retry, actual process interruption,
  no-overwrite activation and two-application offline lifecycle journeys. The
  final from-restore suite passed; no live-provider or physical-device claim
  follows from that result.
- Physical power loss, torn sectors, actual full-device behavior, network shares
  and live sync clients remain unqualified.

## Consequences

### Positive

- The chosen profile matches the local one-file-at-rest product model.
- Copy and backup rules are simpler than an always-open WAL file set.
- Settings and busy behavior are explicit and testable.

### Negative

- A long reader can delay a writer more than under WAL.
- Read-heavy future Studio workloads may outgrow the measured profile.
- `FULL` synchronous operation trades some throughput for the selected local
  durability posture.

## Rejected alternatives

Provider-default behavior is rejected because it is not a stable product
contract. WAL is not selected for the first profile because it failed the
predeclared writer-tail allowance, despite material reader benefits.

## Revisit triggers

- Production Studio workloads contain long reads or show unacceptable blocked
  edit latency.
- A different connection/checkpoint strategy materially improves WAL writer
  tails in repeatable tests.
- Cloud sync, network shares or cross-platform filesystems enter supported scope.
- Physical-device testing contradicts the selected durability assumptions.

## 2026-09-05 R06 implementation evidence

R06 keeps rollback DELETE, synchronous FULL and full copy validation. Ordinary reads reuse verified authority with a same-connection change token; independent copy connections compare complete content digests. The [contract](../contracts/reads-and-authority.md) and local measurements refine implementation evidence without claiming cloud or physical-power-loss safety.
