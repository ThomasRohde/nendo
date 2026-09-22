# ADR-0010: Define file identity, Duplicate, Fork, Backup and Restore

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0004 result, EX-0006 result and EX-0007 result
- **Depends on:** ADR-0001 local one-file boundary, ADR-0005 write coordinator and ADR-0006 revision model
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

An operating-system copy preserves bytes and embedded IDs, but users also need
intentional Duplicate, Fork, Backup and Restore operations with different
semantic meanings. Silently rewriting identity when a raw copy is opened would
mutate user data without consent and leave no typed history. Replacing an
existing destination risks destroying unrelated files.

## Decision drivers

1. Identity is durable semantic state, not a path-derived property.
2. Duplicate and Fork must have distinct understandable meanings.
3. Every identity change needs typed provenance and revision history.
4. Source and caller-owned destination bytes must be preserved on failure.
5. Backup/Restore must remain recovery operations, not identity transitions.
6. Exact retries and racing destinations must fail or converge deterministically.

## Options considered

### Typed transitions on a verified staged SQLite backup

Create a host-owned destination stage, apply one canonical identity operation,
validate it, then activate without overwriting a destination.

### Raw copy followed by silent identity repair

Rewrite IDs when duplicate identity is detected at open. This hides a semantic
mutation outside normal history and can surprise users.

### Treat every copy as a new application

Always generate new application and instance IDs. This loses the useful
distinction between another instance of the same application and a true fork.

## Decision

Nendo distinguishes five lifecycle operations:

| Operation | Identity and history behavior |
| --- | --- |
| Raw filesystem copy | Preserves bytes, application ID and instance ID; Nendo classifies the duplicate instance and does not rewrite it silently |
| Duplicate | Preserves application ID, assigns a new instance ID, retains history and appends one typed transition revision |
| Fork | Assigns new application and instance IDs, retains source history as explicit lineage and appends one typed transition revision |
| Backup | Preserves all identity/history exactly and captures current semantic state through the storage-owned backup path |
| Restore | Replaces active state only through verified staged activation, preserves the restored identity/history and retains a recoverable pre-restore artefact |

Duplicate and Fork use one canonical `identity.transition` operation through a
dedicated kernel/application-service path.

- The transition records source/result IDs and the source revision point in
  ordinary canonical operation history; no identity sidecar or separate
  provenance table is introduced.
- It is `irreversible-declared`, advances the definition revision and change
  sequence once, and does not advance data revision or alter user records.
- Generic mutation and proposal paths reject identity transitions.
- The host creates a SQLite backup stage in the destination filesystem, applies
  the transition, validates format/identity/revisions/integrity, then activates
  with no-overwrite semantics.
- Source path authority is verified through the ADR-0005 coordinator. The source
  remains unchanged on success or failure.
- Existing or racing destinations are never overwritten. Exact concurrent
  retries may converge only when the committed typed provenance matches.
- Host-generated result IDs need only be collision-resistant inside the bounded
  local product; Nendo does not claim a global registry.
- Move/Rename preserves embedded identity and is not a Duplicate or Fork.

## Evidence and validation obligations

- [Review outcome/lifecycle audit](../contracts/operation-outcomes.md#file-lifecycle-outcomes-and-limits)
  preserves the P4 copy/replacement evidence and retry limits, and separates a
  completed native file-action notice from later view-refresh failure.

- EX-0006 proved both transition tables, one exact irreversible definition-lane
  revision, restart provenance, exact/concurrent replay, staged fault cleanup and
  no-overwrite activation.
- EX-0004 proved storage-owned backup, corrupt/truncated rejection, verified
  staged restore and recoverable pre-restore retention.
- EX-0007 supplied the long-lived source path/write authority boundary.
- The 2026-09-04 P4 implementation checkpoints
  add production Engine Backup, typed Duplicate/Fork and staged Restore evidence,
  including source preservation, restart provenance, failure/cancellation,
  no-overwrite tests, local instance admission and actual Restore child-process
  termination with fresh-process read-only recovery inspection. Desktop controller
  Restore/upgrade now stop MCP and reopen only the verified result with fresh
  session authority.
- The P4 production closure
  completes the bounded native/Workbench naming, collision, recent-file,
  cancel/retry, capacity and recovery journeys. Actual Windows destination ACL
  denial, two Desktop instances, populated Idea/Decision offline copy/Restore
  and delayed MCP invalidation are included. Human comprehension of the
  Duplicate/Fork distinction remains unevaluated; only local tested filesystem
  behavior is claimed.
- Cross-volume metadata atomicity and physical power loss are not claimed.

## Consequences

### Positive

- Users can choose whether a result stays in an application lineage or becomes
  a new application.
- Identity changes use the same typed audit/idempotency model as other changes.
- Raw copies and caller-owned destinations are never mutated silently.

### Negative

- Raw duplicate instances need a clear warning and resolution journey.
- Fork retains source history, including lineage and potentially sensitive
  provenance.
- Same-directory activation behavior does not prove every filesystem.

## Rejected alternatives

Silent repair and “every copy is a fork” are rejected because both erase user
intent and bypass explicit typed history.

## Revisit triggers

- Users cannot understand the Duplicate/Fork distinction in the installed
  journey.
- Cross-device or shared-folder workflows require globally coordinated identity.
- A future privacy model requires history redaction when forking.
- Cross-platform filesystems cannot implement equivalent no-overwrite staging.
