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
If the host attempts a guessed repair, or lets normal integrations continue, a
recoverable finding can become data loss. At the same time, a broken custom
surface must not make otherwise valid user data inaccessible.

## Decision drivers

1. Preserve user data and one trusted authority before convenience.
2. Keep Studio/recovery reachable without WebView2 or custom definitions.
3. Separate compatibility, integrity, drift and renderer failures clearly.
4. Disable only capabilities proven unsafe for the current classification.
5. Make migrations transactional, backed up and reversible by recovery action.
6. Never claim to understand a newer format or unknown executable behavior, and
   never run custom-view code in safe mode or recovery.

## Options considered

### Explicit open classifications with fail-closed capabilities

Classify the file before exposing mutation. Present bounded recovery actions that
the host owns.

### Best-effort normal open and automatic repair

Continue despite drift or incompatibility, and repair what appears wrong. This
option can destroy evidence and make unsupported formats look writable.

### Reject every imperfect file completely

This option protects mutation. But it withholds valid data, export and backups
without need when a bounded read-only projection is still safe.

## Decision

The host classifies every open before it enables normal UI or integrations.

| State | Minimum behavior |
| --- | --- |
| Normal writable | Supported format/host version, valid manifest/schema/integrity, trusted local file and acquired coordinator authority; all authorised capabilities may run |
| Normal read-only | Semantically compatible file whose filesystem/user choice forbids writes; Studio inspection, history, export and backup remain available |
| Safe mode / recovery required | The host can open bounded trusted data, but compatibility, drift, definition, path-authority or recovery findings make normal behavior unsafe; custom surfaces, custom-view code, declarative commands and MCP mutation/authoring are disabled, and data mutation is read-only unless a classifier explicitly proves a narrower safe capability |
| Incompatible or rejected | File identity/format cannot be safely understood, or integrity is insufficient even for bounded projection; no mutation or guessed repair, with copy/diagnostic/upgrade guidance where safe |

### Compatibility

- Format version 1 contains mandatory `format_version` and
  `minimum_host_version` in the protected manifest.
- A host older than `minimum_host_version`, an unknown future core format or an
  unsupported protected schema never opens writable.
- Unknown future user field/presentation semantics remain visible and read-only
  only when the current core format can safely enumerate their bounded values.
  They never disappear silently.
- Older supported formats migrate only through an explicit version path.
  Downgrade-in-place is not supported.
- A file that carries custom-view packages needs host 1.33.0
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)). Open view definitions
  need 1.34.0, and `extensionView` and `extensionTile` need 1.35.0. An older host
  refuses writable open of such a file by the `minimum_host_version` rule above.

### Migration and recovery

- Before a mutating migration or Restore, the host creates and validates a
  current storage-owned backup.
- Migration runs on a host-owned staged SQLite backup. It has explicit source and
  target versions, deterministic steps, transactional validation and
  no-overwrite/fail-closed activation under lifecycle authority.
- A failed migration leaves the active file authoritative and the failure
  evidence available. A successful activation retains a recoverable pre-change
  artefact according to policy.
- External path, byte or canonical-manifest divergence enters recovery required
  before another mutation. The host may refresh authority only after explicit
  validation. The host never silently adopts unrelated changed bytes.

### Safe-mode surfaces and authority

- The thin WinUI host owns a bounded native recovery route. This route remains
  usable when WebView2 cannot initialize or crashes.
- When the workbench can run safely, restricted Studio exposes Health plus
  bounded Data, History, export, backup, restore, diagnostics and custom-surface
  disable/retry actions that are appropriate to the classification.
- Safe mode is host behavior. Application content and agents cannot hide or
  alter it.
- Safe mode and recovery never run custom-view code, whatever the device and file
  switches say. [ADR-0013](0013-custom-views-with-code-in-the-file.md) enforces
  this twice: the Workbench mounts no view frame, and the host answers 403 on
  every view origin. It also puts **Restart without custom views** in the recovery
  panel.
