# Architecture

The current state of the system as built. Behavioural detail lives in
[contracts](contracts/); the reasoning behind each boundary lives in the
[decision records](decisions/README.md). Where this document and the code
disagree, the code is right — say so and fix this file.

## Composition

[ADR-0013's accepted 2026-09-20 amendment](decisions/0013-defer-general-extension-model.md)
authorizes an isolated custom-view helper in a zero-capability AppContainer/Job
Object, outside the permanent Studio process. This is implementation authority,
not a statement that the visible feature is integrated or release-qualified.
The production helper now runs in Desktop tests; prototype evidence and remaining gates
are recorded in [the OS experiment](../prototypes/custom-views/OS-BOUNDARY.md).

The Engine now contains the [custom-view foundation](contracts/custom-views.md):
immutable package validation, a closed consent-bound session protocol, bounded
stream framing and a coherent graph projection through typed application services.
Durable `extensionGraphSurface` definitions now use canonical UI operations, exact
proposal replay and compatibility rung 1.29.0. An Engine-owned transaction resolves
the view and its graph together. These components are tested in the existing Engine
lane, and the authoring example runs through MCP. `DesktopExtensionProcess` now
launches `Nendo.ExtensionHost` suspended, establishes and checks OS containment,
then authenticates a private inherited-pipe transport. The helper references no
application assembly; its WebView2 tree has no Engine or MCP authority. Tests
measure round-trip selection, loop termination, silent revocation and timeout.
The device cache now performs validated atomic archive activation and exact export;
physical-file-scoped consent and one-use native reviews remain outside portable data.
Native File → Custom views now provides package management and consent dialogs.
It also opens a custom view as a native pane beside the Workbench in the main
window, whose toolbar and record navigation remain host-owned; the owner chose
the pane over a second window on 2026-09-20. A host-owned splitter in a column of
its own moves the boundary between the two, by pointer or by arrow key, within
[480 DIPs, window − 420]; the width is not remembered between openings.
Controller-owned lifetimes retain package leases,
cancel startup/kill Jobs on file rotation and refresh bounded projections.
Cross-process HWND placement and retained containment have measured tests. An
isolated native journey imports and exports through native file pickers, reviews
consent, opens the configured graph from Use,
measures both themes at the enforced minimum window size, edits a selected record
through Studio and returns keyboard focus with F6. It terminates the owned helper,
checks the native fallback, saves another Studio edit and revokes permission.
Missing and disabled states keep Studio reachable. Writing a package against this
boundary is documented in [authoring a custom view](custom-view-authoring.md).
High-DPI toolbar reflow,
broader containment checks and the complete installed-host journey remain release gates.

[ADR-0008](decisions/0008-general-scripting-and-capability-isolation.md) accepts
bounded calculations and host-owned local actions. Stages S1–S4 of its
[implementation plan](design/adr-0008-implementation-plan.md) are now in the
Engine: a protected definition table, a bounded expression runtime over NCalc,
calculated fields, and trigger expansion inside the initiating write transaction.
The file format gained the behaviour rung (minimum host 1.17.0), two new canonical
definition operations, a rung for a field or section shown only when a
calculation says so (1.18.0), and a rung for colour and the record-page header
(1.19.0, ADR-0004's 2026-09-14 amendment: a `tone` on a choice option in its own
protected table at the end of the layout ladder, and a `detailSurface` that names a
title, subtitle or accent field), a rung for the first charts (1.20.0: a
`breakdownChart` or a `progressTile`, read through one exact grouped aggregate over
a closed grouping), and a rung for the timeline (1.21.0: a `timelineSurface`
placing records on a spine by a Date field, one civil year at a time, with an
optional end date drawn as a span from its start), and a rung for the gallery and
the rating scale (1.22.0: a `gallerySurface` of cards over a list's window, and an
Integer field drawn on a closed scale stored in the layout ladder's then-last rung),
and a rung for what the file is for (1.24.0: prose the file carries itself, in its own
protected table as the layout ladder's new last rung, led with by the describe resource
and belonging to no record type and no node); every other boundary below is unchanged.

NCalc is referenced by the Engine alone, and its compile and build assets are
withheld from every consumer, so an expression can only reach it through the typed
adapter in `Nendo.Engine/Behaviour/`. A file that holds no calculations never loads
it at all.

A file that carries a trigger cannot be edited until this device has approved that
exact behaviour, checked again at the commit boundary. Approvals are device state
under the per-user root, never inside a `.nendo` file, so a file can never carry
its own permission and a copy always asks again. The Engine consumes a narrow
authority interface and never learns where approvals are kept.

Studio and custom surfaces both show calculated fields, the approval route lives in
File status, and the real-host journey drives all of it through the actual
WinUI/WebView2 host — see
[calculations-and-actions.md](contracts/calculations-and-actions.md) for what each
ADR obligation rests on. Production retains coordinator-owned atomic writes, exact
proposal replay, and permanent Studio/recovery access.

```text
Nendo.Workbench  --closed typed bridge-->  Nendo.Desktop  -->  Nendo.Engine
   (TypeScript)                              (WinUI 3)            |
                                                                  +--> Nendo.LocalMcp
```

| Project | Role | Size |
| --- | --- | --- |
| `src/Nendo.Engine` | Storage, typed operations, revisions, proposals, the semantic compiler. The only code that opens SQLite. | ~12.8k lines |
| `src/Nendo.Desktop` | Thin WinUI 3 host: file lifecycle, native dialogs, recovery, window and appearance policy, the notification area and Windows notifications, the Workbench bridge. | ~5.8k lines |
| `src/Nendo.Workbench` | Local web UI in a WebView2: Studio, custom surfaces, Help (how-to guides, how Nendo works, and an agent reference the production gate ties to the MCP surface). Built by Vite, bundled into the host. | ~9.5k lines |
| `src/Nendo.LocalMcp` | MCP adapter over the same application services. Not an authority model. | ~3.9k lines |

The dependency arrows are enforced, not conventional. `Test-Production.ps1`
fails the build if `Microsoft.Data.Sqlite`, a SQLite connection type or
`SQLitePCL` appears anywhere in Desktop or LocalMcp, and if any project under
`src/` or `tests/` references `prototypes/`.

No UI or MCP adapter receives SQL, a SQLite handle, physical identifiers, the
database path, arbitrary filesystem/network/process capability, or a generic
host invocation. See [ADR-0005](decisions/0005-host-application-services-and-write-coordinator.md)
and [ADR-0017](decisions/0017-production-composition-and-build-layout.md).

## The file

One SQLite file at rest, extension `.nendo`, application ID `0x4E454E44`,
identifier `nendo.sqlite.application`. Journals, proposal clones and backups are
host-owned operational derivatives, never user-managed artefacts.

Storage is rollback DELETE with `synchronous=FULL` and a 2,000 ms busy timeout.
WAL measured materially better long-read and read-throughput behaviour but
exceeded the allowed writer-tail regression, so it was not taken
([ADR-0011](decisions/0011-local-sqlite-journal-and-copy-discipline.md)).

A file records the `minimumHostVersion` it needs. The constants live in
`src/Nendo.Engine/NendoFormat.cs` and step with each capability that changes what
a file can contain — `1.11.0` for composable surfaces, then one version per
widened semantic shape up to `1.18.0` for a field shown only when a calculation says so. Which of them a stored
definition actually needs is computed from its shape by
`src/Nendo.Engine/SemanticCapability.cs`, over the tree a mutation leaves behind
rather than the operations it submitted: contract version 3 covers a plain form
and a tabbed page with two boards alike, so the version on a root cannot answer
it, and a move that relocates a node changes the answer without setting any
property. A recorded minimum is only raised, never lowered. An older host refuses
a newer file explicitly rather than opening it partially; opening an older file
never upgrades or rewrites it.

**Cloud sync is unsupported.** Known sync-managed paths (OneDrive, Dropbox,
Google Drive) are detected where practical and warned about. There is no
sync-safety claim and no live-provider evidence.

## Data model

User entities materialise as ordinary relational tables. Stable semantic IDs map
entities and fields to physical names, so display names change without breaking
bindings. The schema service is the only path to physical DDL and protected
metadata; external changes are detected as drift and produce a normal,
repairable-safe or read-only open, never a guessed repair
([ADR-0003](decisions/0003-relational-user-data-and-protected-metadata.md)).

Scalar storage kinds: `text`, `integer`, `decimal`, `boolean`, `date`,
`datetime`, `uuid`, `reference`. Presentation and constraints refine these —
long text, single choice, email, URL and Markdown are all semantics over `text`.
Multi-choice is a relationship, and is out of scope.

Numeric exactness is a contract, not a convention: `decimal` is the .NET decimal
domain stored as exact TEXT, and no numeric value passes through a JavaScript
number anywhere in the Workbench transport or edit path. See
[contracts/scalars.md](contracts/scalars.md).

## Two lanes

The mutation model splits by what is changing, because a single global revision
would make every agent proposal stale after any unrelated cell edit.

**Data lane** — record create/update/delete, bounded paste and import. Direct
validated transaction against the active file, with optimistic record-version
checks and idempotency keys. One attributable revision per accepted transaction.

**Application lane** — schema, semantic UI, constraints and declarative
commands. Agent work happens in a proposal clone; validation and semantic diff
precede promotion; acceptance is an explicit host-owned action.

A bootstrap proposal may carry schema, initial records and surfaces together.
Ordinary record entry never pays the clone-and-preview cost.

### Revision lineages

- `definition_revision` — schema, UI, commands, constraints, settings
- `data_revision` — record state
- `change_sequence` — monotonic audit ordering across both
- per-record versions — optimistic concurrency for touched records

A proposal is stale when its required definition revision moved, or when a record
it actually reads or transforms no longer matches its captured version. An edit
to an unrelated record does not invalidate a UI-only proposal
([ADR-0006](decisions/0006-split-revisions-audit-and-compensation.md)).

### Typed operations

Twenty-one canonical operations are the primitive. Everything — semantic diff,
undo evidence, replay — derives from the same operation stream.

```text
schema.createEntity      data.createRecord              ui.addNode
schema.addField          data.setField                  ui.setProperty
schema.renameEntity      data.deleteRecord              ui.moveNode
schema.renameField       data.restoreDeletedRecord *    ui.removeNode
schema.setFieldRequired  data.backfillRetiredField
schema.setRetired        data.convertLegacyReference    behaviour.setDefinition
schema.setChoiceMetadata identity.transition *          behaviour.removeDefinition
schema.configureReference
```

`*` native-only. The other nineteen are the closed union an MCP client may
author — see `NendoAuthoringOperations.cs`. Whole-definition convenience APIs
must expand into typed operations before anything is recorded, diffed or
promoted.

Every operation declares a reversibility class — `reversible`,
`reversible-with-retained-state` or `irreversible-declared`. Lossy conversion is
never labelled reversible just because a backup exists. There is no universal
undo; compensation applies a proven inverse as a *new* revision and never
rewinds history.

## Proposal lifecycle

```text
Draft → Validating → Invalid | Previewable
                   → Rejected | Stale | Applying
                   → Active | Failed
                   → Compensated, where the accepted operations support it
```

A proposal binds application and instance identity, required definition revision,
touched record versions, canonical operations, validation evidence and the
semantic diff.

**Promotion never replaces the active file with the clone.** The host replays the
exact validated operations against the active file after checking every
precondition. The interpreter and validation version used for preview and for
promotion must match ([ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md)).

There is no MCP accept or promote tool. Acceptance is native-owned: the Workbench
review calls `PromoteProposalAsync` with the reviewed digest, and the write gate
verifies that digest before replaying.

## Semantic surfaces

Stored surfaces follow a strict versioned contract
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md)). **Contract
version 3 is the only shape this host compiles** — an ordered composable node
tree governed by one vocabulary table, covering `recordForm`, `recordList`,
`boardSurface`, `gallerySurface`, `calendarSurface`, `timelineSurface`, `detailSurface`,
`overviewSurface`, `recordCommand`, `section`, `tabGroup`, `relatedList`, `fieldBinding`,
`recentList`, `filterClause`, `commandStep`, a bounded `summaryTile` and the three tiles
that draw a number, `breakdownChart`, `progressTile` and `rangeTile`.

