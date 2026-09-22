# Architecture decisions

Accepted ADRs are the architecture authority for Nendo. Deferred and scheduled
decisions grant no implementation authority on their own.

[ADR-0000](0000-record-architecture-decisions.md) and [the template](template.md)
define the required format.

The first design backlog reserved ADR numbers 0001–0014 before the files
existed. For this reason the numbering is contiguous by intent.

| ADR | Status | Decision |
| --- | --- | --- |
| [0000](0000-record-architecture-decisions.md) | Accepted | Decision process, status, evidence and numbering |
| [0001](0001-local-one-file-product-boundary.md) | Accepted | Local one-file product boundary, host-owned derivatives, unsupported sync-managed locations |
| [0002](0002-containing-desktop-architecture-and-process-model.md) | Accepted | Thin WinUI host, one local WebView2 workbench, bounded native recovery |
| [0003](0003-relational-user-data-and-protected-metadata.md) | Accepted | Relational user tables, stable semantic mappings, protected metadata |
| [0004](0004-versioned-semantic-ui-contract.md) | Accepted | Strict versioned semantic UI trees, stable node IDs, typed operations |
| [0005](0005-host-application-services-and-write-coordinator.md) | Accepted | Host application services and one coordinator-owned writable authority |
| [0006](0006-split-revisions-audit-and-compensation.md) | Accepted | Split revisions, total audit ordering, idempotency, explicit compensation |
| [0007](0007-proposal-clone-validation-and-replay-promotion.md) | Accepted | Host-owned proposal clone, validation, preconditions, replay promotion |
| [0008](0008-general-scripting-and-capability-isolation.md) | **Accepted** | Bounded calculations, reusable functions, local actions and automatic triggers; delivered (stages S0–S9) |
| [0009](0009-local-mcp-transport-authority-and-change-sets.md) | Accepted | Client-neutral local MCP transport, server-owned authority, modifying leases, explicit change sets |
| [0010](0010-file-identity-duplicate-fork-backup-and-restore.md) | Accepted | Raw copy classification plus typed Duplicate, Fork, Backup and Restore |
| [0011](0011-local-sqlite-journal-and-copy-discipline.md) | Accepted | Local rollback DELETE, FULL synchronous operation, bounded busy behaviour, host-owned copy discipline |
| [0012](0012-safe-mode-compatibility-and-migration.md) | Accepted | Explicit normal/read-only/recovery/rejected states, staged migration, permanent host safe mode |
| [0013](0013-defer-general-extension-model.md) | **Accepted, bounded slice** | OS-contained read-only custom views; broader extensions remain deferred |
| [0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md) | Accepted | Drop the embedded agent; the local MCP interface is the agent surface. AG-UI not adopted |
| [0015](0015-host-owned-database-studio-and-ag-grid-community.md) | Accepted | Host-owned Studio, containing UI architecture, AG Grid Community as the grid substrate |
| [0016](0016-vendor-pinned-dotnet-agent-skills.md) | Accepted | Pinned curated first-party .NET agent skills |
| [0017](0017-production-composition-and-build-layout.md) | Accepted | Minimal Engine/Desktop/Workbench/LocalMcp composition and centralized build layout |
| [0018](0018-public-website-and-deployment-lane.md) | Accepted | Public website at `site/`, outside the product boundary, with one CI lane that deploys only it |

## Amendments in force

- **ADR-0013, 2026-09-20**: the owner accepted OS-contained custom views after the
  AppContainer/Job prototype. The amendment permits a helper process
  (ADR-0002/0017), protected view references (0003), typed view bindings (0004)
  and supported-envelope preservation (0012). Pending security/lifecycle checks
  remain release gates.
- **ADR-0004, 2026-09-20 — a section can be folded away**: every `section` folds.
  An author can store how a section starts, as the `opens` property with the
  closed words `open` and `closed`. A person's own fold is renderer state for the
  file session and is never stored in the file.
- **ADR-0008, 2026-09-20 — an optional result is quietly empty, and a formula can
  refuse by name**: a calculation or function with `resultNullable: true` reports
  an empty result when an empty input stops its formula. A definition declared
  never to be empty reports `calculation-missing-input`. The catalogue adds
  `Refuse(text)`, which reports `calculation-refused` with the author's sentence.

