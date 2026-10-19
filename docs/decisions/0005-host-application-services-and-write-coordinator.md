# ADR-0005: Centralize authority in host application services and one write coordinator

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `WriteCoordinatorReviewTests`, `InstanceOwnershipTests`, `ObservedFileTests`, `AuthorityCacheTests` (Engine) and `McpDataParityTests` (LocalMcp)

## Context

Studio, semantic surfaces and MCP need the same behaviour without becoming separate
storage authorities. On Windows a path validated now and opened later can be moved
or replaced in between, and SQLite can hold committed state outside the main file's
bytes.

## Decision

One host-owned write coordinator is the sole mutation authority for each open
writable `.nendo` file.

- The coordinator owns the cooperative write lease, the delete-denying Windows path
  handle, the writable kernel and storage session, the canonical authority snapshot
  and one serialized mutation gate.
- The desktop lifecycle service receives the path the person chose. UI and MCP
  adapters receive typed application-service capabilities, never SQL, SQLite objects,
  physical identifiers, the database path or generic invocation.
- Every schema, data, definition, proposal and lifecycle mutation passes through
  typed application services and the coordinator.
- Read services may use bounded read-only connections. They cannot acquire mutation
  authority or leak storage details.
- Each admitted write verifies file identity and the canonical manifest and state
  snapshot, applies one typed transaction, and advances the authority snapshot only
  to the exact committed result.
- A missing, moved, replaced or semantically changed file fails closed into recovery
  required before another write. Where derivatives may hold committed state, a
  main-file digest alone is not authority evidence.
- A historical receipt never replaces current session authority. The authority digest
  covers typed audit, canonical operations and retained inverse evidence.
- Disposal closes the kernel and path handle, releases the lease and admits a
  successor coordinator.
- The lease is cooperative; the operating-system account is the security boundary.
  This does not protect against malware, privileged code or an already-open hostile
  writer. Network shares, removable media and non-Windows filesystems are unsupported.

The [read and authority contract](../contracts/reads-and-authority.md) holds the
detail: initial content verification, snapshot-bound connection tokens, atomic
authority publication and permanent rejection of outside commits.

## Consequences

### Positive

- Every client sees one validation, revision and authority model.
- The host can outlive and restart renderers without handing over storage authority.
- File replacement and cooperative-writer races fail closed.

### Negative

- Long operations serialize unrelated writes and need cancellation and progress.
- Windows path-handle behaviour is part of the host implementation.
- External SQLite mutation is unsupported and may force recovery mode.

## Rejected alternatives

- Each adapter opening SQLite itself: fragments validation, identity and history
  rules.
- Validating the path before each operation without pinning it: leaves the
  namespace replacement race.

## Revisit triggers

- Multi-user or multi-process cooperative editing becomes product scope.
- Cross-platform support needs another path-ownership mechanism.
- Measured workloads need a different connection lifetime behind the same single
  authority.