`relatedList` is the one kind that does something the vocabulary does not describe. It
adds a record of the related type with the reference back already filled in, and opens the
row you click (2026-09-18 amendment). Nothing is stored for either and no rung moves: the
node already names the target type and the field that points back, and the compiler has
already proved them, so an author has nothing left to say and every file built before it
has the actions already.

`overviewSurface` is the one root that belongs to the file rather than to a record
type (2026-09-14 amendment, S4). The compiler groups every other root by its
`entityId` and builds one `NendoApplicationPlan` per group; the overview is split
off before that grouping and arrives as its own plan on the compile result,
carrying the entity plans its tiles name. Giving it an entity plan would have
meant inventing an entity nothing stores, and every consumer would then have had
to know which of the plans was the pretend one.

The 2026-09-12 amendment widened that vocabulary within version 3: eight
`recordList`, `boardSurface`, `calendarSurface` and `recordCommand` roots per
record type, selected in Use by stable ID rather than by kind; `summaryTile` on a
list or board with a closed `surface`/`group` scope; `tabGroup` naming record
sections as tabs; and a Date-field month calendar with its own undated view. What
a flat kind table cannot express — which parent admits a property, how a bounded
query composes against the eight-filter ceiling, whether a tab group already
encloses a node — travels down the compiler's recursion as `SurfaceContext`. See
[the semantic surfaces contract](contracts/semantic-surfaces.md) for the rules and
the diagnostics.