- **ADR-0004, 2026-09-18 — a related list is a way in, not only a view**: a
  related list offers two actions. Add opens a new record of the related type,
  with the reference back already filled in. Open opens a related row as its own
  page, with one step back. This is the first entry under this ADR that adds
  nothing to the vocabulary: no kind, no property, no diagnostic, no diff sentence
  and no rung, because nothing is stored. The node already carries both halves of
  the relation, and the compiler already proves them. So an author had nothing
  left to state. A stored property would have left every screen built before
  that day, including this product's own planner, without the button until a
  reviewed proposal added it, although the button needs nothing from the file.
  The owner accepted it on 2026-09-18, in answer to F-031 and the workaround
  accepted as C-044. The filled-in reference carries the parent's version. A page
  with unsaved edits declines both actions with the same words as the board drag.
  A related type with no screen of its own offers neither action, and the page
  states this.
- **ADR-0002, 2026-09-17 — a screen is told when the file moves**: the
  coordinator raises `Committed` with the change sequence that it reached, for
  every writer that it serves. The host forwards it to the renderer as the second
  member of the closed unsolicited-event set: `fileChanged`, which carries that
  number and nothing else. It carries no record contents and no description of
  what changed. It causes no notification and no tray change, because a person is
  not told about a write. The owner reported three times that a surface stayed on
  the revision it was drawn at while an agent wrote through MCP. This amendment
  followed the third report. That report was about a board, which showed that the
  problem was never limited to the front page or an open inspector. It affected
  every Use surface: the renderer compares the whole view against the change
  sequence that it holds, and only a person's action refreshed it. This entry is
  the full record of the amendment. ADR-0002 has a short section that points
  here.

  **It is a nudge, not a refresh.** The renderer decides what to re-read and,
  more importantly, when a redraw is safe. The event goes through the same bounded
  chase that the tiles use. So there is at most one refresh a second, and never a
  refresh while somebody has hold of the page. This restraint has a real cause.
  The hold exists because a redraw under an open menu made the front page's
  picker unusable for an hour on 2026-09-16. A live-refresh push would cause the
  same problem again on every agent write.

  **What it does not promise.** Not every change reaches every screen instantly.
  A held page waits for the hold to end, and the host does not resend a message
  that a renderer missed. The promise is that a surface catches up without help,
  and does not wait for the person to leave it and return. Unsaved drafts are not
  affected, because a draft keys on the file session and a write does not change
  the file session. The existing `decideDraftState` contract already answers
  `keep-editable` for this case, and it does not change.

  A replay announces nothing, because it commits nothing. A listener that re-read
  on a replay would re-read a file that had not moved. The Engine raises the event
  synchronously while the coordinator is gated, under the same one-way contract
  as `WriteAuthorityLost`: a handler marshals and returns, and never waits on a
  coordinator operation.

  The owner accepted this on 2026-09-17, after the work was built and its limits
  were put to the owner. These are the recorded outcomes, and only measured
  outcomes are recorded:

  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and the unit suites, and 1,074 .NET
    tests (Engine 751 with one measurement harness skipped, Desktop 225, LocalMcp
    98).
  - `Test-AgentAuthoringGate.ps1` passed both phases. Its new step contains the
    whole claim: a board on screen, a `set_field` over MCP, nothing touching the
    app in between, and the board following. Afterwards the step puts the handle
    back, so the rest of the run sees the register that it expects.

  **The gate caught a real defect in the first wiring**, which is the reason for
  the gate. The chase calls back after a pass *and* after a hold ends, and the two
  calls mean opposite things: the read finished, or the read never started. When
  the redraw was passed as that callback, a nudge that arrived while the page was
  held was lost without a sign. The wake redrew and nothing re-armed the read. Now
  the read re-enters whenever the session is still behind the sequence that the
  host named. The falsification disconnected the forward, and the gate failed with
  `Timed out waiting for the board to follow an agent write without the person
  touching anything`. Then the gate ran three times in succession, because a flaky
  proof of this would be worse than none.

  Not instrumented: what a person sees while they read. The gate asserts that the
  board follows. The Workbench lane asserts that the renderer never redraws
  through a held page. Whether a refresh feels as if it moves under somebody in
  the middle of a sentence stays owner-reported.

