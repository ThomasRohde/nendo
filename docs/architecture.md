# Architecture

This document describes the current state of the system as built. The
[contracts](contracts/) hold the behavioural detail. The
[decision records](decisions/README.md) hold the reasoning behind each boundary.
If this document and the code disagree, the code is correct. Report the
difference and fix this file.

## Composition

[ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md), accepted
2026-09-25, puts a custom view's code in the `.nendo` file and runs views inline in
the Workbench. It lands in phases, and Phases 0 to 2 are delivered, in product
0.14.0:

- A view's code is a package that the file carries, at host 1.33.0 (see
  [The file](#the-file)). It arrives through a proposal, and a person reviews it as
  code.
- A view is a cross-origin frame in the Workbench's own WebView2. Each package in
  each file has an origin of its own under the reserved `.example` domain, so
  Chromium gives each package a renderer process of its own, apart from the
  Workbench's.
- The host answers every view origin from the open file, through the browser's
  resource-request event, and serves the view API, `/_nendo/api.js`, from the
  installed Workbench.
- A view calls `window.nendo`. The Workbench's broker checks each request against a
  closed method table and answers it through the Workbench's own typed bridge, so a
  view is one more client of the same application services. In this phase the table
  holds reads and navigation, and nothing that writes.
- Device-local kill switches decide whether views run. A view's renderer ending
  stops that view alone. Only a failure of the Workbench's own renderer or of the
  browser sends the app to recovery, whose panel can restart without custom views.

The contained helper, `Nendo.ExtensionHost`, which ran one view at a time in an
AppContainer and a Job Object with a browser of its own, is deleted. So are the
device package cache, device consent and the native pane. The
[custom-view contract](contracts/custom-views.md) has the rules, and
[Authoring a custom view](custom-view-authoring.md) tells how to write a view.
A view writes records and runs commands, and a package can be developed from a
folder on this device (Phases 3 and 4). Proposals and state from a view, and views
anywhere (the rest of Phase 3, and Phase 5), are not yet delivered
([roadmap](roadmap.md)).

[ADR-0008](decisions/0008-general-scripting-and-capability-isolation.md) accepts
bounded calculations and host-owned local actions. Stages S1–S4 of its
[implementation plan](design/adr-0008-implementation-plan.md) are now in the
Engine: a protected definition table, a bounded expression runtime over NCalc,
calculated fields, and trigger expansion inside the initiating write transaction.
The file format gained these rungs and operations:

- The behaviour rung (minimum host 1.17.0) and two new canonical definition
  operations.
- A rung for a field or section that a calculation shows or hides (1.18.0).
- A rung for colour and the record-page header (1.19.0, ADR-0004's 2026-09-14
  amendment). It adds a `tone` on a choice option, in its own protected table at
  the end of the layout ladder. It also adds a `detailSurface` that names a title,
  subtitle or accent field.
- A rung for the first charts (1.20.0): a `breakdownChart` or a `progressTile`. The
  host reads each through one exact grouped aggregate over a closed grouping.
- A rung for the timeline (1.21.0): a `timelineSurface` that places records on a
  spine by a Date field, one civil year at a time. An optional end date draws as a
  span from its start.
- A rung for the gallery and the rating scale (1.22.0): a `gallerySurface` of cards
  over a list's window, and an Integer field drawn on a closed scale. The scale is
  stored in the layout ladder's then-last rung.
- A rung for the front page (1.23.0): an `overviewSurface` that belongs to the file
  and not to a record type, with a `recentList` and a `rangeTile` under it.
- A rung for what the file is for (1.24.0): prose that the file carries itself. The
  prose is in its own protected table, on the layout ladder's rung below the
  custom-view package tables.
  The describe resource leads with it, and it belongs to no record type and no
  node.

Every other boundary below is unchanged.

Only the Engine references NCalc. The Engine withholds the NCalc compile and build
assets from every consumer. Thus an expression can reach NCalc only through the
typed adapter in `Nendo.Engine/Behaviour/`. If a file holds no calculations, the
host never loads NCalc.

If a file carries a trigger, nobody can edit the file until this device approves
that exact behaviour. The host checks the approval again at the commit boundary.
Approvals are device state under the per-user root, and never go inside a `.nendo`
file. Thus a file can never carry its own permission, and a copy always asks
again. The Engine consumes a narrow authority interface and never learns where the
host keeps approvals.

Studio and custom surfaces both show calculated fields. The approval route is in
File status. The real-host journey drives all of this through the real
WinUI/WebView2 host.
[calculations-and-actions.md](contracts/calculations-and-actions.md) records the
evidence for each ADR obligation. Production retains coordinator-owned atomic
writes, exact proposal replay, and permanent Studio/recovery access.

```text
Nendo.Workbench  --closed typed bridge-->  Nendo.Desktop  -->  Nendo.Engine
   (TypeScript)                              (WinUI 3)            |
      ^                                                           +--> Nendo.LocalMcp
      |  window.nendo: one MessagePort per view, a closed method table
custom-view frames (an origin, and a renderer, per package per file)
```

| Project | Role | Size |
| --- | --- | --- |
| `src/Nendo.Engine` | Storage, typed operations, revisions, proposals, the semantic compiler. The only code that opens SQLite. | ~26.6k lines |
| `src/Nendo.Desktop` | Thin WinUI 3 host: file lifecycle, native dialogs, recovery, window and appearance policy, the notification area and Windows notifications, the Workbench bridge, and serving custom views from the open file. | ~8.7k lines |
| `src/Nendo.Workbench` | Local web UI in a WebView2: Studio, custom surfaces, the custom-view frames and their broker, Help (how-to guides, how Nendo works, and an agent reference that the production gate ties to the MCP surface). Vite builds it and the view API, and the host bundles both. | ~17.7k lines of TypeScript |
| `src/Nendo.LocalMcp` | MCP adapter over the same application services. Not an authority model. | ~7.9k lines |

The sizes are `wc -l` counts of the source files on 2026-09-25.

A gate enforces the dependency arrows. `Test-Production.ps1` fails the build if
`Microsoft.Data.Sqlite`, a SQLite connection type or `SQLitePCL` appears anywhere
in Desktop or LocalMcp. It also fails the build if any project under `src/` or
`tests/` references `prototypes/`, if `src/Nendo.ExtensionHost` comes back, if the
Desktop registers a catch-all `"*"` resource filter, or if a package source under
`extensions/` names `chrome.webview`.

No UI or MCP adapter receives SQL, a SQLite handle, physical identifiers, the
database path, arbitrary filesystem/network/process capability, or a generic
host invocation. Nor does a custom view: it reaches the file only through the
broker's closed method table. See
[ADR-0005](decisions/0005-host-application-services-and-write-coordinator.md)
and [ADR-0017](decisions/0017-production-composition-and-build-layout.md).

## The file

At rest, the file is one SQLite file with the extension `.nendo`, the application
ID `0x4E454E44` and the identifier `nendo.sqlite.application`. Journals, proposal
clones and backups are host-owned operational derivatives. They are never
user-managed artefacts.

Storage uses rollback DELETE with `synchronous=FULL` and a 2,000 ms busy timeout.
In measurements, WAL had materially better long-read and read-throughput
behaviour. It also exceeded the allowed writer-tail regression, so the project did
not select it
([ADR-0011](decisions/0011-local-sqlite-journal-and-copy-discipline.md)).

A file records the `minimumHostVersion` that it needs. The constants are in
`src/Nendo.Engine/NendoFormat.cs`. They step with each capability that changes
what a file can contain. `1.11.0` is for composable surfaces. After it, each
version adds one capability, usually a widened semantic shape. The highest version
is `1.34.0`, for a custom view defined by rules that earlier hosts refused (ADR-0013,
2026-09-25). `1.33.0` is for custom-view packages carried in the file, `1.32.0` a
custom view on a record page (`extensionRecordPanel`), `1.31.0` a custom view of one
record type as typed columns (`extensionRecordsSurface`), `1.30.0` a view at
protocol 2 and `1.29.0` a custom graph (`extensionGraphSurface`). A view that the
earlier rules accept keeps its earlier rung.

`src/Nendo.Engine/SemanticCapability.cs` computes from its shape which of these
versions a stored definition needs. It computes this over the tree that a mutation
leaves, not over the operations that the mutation submitted. Contract version 3
covers both a plain form and a tabbed page with two boards, so the version on a
root cannot give the answer. Also, a move that relocates a node changes the answer
without setting any property.

The host only raises a recorded minimum, and never lowers it. An older host
refuses a newer file explicitly, and does not open it partially. Opening an older
file never upgrades or rewrites it.

Custom-view packages in the file are four protected tables on the layout ladder's
last rung: the packages, a content store, the files and view state. The Engine
creates them on the first extension write, never at file creation. A file that
never carries a package keeps its layout and the host version it states. The
content store is addressed by SHA-256. Each distinct content is stored once, a file
row names it, and replaced or removed content stays, so compensation restores the
exact bytes. Operation and history rows carry the hash, the size and the media
type, never the bytes. An ordinary open checks the tables' shape and bounds. An
explicit integrity verification also reads every stored content and compares it
with its hash. A view that is shown runs its package's code, which the host serves
from these tables through a content cache keyed by SHA-256. The
[custom-view contract](contracts/custom-views.md#packages-in-the-file) has the
operations, the bounds and the review.

**Cloud sync is unsupported.** Where practical, the host detects known
sync-managed paths (OneDrive, Dropbox, Google Drive) and shows a warning. The
project makes no sync-safety claim and has no live-provider evidence.

## Data model

User entities materialise as ordinary relational tables. Stable semantic IDs map
entities and fields to physical names, so a display name can change without
breaking bindings. The schema service is the only path to physical DDL and
protected metadata. The host detects external changes as drift. Drift produces a
normal, repairable-safe or read-only open, never a guessed repair
([ADR-0003](decisions/0003-relational-user-data-and-protected-metadata.md)).

The scalar storage kinds are `text`, `integer`, `decimal`, `boolean`, `date`,
`datetime`, `uuid` and `reference`. Presentation and constraints refine these
kinds. Long text, single choice, email, URL and Markdown are all semantics over
`text`. Multi-choice is a relationship, and it is out of scope.

Numeric exactness is a contract. `decimal` is the .NET decimal domain stored as
exact TEXT. No numeric value passes through a JavaScript number anywhere in the
Workbench transport or edit path. See [contracts/scalars.md](contracts/scalars.md).

## Two lanes

The mutation model divides changes by what they affect. A single global revision
would make every agent proposal stale after any unrelated cell edit.

**Data lane**: record create/update/delete, bounded paste and import. Each change
is a direct validated transaction against the active file, with optimistic
record-version checks and idempotency keys. Each accepted transaction makes one
attributable revision.

**Application lane**: schema, semantic UI, constraints and declarative commands.
Agent work occurs in a proposal clone. Validation and semantic diff occur before
promotion. Acceptance is an explicit host-owned action.

A bootstrap proposal may carry schema, initial records and surfaces together.
Ordinary record entry never incurs the clone-and-preview cost.

### Revision lineages

- `definition_revision` — schema, UI, commands, constraints, settings
- `data_revision` — record state
- `change_sequence` — monotonic audit ordering across both
- per-record versions — optimistic concurrency for touched records

A proposal is stale if its required definition revision moved. It is also stale
if a record that it reads or transforms no longer matches its captured version.
An edit to an unrelated record does not invalidate a UI-only proposal
([ADR-0006](decisions/0006-split-revisions-audit-and-compensation.md)).

### Typed operations

Twenty-six operation types are the primitive: every type that a revision can
record, including the two that only host services create. Semantic diff, undo
evidence and replay all derive from the same operation stream.

```text
schema.createEntity      data.createRecord              ui.addNode
schema.addField          data.setField                  ui.setProperty
schema.renameEntity      data.deleteRecord              ui.moveNode
schema.renameField       data.restoreDeletedRecord *    ui.removeNode
schema.setFieldRequired  data.backfillRetiredField
schema.setRetired        data.convertLegacyReference    behaviour.setDefinition
schema.setChoiceMetadata identity.transition *          behaviour.removeDefinition
schema.configureReference                               application.setPurpose

extension.setPackage     extension.removeFile
extension.putFile        extension.removePackage
```

`*` marks a native-only operation. The other twenty-four are the closed union that
the canonical change-set parser accepts and an MCP client may author (see
`NendoAuthoringOperations.cs`). Whole-definition
convenience APIs must expand into typed operations before the host records, diffs
or promotes anything.

Every operation declares a reversibility class: `reversible`,
`reversible-with-retained-state` or `irreversible-declared`. A lossy conversion is
never labelled reversible only because a backup exists. There is no universal
undo. Compensation applies a proven inverse as a *new* revision and never rewinds
history.

## Proposal lifecycle

```text
Draft → Validating → Invalid | Previewable
                   → Rejected | Stale | Applying
                   → Active | Failed
```

Compensation is not a proposal state. Where the accepted operations support it,
compensation applies their inverse as a new revision.

A proposal binds application and instance identity, required definition revision,
touched record versions, canonical operations, validation evidence and the
semantic diff.

**Promotion never replaces the active file with the clone.** The host checks every
precondition. Then it replays the exact validated operations against the active
file. Preview and promotion must use the same interpreter and validation version
([ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md)).

Below the Unattended access level, there is no MCP accept or promote tool, and
acceptance is native-owned. The Workbench review calls `PromoteProposalAsync` with
the reviewed digest. The write gate verifies that digest before replay. At
Unattended, `nendo.change_set.accept` calls the same service with the same digest
(see [Agent surface](#agent-surface)).

## Semantic surfaces

Stored surfaces follow a strict versioned contract
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md)). **Contract
version 3 is the only shape this host compiles.** It is an ordered composable node
tree that one vocabulary table governs. It covers `recordForm`, `recordList`,
`boardSurface`, `gallerySurface`, `calendarSurface`, `timelineSurface`,
`detailSurface`, `overviewSurface`, `recordCommand`, `section`, `tabGroup`,
`relatedList`, `fieldBinding`, `recentList`, `filterClause`, `commandStep`, a
bounded `summaryTile` and the three tiles that draw a number: `breakdownChart`,
`progressTile` and `rangeTile`. It also covers `matrixSurface`, `rankedList`,
`trendChart` and `activityGrid` (see [Studio and safe mode](#studio-and-safe-mode)),
and the three custom-view kinds: the `extensionGraphSurface` and
`extensionRecordsSurface` roots, and the `extensionRecordPanel` on a record page.

`relatedList` is the one kind that does something the vocabulary does not
describe. It adds a record of the related type with the reference back already
filled in. It also opens the row that the person clicks (2026-09-18 amendment).
The file stores nothing for either action, and no rung moves. The node already
names the target type and the field that points back, and the compiler already
proved them. Thus an author has nothing more to specify, and every file built
before the amendment already has the actions.

`overviewSurface` is the one root that belongs to the file and not to a record
type (2026-09-14 amendment, S4). The compiler groups every other root by its
`entityId` and builds one `NendoApplicationPlan` for each group. The compiler
separates the overview before that grouping. The overview arrives as its own plan
on the compile result, and it carries the entity plans that its tiles name. An
entity plan for the overview would need an invented entity that nothing stores.
Every consumer would then need to know which plan was the invented one.

The 2026-09-12 amendment widened that vocabulary within version 3:

- eight `recordList`, `boardSurface`, `calendarSurface` and `recordCommand` roots
  for each record type, which Use selects by stable ID and not by kind;
- `summaryTile` on a list or board, with a closed `surface`/`group` scope;
- `tabGroup`, which names record sections as tabs;
- a Date-field month calendar with its own undated view.

A flat kind table cannot express some rules: which parent admits a property, how a
bounded query composes against the eight-filter ceiling, and whether a tab group
already encloses a node. This information moves down the compiler's recursion as
`SurfaceContext`. [The semantic surfaces contract](contracts/semantic-surfaces.md)
gives the rules and the diagnostics.

The project removed contract versions 1 and 2 on 2026-09-12, before the format had
users. There is one compile path, one plan shape and one digest projection. If a
stored root declares version 1 or 2, `NUI003` refuses it and the host suppresses
every custom plan. Studio, the data and recovery are not affected. Board card
fields come from ordered `fieldBinding` children. The parallel `cardFieldIds`
property no longer exists.

`src/Nendo.Engine/SemanticVocabulary.cs` holds a single table. The compiler
validates against this table, and the host generates the published vocabulary
description from it. Thus the host can never tell a client about a kind that the
host will not accept. The host serves the table as `nendo://application/vocabulary`,
so an authoring client reads the contract and does not probe for it.

Unknown kinds, unknown properties, illegal parenting and mixed contract versions
all fail closed with `NUIxxx` diagnostics that carry `semanticId` and
`propertyPath`. Any error suppresses every custom plan, and the host does not
render a partial application. With zero custom nodes, the permanent Studio
remains.

`summaryTile` computes exact `count`, `sum`, `min` and `max` over an Integer or
Decimal field. The host folds these values over stored lexemes. `rangeTile` states
the `min` and `max` of one field. It is the one place where either tile reads a
**Date**. The host chooses the extremes of a set of civil dates by ordinal
comparison over the fixed-width ISO form. This comparison needs no arithmetic, and
so it needs no rounding rule.

The safe-mode fold also answers for a date. Otherwise an aggregate would be exact
in SQLite and *Unavailable* in safe mode, which gives two answers to one question.
The host still refuses a sum over a Date, and the refusal names it. The host also
refuses `avg`, and the refusal names it. The host publishes `avg` with its reason:
the mean of exact decimals is not generally an exact decimal.

On a list or board, a tile covers the whole filtered set, not the loaded page. The
renderer labels the tile to show this. The host accepts `scope` group only on a
direct board child. That scope addresses a column by its stored choice ID, and the
ungrouped column by `isNull`.

## The window, and what outlives it

When the person closes the window, the host hides it into the notification area.
The process stays resident with its file open and its MCP host listening. The tray
menu contains the real exit. This behaviour is the 2026-09-15 amendment to
[ADR-0002](decisions/0002-containing-desktop-architecture-and-process-model.md).

Below the Unattended access level, an agent cannot do two things for itself:
accept a proposal and consent to automatic actions. These two actions belong to
the person. Before the amendment,
the person had to keep a window open to receive the request.

The close behaviour is device state (`shell.json`, beside the appearance and grant
stores). Its default is the notification area, and the person toggles it from the
tray menu. The process owner pins it with `NENDO_DESKTOP_CLOSE_ACTION`. Every
scripted window lane sets it to `exit`, because no lane can click a tray menu.
There is one icon for each window.

Four conditions raise a Windows notification, and only while the window is hidden
or minimised:

- a validated proposal is waiting;
- a file's automatic actions need consent;
- the open file stopped being writable;
- the workspace failed.

The activation argument of a notification carries a view name and nothing else.
The text names the open file, but it carries no path, no digest and no proposal
id. Notifications **route; they do not grant**. A click on a notification
opens the page where the person answers. No notification carries the answer,
because promotion verifies the reviewed digest, and a grant binds an exact digest,
revision and capability set. `Test-Production.ps1` keeps the notification types
out of the MCP adapter. `DesktopNotificationContentTests` asserts that no payload
carries an approve or promote argument.

## What Nendo is to Windows

Setup writes five items into the per-user class store, and one shortcut:

- A `.nendo` file has its own icon, and a double-click on it opens Nendo.
- *New > Nendo application* in Explorer runs `Nendo.Desktop.exe -new "%1"`.
  Explorer picks the name and Nendo makes a real empty file. Thus the project does
  not ship a template and keep it in step with what *New file* already produces.
- `OpenWithProgids` puts Nendo in *Open with*.
- An `Applications\Nendo.Desktop.exe` key lets *Open with* reach Nendo also for a
  file whose extension another program owns.
- An `AppUserModelId` key carries the display name and icon that the notification
  centre reads.

The `AppUserModelId` key gives the application's identity to the shell. Three
places must agree on it:

- `DesktopShellIdentity` sets it on the process in the `App` constructor, before
  the first window. If a window is created under one identity and renamed later,
  the application gets two taskbar buttons.
- `DesktopShellIdentity` sets it again on the window itself. This is a second
  protection against the Windows App SDK notification registration, which can
  rename the process later. It is also the only way to read the identity back.
- Setup stamps the same string onto the Start Menu shortcut as
  `System.AppUserModel.ID`. Windows pins a shortcut without it, but the pinned copy
  then groups separately from the running window. The result is two buttons for
  one application, with the Jump List on the wrong one.

`Test-Repository.ps1` checks that the C# constant and the setup script still
contain the same string. No other check can see both files, and the failure is
silent.

`Invoke-NendoSetup.ps1` writes the Start Menu shortcut, and the NSIS script does
not. The reason is the same as for the association: NSIS cannot set a shell
property, and the setup script is the part that a lane can run.

The taskbar button carries the state that the window shows but that nobody can
see:

- a badge when the open file is waiting on approval or recovery;
- a lock when the file is read-only;
- indeterminate progress while a file action runs.

One `DesktopShellBadge` decides the state, and the notification-area tooltip reads
the same one. Thus the two cannot disagree. When the open file changes, the host
rebuilds the button's Recent list from `DesktopFileHistory`. It honours the
destinations that the person removed, because re-adding one makes the whole
commit fail.

If a person drags a `.nendo` file onto the window or onto the taskbar button, the
file opens by the same route as *Open file*. The page sees the drag and draws the
hint. It then gives the host the shell's own file object through
`postMessageWithAdditionalObjects`. The host asks Windows for the path. The page
never names a path, so a tampered page can at most ask about a file that somebody
physically dropped.

To route a click, the host must send the first message. Bridge protocol version 7
adds this: an unsolicited `{protocolVersion, event, payload}` message that carries
a route name. The message has no `requestId`. Thus a renderer at versions 2–6
drops it, as it drops any other message that it did not request.

**Agent work is now visible from every screen.** The MCP host brackets every tool
and resource call and sends `(busy, client, what)` to the shell. The shell
forwards it as the third unsolicited event. The status bar draws a pill after the
same 700 ms that the busy bar waits. The busy bar names the cause: *Claude Code is
writing to this file…* and not *Still working…*. A request in the queue behind an
agent's write is not slow; it is waiting.

The gated lease read was part of the problem. It took the same semaphore that the
write held. Thus a query about who was editing waited for the edit, and it held
the Desktop's own gate while it waited. That read is now a gate-free peek.

**What this costs.** While a file is open with agent access on, any process on this
machine can connect at that level
([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)).
Before, closing the window ended this access. Now it does not. The tray menu shows
the live access mode and offers to turn it off. The tooltip names the open file
and shows when the file is waiting on approval. The first close on a device
explains where the window went. The project added no credential or peer check.

## Studio and safe mode

Every valid file opens with **Nendo Studio**. Studio is the permanent, host-owned
human workspace, and it covers Data, Structure, Surfaces, History and Health.
Studio is available when there are no user entities, no connected agent or no
custom surface. It is also available with an invalid definition, or with a file in
restricted safe mode. Application content cannot remove, replace or hide the route
back to Studio
([ADR-0015](decisions/0015-host-owned-database-studio-and-ag-grid-community.md)).

Some charts group over a civil date. A `trendChart` shows one number for each
month or week, and an `activityGrid` shows one count for each day. These are the
first groupings whose groups come from a resolved range and not from a field's
options. Thus the host makes every bucket before it reads. A period with no
records shows as empty, and the host does not leave it out. A range is a closed
word that the host resolves at read time. It is never a stored date. Minimum
host 1.25.0 ([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md),
2026-09-16).

A `matrixSurface` crosses two choice dimensions. A `rankedList` states the few
records at the top of one stored number. The grid is **one** grouped read, whatever
its size. The host makes every cell key from the cross product of the two option
sets before it reads a record. Thus an empty cell is still a cell, and each number
is exact over all that the surface covers. The cards in a cell come from the
surface's one loaded window, so a cell can state how many records it does not
show.

The cross product uses the same 366-group ceiling. The host refuses an excess when
it is authored and states it when it is read. A ranking adds one predicate of its
own to keep the records that have a number. Thus it carries seven authored
clauses, not eight. Minimum host 1.26.0
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-17).

A `boardSurface` also groups by a **bound Reference field**. Its columns are then
records of another record type, not a field's options. It is the first grouping in
the product whose members are not written in the definition and not computed from
a range. People make and remove these records while the board is open, so the
board reads them. Every active record of the target type is a column, in the order
of the reference's label, because a lane that nobody has used is also an answer.

A board draws at most `MaximumReferenceBoardColumns` (24) columns. Above that
bound it draws no columns, and it names the type, its count and the bound. This is
a read-time rule, because a definition cannot carry how many records a record type
holds. A drag between lanes writes the reference with the target's current
version, which the board already holds. Minimum host 1.27.0
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md), 2026-09-17).

**The reference-grouped board is the one capability the node tree cannot show.**
For this reason, `NendoSemanticCapability.RequiredHostVersion` takes the stored
fields in addition to the nodes. A board grouped by a reference and a board
grouped by a choice are the same kind, with the same property and the same
children. Only the storage kind of the grouping field makes them different. Every
other rung of the node tree is a shape. The recompute still occurs only when a
mutation touches UI nodes. This is sound because no conversion changes a choice
field into a reference field: the storage kind of a field never changes under a
board.

**A section can be folded away.** Every section on a record page or the front page
is a disclosure, and its heading is the control. A closed section reads none of
its content. The walkers that decide what a page is still waiting for stop at a
closed section (`fold-state.ts`, `overview-model.ts`, `plan-selection.ts`). The one
stored word is the initial state: `opens` on `section`. What the person does with
the section never reaches the file. It is kept for the device in the Workbench's
local storage under `nendo.sectionFolds.<applicationId>`, as the theme and the rail
are (and, since 2026-09-26, whether keyboard shortcuts are shown: `nendo.shortcuts`), so it
survives a reopen (2026-09-24). Minimum host 1.28.0, only for a file that
carries the property ([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md),
2026-09-20 and 2026-09-24).

The host tells the renderer when the open file changes. For every writer that it
serves, the coordinator raises `Committed` with the change sequence. The shell
forwards it as `fileChanged`, the second member of the closed unsolicited-event
set. The event carries that number and nothing else. It is only a signal. The
renderer reads again through the same bounded chase that the tiles use, at most
once a second and never while somebody holds the page. Thus a surface updates
itself, and the person does not need to leave it and return to it
([ADR-0002](decisions/0002-containing-desktop-architecture-and-process-model.md),
2026-09-17).

Open states are explicit: normal, read-only, recovery and rejected. Safe mode is a
permanent host capability. It is not a failure path added later
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)).

