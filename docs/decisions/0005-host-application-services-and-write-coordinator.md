# ADR-0005: Centralize authority in host application services and one write coordinator

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0004 result and EX-0007 result
- **Depends on:** ADR-0001 local file boundary and ADR-0002 containing desktop architecture
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Studio, semantic surfaces and MCP all need the same behavior. They must not
become independent storage authorities. On Windows, if a process validates a path
and opens it later, a race remains: the file can be moved or replaced between the
two steps. While WAL is active, SQLite can also hold committed state outside the
main-file bytes.

## Decision drivers

1. One typed mutation path for every adapter.
2. Serialized writes, optimistic preconditions and idempotency.
3. Bounded ownership of the open file and its namespace entry.
4. Fail-closed detection of outside semantic changes.
5. Renderer and MCP isolation from SQLite and filesystem authority.
6. Clear release and recovery behavior.

## Options considered

### One host-owned coordinator per writable file

Own the cooperative lease, Windows path pin, writable kernel, authority snapshot
and serialized mutation gate for the complete open session.

### Let each adapter open SQLite independently

Studio, renderer and MCP would coordinate only through SQLite locking. They could
apply inconsistent validation, identity and history rules.

### Validate the path before each operation without pinning it

This option detects some changes. But it leaves a namespace replacement race
between the check and the admitted operation.

## Decision

One host-owned write coordinator is the sole mutation authority for each open
writable `.nendo` file.

- The coordinator owns these items:
  - the cooperative write lease;
  - the delete-denying Windows path handle;
  - the writable kernel/storage session;
  - the canonical authority snapshot;
  - one serialized mutation gate.
- The desktop lifecycle service receives the user-selected path. UI and MCP
  adapters receive typed application-service capabilities. They never receive
  SQL, SQLite objects, physical identifiers, the database path or generic
  invocation.
- All schema, data, semantic definition, proposal and lifecycle mutations pass
  through typed application services and the coordinator.
- Read services may use bounded read-only connections. They cannot acquire
  mutation authority or leak storage details.
- Each admitted write verifies the file identity plus a canonical manifest/state
  snapshot and applies one typed transaction. Then it advances the authority
  snapshot only to the exact committed result.
- If the file is missing, moved, replaced or semantically changed, the host fails
  closed into a recovery-required state before another write. Where derivatives
  may contain committed state, a main-file digest alone is not sufficient
  authority evidence.
- Disposal closes the kernel and path handle, releases the lease and permits a
  successor coordinator.
- The lease is cooperative, and the OS-user account remains the security
  boundary. This design does not protect against malware, privileged code or an
  already-open hostile writer.

## Evidence and validation obligations

- EX-0004 proved host-process exclusion and typed service/MCP parity for the
  bounded mutation.
- EX-0007 proved these results on the Windows reference machine: serialized
  writes, move/delete/replace exclusion at the race seam, WAL-only outside-change
  detection, native capacity rollback and successor ownership.
- Production tests must cover concurrent UI/MCP calls, cancellation,
  idempotency, outside changes, disposal, renderer restart and recovery mode.
- The 2026-09-05 remediation record
  adds executed delayed-replay and audit-drift regressions. Historical receipts
  do not replace current session authority. The digest covers typed audit,
  canonical operations and retained inverse evidence. This change strengthens the
  existing session check, and does not change the file format or writer boundary.
- Network shares, removable media, non-Windows semantics and arbitrary hostile
  writers are unsupported unless separately qualified.

## Consequences

### Positive

- All clients observe one validation, revision and authority model.
- The host can outlive/restart renderers and does not transfer storage authority.
- File replacement and cooperative writer races fail closed.

### Negative

- Long operations can serialize unrelated writes and need cancellation/progress.
- Windows path-handle behavior is part of the MVP host implementation.
- External SQLite mutation is unsupported and may force recovery mode.

## Rejected alternatives

Adapter-owned connections and check-then-open path validation are rejected. They
fragment semantic authority and leave the tested namespace race.

## Revisit triggers

- Multi-user or multi-process cooperative editing becomes product scope.
- Cross-platform support requires another path-ownership mechanism.
- Measured workloads require a different internal connection lifetime while
  preserving the single authority boundary.

## 2026-09-05 R06 implementation evidence

R06 keeps one coordinator and one connection. The [read and authority contract](../contracts/reads-and-authority.md) records these items: complete initial content verification, snapshot-bound connection-token checks, atomic local authority publication and permanent rejection of outside commits. Bounded typed pages and metadata projections do not transfer authority to adapters. See the measured result.