- **ADR-0012, 2026-09-17 — a write that would make a file unopenable is refused**:
  the owner accepted this on 2026-09-17, after the work was built and its limits
  were put to the owner. The same two numbers that bound the open path now bound
  the write path. Before any operation is staged, the host refuses a mutation when
  the file has reached a write ceiling. Each write ceiling sits a stated reserve
  below its open bound. The refusal states what was measured, that nothing
  changed, and that the file still opens.

  This is the half of W-039 to take first, because it closes the only route in.
  Every file that was ever stranded got there through Nendo's own write path,
  with an agent driving it. A refusal there means that the product cannot produce
  a file that it will not open. The other half is a route back into a file
  already over the line. It protects a population that is currently empty, and it
  is a feature, not a fix. Every `Unreadable` result returns
  `NendoFileCapabilities.None`, so the existing recovery export cannot reach such a
  file. It could not reach it in any case, because preparing an export re-runs the
  same inspection that refused. That is real work, and it is W-045, not this.

  **Both bounds, not one.** A guard on bytes alone would fix the reported case
  and leave an identical trap one step further on. That would guard a symptom.
  The 2026-09-16 amendment already named `MaximumInspectionRows` as the wall that
  binds next. It stated that this wall arrives first for small records, or for a
  file edited as much as it is written. So the host checks the ceiling against
  both bounds, and a person meets whichever bound they reach first.

  **Derived, never typed twice.** The host computes both ceilings from the open
  constants minus their reserve. It builds both sentences from the numbers; nobody
  writes them beside the numbers. F-043 taught this discipline, and C-053 guards
  it: the previous bound reached people only as the words in its own refusal, and
  it drifted from the constant it described.

  **The reserve is headroom, and the headroom is measured.** The cost of a commit
  is not known before the commit, so the ceiling must sit far enough below the
  bound that no single write can cross the gap. The bytes reserve is **4 MiB**.
  The measured worst case is **446,464 bytes**. That is the largest change this
  product accepts: a change set at the published 128-operation ceiling, with
  records of the size that the 2026-09-16 amendment measured, 1,306 bytes of text
  each. That is 9.4 times inside the reserve. A test asserts the relationship, not
  the number, so a commit that becomes more costly fails here and not in
  somebody's file. The rows reserve is **1,000**, against at most 129 rows for the
  same commit: 128 operations and the revision that carries them.

  **What this does not do.** A file already over either bound still has no route
  to its data, and this amendment does not give it one. It also does not warn on
  approach. There is no band in which a person is told that they are getting
  close, because a warning that an agent ignores is not a fix when the agent is
  the writer. The refusal is the whole mechanism.

  These are the recorded outcomes, and only measured outcomes are recorded.
  `Test-Production.ps1` passed. It covered the repository gate, the production
  boundaries, the Workbench check, build and the unit suites: 1,116 .NET tests
  (Engine 792 with one measurement harness skipped, Desktop 225, LocalMcp 99) and
  228 Workbench cases. Each half of the guard was falsified separately, and the
  second falsification is the important one. With the mutation path guarded and
  the change-set path left open, the suite failed with *"A promotion meets the
  same ceiling, or the bound is one an agent walks around by sending a change set
  instead"*. A guard on one entry point alone looks complete, but it is not.
  C-084 carries both falsifications, and C-085 carries the reserve measurement.

  **A second defect, found because the guard was put on both paths** (F-068).
  Promotion does not throw. It catches everything that derives from
  `NendoException` and reports a fixed sentence. So a proposal refused for the
  file's size said "The active file rejected the proposal" and nothing about
  size. This same bound, with authority behind it, lost its words on the way to
  the person. Now the host carries the reason through. The guard for this defect
  had to assert that the reason survives, not only that the promotion failed. A
  test that checks only the failure passes against the version that discards the
  message.