Before the host grants any capability, the open inspects the whole file. For this
reason, the file has a size bound of **256 MiB**. The project raised it from
64 MiB on 2026-09-16. The ADR-0012 amendment records this change with its measured
cost. A record that carries 1,306 bytes of text uses 3,554 bytes on disk, a
multiple of 2.72. Thus a file reaches the bound at approximately 75,500 such
records, and one cold open at that size takes about 6.6 seconds.

A separate bound of 100,000 rows applies to each audit and definition table.
`__nendo_operation` carries one row for each record write and one for each later
edit. Thus a file reaches that bound at approximately 100,000 writes, whatever
their size. The host also enforces both bounds at write. Before it stages a
mutation or a promotion, it refuses the write when the file has reached a write
ceiling: 32 MiB below the size bound, at 224 MiB, or 1,000 rows below the row
bound. The byte reserve covers the largest commit the product accepts, a change set
with 4 MiB of new custom-view package content
([ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md)). The
refusal states that nothing changed and that the file still opens. The host gives
no warning as a file approaches a ceiling
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md), 2026-09-17).

## Agent surface

MCP is an adapter over application services. It is not the authority model.

The transport is loopback, stateless Streamable HTTP with no credential. The
address `http://127.0.0.1:41763/mcp` is the whole client configuration. The host
serves both MCP eras: the `initialize` handshake on any version that the SDK
supports, and the 2026-07-28 `server/discover` path. Thus Claude Code and Codex
can both connect. Lease acquisition mints an opaque `applicationHandle` together
with the `leaseId`, and every owned operation requires both. Possession of the
handle governs ownership. Claimed client names and HTTP connection identity do
not govern it.

