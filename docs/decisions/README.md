# Architecture decisions

Accepted ADRs are the architecture authority for Nendo. Deferred and scheduled
decisions grant no implementation authority on their own.

The required format is defined by [ADR-0000](0000-record-architecture-decisions.md)
and [the template](template.md).

ADR numbers 0001–0014 were reserved by the first design backlog before the files
existed, so the numbering is contiguous by intent rather than by accident.

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
| [0008](0008-general-scripting-and-capability-isolation.md) | **Accepted** | Bounded calculations, reusable functions, local actions and automatic triggers; production delivery pending |
| [0009](0009-local-mcp-transport-authority-and-change-sets.md) | Accepted | Client-neutral local MCP transport, server-owned authority, modifying leases, explicit change sets |
| [0010](0010-file-identity-duplicate-fork-backup-and-restore.md) | Accepted | Raw copy classification plus typed Duplicate, Fork, Backup and Restore |
| [0011](0011-local-sqlite-journal-and-copy-discipline.md) | Accepted | Local rollback DELETE, FULL synchronous operation, bounded busy behaviour, host-owned copy discipline |
| [0012](0012-safe-mode-compatibility-and-migration.md) | Accepted | Explicit normal/read-only/recovery/rejected states, staged migration, permanent host safe mode |
| [0013](0013-defer-general-extension-model.md) | **Accepted, bounded slice** | OS-contained read-only custom views; broader extensions remain deferred |
| [0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md) | Accepted | Drop the embedded agent; the local MCP interface is the agent surface. AG-UI not adopted |
| [0015](0015-host-owned-database-studio-and-ag-grid-community.md) | Accepted | Host-owned Studio, containing UI architecture, AG Grid Community as the grid substrate |
| [0016](0016-vendor-pinned-dotnet-agent-skills.md) | Accepted | Pinned curated first-party .NET agent skills |
| [0017](0017-production-composition-and-build-layout.md) | Accepted | Minimal Engine/Desktop/Workbench/LocalMcp composition and centralized build layout |

## Amendments in force

- **ADR-0013, 2026-09-20** — owner accepted OS-contained custom views after the
  AppContainer/Job prototype. Permits a helper process (ADR-0002/0017), protected
  view references (0003), typed view bindings (0004) and supported-envelope
  preservation (0012). Pending security/lifecycle checks remain release gates.

- **ADR-0004, 2026-09-18 — a related list is a way in, not only a view** — a related list
  offers Add, which opens a new record of the related type with the reference back already
  filled in, and open, which opens a related row as its own page with one step back. The
  first entry under this ADR that adds nothing to the vocabulary: no kind, no property, no
  diagnostic, no diff sentence and no rung, because nothing is stored. The node already
  carries both halves of the relation and the compiler already proves them, so there was
  nothing left for an author to say — and a stored property would have left every screen
  built before today, including this product's own planner, waiting for a reviewed proposal
  to get a button that needs nothing from the file. Accepted by the owner on 2026-09-18,
  answering F-031 and the workaround accepted as C-044. The filled-in reference carries the
  parent's version, a page with unsaved edits declines both actions in the board drag's own
  words, and a related type with no screen of its own offers neither and says so.
