# ADR-0012: Fail closed through explicit compatibility and safe-mode states

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `FileInspectionTests`, `FormatPromiseTests`, `FileGrowthMeasurementTests`, `StorageEvolutionReviewTests`, `RestoreTests`, `UpgradeLifecycleTests`, `MediaTests` (Engine) and `DesktopRecoveryTests` (Desktop)

## Context

Nendo meets invalid definitions, incompatible host versions, external changes,
failed migrations, corrupt backups and renderer failure. A guessed repair, or normal
integrations carrying on, can turn a recoverable finding into data loss. A broken
custom surface must not make valid data unreachable.

## Decision

The host classifies every open before it enables normal UI or integrations.

| State | Minimum behaviour |
| --- | --- |
| Normal writable | Supported format and host version, valid manifest, schema and integrity, trusted local file and acquired coordinator authority; all authorised capabilities run. |
| Normal read-only | Compatible file whose filesystem or the person's choice forbids writes; Studio inspection, history, export and backup stay available. |
| Safe mode / recovery required | Bounded trusted data can be opened, but compatibility, drift, definition, path-authority or recovery findings make normal behaviour unsafe. Custom surfaces, custom-view code, declarative commands and MCP mutation and authoring are off; data is read-only unless a classifier proves a narrower safe capability. |
| Incompatible or rejected | Identity or format cannot be safely understood, or integrity is too poor even for bounded projection; no mutation or guessed repair, with copy, diagnostic or upgrade guidance where safe. |

### Compatibility

- The protected manifest carries mandatory `format_version` and
  `minimum_host_version`. A host older than `minimum_host_version`, an unknown future
  core format or an unsupported protected schema never opens writable.
- Unknown future field or presentation semantics stay visible and read-only only when
  the current core format can safely enumerate their values; they never disappear
  silently.
- A feature older hosts cannot read raises `minimum_host_version` to its rung on the
  `NendoFormat` ladder; [`../architecture.md`](../architecture.md) names the highest
  rung and the [semantic-surfaces contract](../contracts/semantic-surfaces.md) places
  every one. Among them: custom-view packages 1.33.0, open view definitions 1.34.0, a
  declared hierarchy 1.35.0 and its outline 1.36.0, a unique field 1.37.0, a file's
  own look 1.38.0, folded history 1.39.0, a filter or sort on a calculated field
  1.40.0, what a new file keeps 1.41.0, `extensionView` 1.42.0, a skill package
  1.43.0, a link rule 1.45.0, media 1.52.0.
- Older supported formats migrate only through an explicit version path. A file is
  never downgraded in place.

### The 1.x format promise

The product version (`Directory.Build.props`) is what the person installs; the
minimum host version is the format's capability ladder. The promise is in product
versions:

1. A file that Nendo 1.0.0 opens normally, every later 1.x opens *Normal writable*
   where the file and folder allow writes, with every record type, field, value,
   screen node and package reading back unchanged. That includes files 0.x hosts
   wrote.
2. A later 1.x may add rungs, never remove one. It keeps core format version 1 and
   every rung up to 1.51.0. Any migration a file needs runs automatically through the
   staged, backed-up path below.
3. Not promised: an older 1.x still refuses a file that uses a newer rung, and how a
   screen looks or behaves may improve.

Breaking any part needs Nendo 2.0 and its own ADR. `FormatPromiseTests` holds it with
the fixtures in `tests/Nendo.Engine.Tests/Fixtures/Format1/` (`Nendo Station.nendo`
at 1.33.0, `Swarm.nendo` at 1.42.0, and a generated `Rung 1.51.0.nendo`), each with
a JSON record of what it holds: it opens a copy of each, requires *Normal writable*
with no findings, compares what it reads with the record, and writes to it. Within
1.x a fixture may be added for a new rung but never rebuilt or replaced. The builder
runs only with `NENDO_WRITE_FORMAT_FIXTURES=1`.

### Size bounds

- A file opens only within 256 MiB (`MaximumInspectionFileBytes`) and 100,000 rows in
  each of `__nendo_entity`, `__nendo_field`, `__nendo_revision` and
  `__nendo_operation` (`MaximumInspectionRows`). The sentence a person sees is derived
  from the constant.
- A write is refused before anything is staged once the file reaches a write ceiling:
  32 MiB below the byte bound (224 MiB) and 1,000 rows below the row bound. The
  refusal states what was measured, that nothing changed and that the file still
  opens.
- The ceilings are early headroom, not proof. Direct writes and proposal promotion
  measure the pending transaction's pages, schema objects, each table and live
  records against the open bounds before commit, and roll back a result this host
  would not open.
- Embedded media content (`__nendo_media_content`) is outside these bounds and
  bounded on its own: 64 MiB per item and 2 GiB per file
  ([ADR-0031](0031-media-in-user-data.md)). Opening checks the media tables' shape and
  totals without reading their content. The physical file may reach the open bound
  plus the media bound plus the write headroom, checked before SQLite opens anything.