Contract versions 1 and 2 were removed on 2026-09-12, before the format had
users. There is one compile path, one plan shape and one digest projection; a
stored root declaring version 1 or 2 is refused by `NUI003` and every custom plan
is suppressed, while Studio, the data and recovery are unaffected. Board card
fields come from ordered `fieldBinding` children — the parallel `cardFieldIds`
property is gone.

`src/Nendo.Engine/SemanticVocabulary.cs` holds the single table that both the
compiler validates against and the published vocabulary description is generated
from — a client can never be told about a kind the host will not accept. That
table is served as `nendo://application/vocabulary`, so an authoring client reads
the contract instead of probing for it.

Unknown kinds, unknown properties, illegal parenting and mixed contract versions
all fail closed with `NUIxxx` diagnostics carrying `semanticId` and
`propertyPath`. Any error suppresses every custom plan rather than rendering a
partial application. Zero custom nodes still leaves permanent Studio.

`summaryTile` computes exact `count`, `sum`, `min` and `max` over an Integer or
Decimal field, folded in the host over stored lexemes. `rangeTile` states `min` and
`max` of one field and is the one place either reads a **Date**: the extremes of a
set of civil dates are chosen by ordinal comparison over the fixed-width ISO form,
which needs no arithmetic and so no rounding rule. The safe-mode fold answers a
date too, because an aggregate that was exact in SQLite and *Unavailable* in safe
mode would be two answers to one question; a sum over a Date stays refused by
name. `avg` is refused by name
and published with its reason: the mean of exact decimals is not generally an
exact decimal. On a list or board a tile covers the whole filtered set rather
than the loaded page, and the renderer labels it as such; `scope` group is
accepted only on a direct board child, addresses a column by its stored choice ID
and the ungrouped column by `isNull`.