The MCP surface has sixteen resources and nineteen tools. Resources are reads and
need no lease. Tools are writes and need a lease. The exceptions are
`nendo.lease.status`, `nendo.data.get_receipt` and
`nendo.health.verify_integrity`: they read authority or file state, and they
neither hold nor grant authority. `Test-Production.ps1` asserts both surfaces by
name. Thus a new resource or tool fails the gate until somebody updates the
contract. Full map: [contracts/mcp-interface.md](contracts/mcp-interface.md).

Visible access modes, as the Agent page names them: *Off*, *Inspect*, *Edit data*,
*Shape app* and *Unattended*. The tray menu names the same levels *Off*,
*Read-only inspection*, *Data mutation*, *Application authoring* and *Unattended
authoring*.

**In the fifth mode, an agent decides for itself.** At Unattended, and at no lower
level, `nendo.change_set.accept` promotes a proposal that the same session
validated. It uses the same `PromoteProposalAsync` that the person's Accept button
calls, with the reviewed digest, so every staleness and digest check still
applies. The host also records this device's consent for the automatic actions
that the acceptance installs. It records the same consent once before it retries
a data write that was refused for lack of it. The mode gives up a real protection, and that is its
purpose: a shape change and an action can reach the active file when nobody has
read either. The mode is off by default, and the host confirms it before it takes
effect. It ends when the level is lowered or the file closes, and the host never
persists it
([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md),
2026-09-22).