### Migration, restore and recovery

- Before a mutating migration or Restore, the host creates and validates a current
  storage-owned backup.
- Migration runs on a staged SQLite backup, with explicit source and target versions,
  deterministic steps, transactional validation and no-overwrite, fail-closed
  activation. A failed migration leaves the active file authoritative with its
  failure evidence; a successful one keeps a recoverable pre-change copy.
- A file marked read-only in File Explorer is not replaced by Restore or upgrade:
  Nendo refuses with `replacement-target-read-only` and asks the person to clear the
  mark first.
- External path, byte or canonical-manifest divergence enters recovery required
  before another mutation. Authority is refreshed only after explicit validation;
  unrelated changed bytes are never adopted.
- A read-only session reads its package files from the file only while the file still
  holds what it inspected.

### An interrupted write

A lone `-journal` beside a file (no `-wal` or `-shm`) is played back by SQLite only
when all of these hold; otherwise the file is refused untouched, with the reason and
what to do:

1. **Only on the person's own open of that file** (`NendoInterruptedWrite.RollBack`):
   Open file, Open read-only, a file Nendo is asked to open, a recent file the person
   picks. The recent-file collision check, a backup chosen for Restore and every
   other inspection refuse untouched.
2. **Never in a folder that may be synced** (OneDrive, Dropbox, Google Drive), since
   the journal may come from another computer. The refusal says to let sync finish,
   copy the file with its journal to a folder that is not synced, and open it there.
3. **Only a journal that could be this file's**, shown by plain reads that write
   nothing: the file is within the size bound, carries Nendo's application ID at
   header offset 68 and is in rollback-journal mode; the journal has SQLite's magic
   `d9d505f920a163d7` and the file's page size; among its records is a saved Nendo
   page 1 whose change counter is the file's (then page 1 matches byte for byte) or
   one behind; it names at least one Nendo instance and every one is in the file; and
   a read-only SQLite connection reports it hot, so a live writer is answered as such.
4. **The file as it was is always kept.** Under the write-ownership lease, the file
   and journal are copied to temporary names, flushed and renamed to
   `<file>.before-rollback-<time>.nendo-held` and `<that>.journal`, names SQLite does
   not pair, before one read-write connection plays the journal back. Once anything
   was played back, the kept copy is never removed automatically: every inspection
   names it until the person removes it. A copy cut short keeps its temporary name and
   is never offered.

These checks rule out another file's journal but not one from a copy of the same
file (an Explorer copy, a backup, a synced copy), which SQLite cannot tell apart;
rules 1, 2 and 4 cover that case. A journal holding nothing to roll back is cleared on
the person's open while Nendo holds the RESERVED lock. A read-only file or journal, an
unwritable folder, a copy that cannot be made, and a detected writer or lock each
have their own refusal. A `-wal` or `-shm` set is refused unopened, and the refusal
says never to delete the files beside a `.nendo` file or copy it without them. This
is SQLite's own recovery, not a guessed repair.

### Safe-mode surfaces

- The WinUI host owns a bounded native recovery route that works when WebView2
  cannot start or crashes
  ([ADR-0002](0002-containing-desktop-architecture-and-process-model.md)).
- When the Workbench can run safely, restricted Studio offers Health and bounded Data,
  History, export, backup, restore, diagnostics and custom-surface disable and retry
  actions suited to the classification ([Studio contract](../contracts/studio.md)).
- Safe mode is host behaviour that application content and agents cannot hide or
  alter. It never runs custom-view code, whatever the switches say: the Workbench
  mounts no view frame and the host answers 403 on every view origin
  ([ADR-0013](0013-custom-views-with-code-in-the-file.md)). The recovery panel offers
  **Restart without custom views**.
- The System, Light or Dark device theme applies to Workbench safe mode and the
  native recovery route.
- Nendo targets locally created or explicitly trusted files. It does not sandbox
  hostile files: a received file's view code runs when its view is shown, outside
  safe mode and recovery.

Human recovery usability, real full-device behaviour, physical power loss and
hostile-file handling are not claimed.

## Consequences

### Positive

- Broken custom behaviour cannot make valid data unreachable.
- Unknown or changed files never receive destructive repairs.
- Migration and restore failures keep an authoritative recovery path.
- Nendo cannot write a file it will then refuse to open.

### Negative

- Classification and recovery UX are substantial product work.
- Some readable files stay non-writable by design.
- Staged migrations need temporary disk space.

## Rejected alternatives

- Best-effort normal open with automatic repair: destroys trustworthy evidence and
  makes unsupported formats look writable.
- Rejecting every imperfect file outright: withholds data, export and backup where a
  bounded read-only projection is safe.

## Revisit triggers

- A received file's view code causes harm the ADR-0013 kill switches do not cover,
  and packages need a trust model such as signatures.
- Cross-platform hosts need different native recovery behaviour.
- A migration cannot be staged within the local-file budget.
- Hostile third-party files become a supported security boundary.