## The window, and what outlives it

Closing the window hides it into the notification area; the process stays resident
with its file open and its MCP host listening, and the tray menu carries the real
exit. This is the 2026-09-15 amendment to
[ADR-0002](decisions/0002-containing-desktop-architecture-and-process-model.md),
and it is there because the two things an agent cannot do for itself — accept a
proposal and consent to automatic actions — are the person's, and the person was
previously required to keep a window open to be asked.

The close behaviour is device state (`shell.json`, beside the appearance and grant
stores), defaults to the notification area, and is toggled from the tray menu. The
process owner pins it with `NENDO_DESKTOP_CLOSE_ACTION`; every scripted window lane
sets it to `exit`, because none of them can click a tray menu. One icon per window.

Four things raise a Windows notification, and only while the window is hidden or
minimised: a validated proposal is waiting, a file's automatic actions need consent,
the open file stopped being writable, and the workspace failed. They carry a view
name and nothing else — no path, no digest, no proposal id — and they **route rather
than grant**. Clicking one opens the page where the person answers; none of them
carries the answer, because promotion verifies the digest that was reviewed and a
grant binds an exact digest, revision and capability set. `Test-Production.ps1` keeps
the notification types out of the MCP adapter, and
`DesktopNotificationContentTests` asserts no payload carries an approve or promote
argument.

## What Nendo is to Windows

Setup writes five things into the per-user class store, and one shortcut. A `.nendo`
file has its own icon and opens Nendo when it is double-clicked; *New > Nendo
application* in Explorer runs `Nendo.Desktop.exe -new "%1"`, so Explorer picks the
name and Nendo makes a real empty file — rather than a template being shipped and
then kept in step with what *New file* already produces; `OpenWithProgids` puts Nendo
in *Open with*; and an `AppUserModelId` key carries the display name and icon the
notification centre reads.

That last key names the application's identity to the shell, and three things have to
agree on it. `DesktopShellIdentity` sets it on the process in the `App` constructor —
before the first window, because a window created under one identity and renamed
afterwards is how an application ends up with two taskbar buttons — and again on the
window itself, which is both belt and braces against the Windows App SDK notification
registration renaming the process later, and the only way the identity can be read
back at all. Setup stamps the same string onto the Start Menu shortcut as
`System.AppUserModel.ID`. Windows will pin a shortcut without it, but the pinned copy
then groups separately from the running window — two buttons for one application, and
the Jump List on the wrong one.
`Test-Repository.ps1` checks that the C# constant and the setup script still say the
same thing, because nothing else can see both files and the failure is silent.

The Start Menu shortcut is written by `Invoke-NendoSetup.ps1` rather than by the NSIS
script, for the reason the association is: NSIS cannot set a shell property, and the
setup script is the half that a lane can run.

The taskbar button carries the state the window shows and nobody can see: a badge when
the open file is waiting on approval or recovery, a lock when it is read-only, and
indeterminate progress while a file action runs. One `DesktopShellBadge` decides it and
the notification-area tooltip reads the same one, so the two cannot disagree. The
button's Recent list is rebuilt from `DesktopFileHistory` when the open file changes,
honouring the destinations the person has removed — re-adding one makes the whole
commit fail.

A `.nendo` file dragged onto the window, or onto the taskbar button, opens by the same
route as *Open file*: the page sees the drag and draws the hint, then hands the host
the shell's own file object through `postMessageWithAdditionalObjects`. The host asks
Windows for the path. The page never names one, so the worst a tampered page could do
is ask about a file somebody physically dropped.

Routing a click needs the host to speak first, which is bridge protocol version 7:
an unsolicited `{protocolVersion, event, payload}` message carrying a route name.
It has no `requestId`, so a renderer at versions 2–6 drops it exactly as it drops
anything else it did not ask for.