**Bulk data crosses the same boundary as a single record.**
`nendo://application/entity/{entityId}/export` is a page of faithful Nendo CSV, in
the profile that the person's own Export writes. `nendo.data.import_records` takes
CSV text or typed JSON at *Edit data*. It commits the rows through the same
`CreateRecordsAsync` that a single create uses: fifty rows to a revision, and up to
five hundred rows in a call. Export is a resource and not a tool, so that Inspect
keeps an empty tool list. Neither export nor import carries a path, in either
direction.

The security boundary is this computer, at the owner's chosen access level. While
a file is open with access on, any process on the machine can connect, under any
account. Exact Host and Origin matching keeps out browser-origin requests and DNS
rebinding. The owner's controls are the access level (Off by default), lease
revocation, and the approval dialog for application changes. **It is not an
anti-malware boundary, and it is the wrong posture for a shared machine.**
([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md))

The local defaults suit single-user work:

- a fixed loopback port (41763). If it cannot use that port, the host falls back
  to an ephemeral port and reports it.
- an edit lease with no expiry, which ends on explicit release or owner revocation.

The person can change both in Agent → Connection. That page also shows the live
address and copies the registration command for Claude Code or Codex. Closing an
agent does not end a lease. Closing, switching, replacing or recovering the file
invalidates all authority. A healthy renderer-only restart preserves it.