- **ADR-0002, 2026-09-17 — a screen is told when the file moves** — the coordinator raises
  `Committed` with the change sequence it reached, for every writer it serves, and the host
  forwards it to the renderer as the second member of the closed unsolicited-event set:
  `fileChanged`, carrying that number and nothing else. No record contents, no description
  of what changed, no notification and no tray change — a write is not something a person
  is told about. Taken after the owner reported, for the third time, that a surface stayed
  on the revision it was drawn at while an agent wrote through MCP; the third report was a
  board, which settled that this was never a front-page or an open-inspector problem but
  every Use surface, because the whole view is compared against the change sequence the
  renderer holds and only a person's action refreshed it.

  **It is a nudge, not a refresh.** The renderer decides what to re-read and, more to the
  point, when redrawing is safe: the event goes through the same bounded chase the tiles
  use, so at most one refresh a second and never one while somebody has hold of the page.
  That restraint is not theoretical. The hold exists because a redraw landing under an open
  menu made the front page's picker unusable for an hour on 2026-09-16, and a live-refresh
  push is exactly the thing that would do it again on every agent write.

  **What it does not promise.** Not every change reaches every screen instantly: a held
  page waits for the hold to end, and a renderer that missed a message is not resent one.
  What is promised is that a surface catches up on its own rather than waiting to be left
  and returned to. Unsaved drafts are unaffected, because a draft keys on the file session
  and a write does not change it — the existing `decideDraftState` contract already answers
  `keep-editable` for this case and is unchanged.

  A replay announces nothing, because it commits nothing; a listener that re-read on a
  replay would re-read a file that had not moved. The Engine event is raised synchronously
  while the coordinator is gated, under the same one-way contract as `WriteAuthorityLost`:
  a handler marshals and returns, and never waits on a coordinator operation.

  Accepted by the owner on 2026-09-17, after the work was built and its limits put to them
  explicitly. Recorded outcomes, and only the outcomes that were measured:
  `Test-Production.ps1` passed, covering the repository gate, the production boundaries,
  the Workbench check, build and the unit suites, and 1,074 .NET tests (Engine 751 with one
  measurement harness skipped, Desktop 225, LocalMcp 98). `Test-AgentAuthoringGate.ps1`
  passed both phases, and its new step is the whole claim in one place: a board on screen,
  a `set_field` over MCP, nothing touching the app in between, and the board following. It
  puts the handle back afterwards so the rest of the run sees the register it expects.

  **The gate caught a real defect in the first wiring**, which is the argument for it
  existing at all. The chase calls back after a pass *and* after a hold ends, and those
  mean opposite things — the reading finished, versus the reading never started. Passing
  the redraw as that callback silently lost any nudge arriving while the page was held: the
  wake redrew and nothing re-armed the read. It re-enters now whenever the session is still
  behind the sequence the host named. Falsified by disconnecting the forward, which fails
  with `Timed out waiting for the board to follow an agent write without the person
  touching anything`; the gate was then run three times in succession, because a flaky
  proof of this would be worse than none.

  Not instrumented: what a person sees while they read. The gate asserts the board follows
  and the Workbench lane asserts a held page is never redrawn through, but whether a
  refresh feels like it moves under somebody mid-sentence stays owner-reported.

- **ADR-0012, 2026-09-17 — a write that would make a file unopenable is refused** —
  accepted by the owner on 2026-09-17, after the work was built and its limits put to them
  explicitly. The write path is bounded by the same two numbers the open
  path uses. Before any operation is staged, a mutation is refused when the file has
  reached a write ceiling sitting a stated reserve below each open bound, and the refusal
  says what was measured, that nothing was changed, and that the file still opens.

  This is the half of W-039 worth taking first, and the reason is that it closes the only
  route in. Every file that has ever been stranded got there through Nendo's own write
  path with an agent driving it; refusing there means the product cannot produce a file it
  will not open. The other half — a route back into a file already over the line — protects
  a population that is currently empty, and it is a feature rather than a fix: every
  `Unreadable` result returns `NendoFileCapabilities.None`, so the existing recovery export
  cannot reach such a file, and it could not anyway, because preparing an export re-runs
  the same inspection that refused. That is real work and it is W-045, not this.

  **Both bounds, not one.** Guarding bytes alone would fix the reported case and leave an
  identical trap one step over, which is the shape of guarding a symptom. The 2026-09-16
  amendment already named `MaximumInspectionRows` as the wall that binds next and said it
  arrives first for small records or for a file edited as much as it is written. So the
  ceiling is checked against both, and a person meets whichever they reach.

  **Derived, never typed twice.** Both ceilings are computed from the open constants minus
  their reserve, and both sentences are built from the numbers rather than written beside
  them. That is the discipline F-043 cost us and C-053 guards: the previous bound reached
  people only as the words in its own refusal, and drifted from the constant it described.

  **The reserve is headroom, and the headroom is measured.** It exists because the cost of
  a commit is not known before it is made, so the ceiling must sit far enough below the
  bound that no single write can cross the gap. The bytes reserve is **4 MiB**, against a
  measured worst case of **446,464 bytes** — the largest change this product accepts, a
  change set at the published 128-operation ceiling carrying records of the size the
  2026-09-16 amendment measured, 1,306 bytes of text each. That is 9.4 times inside the
  reserve, and a test asserts the relationship rather than the number, so a commit that
  grows costlier fails here rather than in somebody's file. The rows reserve is **1,000**
  against at most 129 rows for the same commit: 128 operations and the revision that
  carries them.

  **What this does not do.** A file already over either bound still has no route to its
  data, and this amendment does not give it one. It also does not warn on approach: there
  is no band in which a person is told they are getting close, because a warning an agent
  ignores is not a fix when the agent is the writer. The refusal is the whole mechanism.

  Recorded outcomes, and only the ones that were measured: `Test-Production.ps1` passed,
  covering the repository gate, the production boundaries, the Workbench check, build and
  the unit suites — 1,116 .NET tests (Engine 792 with one measurement harness skipped,
  Desktop 225, LocalMcp 99) and 228 Workbench cases. Both halves of the guard were
  falsified separately and the second is the one worth keeping: with the mutation path
  guarded and the change-set path left open, the suite failed with *"A promotion meets the
  same ceiling, or the bound is one an agent walks around by sending a change set
  instead"* — a guard on one entry point alone looks complete and is not. C-084 carries
  both falsifications, C-085 the reserve measurement.

  **A second defect, found because the guard was put on both paths** (F-068). Promotion
  does not throw; it catches everything deriving from `NendoException` and reports a fixed
  sentence. So a proposal refused for the file's size said "The active file rejected the
  proposal" and nothing about size — this same bound, with authority behind it, losing its
  words on the way to the person. The reason is carried through now. The guard for it had
  to assert that the reason survives rather than that the promotion failed, because a test
  checking only the failure passes against the version that discards the message.