**An agent working is now visible from every screen.** The MCP host brackets every
tool and resource call and pushes `(busy, client, what)` to the shell, which
forwards it as the third unsolicited event. The status bar draws a pill after the
same 700 ms the busy bar waits, and the busy bar names the cause — *Claude Code is
writing to this file…* rather than *Still working…* — because a request queued
behind an agent's write is not slow, it is waiting. The gated lease read was part
of the problem: it took the same semaphore the write held, so asking who was
editing waited for the edit, while holding the Desktop's own gate. That read is now
a gate-free peek.

**What this costs.** While a file is open with agent access on, any process on this
machine can connect at that level ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)).
Closing the window used to end that; it does not now. The tray menu shows the live
access mode and offers to turn it off, the tooltip names the open file and says when
it is waiting on approval, and the first close on a device explains where the window
went. No credential or peer check was added.

## Studio and safe mode

Every valid file opens with **Nendo Studio** — the permanent, host-owned human
workspace covering Data, Structure, Surfaces, History and Health. It is available
with no user entities, no agent connected, no custom surface, an invalid
definition, or a file in restricted safe mode. Application content cannot remove,
replace or hide the route back to it
([ADR-0015](decisions/0015-host-owned-database-studio-and-ag-grid-community.md)).

Charts over a civil date — a `trendChart` of one number per month or week, an
`activityGrid` of one count per day — are the first groupings whose groups are
generated from a resolved range rather than read from a field's options, so the
host makes every bucket before it reads and a period with nothing in it is stated
as empty rather than left out. A range is a closed word resolved at read time,
never a stored date. Minimum host 1.25.0
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-16).

A `matrixSurface` crosses two choice dimensions and a `rankedList` states the few
records at the top of one stored number. The grid is **one** grouped read whatever
its size: every cell key is made from the cross product of the two option sets
before a record is read, so an empty cell is a cell and each number is exact over
everything the surface covers while the cards in it are the surface's one loaded
window — which is why a cell can say how many it is not showing. The cross product
spends the same 366-group ceiling, refused when it is authored and stated when it is
read. A ranking adds one predicate of its own to keep the records that have a number,
so it carries seven authored clauses rather than eight. Minimum host 1.26.0
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-17).

A `boardSurface` also groups by a **bound Reference field**, whose columns are records of
another record type rather than a field's options. It is the first grouping in the product
whose members are neither written in the definition nor computed from a range: people make
and remove them while the board is open, so the board reads them. Every active record of
the target type is a column, ordered by the reference's label, because a lane nobody has
used is an answer. A board draws at most `MaximumReferenceBoardColumns` (24) of them and
above that draws none at all, naming the type, its count and the bound — a read-time rule,
because a definition cannot carry how many records a record type holds. A drag between
lanes writes the reference with the target's current version, which the board is already
holding. Minimum host 1.27.0
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-17).

**A section can be folded away.** Every section on a record page or the front page is a
disclosure whose heading is the control; a closed one reads none of what it holds, and the
walkers that decide what a page is still waiting for stop at it (`fold-state.ts`,
`overview-model.ts`, `plan-selection.ts`). The one stored word is how it starts, `opens`
on `section`; what the person does with it is file-scoped renderer state like a selected
tab and never reaches the file. Minimum host 1.28.0, only for a file carrying the property
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-20).

**This is the one capability the node tree cannot show**, and it is why
`NendoSemanticCapability.RequiredHostVersion` takes the stored fields beside the nodes: a
board grouped by a reference and a board grouped by a choice are the same kind with the
same property and the same children, and only the grouping field's storage kind separates
them. Every other rung is a shape. The recompute still fires only when a mutation touches
UI nodes, which is sound because no conversion turns a choice field into a reference one —
a field's storage kind never changes underneath a board.

The host tells the renderer when the open file moves. The coordinator raises
`Committed` with the change sequence for every writer it serves, and the shell
forwards it as `fileChanged`, the second member of the closed unsolicited-event
set, carrying that number and nothing else. It is a nudge: the renderer re-reads
through the same bounded chase the tiles use, at most once a second and never
while somebody has hold of the page, so a surface catches up on its own instead
of waiting to be left and returned to
([ADR-0002](decisions/0002-containing-desktop-architecture-and-process-model.md),
2026-09-17).

Open states are explicit: normal, read-only, recovery and rejected. Safe mode is
a permanent host capability, not a failure path bolted on
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)).

Opening inspects the whole file before granting any capability, so the file has a
size bound: **256 MiB**, raised from 64 MiB on 2026-09-16 and recorded in the
ADR-0012 amendment with what it was measured to cost. A record carrying 1,306
bytes of text costs 3,554 bytes on disk — a multiple of 2.72 — so the bound is
reached at roughly 75,500 such records, and one cold open at that size takes
about 6.6 seconds. A separate bound of 100,000 rows applies per audit and
definition table, and `__nendo_operation` carries one row per record write and one
per later edit, so that bound arrives at roughly 100,000 writes whatever they
weigh. Neither bound is enforced at write: a file can still be written past the
size at which it will open, and being told at write time is open work (W-038).

