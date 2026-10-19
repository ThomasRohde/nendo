# ADR-0010: Define file identity, Duplicate, Fork, Backup and Restore

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `IdentityCopyTests`, `NewFileTests`, `BackupTests`, `RestoreTests`, `RestoreInterruptionTests` (Engine) and `DesktopReplacementTests` (Desktop)

## Context

An operating-system copy preserves bytes and embedded IDs, but people also need
deliberate Duplicate, Fork, Backup and Restore with distinct meanings. Silently
rewriting identity when a raw copy opens would change user data without consent or
typed history, and replacing an existing destination could destroy unrelated files.

## Decision

| Operation | Identity and history |
| --- | --- |
| Raw filesystem copy | Keeps bytes, application ID and instance ID. Nendo classifies the duplicate instance and never rewrites it silently. |
| Duplicate | Keeps the application ID, assigns a new instance ID, retains history and appends one typed transition revision. |
| Fork | Assigns new application and instance IDs, retains source history as explicit lineage and appends one typed transition revision. |
| New | A Duplicate's identity with only the definition and the records the application keeps in new files, its history folded into one checkpoint ([ADR-0022](0022-new-file-keeping-the-records-an-application-ships-with.md)). |
| Backup | Keeps all identity and history exactly, through the storage-owned backup path. |
| Restore | Replaces active state only through verified staged activation, keeps the restored identity and history, and retains a recoverable pre-restore copy. |

- Duplicate and Fork use one canonical `identity.transition` operation through a
  dedicated kernel and application-service path. It records the source and result
  IDs and the source revision point in ordinary operation history, with no identity
  sidecar or separate provenance table.
- The transition is `irreversible-declared`. It advances the definition revision and
  change sequence once, and neither the data revision nor any user record. Generic
  mutation and proposal paths reject it.
- The host stages a SQLite backup in the destination filesystem, applies the
  transition, validates format, identity, revisions and integrity, and activates the
  result without overwriting. New uses its own coordinator path with the same
  staging and no-overwrite activation.
- The [ADR-0005](0005-host-application-services-and-write-coordinator.md) coordinator
  verifies source path authority. The source stays unchanged on success or failure.
- Existing or racing destinations are never overwritten. Concurrent exact retries
  converge only when the committed typed provenance matches.
- Result IDs need to be collision-resistant only within the local product; there is
  no global registry.
- Move and Rename keep embedded identity and are neither Duplicate nor Fork.
- Restore and upgrade stop MCP and reopen only the verified result with fresh session
  authority.

Outcomes, retries and limits per operation are in the
[operation-outcomes contract](../contracts/operation-outcomes.md). Cross-volume
metadata atomicity and physical power loss are not claimed.

## Consequences

### Positive

- People choose whether a result stays in an application lineage or becomes a new
  application.
- Identity changes use the same typed audit and idempotency model as other changes.
- Raw copies and caller-owned destinations are never changed silently.

### Negative

- Raw duplicate instances need a clear warning and resolution journey.
- A Fork keeps source history, including possibly sensitive provenance.
- Same-directory activation does not prove every filesystem.

## Rejected alternatives

- Raw copy followed by silent identity repair at open: a hidden mutation outside
  history.
- Treating every copy as a new application: loses the difference between another
  instance and a true fork.

## Revisit triggers

- People cannot tell Duplicate from Fork in the installed journey.
- Cross-device or shared-folder workflows need globally coordinated identity.
- A privacy model requires history redaction when forking.
- Cross-platform filesystems cannot provide equivalent no-overwrite staging.