- **ADR-0012, 2026-09-16 — how large a file may be before Nendo will not open it**:
  the open-time size bound is raised from 64 MiB to 256 MiB. Two files that Nendo
  itself wrote, through the agent surface alone, could not be reopened (F-040).
  The write path and the open path disagreed about how large a file may be, and
  the person found out only when the file would not open. This amendment followed.
  The old number had no authority anywhere: no ADR, no contract, no test. It
  reached people only as the words in its own refusal (F-043). It has authority
  now, and the host derives the sentence that a person sees from the constant.
  Nobody types it beside the constant.

  The measurement came before the choice of the number. It used records of a
  known size through the ordinary write path. A record that carries 1,306 bytes
  of text costs **3,554 bytes on disk, a multiple of 2.72**. So the reasoned
  "roughly three times" in F-040 was close, and it is now a measurement. 64 MiB
  was reached at about **18,900** such records. 256 MiB is reached at about
  **75,500**. This bound applies only to one cold open. One cold open costs
  437 ms at 16 MiB, 728 ms at 32 MiB, 1,465 ms at 64 MiB, 3,226 ms at 128 MiB and
  **6,577 ms at 250 MiB**. This is linear at roughly 26 ms per MiB. So the raise
  costs about 5 seconds of additional wait at the new ceiling. F-025 already
  records that one open inspects twice, and a person pays for that at the same
  rate.

  **What this does not do.** Nothing is enforced at write. A person's own agent
  can still take the file past the bound, and the person finds out at the next
  open. This amendment does not meet the acceptance criterion in W-038 that says
  the person must be told first. It also does not meet the criterion that asks for
  a route back into a file already over the line. Both remain open work.

  **The wall that binds next**, named here so that it does not surprise anyone a
  second time: `MaximumInspectionRows` stays at 100,000. It is not raised with the
  bytes, and this is intentional. It counts `__nendo_operation`, which carries one
  row per record write and one per later edit. The measurement was 10,003 rows for
  10,000 records. So the host refuses a file at about 100,000 writes, whatever
  they weigh, and edits count. For records of the size measured here, the byte
  bound still binds first (75,500 before 100,000). But for smaller records, or for
  a file that is edited as much as it is written, the row bound arrives first and
  states something different. A change to it is its own decision with its own
  measured cost.

- **ADR-0002, 2026-09-15 — the host outlives its window**: the close button hides
  the window into the notification area. The process stays resident with its
  file open and its MCP host listening. The tray menu carries the exit, the live
  agent access mode and a control to end that access. While the window is out of
  sight, Windows notifications announce a waiting proposal, outstanding consent,
  a file that stopped being writable and a failed workspace. They route and never
  grant: the production gate keeps them out of the MCP adapter, and a test
  asserts that no payload carries an approve, accept, promote or grant argument.
  Bridge protocol 7 adds the first unsolicited host message, and 2–6 stay
  supported. The
  amendment records the cost: closing the window no longer turns off the ADR-0009
  posture.
- **ADR-0002, 2026-09-16 — a screen may not chase its reads without a bound**: a
  surface chases the reads it is missing at most once a second, one pass at a
  time. It keeps an answer even if the file moved while the answer was read,
  because the answer is about the revision it names. Nothing redraws while
  somebody has hold of the page. An unbounded chase redrew as fast as the host
  could answer, and it was the cause of the app view stopping.
- **ADR-0002, 2026-09-15 — a view failure is written down**: when the app view
  stops responding, the host keeps a device-local line. The line holds the
  `ProcessFailedKind`, how long the view was up, whether the window was out of
  sight, and what Windows reported about free memory at that moment. The record
  is capped at 50 entries. It carries no file path, identity or record contents,
  and one click in the tray switches it off. It records by default. A person
  cannot predict the failure, so a record that the person must enable before the
  failure would capture nothing. This amendment followed the same failure twice in
  a day, which left only a screenshot.
- **ADR-0004, 2026-09-15 — what the file is for**: a file carries one prose
  purpose of its own. `application.setPurpose` sets it,
  `nendo://application/describe` shows it first, and About this file in the File
  menu shows it. It is stored in its own protected table as the layout ladder's
  new last rung, with minimum host 1.24.0. If nobody has stated a purpose, it is
  absent; the host does not invent one. The front page's `description` stays the
  front page's.