- The selected System/Light/Dark device theme applies to both workbench safe mode
  and the native recovery route where applicable.
- Nendo targets locally created or explicitly trusted files. It does not claim
  hostile-file sandboxing or anti-malware protection. A received file's
  custom-view code runs when its view is shown, outside safe mode and recovery
  (ADR-0013).

## Evidence and validation obligations

- EX-0001 proved manifest validation, invalid-proposal isolation and restart.
- EX-0003 proved that a native fallback remained usable after WebView2 process
  loss.
- EX-0004 proved corrupt/truncated backup classification, staged restore failure
  preservation and open-path replacement recovery.
- EX-0007 proved fail-closed path/canonical-state divergence and exact capacity
  rollback.
- The P4 production checkpoints
  add bounded classification/read-only projections, Engine Restore and the
  registered production-P1 staged migration. The migration has retained
  originals, explicit pending-replacement inspection and actual child-process
  interruption. The checkpoints also record Desktop controller shutdown/reopen,
  native recovery controls and a bounded
  startup-failure/minimum-window/Close/Cancel journey.
- The P4 production closure
  completes the bounded fixture matrix and the actual native picker/Workbench,
  registered upgrade, readable/partial export, diagnostic privacy and theme
  journeys. Actual renderer loss preserves healthy host authority. External file
  divergence revokes that authority and refreshes the visible recovery state. The
  tests cover read-only file attributes and real Windows destination ACL denial.
  They do not cover every physical read-only medium. All fifteen plan acceptance
  rows are mapped.
- Human recovery usability, actual full-device behavior, physical power loss and
  hostile-file handling remain release/hardening evidence, not accepted claims.

## 2026-09-16 amendment — how large a file may be before Nendo will not open it

The owner accepted this amendment on 2026-09-16. The open-time size bound
changes from 64 MiB to 256 MiB. The host derives the refusal sentence from the
constant. The full record, with its measurements and limits, is the entry for
this date in the [decision index](README.md#amendments-in-force).

## 2026-09-17 amendment — a write that would make a file unopenable is refused

The owner accepted this amendment on 2026-09-17. Before any operation is staged,
the host refuses a mutation when the file has reached a write ceiling. There are
two write ceilings, one for bytes and one for inspection rows. Each one sits a
measured reserve below its open bound. The bytes reserve is 32 MiB, so the byte
write ceiling is 224 MiB. The rows reserve is 1,000. The full record, with its
recorded outcomes, is the entry for this date in the
[decision index](README.md#amendments-in-force).

## Consequences

### Positive

- Broken custom behavior cannot make valid data inaccessible.
- Unknown or changed files do not silently receive destructive repairs.
- Migration and restore failures retain an authoritative recovery path.

### Negative

- Capability classification and recovery UX are substantial product work.
- Some readable files will remain non-writable by design.
- Staged migrations require additional temporary disk space.

## Rejected alternatives

Best-effort repair is rejected because it destroys trustworthy evidence.
Complete rejection is rejected when bounded read-only access can be proven safe.

## Revisit triggers

- A received file's custom-view code causes harm that ADR-0013's kill switches do
  not cover, and packages need a trust model such as signatures.
- Cross-platform hosts require different native recovery behavior.
- A migration cannot be staged within the modest local-file budget.
- Hostile third-party files become a supported security boundary.

## History

- 2026-09-02 — accepted.
- 2026-09-16 — the open-time size bound raised from 64 MiB to 256 MiB (the
  amendment above).
- 2026-09-17 — a write that would make a file unopenable is refused (the
  amendment above).
- 2026-09-25 — safe mode and recovery never run custom-view code, and a file that
  carries packages needs host 1.33.0
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)).
- 2026-09-25 — the bytes write reserve raised from 4 MiB to 32 MiB, so the byte
  write ceiling fell from 252 MiB to 224 MiB. A change set may now carry 4 MiB of
  new custom-view package content, which grows the file by about 4.3 MB
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)).
