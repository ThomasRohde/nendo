# ADR-0005: Centralize authority in host application services and one write coordinator

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0004 result and EX-0007 result
- **Depends on:** ADR-0001 local file boundary and ADR-0002 containing desktop architecture
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Studio, semantic surfaces and MCP all need the same behavior and must not become
independent storage authorities. On Windows, validating a path and later opening
it leaves a race in which the file can be moved or replaced. SQLite can also
hold committed state outside the main-file bytes while WAL is active.

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

Studio, renderer and MCP would coordinate only through SQLite locking and could
apply inconsistent validation, identity and history rules.

### Validate the path before each operation without pinning it

This detects some changes but leaves a namespace replacement race between the
check and the admitted operation.

## Decision

One host-owned write coordinator is the sole mutation authority for each open
writable `.nendo` file.

- The coordinator owns the cooperative write lease, delete-denying Windows path
  handle, writable kernel/storage session, canonical authority snapshot and one
  serialized mutation gate.
- The desktop lifecycle service receives the user-selected path. UI and MCP
  adapters receive typed application-service capabilities, never SQL, SQLite
  objects, physical identifiers, the database path or generic invocation.
- All schema, data, semantic definition, proposal and lifecycle mutations pass
  through typed application services and the coordinator.
- Read services may use bounded read-only connections but cannot acquire
  mutation authority or leak storage details.
- Each admitted write verifies file identity plus a canonical manifest/state
  snapshot, applies one typed transaction, then advances the authority snapshot
  only to the exact committed result.
- A missing, moved, replaced or semantically changed file fails closed into a
  recovery-required state before another write. Main-file digest alone is not
  sufficient authority evidence where derivatives may contain committed state.
- Disposal closes the kernel and path handle, releases the lease and permits a
  successor coordinator.
- The lease is cooperative and the OS-user account remains the security
  boundary. This is not protection against malware, privileged code or an
  already-open hostile writer.

## Evidence and validation obligations

- EX-0004 proved host-process exclusion and typed service/MCP parity for the
  bounded mutation.
- EX-0007 proved serialized writes, move/delete/replace exclusion at the race
  seam, WAL-only outside-change detection, native capacity rollback and
  successor ownership on the Windows reference machine.
- Production tests must cover concurrent UI/MCP calls, cancellation,
  idempotency, outside changes, disposal, renderer restart and recovery mode.
- The 2026-09-05 remediation record
  adds executed delayed-replay and audit-drift regressions: historical receipts
  do not replace current session authority, and the digest covers typed audit,
  canonical operations and retained inverse evidence. This strengthens the
  existing session check without changing the file format or writer boundary.
- Network shares, removable media, non-Windows semantics and arbitrary hostile
  writers are unsupported unless separately qualified.

## Consequences

### Positive

- All clients observe one validation, revision and authority model.
- The host can outlive/restart renderers without transferring storage authority.
- File replacement and cooperative writer races fail closed.

### Negative

- Long operations can serialize unrelated writes and need cancellation/progress.
- Windows path-handle behavior is part of the MVP host implementation.
- External SQLite mutation is unsupported and may force recovery mode.

## Rejected alternatives

Adapter-owned connections and check-then-open path validation are rejected
because they fragment semantic authority and leave the tested namespace race.

## Revisit triggers

- Multi-user or multi-process cooperative editing becomes product scope.
- Cross-platform support requires another path-ownership mechanism.
- Measured workloads require a different internal connection lifetime while
  preserving the single authority boundary.

## 2026-09-05 R06 implementation evidence

R06 retains one coordinator and connection. The [read and authority contract](../contracts/reads-and-authority.md) records complete initial content verification, snapshot-bound connection-token checks, atomic local authority publication and permanent rejection of outside commits. Bounded typed pages and metadata projections do not transfer authority to adapters. See the measured result.