- **ADR-0004, 2026-09-14 — colour, charts and the overview page**: a choice option
  may carry a `tone` from a closed set of named hues. A chart is an exact
  aggregate over one closed grouping. An `overviewSurface` is one file-level root
  of sections, tiles, charts and short recent lists. The ADR records each slice
  of the surfaces and charts plan under this heading as it lands.
- **ADR-0004, 2026-09-12 — vocabulary widening**: delivered. It adds list/board
  tiles with explicit scope, eight roots per eligible kind/entity, named section
  tabs and Date-only calendars. It includes effective-filter bounds, per-surface
  selection and a shape-derived capability ladder from 1.12 to 1.16. The
  production gate, the Workbench suite and the MCP authoring, drag and neutrality
  runtime lanes passed. `Review-OutcomeRuntime.ps1` fails, and a measurement
  showed that it failed the same way before this work.
- **ADR-0004, 2026-09-12**: contract versions 1 and 2 are removed. Version 3 is
  the only shape that a host compiles: one compile path, one plan shape, one
  digest projection, no `cardFieldIds`, and no `form`/`list`/`board`/`command`
  slots on the plan or the MCP surfaces resource. An older stored root fails
  closed with `NUI003`. Studio, data and recovery are not affected. The reason:
  nobody has distributed the file format, and the slot-shaped plan rendered a
  version 3 board as a list without any sign.
- **ADR-0004, 2026-09-09**: semantic UI contract version 3. It adds a composable
  node tree, a per-kind child allow-list, and the `detailSurface`, `section`,
  `relatedList`, `commandStep`, `summaryTile` and `filterClause` kinds. (The
  2026-09-12 amendment supersedes its version 1 and 2 compatibility clause.)
- **ADR-0003, 2026-09-09 — covering index on configured reference columns**: an
  accepted note. The operation that configures a reference also creates one
  covering index on its column, so a `relatedList` read of the inverse relation
  does not walk the table. The host never adds the index on open or as a repair.
- **ADR-0004, 2026-09-10**: exact `sum`, `min` and `max` on `summaryTile` over an
  Integer or Decimal field. The host refuses `avg`, the refusal names it, and the
  host publishes the reason. This corrected a recorded premise: a Decimal column
  stores exact TEXT, not a float, and the host folds the lexemes instead of asking
  SQLite to fold them.
- **ADR-0009, 2026-09-13**: rewritten to the current transport. It uses a static
  loopback address with no credential, serves both MCP protocol eras, and by
  default uses a fixed port and no lease expiry. Its history section lists the
  transport, credential and protocol-pin clauses that it replaces.
- **ADR-0009, 2026-09-22**: a fifth access level, Unattended. At this level MCP
  gains `nendo.change_set.accept` for a proposal that the same session validated,
  and the host grants the open file's automatic-action consent. Below this level
  nothing changes. The amendment states what the level gives up: a shape change
  and an action can reach the active file before anybody reads either. It also
  adds bulk data in and out: a paged faithful-CSV export resource and one import
  tool at Edit data.
- **ADR-0013, 2026-09-10**: general scripting and the general extension model
  are scheduled for P7. They are not deferred indefinitely. Scheduling grants no
  implementation authority; each still needs its own accepted ADR.

## Rules

- Do not create a second file for a reserved number.
- Do not mark an ADR Accepted while evidence required to choose between
  alternatives is still planned and not recorded.
- Preserve superseded and rejected decisions. Do not rewrite history to make the
  current choice look inevitable.
- When an ADR changes an architecture-significant statement, update
  [`../architecture.md`](../architecture.md) and any affected
  [contract](../contracts/) in the same change.

## A note on evidence

Earlier ADRs cite named experiments (`EX-0001` … `EX-0010`, `DS1`, `DS2`) and
dated milestone reviews. Those documents were disposable by design, and they are
now removed. The ADRs record their conclusions. The test suites under `tests/`
and [`../architecture.md`](../architecture.md) assert the delivered behaviour.
The citations stay as provenance for *why* a decision was made. They are not live
links.