## Agent surface

MCP is an adapter over application services. It is not the authority model.

Transport is loopback, stateless Streamable HTTP with no credential: the address
`http://127.0.0.1:41763/mcp` is the whole client configuration. Both MCP eras are
served — the `initialize` handshake on any version the SDK supports, and the
2026-07-28 `server/discover` path — so Claude Code and Codex both connect. Lease
acquisition mints an opaque `applicationHandle` alongside the `leaseId`; both are
required on every owned operation. Handle possession governs ownership — not
claimed client names and not HTTP connection identity.

Fourteen resources (reads, no lease required) and nineteen tools (writes, lease
required — except `nendo.lease.status`, `nendo.data.get_receipt` and
`nendo.health.verify_integrity`, which read authority or file state without
holding or granting any). Both surfaces are asserted by name in
`Test-Production.ps1`, so adding one fails the gate until the contract is updated
deliberately. Full map: [contracts/mcp-interface.md](contracts/mcp-interface.md).

Visible access modes: `Disabled`, `Read-only inspection`, `Data mutation`,
`Application authoring`, `Unattended authoring`.

**The fifth mode is where an agent decides for itself.** At Unattended, and
nowhere below it, `nendo.change_set.accept` promotes a proposal the same session
validated — through the same `PromoteProposalAsync` the person's Accept button
calls, with the reviewed digest, so every staleness and digest check stands — and
the host records this device's consent for the automatic actions that acceptance
installs. What it gives up is real and is the point of it: a shape change and an
action can reach the active file with nobody having read either. It is off by
default, confirmed before it takes effect, ends when the level is lowered or the
file closes, and is never persisted
([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md),
2026-09-22).

**Bulk data crosses the same boundary as a single record.**
`nendo://application/entity/{entityId}/export` is a page of faithful Nendo CSV —
the profile the person's own Export writes — and `nendo.data.import_records` takes
CSV text or typed JSON at *Data mutation* and commits it through the same
`CreateRecordsAsync` a single create uses, fifty to a revision, up to five hundred
rows a call. Export is a resource rather than a tool so that Inspect keeps an
empty tool list. Neither carries a path, in either direction.

The security boundary is this computer, at the owner's chosen access level.
While a file is open with access on, any process on the machine — under any
account — can connect; exact Host and Origin matching keeps browser-origin
requests and DNS rebinding out. The owner's controls are the access level (Off
by default), lease revocation, and the approval dialog for application changes.
**It is not an anti-malware boundary, and it is the wrong posture for a shared
machine.** ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md))

Local defaults suit single-user work: a fixed loopback port (41763, falling back
to ephemeral and reporting it) and an edit lease with no expiry that ends on
explicit release or owner revocation. Both can be changed in Agent → Connection,
which also shows the live address and copies the registration command for
Claude Code or Codex. Closing an agent does not end a lease; closing, switching,
replacing or recovering the file invalidates all authority, while a healthy
renderer-only restart preserves it.

There is no embedded agent and AG-UI was not adopted
([ADR-0014](decisions/0014-drop-embedded-agent-mcp-is-the-agent-surface.md)).

## File lifecycle

Typed Duplicate, Fork, Backup and Restore have defined identity semantics, and
raw copies are classified before any write
([ADR-0010](decisions/0010-file-identity-duplicate-fork-backup-and-restore.md)).
Interrupted replacement is resolved explicitly, never silently repaired. There is
no guessed migration and no identity repair.

## Product version

One number for the whole tree, declared as `<Version>` in
`Directory.Build.props`. `NendoProduct.Version` reads it back from the assembly at
runtime, and everything that shows it reads it from there: the Workbench status
bar, the MCP `server/discover` handshake, and the installer's `DisplayVersion`,
which now carries the release beside a `BuildId` carrying the payload identity. A
bump lands in one place.

This is the application's version. It is unrelated to
`NendoFormat.CurrentHostVersion`, which states the file-format capability a
`.nendo` file needs from whatever host opens it, and which moves only when the
format gains one.

## Where things live

Current locations, to save a search:

