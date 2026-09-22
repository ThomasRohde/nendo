# ADR-0012: Fail closed through explicit compatibility and safe-mode states

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0003 result, EX-0004 result, EX-0007 result and the [Studio design](../contracts/studio.md)
- **Depends on:** ADR-0001 local file boundary, ADR-0002 containing desktop architecture, ADR-0003 format boundary and ADR-0005 write coordinator
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo will encounter invalid semantic definitions, incompatible host versions,
external file changes, failed migrations, corrupt backups and renderer failure.
Attempting guessed repair or allowing normal integrations to continue can turn a
recoverable finding into data loss. At the same time, a broken custom surface
must not make otherwise valid user data inaccessible.

## Decision drivers

1. Preserve user data and one trusted authority before convenience.
2. Keep Studio/recovery reachable without WebView2 or custom definitions.
3. Separate compatibility, integrity, drift and renderer failures clearly.
4. Disable only capabilities proven unsafe for the current classification.
5. Make migrations transactional, backed up and reversible by recovery action.
6. Never pretend to understand a newer format or unknown executable behavior.

## Options considered

### Explicit open classifications with fail-closed capabilities

Classify the file before exposing mutation and present bounded recovery actions
owned by the host.

### Best-effort normal open and automatic repair

Continue despite drift or incompatibility and repair what appears wrong. This
can destroy evidence and make unsupported formats look writable.

### Reject every imperfect file completely

Protects mutation but needlessly withholds valid data, export and backups when a
bounded read-only projection is still safe.

## Decision

The host classifies every open before enabling normal UI or integrations.

| State | Minimum behavior |
| --- | --- |
| Normal writable | Supported format/host version, valid manifest/schema/integrity, trusted local file and acquired coordinator authority; all authorised capabilities may run |
| Normal read-only | Semantically compatible file whose filesystem/user choice forbids writes; Studio inspection, history, export and backup remain available |
| Safe mode / recovery required | The host can open bounded trusted data but compatibility, drift, definition, path-authority or recovery findings make normal behavior unsafe; custom surfaces, declarative commands and MCP mutation/authoring are disabled, and data mutation is read-only unless a classifier explicitly proves a narrower safe capability |
| Incompatible or rejected | File identity/format cannot be safely understood or integrity is insufficient even for bounded projection; no mutation or guessed repair, with copy/diagnostic/upgrade guidance where safe |

### Compatibility

- Format version 1 contains mandatory `format_version` and
  `minimum_host_version` in the protected manifest.
- A host older than `minimum_host_version`, an unknown future core format or an
  unsupported protected schema never opens writable.
- Unknown future user field/presentation semantics remain visible and read-only
  only when the current core format can safely enumerate their bounded values;
  they never disappear silently.
- Older supported formats migrate only through an explicit version path.
  Downgrade-in-place is not supported.

### Migration and recovery

- Before a mutating migration or Restore, the host creates and validates a
  current storage-owned backup.
- Migration runs on a host-owned staged SQLite backup with explicit source and
  target versions, deterministic steps, transactional validation and
  no-overwrite/fail-closed activation under lifecycle authority.
- A failed migration leaves the active file authoritative and the failure
  evidence available; successful activation retains a recoverable pre-change
  artefact according to policy.
- External path, byte or canonical-manifest divergence enters recovery required
  before another mutation. Refreshing authority is allowed only after explicit
  validation; the host never silently adopts unrelated changed bytes.

### Safe-mode surfaces and authority

- The thin WinUI host owns a bounded native recovery route that remains usable
  when WebView2 cannot initialize or crashes.
- When the workbench can run safely, restricted Studio exposes Health plus
  bounded Data, History, export, backup, restore, diagnostics and custom-surface
  disable/retry actions appropriate to the classification.
- Safe mode is host behavior and cannot be hidden or altered by application
  content or an agent.
- The selected System/Light/Dark device theme reaches both workbench safe mode
  and the native recovery route where applicable.
- Nendo targets locally created or explicitly trusted files. It does not claim
  hostile-file sandboxing or anti-malware protection.

## Evidence and validation obligations

- EX-0001 proved manifest validation, invalid-proposal isolation and restart.
- EX-0003 proved a native fallback remained usable after WebView2 process loss.
- EX-0004 proved corrupt/truncated backup classification, staged restore failure
  preservation and open-path replacement recovery.
- EX-0007 proved fail-closed path/canonical-state divergence and exact capacity
  rollback.
- The P4 production checkpoints
  add bounded classification/read-only projections, Engine Restore and the
  registered production-P1 staged migration, with retained originals, explicit
  pending-replacement inspection and actual child-process interruption.
  Desktop controller shutdown/reopen, native recovery controls and a bounded
  startup-failure/minimum-window/Close/Cancel journey are also recorded.
- The P4 production closure
  completes the bounded fixture matrix and actual native picker/Workbench,
  registered upgrade, readable/partial export, diagnostic privacy and theme
  journeys. Actual renderer loss preserves healthy host authority; external
  file divergence revokes it and refreshes the visible recovery state. Read-only
  file attributes and real Windows destination ACL denial are tested, not every
  physical read-only medium. All fifteen plan acceptance rows are mapped.
- Human recovery usability, actual full-device behavior, physical power loss and
  hostile-file handling remain release/hardening evidence, not accepted claims.

## Consequences

### Positive

- Broken custom behavior cannot make valid data inaccessible.
- Unknown or changed files do not silently receive destructive repairs.
- Migration and restore failures retain an authoritative recovery path.

### Negative

- Capability classification and recovery UX are substantial product work.
- Some readable files will intentionally remain non-writable.
- Staged migrations require additional temporary disk space.

## Rejected alternatives

Best-effort repair is rejected because it destroys trustworthy evidence.
Complete rejection is rejected when bounded read-only access can be proven safe.

## Revisit triggers

- Signed/trusted extension packages introduce a stronger trust model.
- Cross-platform hosts require different native recovery behavior.
- A migration cannot be staged within the modest local-file budget.
- Hostile third-party files become a supported security boundary.
