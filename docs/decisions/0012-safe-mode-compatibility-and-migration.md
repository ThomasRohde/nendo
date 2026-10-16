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
  need 1.34.0, an `extensionView` 1.42.0 (W-106), a skill package 1.43.0 ([ADR-0024](0024-a-file-carries-its-own-agent-skill.md), W-160), and `extensionTile` will need the rung after it, since
  1.39.0 went to folded history ([ADR-0021](0021-folding-old-history.md)), 1.40.0 to a
  filter or sort on a calculated field (ADR-0008, 2026-09-30 amendment) and 1.41.0 to what a
  new file keeps ([ADR-0022](0022-new-file-keeping-the-records-an-application-ships-with.md)). A declared
  hierarchy needs 1.35.0, and an outline of one 1.36.0
  ([ADR-0019](0019-hierarchies-in-the-schema.md)). A unique field needs 1.37.0
  ([ADR-0020](0020-unique-and-generated-fields.md)), a file's own look 1.38.0
  ([ADR-0004](0004-versioned-semantic-ui-contract.md), 2026-09-28), and a link rule 1.45.0
  ([ADR-0026](0026-allowed-links.md)). An older host
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

Implementation correction, 2026-10-03 (R02-025): the early ceilings remain unchanged,
but their reserves do not bound every accepted transaction. A supported 200-record,
64-field batch expands to 12,800 operations before automatic actions. Both direct writes
and proposal promotion now measure the pending transaction's pages, schema objects,
each table and total live records against the existing open limits before committing.
Overflow rolls the whole transaction back. The regression guard exercises the largest
record batch and a smaller batch whose generated effects alone cross the remaining gap;
the older 128-operation sample is no longer described as a maximum.

## 2026-10-13 amendment — an interrupted write is rolled back when the person opens the file

The owner accepted this amendment on 2026-10-13 (ESC-01, W-212). A writer stopped in
the middle of a write, by a crash, a kill or a forced restart, leaves the file's
rollback journal beside it. Until now every later inspection refused the file as an
unfinished storage operation and told the person to close a writer that no longer
existed, so the data stayed unreachable, and the obvious workarounds, deleting the
`-journal` or copying the file without it, turn an exactly recoverable file into a torn
one.

A lone `-journal` (no `-wal` or `-shm`) beside a file is played back only under all of
these rules, and otherwise the file is refused untouched, saying why and what to do:

1. **Only on the person's own open of that file.** The host says so explicitly
   (`NendoInterruptedWrite.RollBack`): the Desktop does for Open file, Open read-only, a
   file it is asked to open and a recent file the person picks. Every other observation
   refuses untouched: the recent-file collision check, which observes copies the person
   never opened, a backup chosen for Restore, and any inspection that is not an open.
2. **Never in a folder that may be synced.** The Desktop's location check (OneDrive,
   Dropbox, Google Drive) makes the open refuse, because the journal may have come from
   another computer; the refusal says to let sync finish, copy the file with its journal to
   a folder that is not synced, and open it there.
3. **Only a journal that could be this file's**, shown by plain file reads with nothing
   written: the file is within the size bound, carries Nendo's application ID at header
   offset 68 and is in rollback-journal mode; the journal has SQLite's header (magic
   `d9d505f920a163d7`) and the file's page size; among its counted records is a saved Nendo
   page 1 whose change counter is the file's (then the file's page 1 must match it byte for
   byte) or one behind; it names at least one Nendo instance and every one is in the file;
   and a read-only SQLite connection reports it hot, so a program still writing is answered
   as such and nothing is copied. Page 1 need not be the first record: measured, a spilled
   write saved it fifth.
4. **The file as it was is always kept.** Under the file's write-ownership lease, the file
   and its journal are copied, each to a temporary name, flushed, then renamed to
   `<file>.before-rollback-<time>.nendo-held` and `<that>.journal`, names SQLite does not
   pair, before SQLite plays the journal back on one read-write connection. Once anything
   was played back the copy is never removed automatically: every inspection names it until
   the person removes it, saying that Nendo rolled back an unfinished save and kept the file
   as it was in case the journal came from another copy, and how to open the kept file alone.
   A copy cut short keeps its temporary name and is never offered.

These checks rule out another file's journal, but not one from a copy of the same file: an
Explorer copy, a backup, or the file synced to another machine has the same instance, and
SQLite's format cannot tell a copy one commit ahead, or a copy at the same counter with an
identical page 1, from the file the journal was written for. Rules 1, 2 and 4 exist for that
case: the playback runs only when the person opened this file outside a synced folder, and the
kept copy holds the other copy exactly as it was.