- **ADR-0012, 2026-09-16 — how large a file may be before Nendo will not open it** —
  the open-time size bound is raised from 64 MiB to 256 MiB. Taken after two files that
  Nendo itself had written, through the agent surface alone, could not be reopened
  (F-040): the write path and the open path disagreed about how large a file may be, and
  the person found out only when the file would not open. The old number had no authority
  anywhere — no ADR, no contract, no test — and reached people only as the words in its own
  refusal (F-043). It has one now, and the sentence a person is shown is derived from the
  constant rather than typed beside it.

  Measured before the number was chosen, not after, on records of a known size through the
  ordinary write path: a record carrying 1,306 bytes of text costs **3,554 bytes on disk, a
  multiple of 2.72** — so F-040's reasoned "roughly three times" was close, and it is now a
  measurement. 64 MiB was reached at about **18,900** such records; 256 MiB is reached at
  about **75,500**. One cold open, which is the whole of what this bound is bounding, costs
  437 ms at 16 MiB, 728 ms at 32 MiB, 1,465 ms at 64 MiB, 3,226 ms at 128 MiB and
  **6,577 ms at 250 MiB** — linear at roughly 26 ms per MiB. So the cost of the raise is
  about 5 seconds of additional wait at the new ceiling, and F-025 already records that one
  open inspects twice, which a person pays at the same rate.

  **What this does not do.** Nothing is enforced at write. A person can still be taken past
  the bound by their own agent and find out at the next open; the acceptance criterion in
  W-038 that says they must be told first is not met by this amendment, and neither is the
  one that asks for a route back into a file already over the line. Both remain open work.

  **The wall that binds next**, named here so that it is not a surprise twice:
  `MaximumInspectionRows` stays at 100,000 and is deliberately not raised alongside the
  bytes. It counts `__nendo_operation`, which carries one row per record write and one per
  later edit — measured at 10,003 rows for 10,000 records — so a file is refused at about
  100,000 writes whatever they weigh, and edits count. For records at the size measured
  here the byte bound still binds first (75,500 before 100,000), but for anything smaller,
  or for a file that is edited as much as it is written, the row bound arrives first and
  says something different. Moving it is its own decision with its own measured cost.

- **ADR-0002, 2026-09-15 — the host outlives its window** — the close button hides
  the window into the notification area and the process stays resident with its
  file open and its MCP host listening; the tray menu carries the exit, the live
  agent access mode and a way to end it. Windows notifications announce a waiting
  proposal, outstanding consent, a file that stopped being writable and a failed
  workspace, while the window is out of sight. They route and never grant: the
  production gate keeps them out of the MCP adapter and a test asserts no payload
  carries an approve or promote argument. Bridge protocol 7 adds the first
  unsolicited host message; 2–6 stay supported. The cost is recorded in the
  amendment — closing the window is no longer the off switch for the ADR-0009
  posture.