| Concern | Path |
| --- | --- |
| Product version | `Directory.Build.props`, `Engine/NendoProduct.cs` |
| Vocabulary and validation | `Engine/SemanticVocabulary.cs`, `NendoSemanticCompiler*.cs` |
| Plan shape and digests | `Engine/SemanticModel.cs` |
| Accept gate / diff | `Engine/SemanticDiff.cs` |
| Canonical operations | `Engine/Operations.cs`, `CanonicalChangeSetRequest.cs` |
| Write authority | `Engine/NendoWriteCoordinator*.cs` |
| SQLite (only here) | `Engine/Storage/SqliteNendoStore*.cs` |
| Bounded reads and cursors | `Engine/ReadQueries.cs`, `NendoQueryCursor.cs` |
| Bridge | `Desktop/DesktopShellContract.cs`, `WorkbenchProtocol.cs` |
| Notification area | `Desktop/DesktopTrayIcon.cs` — the only interop in the tree: one hidden top-level window, `Shell_NotifyIcon`, one popup menu |
| Notifications | `Desktop/DesktopNotifier.cs` (the OS side), `DesktopNotificationContent.cs` (the wording and routes, pure), `DesktopNotificationTrigger.cs` (transition, never condition) |
| Close behaviour | `Desktop/DesktopShellStore.cs` (device state), `DesktopCloseAction.cs` (the decision, pure), `MainWindow.xaml.cs` |
| Renderer entry point | `Workbench/src/main.ts` — the router and the frame; it hands `render` and `updateChrome` to `shell.ts` so a view never imports it back |
| One view per file | `Workbench/src/view-*.ts` (Use surfaces are hand-rolled DOM; AG Grid stays in `view-data.ts`) |
| Renderer state | `Workbench/src/app-state.ts` — one `state` object and the caches, importing no view so nothing cycles through it |
| Markup | `Workbench/src/record-markup.ts` (the pieces), `page-markup.ts` (a record page), `surface-markup.ts` (the selected surface) — pure string builders, under test |
| Reads and writes | `Workbench/src/reads.ts`, `panels.ts` (tiles and charts), `actions.ts` (the one write path and the coherent-snapshot refresh) |
| Host bridge | `Workbench/src/host.ts` (protocol version and which client), `host-types.ts`, `host-desktop.ts`, `host-preview.ts` |
| Stylesheet | `Workbench/src/styles.css` — an ordered `@import` list; the numbered slices in `styles/` are one cascade, not independent sheets |
| Plan-shape resolution | `Workbench/src/surface-model.ts` — resolves selectable surfaces, roots, fields and commands from the version 3 node tree |
| Read windows | `Workbench/src/record-window.ts` — the query snapshot a window owns, its page requests and structured cache keys |
| Totals | `Workbench/src/summary-tiles.ts` — tile scopes and the exact read each one composes |
| Calendars | `Workbench/src/calendar-model.ts` — civil-date arithmetic, the Monday-first month grid and month/undated queries |
| Timelines | `Workbench/src/timeline-model.ts` — civil-year bounds, month grouping, integer day arithmetic and spans cut at the year end; the calendar's page accumulator in `reads.ts` serves both |
| Ratings | `Workbench/src/rating.ts` — the dots, their accessible name and the radio control; the scale itself is stored by `Engine/Storage/SqliteNendoStore.Scales.cs` one rung below the last |
| View failures | `Desktop/DesktopViewFailureLog.cs` — the kind, how long the view had been up, whether the window was out of sight and what Windows said about memory, capped at 50 and switched from the tray; device state, never in the file |
| What the file is for | `Engine/Storage/SqliteNendoStore.Application.cs` — a singleton row in the layout ladder's last rung, read onto the manifest and led with by `nendo://application/describe`; `Workbench/src/file-actions.ts` shows it on its own page, from About this file in the File menu |
| Agent tools and allow-list | `LocalMcp/NendoAuthoringTools.cs`, `NendoAgentAuthoringService.cs` |
| Resources | `LocalMcp/NendoMcpResources.cs`, `NendoResourceProjection.cs` |

## Running it

The Workbench must be built before the host, because it is bundled into the
Desktop output:

```powershell
cd src/Nendo.Workbench; npm ci; npm run build; cd ../..
dotnet build Nendo.slnx
./artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe
```

Windows only — the host is WinUI 3 and needs the WebView2 Evergreen runtime.
The app opens with no file; create one from the File menu and Studio appears.

For UI work without the host, `npm run dev` in `src/Nendo.Workbench` serves the
page at `127.0.0.1`; append `?preview=1` to get the in-memory protocol double.
That is visual-only and proves nothing about storage or the bridge.

## Building and verifying

```powershell
pwsh ./tools/Test-Repository.ps1      # fast: invariants, line endings, binary assets, ADR structure, vendored skills
pwsh ./tools/Test-Production.ps1      # full gate; includes the repository check
```

Do not run `Test-Production.ps1` twice — it already includes `Test-Repository.ps1`.
Use `-SkipRestore` only with unchanged dependencies.

**There is no CI, deliberately.** The gate above is the gate: it runs in about a
minute locally, and on a solo project with no pull requests a hosted copy of it
earns nothing. Run it before you push. Add CI back when there is a reason —
a second contributor, or approaching a real release.

Two native lanes exist and are not in the gate, because they drive a real
Desktop window and need a desktop session:

```powershell
pwsh ./tools/Review-OutcomeRuntime.ps1      # real file-action outcomes and recovery; -Executable for the published payload
pwsh ./tools/Review-NeutralityRuntime.ps1   # application-neutral surfaces through MCP
pwsh ./tools/Review-DesktopPerformance.ps1  # startup, edit, memory against the four datasets
pwsh ./tools/Review-ShellRuntime.ps1        # closing hides the window and keeps the file open
```