There is no embedded agent, and the project did not adopt AG-UI
([ADR-0014](decisions/0014-drop-embedded-agent-mcp-is-the-agent-surface.md)).

## File lifecycle

Typed Duplicate, Fork, Backup and Restore have defined identity semantics. The host
classifies raw copies before any write
([ADR-0010](decisions/0010-file-identity-duplicate-fork-backup-and-restore.md)).
The host resolves an interrupted replacement explicitly and never repairs it
silently. There is no guessed migration and no identity repair.

## Product version

The whole tree has one version number, declared as `<Version>` in
`Directory.Build.props`. `NendoProduct.Version` reads it back from the assembly at
runtime. Everything that shows the version reads it from there:

- the Workbench status bar;
- the MCP `server/discover` handshake;
- the installer's `DisplayVersion`, which now carries the release. A `BuildId`
  beside it carries the payload identity.

A version change occurs in one place.

This is the application's version. It is not related to
`NendoFormat.CurrentHostVersion`. That constant states the file-format capability
that a `.nendo` file needs from the host that opens it. It changes only when the
format gains a capability.

## Where things live

This table gives the current locations, so that you do not need to search.

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
| Notification area | `Desktop/DesktopTrayIcon.cs`: one hidden top-level window, `Shell_NotifyIcon`, one popup menu |
| Notifications | `Desktop/DesktopNotifier.cs` (the OS side), `DesktopNotificationContent.cs` (the wording and routes, pure), `DesktopNotificationTrigger.cs` (transition, never condition) |
| Close behaviour | `Desktop/DesktopShellStore.cs` (device state), `DesktopCloseAction.cs` (the decision, pure), `MainWindow.xaml.cs` |
| Renderer entry point | `Workbench/src/main.ts`: the router and the frame. It gives `render` and `updateChrome` to `shell.ts`, so that a view never imports it back |
| One view per file | `Workbench/src/view-*.ts` (Use surfaces are hand-rolled DOM; AG Grid stays in `view-data.ts`, and `main.ts` registers its modules) |
| Renderer state | `Workbench/src/app-state.ts`: one `state` object and the caches. It imports no view, so nothing cycles through it |
| Markup | `Workbench/src/record-markup.ts` (the pieces), `page-markup.ts` (a record page), `surface-markup.ts` (the selected surface): pure string builders, under test |
| Reads and writes | `Workbench/src/reads.ts`, `panels.ts` (tiles and charts), `actions.ts` (the one write path and the coherent-snapshot refresh) |
| Host bridge | `Workbench/src/host.ts` (protocol version and which client), `host-types.ts`, `host-desktop.ts`, `host-preview.ts` |
| Stylesheet | `Workbench/src/styles.css`: an ordered `@import` list. The numbered slices in `styles/` are one cascade, not independent sheets |
| Plan-shape resolution | `Workbench/src/surface-model.ts`: resolves selectable surfaces, roots, fields and commands from the version 3 node tree |
| Read windows | `Workbench/src/record-window.ts`: the query snapshot that a window owns, its page requests and structured cache keys |
| Totals | `Workbench/src/summary-tiles.ts`: tile scopes and the exact read that each one composes |
| Calendars | `Workbench/src/calendar-model.ts`: civil-date arithmetic, the Monday-first month grid and month/undated queries |
| Timelines | `Workbench/src/timeline-model.ts`: civil-year bounds, month grouping, integer day arithmetic and spans cut at the year end. The calendar's page accumulator in `reads.ts` serves both |
| Ratings | `Workbench/src/rating.ts`: the dots, their accessible name and the radio control. `Engine/Storage/SqliteNendoStore.Scales.cs` stores the scale itself, two rungs below the last |
| View failures | `Desktop/DesktopViewFailureLog.cs`: the kind, how long the view was up, whether the window was out of sight and what Windows said about memory. Capped at 50 and switched from the tray. Device state, never in the file |
| Custom-view packages in the file | `Engine/Extensions/ExtensionPackageOperations.cs` (the four operations), `ExtensionPackageModel.cs` (the bounds, the path rules and the media types), `ExtensionPackageDiff.cs` (the review's line diff), `ExtensionArchive.cs` (reading a folder, a zip or a `.nendoview`, the import change set and the exported manifest). `Engine/Storage/SqliteNendoStore.ExtensionPackages.cs` stores them on the layout ladder's last rung. `Workbench/src/package-diff-markup.ts` draws the review's Code section |
| Custom-view definitions | `Engine/Extensions/ExtensionViewDefinition.cs` (the three kinds and their properties), `NendoSemanticCompiler.Extensions.cs` (`NUI450`, `NUI452`), `SemanticCapability.cs` (which rung a view needs, 1.29.0 to 1.34.0), `SemanticDiff.cs` (the review sentences and the line that code runs) |
| Custom views: the host | `Desktop/Extensions/ExtensionOrigins.cs` (an origin per package per file), `ExtensionAssetServer.cs` (answers every view origin from the open file), `DesktopSessionController.Extensions.cs` (what each origin serves, the switches, the content cache, import and removal proposals), `DesktopExtensionSettingsStore.cs` (`extension-settings.json`), `ExtensionWebViewPolicy.cs` (menus, DevTools, permissions, new windows, frame navigation), `WorkbenchProtocol.Extensions.cs` (the `extension.*` bridge methods), `ExtensionFrameDiagnostics.cs` (`diagnostics.frameProcesses`). `MainPage.xaml.cs` turns a view renderer's exit into `extensionFramesFailed` and holds Restart without custom views; `MainPage.Extensions.cs` holds the import and export pickers |
| Custom views: the Workbench | `Workbench/src/view-frames.ts` (mounts, lazy start, park and adopt, heartbeat, overlays, Stop and Reload), `view-frame-markup.ts` (placeholders, notices, overlays, the frame's attributes, the Studio panel's markup), `extension-broker.ts` (the closed method table and the caps), `extension-model.ts` (the context, records, schema and theme tokens a view is handed), `extension-ui.ts` (what a view may ask the Workbench to do), `view-packages.ts` (Studio → Surfaces → Custom views), `frame-guard.ts` (refuses to run framed) |
| The view API | `Workbench/src/extension-api/nendo-api.ts` (`window.nendo`) and `protocol.ts` (the messages, shapes and limits both ends share), built by `vite.api.config.ts` to `dist/_nendo/api.js` and served at `/_nendo/api.js` on every view origin |
| What the file is for | `Engine/Storage/SqliteNendoStore.Application.cs`: a singleton row one rung below the layout ladder's last, read onto the manifest. `nendo://application/describe` leads with it. `Workbench/src/file-actions.ts` shows it on its own page, from About this file in the File menu |
| Agent tools and allow-list | `LocalMcp/NendoAuthoringTools.cs`, `NendoAgentAuthoringService.cs`, `NendoAuthoringOperations.cs`; the other tools are in `NendoLeaseTools.cs`, `NendoDataTools.cs`, `NendoHealthTools.cs` and `NendoUnattendedTools.cs` |
| Resources | `LocalMcp/NendoMcpResources.cs`, `NendoResourceProjection.cs` |

## Running it

You must build the Workbench before the host, because the build bundles the
Workbench into the Desktop output:

```powershell
cd src/Nendo.Workbench; npm ci; npm run build; cd ../..
dotnet build Nendo.slnx
./artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe
```

The host runs on Windows only. It is WinUI 3 and needs the WebView2 Evergreen
runtime. The app opens with no file. Create a file from the File menu, and Studio
appears.

For UI work without the host, run `npm run dev` in `src/Nendo.Workbench`. It serves
the page at `127.0.0.1`. Append `?preview=1` to get the in-memory protocol double.
The preview is visual only and proves nothing about storage or the bridge.

## Building and verifying

```powershell
pwsh ./tools/Test-Repository.ps1      # fast: vendored skills, tracked files, binary assets, line endings, ADR structure, blackbox coverage, shell identity
pwsh ./tools/Test-Production.ps1      # full gate; includes the repository check
```

Do not run `Test-Production.ps1` twice. It already includes `Test-Repository.ps1`.
Use `-SkipRestore` only with unchanged dependencies.

**The product has no CI, by choice.** The gate above is the gate. It runs locally
in about a minute. On a solo project with no pull requests, a hosted copy of the
gate gives no benefit. Run the gate before you push. Add CI for the product when
there is a reason, for example a second contributor or a real release that is
near.

One GitHub Actions workflow exists: `.github/workflows/pages.yml`. It builds and
deploys the public website in `site/`
([ADR-0018](decisions/0018-public-website-and-deployment-lane.md)). It runs only on
a push to `main` that touches `site/`, `docs/assets/brand/`, the application icon or the
workflow itself, or when somebody starts it by hand. It does not restore,
build or test a .NET project, and it runs neither gate script. Thus it cannot pass
or fail on anything that the gate covers. `tools/Test-Site.ps1` is the local
equivalent, and the project keeps it out of `Test-Production.ps1`.

These native lanes exist outside the gate, because they drive a real Desktop window
and need a desktop session:

```powershell
pwsh ./tools/Review-OutcomeRuntime.ps1      # real file-action outcomes and recovery; -Executable for the published payload
pwsh ./tools/Review-NeutralityRuntime.ps1   # application-neutral surfaces through MCP
pwsh ./tools/Review-DesktopPerformance.ps1  # startup, edit, memory against the four datasets
pwsh ./tools/Review-ShellRuntime.ps1        # closing hides the window and keeps the file open
pwsh ./tools/Test-JourneyPilot.ps1 -Executable <Nendo.Desktop.exe>  # pilot and behaviour journeys, create and reopen
pwsh ./tools/Test-JourneyDrag.ps1  -Executable <Nendo.Desktop.exe>  # drag journey, create and reopen
```

`Test-NendoInstaller.ps1` runs one of the two journey lanes against the installed
copy.

`Review-ShellRuntime.ps1` covers the close behaviour, the shell identity of the
window and the Jump List that Windows stores. No script can enumerate the tray icon
of another process or observe a shell notification. Thus the icon, its menu, the
notifications and the taskbar drawing of the Jump List and the overlay badge stay
owner-reported. The lane prints
this limit together with its pass, so that nobody assumes more coverage.

If you add CI again, set `DOTNET_INSTALL_DIR` to a runner-local path. Then install
the SDK version from `global.json`. The `rollForward` policy of this repository is
`latestFeature`. Without that step, a runner's preinstalled SDK silently takes
priority over the pin. The Node floor is the `engines` range in
`src/Nendo.Workbench/package.json`. This document does not repeat the number,
because a repeated number caused the last drift. Package versions come from
`Directory.Packages.props`.

Packaging (Windows x64, unsigned, per-user install):

```powershell
pwsh ./tools/Publish-NendoPayload.ps1
pwsh ./tools/Build-NendoInstaller.ps1     -PilotRoot '<printed payload directory>'
pwsh ./tools/Test-NendoInstaller.ps1      -PilotRoot '<printed payload directory>'
pwsh ./tools/Test-NendoSetupIsolated.ps1  # install/upgrade/uninstall against a task-owned root
```

NSIS only extracts the payload to a temporary folder. `Invoke-NendoSetup.ps1` does
the install after the progress bar is full. It checks every file by hash, keeps the
installed version in `Nendo.previous` as one hard link per file, and moves the
extracted files into place (`-MovePayload`). No payload byte is written twice. Each
step appears in the installer's details list as it starts, and in
`%TEMP%\Nendo-Setup.log`.

You must install NSIS to build the installer. When you rebuild the app, rebuild the
installer in the same task. Prune old payloads only through
`Remove-NendoBuildPayload.ps1`, which verifies hashes first.

### What gets checked, and what doesn't

Two different lanes cover an installer build, and a third runs the custom-view
journey against what the first one installs. It is important which lane you mean.
`artifacts/installer/installer-status.json` records both lanes for the delivered
file.

| Lane | Covers | Runs |
| --- | --- | --- |
| `Test-NendoSetupIsolated.ps1` | The setup logic: install, in-place upgrade, obsolete owned file removal, unowned user file preservation, uninstall, and everything setup registers with Windows (the `.nendo` association, the *New* menu entry, the application identity and the Start Menu shortcut), against a task-owned root, class store and Start Menu folder | Always |
| `Test-NendoInstaller.ps1` | The NSIS wrapper: bootstrapper, payload extraction, HKCU uninstall registration, real `Uninstall.exe` | Only on a clean Windows user |
| `Test-ExtensionInstalledJourney.ps1` | The custom-view journey (`DesktopExtensionViewJourneyTests`) against the app as setup installs it: the published payload installed by `Invoke-NendoSetup.ps1` into a task-owned root, checked byte for byte against the manifest, then uninstalled. The journey drives the page and the view frames over the browser's debugging port, so it needs no pointer and no foreground | On request, after a publish |

The task-owned class store is a run key under a lane key of its own in HKCU
(`Software\Nendo-Isolated-Setup`, `Software\Nendo-Installed-Journey`, and
`Software\Nendo-Setup-Tests` for the fixture lane below). Each lane removes its
run key in a `finally` block, so a failed run removes it as well, and then
removes the lane key once no run is left under it. A failed run keeps its
files under `artifacts/` for diagnosis. It does not keep its registrations.

The second lane installs and then **uninstalls** from the real per-user location.
Thus it refuses to start when Nendo is installed. That refusal is a safety
interlock that protects your installation. It is not a failure, and it is not a
finding about the build. On a developer machine the lane never runs, so the NSIS
wrapper is normally unchecked. State this precisely. Do not call the installer
"unverified": that word reads as a defect, and a defect is not the meaning.

The setup logic has three fast tests over synthetic fixtures. They use no real
payload and no NSIS, and each takes seconds. Run them when you change
`Invoke-NendoSetup.ps1`:

```powershell
pwsh ./tools/Test-NendoSetup.ps1          # 16 cases: fresh install, upgrade, rollback,
                                          # locked files, corrupt extraction, path traversal,
                                          # moved payload and linked backup, and this
                                          # account's .nendo registration left untouched
pwsh ./tools/Test-NendoLegacyUpgrade.ps1  # upgrade over a legacy owned payload
pwsh ./tools/Test-NendoBuildPruning.ps1   # Remove-NendoBuildPayload safety
```

The agent-authoring gate builds a complete application from an empty file through
the MCP interface only. Then it reopens the file offline:

```powershell
pwsh ./tools/Test-AgentAuthoringGate.ps1 -Executable <Nendo.Desktop.exe>
```

The unattended gate does the same at the fifth access level. At that level, the
agent accepts its own proposal, and the host records the consent that its
automatic actions need. Nobody touches the window after the level is set. The gate
also measures what the person can see during the run: the status-bar indicator
names the client and the call, and goes away when the agent is quiet. The gate
reads the DOM to measure this, and does not look at a screenshot:

```powershell
pwsh ./tools/Test-UnattendedBuildGate.ps1 -Executable <Nendo.Desktop.exe>
```

The behaviour gate does the same for calculations and automatic actions. It then
checks what an agent still cannot do: run what it authored, reach this device's
consent, or make a surface sort by a calculated field:

```powershell
pwsh ./tools/Test-BehaviourAuthoringGate.ps1 -Executable <published Nendo.Desktop.exe>
```

The gate takes the definition body shapes from the wire and not from this
repository. Thus, if a published example stops working, the gate fails, and the
example does not mislead an agent. The gate writes what it observed beside its
assertions. It records whether an open window noticed the new rules without a
refresh. It also records that a grant binds the whole definition revision, so even
a change that alters no rule asks the owner again.

The three gates above were written by somebody who already knew where everything
was. Thus none of them can show whether a capable client could find it. The blackbox review
lane covers this. The project gives
[`docs/reviews/blackbox-prompt.md`](reviews/blackbox-prompt.md) to an agent that
has never seen this repository.
[`docs/reviews/README.md`](reviews/README.md) tells how to run a round and which
contract each phase reaches. It is a manual lane, because it needs a person at the
keyboard and a fresh reviewer. Thus it runs before a release and not in the gate.
The repository gate checks that the coverage table in `docs/reviews/README.md`
names every published contract, and that the prompt contains each phase that the
table names.
