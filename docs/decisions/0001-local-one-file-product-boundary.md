# ADR-0001: Define the local one-file product boundary

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [Product brief](../vision.md), EX-0001 result, EX-0004 result, EX-0006 result, EX-0007 result, EX-0008 result and the implementation-readiness scope correction
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo needs a durable local artefact that stays useful without an account, an
agent, a hosted service or generated application code. SQLite creates
operational journals, backups and proposal clones. Thus “one file” must
distinguish two things: the canonical portable artefact at rest, and the
host-owned derivatives that exist while the application runs.

The MVP is personal, single-user and Windows-first. Cloud sync, collaboration
and hostile same-user isolation are outside its boundary.

## Decision drivers

1. An empty file must be valid and reopenable.
2. Data must outlive custom surfaces, agents and renderer failures.
3. Users must be able to copy and back up one canonical artefact safely.
4. Operational derivatives need explicit ownership and cleanup.
5. The MVP must remain local/offline and bounded for one maintainer.
6. Unsupported environments must be described accurately and not implied.

## Options considered

### One canonical SQLite file at rest

Keep application data, protected metadata, semantic definitions and history in
one `.nendo` SQLite file. Let the host own temporary journals, backups and
proposal workspaces.

### Directory bundle

Store data, definitions, assets and history as multiple coordinated files. With
this option, partial copies and externally reordered writes would become normal
failure modes.

### Hosted or account-backed authority

Make a service the canonical authority, and treat local files as caches or
exports. This option conflicts with the offline and durable-file proposition.

## Decision

Nendo's canonical artefact is one local `.nendo` SQLite file at rest.

- When the host creates a file, it writes only protected compatibility/identity
  metadata and a genesis history entry. A file with zero user entities and
  records is valid.
- The file contains relational user data, protected Nendo metadata, semantic
  definitions and semantic history.
- A custom view's code may travel in the file, as protected metadata
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)). A copy of the file
  carries the view. Device settings, such as the switches that turn views off,
  stay on the device.
- The host permanently provides Studio and recovery access. Custom surfaces,
  custom views and agents cannot hide or revoke that route.
- Journals, backup outputs, staged restores and proposal clones are operational
  derivatives. The host defines their owner, lifetime and cleanup. They are not
  additional canonical artefacts.
- Open-file copies use SQLite backup or an equivalent host-coordinated snapshot.
  A raw copy of the main file while operational derivatives exist is not
  presented as a current backup.
- Duplicate and Fork semantics follow ADR-0010. Journal and close discipline
  follow ADR-0011.
- Files in known sync-managed locations are unsupported for writable use in the
  MVP. Nendo warns where practical and makes no sync-safety claim. Live cloud
  provider qualification is not an implementation prerequisite.
- The security boundary is the operating-system user account. Nendo does not
  claim protection from malware, privileged processes or arbitrary hostile
  writers that already run as that user.

This decision selects the product boundary. It does not select the exact table
layout or source tree of the disposable prototype.

## Evidence and validation obligations

- EX-0001 proved empty creation/reopen and coherent data, definition and history
  in one SQLite file.
- EX-0004 proved bounded backup/restore, copy and replacement-failure paths.
- EX-0006 proved typed Duplicate/Fork candidate semantics.
- EX-0007 proved one coordinated Windows ownership interval and fail-closed
  outside-change detection.
- EX-0008 proved local DELETE/WAL correctness and open-copy discipline.
- Production tests must retain the empty validity, close/reopen, coordinated
  backup, copy, Duplicate/Fork and recovery journeys.
- Release qualification must not claim sync, physical power-loss or
  hostile-writer guarantees without separately authorised evidence.

## Consequences

### Positive

- The durable unit of the user is simple, portable and independently
  inspectable.
- Studio and safe mode can recover data without generated code or an agent.
- A host-owned lifecycle boundary contains the temporary complexity.

### Negative

- Asset fields and multi-file application bundles are excluded. A custom-view
  package, with its code and assets, is the one executable payload that a file may
  carry (ADR-0013).
- A received file's view code runs when its view is shown. Nendo does not sandbox
  hostile files ([ADR-0012](0012-safe-mode-compatibility-and-migration.md)).
- Open-file copies need an explicit host operation. An Explorer copy is not
  treated as transactionally current.
- Sync-managed folders receive a conservative unsupported-use warning.

## Rejected alternatives

Directory bundles and hosted authority are rejected. They weaken the defining
proposition of a durable local file, and they add coordination scope before the
single-user MVP is proved.

## Revisit triggers

- Binary or asset fields become a product requirement.
- Extension code needs to run outside a view, or across files.
- Cloud sync or collaboration becomes explicit scope.
- SQLite can no longer meet the tested local durability and inspectability
  requirements.
- Cross-platform delivery requires a materially different artefact contract.

## History

- 2026-09-02 — accepted. Assets, executable extensions and multi-file application
  bundles were excluded from the MVP.
- 2026-09-25 — a custom view's code may travel in the file
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)). Asset fields and
  multi-file bundles stay excluded.