`Review-ShellRuntime.ps1` covers the close behaviour and nothing else it might be
mistaken for: no script can enumerate another process's tray icon or observe a shell
notification, so the icon, its menu and the notifications stay owner-reported. The
lane prints that alongside its pass rather than leaving it to be assumed.

If you do re-add CI, one thing is not obvious: set
`DOTNET_INSTALL_DIR` to a runner-local path and install the SDK version read
from `global.json`. This repository's `rollForward` policy is `latestFeature`,
so without that a runner's preinstalled SDK silently wins over the pin. The Node
floor is the `engines` range in `src/Nendo.Workbench/package.json` rather than a
number repeated here, which is how the last one drifted; package versions come
from `Directory.Packages.props`.

Packaging (Windows x64, unsigned, per-user install):

```powershell
pwsh ./tools/Publish-NendoPayload.ps1
pwsh ./tools/Build-NendoInstaller.ps1     -PilotRoot '<printed payload directory>'
pwsh ./tools/Test-NendoInstaller.ps1      -PilotRoot '<printed payload directory>'
pwsh ./tools/Test-NendoSetupIsolated.ps1  # install/upgrade/uninstall against a task-owned root
```

NSIS must be installed to build the installer. Rebuilding the app means
rebuilding the installer in the same task. Prune old payloads only through
`Remove-NendoBuildPayload.ps1`, which verifies hashes first.

### What gets checked, and what doesn't

An installer build is covered by two different lanes, and it matters which one
you mean. `artifacts/installer/installer-status.json` records both for the
delivered file.

| Lane | Covers | Runs |
| --- | --- | --- |
| `Test-NendoSetupIsolated.ps1` | The setup logic: install, in-place upgrade, obsolete owned file removal, unowned user file preservation, uninstall, and everything setup registers with Windows — the `.nendo` association, the *New* menu entry, the application identity and the Start Menu shortcut — against a task-owned root, class store and Start Menu folder | Always |
| `Test-NendoInstaller.ps1` | The NSIS wrapper: bootstrapper, payload extraction, HKCU uninstall registration, real `Uninstall.exe` | Only on a clean Windows user |

The second lane installs and then **uninstalls** from the real per-user
location, so it refuses to start when Nendo is actually installed. That refusal
is a safety interlock protecting your installation — not a failure, and not a
finding about the build. On a developer machine it simply never runs, which
means the NSIS wrapper is normally unchecked. Say that precisely rather than
calling the installer "unverified", which reads as a defect and is not what is
meant.

The setup logic itself has three fast tests over synthetic fixtures — no real
payload, no NSIS, seconds each. Run them when you touch `Invoke-NendoSetup.ps1`:

```powershell
pwsh ./tools/Test-NendoSetup.ps1          # 13 cases: fresh install, upgrade, rollback,
                                          # locked files, corrupt extraction, path traversal
pwsh ./tools/Test-NendoLegacyUpgrade.ps1  # upgrade over a legacy owned payload
pwsh ./tools/Test-NendoBuildPruning.ps1   # Remove-NendoBuildPayload safety
```

The agent-authoring gate builds a complete application from an empty file through
the MCP interface alone, then reopens it offline:

```powershell
pwsh ./tools/Test-AgentAuthoringGate.ps1
```

The unattended gate does the same at the fifth access level, where the agent accepts
its own proposal and the host records the consent its automatic actions need, and
nobody touches the window after the level is set. It also measures what the person can
see while that happens — the status-bar indicator naming the client and the call, and
coming down once the agent is quiet — by reading the DOM rather than by looking at a
screenshot:

```powershell
pwsh ./tools/Test-UnattendedBuildGate.ps1
```

The behaviour gate does the same for calculations and automatic actions, and then
checks what an agent still cannot do — run what it authored, reach this device's
consent, or make a surface sort by a calculated field:

```powershell
pwsh ./tools/Test-BehaviourAuthoringGate.ps1 -Executable <published Nendo.Desktop.exe>
```

It takes the definition body shapes off the wire rather than from this repository,
so a published example that stopped working fails the gate instead of misleading an
agent. It writes what it observed beside its assertions: whether an open window
noticed the new rules without a refresh, and that a grant binds the whole definition
revision, so even a change that alters no rule asks the owner again.

Both gates were written by somebody who already knew where everything was, so
neither can tell us whether a capable client could find it. That is what the
blackbox review lane is for: [`docs/reviews/blackbox-prompt.md`](reviews/blackbox-prompt.md)
is handed to an agent that has never seen this repository, and
[`docs/reviews/README.md`](reviews/README.md) says how to run a round and which
contract each phase reaches. It is a manual lane — it needs a person at the
keyboard and a fresh reviewer — so it runs before a release rather than in the
gate, but the repository gate does check that the prompt still covers every
published contract.