A journal that holds nothing to roll back (empty, or a header SQLite never wrote) is cleared on
the person's open while Nendo holds the file's RESERVED lock, which no writer can share; the file
was never changed by it. A read-only file or journal, a folder Nendo cannot write, a copy that
cannot be made and a writer or lock SQLite detected each have their own refusal; a journal another
host rolled back meanwhile leaves the file to be inspected as it is.

This is SQLite's own recovery, which puts back exactly the pages the unfinished write
had changed. It is not a guessed repair, and the rejection of best-effort repair below
stands. A `-wal` or `-shm` set is still refused unopened. The refusal now says never to
delete the files beside a `.nendo` file or to copy it without them. Physical power loss
and torn sectors remain unqualified (ADR-0011).

## 2026-10-14 amendment — a file Nendo 1.0 opens, every later 1.x opens

The owner chose this on 2026-10-14 as the promise that makes Nendo 1.0.0 (I-010, W-235).
Two numbers must not be confused. The product version (`Directory.Build.props`) is what
the person installs and what becomes 1.0.0. The minimum host version a file states is the
format's own capability ladder in `NendoFormat`, which stood at 1.51.0 when the product
reached 1.0.0. The promise is made in product versions:

1. **A file that Nendo 1.0.0 opens normally, every later 1.x opens normally.** That
   includes the files 0.x hosts wrote. Where the file and its folder allow writes, it opens
   *Normal writable*, never in safe mode or recovery. Every record type, field, record value,
   screen node and package the file carried reads back unchanged.
2. **A later 1.x may add rungs to the ladder, never take one away.** It keeps core format
   version 1 and every rung up to 1.51.0. If a file ever needs a migration, the host runs it
   automatically through the staged, backed-up path described above, and the person never
   has to convert a file by hand.
3. **Not promised.** An older 1.x still refuses a file that uses a newer 1.x's rung (the
   `minimum_host_version` rule stands). How a screen looks or behaves may improve. A file is
   still never downgraded in place.

Breaking any part of this needs Nendo 2.0 and its own ADR.

**How it is held.** `tests/Nendo.Engine.Tests/Fixtures/Format1/` keeps files as Nendo 1.0
reads them: frozen copies of two tracked demo files, `Nendo Station.nendo` (host 1.33.0:
custom-view packages and almost every kind of screen) and `Swarm.nendo` (host 1.42.0:
hierarchy, look, folded history and new-file rules). Beside them is one file a builder
generated at the top rung, 1.51.0, which carries the full-text index and a changed
reference label. Each file has a JSON record of what it holds. `FormatPromiseTests` opens a
copy of each one, requires *Normal writable* with no findings, and compares what it reads
back with that record. It also writes to each copy, so the file is proven writable as well
as readable. Within 1.x a fixture may be added for a new rung but never rebuilt or replaced.
Its builder, `FormatPromiseTests.BuildFixtures`, runs only when
`NENDO_WRITE_FORMAT_FIXTURES=1` is set.

## 2026-10-16 amendment — embedded media content is outside the open bound

Decided by [ADR-0031](0031-media-in-user-data.md), accepted 2026-10-16, and built with its Engine
slice (W-264, host 1.52.0). The 256 MiB open bound and the 224 MiB write ceiling
count every page of a file except those of `__nendo_media_content`. That table is bounded on
its own: at most 64 MiB per item and 2 GiB per file. Opening checks the media tables' shape and
totals and does not read their content, so a file's media does not lengthen its open. The
measurement that holds this, a cold open within 10% of the same file without its media, is
W-264's first task; if it fails, the media budget comes down rather than this amendment
changing. A file that holds media needs the host that adds the `-media-` rung, and an older
host refuses it.

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
- 2026-10-16 — embedded media content is left out of the open bound and write ceiling and
  bounded on its own (the amendment above, [ADR-0031](0031-media-in-user-data.md)); built with
  W-264.
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
- 2026-10-13 — a write a crash left unfinished is rolled back by SQLite when the person
  opens the file outside a synced folder, keeping the file as it was (the amendment above).
- 2026-10-13 — owner: a file marked read-only in File Explorer is not replaced by Restore
  or Upgrade; Nendo refuses with `replacement-target-read-only` and asks the person to
  clear the mark first, keeping the table's normal read-only row to inspection, history,
  export and backup (R2SMA-10, W-221). A read-only session reads its package files from
  the file while the file still holds what it inspected (ECO-07).
- 2026-10-14 — owner: a file that Nendo 1.0.0 opens normally, every later 1.x opens
  normally, held by the Format1 fixtures (the amendment above, I-010, W-235).