- **ADR-0002, 2026-09-16 — a screen may not chase its reads without a bound** — a surface
  chases the reads it is missing at most once a second, one pass at a time; an answer is
  kept even though the file moved while it was being read, because it answers about the
  revision it names; and nothing redraws while somebody has hold of the page. An unbounded
  chase redrew as fast as the host could answer and was what stopped the app view.
- **ADR-0002, 2026-09-15 — a view failure is written down** — when the app view stops
  responding the host keeps a device-local line: the `ProcessFailedKind`, how long the
  view had been up, whether the window was out of sight and what Windows said about free
  memory at that moment. Capped at 50 entries, carrying no file path, identity or record
  contents, and switched off from the tray in one click. It records by default, because
  asking somebody to have enabled it before a failure they could not predict is asking
  for nothing. Taken after the same failure twice in a day left only a screenshot.
- **ADR-0004, 2026-09-15 — what the file is for** — a file carries one prose purpose of
  its own, set by `application.setPurpose`, led with by `nendo://application/describe` and
  read from About this file in the File menu; stored in its own protected table as the layout ladder's new
  last rung, minimum host 1.24.0, and absent rather than invented when nobody has said. The
  front page's `description` stays the front page's.
- **ADR-0004, 2026-09-12 — vocabulary widening** — delivered: list/board tiles
  with explicit scope, eight roots per eligible kind/entity, named section tabs
  and Date-only calendars, with effective-filter bounds, per-surface selection and
  a shape-derived capability ladder from 1.12 to 1.16. The production gate, the
  Workbench suite and the MCP authoring, drag and neutrality runtime lanes passed;
  `Review-OutcomeRuntime.ps1` fails and was measured to fail the same way before
  this work.
- **ADR-0004, 2026-09-12** — contract versions 1 and 2 removed. Version 3 is the
  only shape a host compiles: one compile path, one plan shape, one digest
  projection, no `cardFieldIds`, and no `form`/`list`/`board`/`command` slots on
  the plan or the MCP surfaces resource. An older stored root fails closed with
  `NUI003` while Studio, data and recovery are unaffected. Taken because the file
  format has never been distributed, and the slot-shaped plan was silently
  rendering a version 3 board as a list.
- **ADR-0004, 2026-09-09** — semantic UI contract version 3: a composable node
  tree, a per-kind child allow-list, and the added `detailSurface`, `section`,
  `relatedList`, `commandStep`, `summaryTile` and `filterClause` kinds. (Its
  version 1 and 2 compatibility clause is superseded by the 2026-09-12
  amendment.)
- **ADR-0004, 2026-09-10** — exact `sum`, `min` and `max` on `summaryTile` over
  an Integer or Decimal field. `avg` is refused by name and published with its
  reason. This corrected a recorded premise: a Decimal column stores exact TEXT,
  not a float, and the host folds the lexemes rather than asking SQLite to.
- **ADR-0009, 2026-09-13** — rewritten to the current transport: a static
  loopback address with no credential, both MCP protocol eras served, a fixed
  port and no lease expiry by default. Its history section lists the transport,
  credential and protocol-pin clauses it replaces.
- **ADR-0009, 2026-09-22** — a fifth access level, Unattended, at which MCP gains
  `nendo.change_set.accept` for a proposal the same session validated and the host
  grants the open file's automatic-action consent. Below it nothing changes. The
  amendment states what the level gives up: a shape change and an action can reach
  the active file with nobody having read either. Also bulk data in and out —
  a paged faithful-CSV export resource and one import tool at Edit data.
- **ADR-0013, 2026-09-10** — general scripting and the general extension model
  are scheduled for P7 rather than deferred indefinitely. Scheduling grants no
  implementation authority; each still needs its own accepted ADR.

## Rules

- Do not create a second file for a reserved number.
- Do not mark an ADR Accepted while evidence required to choose between
  alternatives is still planned rather than recorded.
- Preserve superseded and rejected decisions. Do not rewrite history to make the
  current choice look inevitable.
- When an ADR changes an architecture-significant statement, update
  [`../architecture.md`](../architecture.md) and any affected
  [contract](../contracts/) in the same change.

## A note on evidence

Earlier ADRs cite named experiments (`EX-0001` … `EX-0010`, `DS1`, `DS2`) and
dated milestone reviews. Those documents were disposable by design and have been
removed; their conclusions are what the ADRs record, and the delivered behaviour
is asserted by the test suites under `tests/` and by
[`../architecture.md`](../architecture.md). The citations are kept as provenance
for *why* a decision was made, not as live links.
