# Architecture

This document describes the system as built. The [contracts](contracts/) hold the
behavioural detail; the [decision records](decisions/README.md) hold the reasoning
behind each boundary. If this document and the code disagree, the code is correct. Fix
this file.

## Composition

```text
Nendo.Workbench  --closed typed bridge-->  Nendo.Desktop  -->  Nendo.Engine
   (TypeScript)                              (WinUI 3)            |
      ^                                                           +--> Nendo.LocalMcp
      |  window.nendo: one MessagePort per view, a closed method table
custom-view frames (an origin, and a renderer, per package per file)
```

| Project | Role |
| --- | --- |
| `src/Nendo.Engine` | Storage, typed operations, revisions, proposals, the semantic compiler. The only code that opens SQLite. |
| `src/Nendo.Desktop` | Thin WinUI 3 host: file lifecycle, native dialogs, recovery, window and appearance policy, the notification area and Windows notifications, the Workbench bridge, serving custom views from the open file, and the launched agent's ACP client. |
| `src/Nendo.Workbench` | Local web UI in a WebView2: Studio, custom surfaces, the custom-view frames and their broker, Help (guides, how Nendo works, and an agent reference the production gate ties to the MCP surface). Vite builds it and the view API; the host bundles both. |
| `src/Nendo.LocalMcp` | MCP adapter over the same application services. Not an authority model. |

No UI or MCP adapter receives SQL, a SQLite handle, physical identifiers, the database
path, arbitrary filesystem/network/process capability, or a generic host invocation.
Nor does a custom view: it reaches the file only through the broker's closed method
table ([ADR-0005](decisions/0005-host-application-services-and-write-coordinator.md),
[ADR-0017](decisions/0017-production-composition-and-build-layout.md)).

`Test-Production.ps1` fails the build if `Microsoft.Data.Sqlite`, a SQLite connection
type or `SQLitePCL` appears in Desktop or LocalMcp; if any project under `src/` or
`tests/` references `prototypes/`; if `src/Nendo.ExtensionHost` exists; if the Desktop
registers a catch-all `"*"` resource filter; or if a package source under `extensions/`
names `chrome.webview`.

### Custom views

A custom view's code is a package the `.nendo` file carries, run inline in the
Workbench ([ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md),
[custom-view contract](contracts/custom-views.md),
[Authoring a custom view](custom-view-authoring.md)).

- A package arrives through a proposal, and a person reviews it as code. It can also be
  developed from a folder on this device.
- A view is a cross-origin frame in the Workbench's own WebView2. Each package in each
  file instance has its own origin under the reserved `.example` domain, so Chromium
  gives it a renderer process apart from the Workbench's, and a Duplicate's views get
  their own storage. The instance each application last opened before the instance ID
  entered the origin key keeps its old origin, recorded once in
  `view-origin-carry.json` (`ExtensionOriginCarry.cs`).
- The host answers every view origin from the open file through the browser's
  resource-request event, and serves the view API, `/_nendo/api.js`, from the installed
  Workbench.
- A view calls `window.nendo`. The broker checks each request against a closed method
  table and answers it through the Workbench's own typed bridge. The table holds reads,
  navigation, record writes and commands under the package's own name, proposals the
  person reviews, and the view's own state; never promotion, behaviour or file actions.
- A view can be a screen of the file (`extensionView`), listed beside the front page and
  able to be the screen the file opens on. The tile kind is not built
  ([roadmap](roadmap.md)).
- A view can declare controls that the Workbench draws in its toolbar and menus, lists in
  Ctrl K and runs the keys of. api.js hands Nendo's own keys back when pressed in a view.
- Device-local kill switches decide whether views run. A view's renderer ending stops
  that view alone. Only a failure of the Workbench's renderer or of the browser sends the
  app to recovery, whose panel can restart without custom views.

### Calculations and actions

[ADR-0008](decisions/0008-general-scripting-and-capability-isolation.md) accepts bounded
calculations and host-owned local actions: a protected definition table, a bounded
expression runtime over NCalc, calculated fields, and trigger expansion inside the
initiating write transaction
([calculations-and-actions contract](contracts/calculations-and-actions.md)).

- Only the Engine references NCalc, and it withholds NCalc's compile and build assets
  from every consumer, so an expression reaches NCalc only through the typed adapter in
  `Nendo.Engine/Behaviour/`. A file with no calculations never loads NCalc.
- If a file carries a trigger, nobody can edit it until this device approves that exact
  behaviour; the host checks again at the commit boundary. Approvals are device state
  under the per-user root, never in a `.nendo` file, so a file cannot carry its own
  permission and a copy asks again. The Engine consumes a narrow authority interface and
  never learns where approvals are kept. The approval route is in File status.
- A list, board, calendar or tile can filter and sort by a calculated field. The store
  reads every record the stored predicates leave, at most 10,000, calculates them, and
  gives the page's SQL, the count and each aggregate the passing records and their order
  as two functions of the record ID. A plain related count is the store's own
  `COUNT(*)`, without the related-row ceiling.

## The file

At rest a file is one SQLite file with the extension `.nendo`, the application ID
`0x4E454E44` and the identifier `nendo.sqlite.application`. Journals, proposal clones and
backups are host-owned operational derivatives, never user-managed artefacts.

Storage uses rollback DELETE with `synchronous=FULL` and a 2,000 ms busy timeout; WAL
exceeded the allowed writer-tail regression
([ADR-0011](decisions/0011-local-sqlite-journal-and-copy-discipline.md)). A rollback
journal a crashed writer left is played back by SQLite only when the file is opened
outside a synced folder, once plain reads show it could be the file's and SQLite reports
it hot, under the file's write lease and after keeping both files under names SQLite
does not pair; the kept copy is named until the person removes it. Any other journal is
refused untouched, with its reason
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)).

**Cloud sync is unsupported.** Where practical, the host detects known sync-managed paths
(OneDrive, Dropbox, Google Drive) and warns. The project makes no sync-safety claim.

### Host versions

A file records the `minimumHostVersion` that it needs. The constants are in
`src/Nendo.Engine/NendoFormat.cs`. They step with each capability that changes what a
file can contain. `1.11.0` is for composable surfaces. After it, each version adds one
capability, usually a widened semantic shape. The highest version is `1.55.0`, for a
file's own picture as its icon.

| Rung | Capability | Rung | Capability |
| --- | --- | --- | --- |
| 1.12 | `summaryTile` on a list or board | 1.34 | a view defined by rules earlier hosts refused |
| 1.13 | several `recordCommand` roots | 1.35 | a declared hierarchy |
| 1.14 | several `recordList`/`boardSurface` roots | 1.36 | `outlineSurface` |
| 1.15 | `tabGroup` | 1.37 | a unique field and its sequence |
| 1.16 | Date `calendarSurface` with an undated view | 1.38 | a file's own look (badge tone and letter) |
| 1.17 | behaviour definitions | 1.39 | folded history |
| 1.18 | a field or section a calculation shows or hides | 1.40 | filter or sort by a calculated field |
| 1.19 | choice `tone`, record-page header (`detailSurface`) | 1.41 | records kept in new files |
| 1.20 | `breakdownChart`, `progressTile` | 1.42 | `extensionView` |
| 1.21 | `timelineSurface` | 1.43 | a package of kind skill |
| 1.22 | `gallerySurface`, the rating scale | 1.44 | a text field shown as Markdown |
| 1.23 | `overviewSurface`, `recentList`, `rangeTile` | 1.45 | a link rule |
| 1.24 | what the file is for | 1.46 | a full-text index |
| 1.25 | `trendChart`, `activityGrid` | 1.47 | a create step's links, `IsEmpty`, a total over a calculation |
| 1.26 | `matrixSurface`, `rankedList` | 1.48 | `ui.removeProperty` |
| 1.27 | a board grouped by a Reference field | 1.49 | `ToText` |
| 1.28 | `opens` on a section | 1.50 | the three history indexes a fold adds |
| 1.29 | `extensionGraphSurface` | 1.51 | `schema.setReferenceLabel` |
| 1.30 | a view at protocol 2 | 1.52 | a media field or an embedded picture |
| 1.31 | `extensionRecordsSurface` | 1.53 | `AddDays`, a `thisWeek` or `thisMonth` filter |
| 1.32 | `extensionRecordPanel` | 1.54 | a tile, breakdown or ranking over a calculated number; a breakdown grouped by a reference |
| 1.33 | custom-view packages in the file | 1.55 | a file's own picture as its icon |

[semantic-surfaces.md](contracts/semantic-surfaces.md) places each rung as a node shape
or in its list of the rest. A view the earlier rules accept keeps its earlier rung.

`src/Nendo.Engine/SemanticCapability.cs` computes the required version from the shape of
the tree a mutation leaves, not from the operations submitted: version 3 covers both a
plain form and a tabbed page with two boards, and a move changes the answer without
setting any property. The host only raises a recorded minimum, never lowers it. An older
host refuses a newer file explicitly and never opens it partially. Opening an older file
never upgrades or rewrites it.

A file that product 1.0.0 opens normally opens normally in every later 1.x, with its
definitions and data intact; a 1.x host adds rungs and never drops one (ADR-0012).
`FormatPromiseTests` holds this against the frozen files in
`tests/Nendo.Engine.Tests/Fixtures/Format1/`.

### Protected tables on the layout ladder

Each optional capability that needs storage is a protected table on the layout ladder,
created by its first write and never at file creation, so a file that never uses it keeps
its layout and stated host version.

- **Custom-view packages**: four tables on the extension rung, after the purpose's (the
  packages, a content store, the files, view state). Content is addressed by SHA-256 and
  stored once; replaced or removed content stays, so compensation restores exact bytes.
  Operation and history rows carry hash, size and media type, never bytes. An ordinary
  open checks shape and bounds; an explicit integrity verification also hashes every
  content. The host serves a shown view's code through a content cache keyed by SHA-256
  ([contract](contracts/custom-views.md#packages-in-the-file)).
- **Skill packages** ([ADR-0024](decisions/0024-a-file-carries-its-own-agent-skill.md)):
  a `SKILL.md` and supporting files for an agent. Its kind is a row in
  `__nendo_extension_kind` (the skill rung, after the new-file rung); a package without a
  row is a view. Its required entry-point column holds `SKILL.md` and every read ignores
  it. Validation refuses a `SKILL.md` without the frontmatter that names it (`NPROP012`).
  MCP lists each in `skills/list` after its own skill and serves its files under
  `skill://{packageId}/`. The Desktop gives it no origin, so nothing serves it to a frame
  or writes in its name.
- **Help pages** ([ADR-0027](decisions/0027-a-file-carries-its-own-help.md)): a package's
  Markdown under `help/`, read with `help.readPages` and shown first in Help under *About
  this app* through the Workbench's escaping Markdown renderer.
- **Media** ([ADR-0031](decisions/0031-media-in-user-data.md),
  [contract](contracts/media.md)): the media rung, after search. `__nendo_media` holds
  metadata and `__nendo_media_content` the bytes, once per SHA-256, put by `media.put`
  with the bytes beside the operation and never in history. Every mutation ends by
  refusing a `media:` address the file does not hold. Opening skips the media content's
  pages and the content digest hashes only its keys, so pictures do not lengthen an open;
  the explicit integrity check hashes them.
- **Full-text search** ([ADR-0028](decisions/0028-full-text-search-in-the-file.md)): the
  search rung, on the link-rule rung. `__nendo_search_doc` maps each record and searched
  field to a row of the FTS5 table `__nendo_search`. `application.buildSearchIndex`
  creates it; `MaintainSearchIndexAsync` keeps it current at the end of every mutation in
  both choke points. It is derived: the content digest leaves it out, the layout
  signature skips the five FTS5 shadow tables (a test pins their DDL), and the per-table
  row ceiling skips it. A damaged index fails `PRAGMA integrity_check` at open. Ctrl K,
  Studio, `records.search` and MCP share the same search.
- **Look and icon**: the badge's tone and letter, stored only when chosen (defaults come
  from the application ID and file name); `__nendo_application_icon`, on the rung above
  media, names an embedded square PNG as the file's icon.
- **Purpose**: prose on the rung below the package tables. The describe resource leads
  with it; it belongs to no record type and no node.
- **Folded history**: `__nendo_history_fold` on the fold rung, after the look's.

## Studio record windows

Studio flat tables use AG Grid Community's Infinite Row Model through
`data.queryRecordWindow` and `NendoApplicationService.QueryRecordWindowAsync`, sharing the
cursor query's typed predicates, exact comparisons, calculated query limits and
deterministic ordering. A signed token binds file/session, complete query and revision.
Storage performs a bounded offset read (maximum 200 records); an optional stable-ID lookup
returns the record's position in that query. The Workbench requests 100 rows per block,
retains five blocks and discards obsolete generations
([query contract](contracts/queries.md)).

## Data model

User entities materialise as ordinary relational tables. Stable semantic IDs map entities
and fields to physical names, so a display name can change without breaking bindings. The
schema service is the only path to physical DDL and protected metadata. External changes
are detected as drift, which produces a normal, repairable-safe or read-only open, never
a guessed repair ([ADR-0003](decisions/0003-relational-user-data-and-protected-metadata.md)).

The scalar storage kinds are `text`, `integer`, `decimal`, `boolean`, `date`, `datetime`,
`uuid` and `reference`. Long text, single choice, email, URL, Markdown and media are
semantics over `text`. Multi-choice is a relationship, and out of scope. `decimal` is the
.NET decimal domain stored as exact TEXT; no numeric value passes through a JavaScript
number in the Workbench transport or edit path ([scalars contract](contracts/scalars.md)).

## Two lanes

Changes are divided by what they affect, so an unrelated cell edit does not make every
agent proposal stale.

- **Data lane**: record create/update/delete, bounded paste and import. Each change is a
  direct validated transaction against the active file, with optimistic record-version
  checks and idempotency keys, making one attributable revision.
- **Application lane**: schema, semantic UI, constraints and declarative commands. Agent
  work occurs in a proposal clone; validation and semantic diff occur before promotion;
  acceptance is an explicit host-owned action.

A bootstrap proposal may carry schema, initial records and surfaces together. Ordinary
record entry never incurs the clone-and-preview cost.

### Revision lineages

- `definition_revision` — schema, UI, commands, constraints, settings
- `data_revision` — record state
- `change_sequence` — monotonic audit ordering across both
- per-record versions — optimistic concurrency for touched records

A proposal is stale if its required definition revision moved, or if a record it reads or
transforms no longer matches its captured version. An edit to an unrelated record does not
invalidate a UI-only proposal
([ADR-0006](decisions/0006-split-revisions-audit-and-compensation.md)).

### Typed operations

Forty-five operation types are every type a revision can record. Semantic diff, undo
evidence and replay derive from the same operation stream.

```text
schema.createEntity         data.createRecord              ui.addNode
schema.addField             data.setField                  ui.setProperty
schema.renameEntity         data.deleteRecord              ui.moveNode
schema.renameField          data.restoreDeletedRecord *    ui.removeNode
schema.setFieldRequired     data.backfillRetiredField      ui.removeProperty
schema.setRetired           data.convertLegacyReference    behaviour.setDefinition
schema.setChoiceMetadata    data.setKeptInNewFiles         behaviour.removeDefinition
schema.configureReference   identity.transition *          application.setPurpose
schema.setReferenceLabel    media.put **                   application.setLook
schema.declareHierarchy                                    application.setIcon
schema.removeHierarchy                                     application.setNewFileLabel
schema.setFieldUnique                                      application.buildSearchIndex
schema.setFieldSequence     extension.setPackage           extension.removeFile
schema.setFieldPresentation extension.putFile              extension.removePackage
schema.setKeptInNewFiles    extension.setState *
schema.declareLinkRule
schema.removeLinkRule
schema.addChoice
schema.removeChoice *
```

`*` marks an operation only host services create: a restore from deletion history, an
identity transition, the undo of an added choice option, and a view's kept state
(`nendo.state`). `**` `media.put` is written by the media service
(`nendo.data.put_media`, the Workbench), never by a change set. The other forty are the
closed union the canonical change-set parser accepts and an MCP client may author
(`NendoAuthoringOperations.cs`). Whole-definition convenience APIs expand into typed
operations before the host records, diffs or promotes anything.

Every operation declares a reversibility class: `reversible`,
`reversibleWithRetainedState` or `irreversibleDeclared`. A lossy conversion is never
labelled reversible because a backup exists. There is no universal undo: compensation
applies a proven inverse as a *new* revision and never rewinds history.

- **Record changes** are compensated a revision at a time, in reverse order, up to 12,800
  operations ([ADR-0023](decisions/0023-a-view-undoes-its-own-revisions.md)): a field put
  back, a deleted record restored, a created or restored record deleted, each against the
  version the revision left (or, for a record whose later changes were all taken back,
  the version that left). A compensation can itself be compensated, which is how a view
  redoes an undo; `data.undoRecordWrites` lets a view do both for a batch its package
  wrote. A compensated create stays irreversible: its record ID stays reserved.
- **A definition revision** of one operation is compensated only while the definition
  stands as it left it. A screen edit (`ui.setProperty`, `ui.removeProperty`,
  `ui.addNode`, `ui.moveNode`) carries no expected revision, so its inverse runs only when
  the file's definition revision is the revision's own; going back over later edits
  could restore a binding a later revision retired. A definition compensation is
  compiled before it commits and refused if it would turn compiling screens into ones
  that do not.

## Proposal lifecycle

```text
Draft → Validating → Invalid | Previewable
                   → Rejected | Stale | Applying
                   → Active | Failed
```

Compensation is not a proposal state. A proposal binds application and instance
identity, required definition revision, touched record versions, canonical operations,
validation evidence and the semantic diff.

**Promotion never replaces the active file with the clone.** The host checks every
precondition, then replays the exact validated operations against the active file.
Preview and promotion use the same interpreter and validation version
([ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md)).

Below Unattended there is no MCP accept or promote tool; acceptance is native-owned. The
Workbench review calls `PromoteProposalAsync` with the reviewed digest, which the write
gate verifies before replay. At Unattended, `nendo.change_set.accept` calls the same
service with the same digest ([Agent surface](#agent-surface)).

## Semantic surfaces

Stored surfaces follow a strict versioned contract
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md),
[semantic surfaces contract](contracts/semantic-surfaces.md)). **Contract version 3 is the
only shape this host compiles**: an ordered composable node tree governed by one
vocabulary table. It covers `recordForm`, `recordList`, `boardSurface`, `gallerySurface`,
`calendarSurface`, `timelineSurface`, `detailSurface`, `overviewSurface`,
`recordCommand`, `section`, `tabGroup`, `relatedList`, `fieldBinding`, `recentList`,
`filterClause`, `commandStep`, `summaryTile`, `breakdownChart`, `progressTile`,
`rangeTile`, `matrixSurface`, `rankedList`, `trendChart`, `activityGrid`,
`outlineSurface`, and the custom-view kinds `extensionGraphSurface`,
`extensionRecordsSurface`, `extensionView` and `extensionRecordPanel`.

`src/Nendo.Engine/SemanticVocabulary.cs` holds that table. The compiler validates against
it and the host generates the published vocabulary from it, served as
`nendo://application/vocabulary`, so the host never advertises a kind it will not accept.
Unknown kinds, unknown properties, illegal parenting and mixed contract versions fail
closed with `NUIxxx` diagnostics carrying `semanticId` and `propertyPath`. A root at
version 1 or 2 is refused with `NUI003`. Any error suppresses every custom plan, and the
host never renders a partial application; Studio, the data and recovery are unaffected.
Rules a flat table cannot express (which parent admits a property, how a query composes
against the eight-filter ceiling, whether a tab group encloses a node) move down the
compiler's recursion as `SurfaceContext`.

- Up to eight `recordList`, `boardSurface`, `calendarSurface` and `recordCommand` roots
  per record type, selected in Use by stable ID. Board card fields are ordered
  `fieldBinding` children.
- `overviewSurface` and `extensionView` belong to the file. The compiler separates them
  before grouping every other root by `entityId` into one `NendoApplicationPlan` each.
  The overview is its own plan on the compile result, carrying the entity plans its tiles
  name; file views arrive as `Views`, compiled without children.
- `relatedList` adds a record of the related type with the reference back filled in, and
  opens the row clicked. The file stores nothing for either.
- `summaryTile` computes exact `count`, `sum`, `min` and `max` over Integer or Decimal,
  folded over stored lexemes. `rangeTile` states the `min` and `max` of one field and may
  read a **Date**, compared ordinally over the fixed-width ISO form; the safe-mode fold
  answers the same. A sum over a Date and `avg` are refused by name (the mean of exact
  decimals is not generally exact).
- On a list or board a tile covers the whole filtered set, not the loaded page, and is
  labelled so. `scope` group is accepted only on a direct board child and addresses a
  column by stored choice ID, the ungrouped column by `isNull`.

## The window, and what outlives it

Closing the window hides it into the notification area. The process stays resident with
its file open and its MCP host listening, so the person can still accept a proposal or
consent to automatic actions, which an agent below Unattended cannot do for itself. The
tray menu holds the real exit
([ADR-0002](decisions/0002-containing-desktop-architecture-and-process-model.md)). The
close behaviour is device state (`shell.json`), defaulting to the notification area and
toggled from the tray. `NENDO_DESKTOP_CLOSE_ACTION` pins it; every scripted window lane
sets it to `exit`. There is one icon per window.

Four conditions raise a Windows notification, only while the window is hidden or
minimised: a validated proposal is waiting; automatic actions need consent; the open file
stopped being writable; the workspace failed. The activation argument carries a view
name, the raising process's number, which of its file sessions raised it, a count, and
nothing else. The text names the open file, never a path, digest or proposal id.
Notifications **route; they do not grant**: a click opens the page where the person
answers, because promotion verifies the reviewed digest and a grant binds an exact
digest, revision and capability set. `Test-Production.ps1` keeps the notification types
out of the MCP adapter; `DesktopNotificationContentTests` asserts no payload carries an
approve or promote argument.

**Agent work is visible from every screen.** The MCP host brackets every tool and
resource call and sends `(busy, client, what)` to the shell, forwarded as an unsolicited
event. The status bar draws a pill after 700 ms, the busy bar's wait, and the busy bar
names the cause (*Claude Code is writing to this file…*). The lease-status read is a
gate-free peek, so asking who is editing never waits for the edit.

**What this costs.** While a file is open with agent access on, any process on this
machine can connect at that level, and closing the window does not end it
([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)). The tray
menu shows the access mode and offers to turn it off; the tooltip names the file and
shows when it waits on approval; the first close on a device explains where the window
went. There is no credential or peer check.

## What Nendo is to Windows

Setup writes five items into the per-user class store, and one shortcut:

- the `.nendo` icon and double-click to open;
- *New > Nendo application*, which runs `Nendo.Desktop.exe -new "%1"` to make a real
  empty file (no template ships);
- `OpenWithProgids`, for *Open with*;
- an `Applications\Nendo.Desktop.exe` key, so *Open with* reaches Nendo for an extension
  another program owns;
- an `AppUserModelId` key with the display name and icon the notification centre reads.

Three places must agree on the `AppUserModelId`: `DesktopShellIdentity` sets it on the
process in the `App` constructor, before the first window (a later rename gives two
taskbar buttons); it sets it again on the window, against the Windows App SDK
notification registration renaming the process, and as the only way to read it back; and
setup stamps it on the Start Menu shortcut as `System.AppUserModel.ID`, without which a
pinned copy groups apart from the running window. `Test-Repository.ps1` checks the C#
constant and the setup script hold the same string. `Invoke-NendoSetup.ps1`, not the NSIS
script, writes the shortcut, because NSIS cannot set a shell property.

The taskbar button shows a badge when the file waits on approval or recovery, a lock
when it is read-only, and indeterminate progress while a file action runs or once an
agent's work has lasted 700 ms. One `DesktopShellBadge` decides the state, and the tray
tooltip reads the same one. When the open file changes, the host rebuilds the Recent list
from `DesktopFileHistory`, honouring destinations the person removed (re-adding one fails
the whole commit).

A `.nendo` file dragged onto the window or the taskbar button opens by the *Open file*
route. The page draws the hint and hands the host the shell's own file object through
`postMessageWithAdditionalObjects`; the host asks Windows for the path. The page never
names a path. The WebView2 and the `WebHost` grid holding it set `AllowDrop`, without
which no drop from Windows arrives.

Bridge protocol version 7 is the only one the host serves. Unsolicited
`{protocolVersion, event, payload}` messages carry a route name and no `requestId`. A
request at any other version gets `unsupported-protocol`, answered at version 7, before
any file binding, read, write or file action runs.

### The title band is the title bar

The window draws no title bar of its own; the page's Mica-with-tabs band is the title bar
([Mica direction](design/mica-direction.md)). `MainWindow.TitleBar.cs` extends the page
into the title bar and asks for the tall title bar, 48 pixels. Over the navigation the
band carries the Nendo mark, the file's name and the File menu; over the work, the tab
strip. Under it the address row holds Back, Forward, the breadcrumb and the command box;
nothing else stands above a screen's content. Windows draws Minimise, Maximise and Close
at the band's right end and treats the rest as caption (drag, double-click, system menu,
snap layouts).

The ground is Mica: `MainWindow.xaml` sets a `MicaBackdrop`, `ShellGrid` in
`MainPage.xaml` is transparent, and the WebView2's `DefaultBackgroundColor` has alpha 0.
The page marks itself `data-backdrop="mica"` in the Desktop host and keeps its ground
transparent; in a browser it paints `--mica`.

`title-bar.ts` measures every control showing in the band and sends their boxes with
`window.setTitleBarControls` whenever one moves, appears or goes. The host hands them to
Windows as passthrough regions (`InputNonClientPointerSource`) in screen pixels and
answers with the bar's height and the width kept for Windows' buttons (144 pixels in the
tall bar), which the tab strip keeps free (`--title-bar-right`). `titleBarChanged`
carries the same answer when the display scale changes. While a menu or dialog is open
the page claims the whole bar up to Windows' buttons, so a press there closes the menu.
In a window at most 840 pixels wide and more than 600 tall, the navigation bar across the
top is the title bar, and there are no tabs.

Each tab is a trail of places (`workspace-tabs.ts`). The window draws from one trail,
`navigationTrail`; switching tabs saves it on the tab left, loads the other's, and
revisits its current place (`revisitCurrent` in `navigation-actions.ts`). Tabs belong to
the window, are never written to the file, and are cleared with the file.

A tab can move to a window of its own: dragged past the window's edge or more than 40
pixels below the strip, or by *Move tab to new window*. It leaves the strip without the
closed-tab listeners hearing it, so a launched agent keeps running. The page hands its
trail to `window.detachTab` as an opaque string; the host opens another `MainWindow` in
the same process (`MainWindow.TabWindows.cs`) at the pointer, with the source window's
restored size, and a `MainPage` on the same `DesktopSessionController`, whose Workbench
takes the trail once with `window.takeTab`. The drag listens on the window, because a
browser sends a held mouse's moves past the edge to the document.

The first window is the main window: it alone has the tray icon, the taskbar badge,
notifications, the Jump List and the file's saved place, and it owns and ends the
session. A tab window subscribes to the session's events (`fileChanged`,
`agentActivity`, `agentSessionChanged`, the extension events, `appearanceChanged`),
hides and shows with the main window, and closes with the process or when its file
session changes. Every exit goes through `MainWindow.ExitAsync`, which closes tab windows
first, since `Window.Close` raises no `AppWindow.Closing`. File actions that open, close or
replace the file answer `main-window-only` in a tab window (`DesktopTabWindowRules`,
`window-role.ts`). All windows of a file share the browser profile, and so the one save
journal slot for the file.

The recovery panel loads the Nendo mark when shown, not with the page; loading it first
at start brings the process down inside XAML.

`diagnostics.titleBar` and `diagnostics.resizeWindow` answer only under
`NENDO_NATIVE_DIAGNOSTICS=1`, and the extension-view journey measures the band with them.
Windows answers `WM_NCHITTEST` over a passed-through control as caption all the same, so
only a real pointer shows that a press there reaches the page.

### Several files at once

Each open file is its own process and main window (ADR-0002).

- **Each file reopens where its window was.** `DesktopWindowStore` keeps the device's last
  place in `window.json` and each file's in `window-files.json`, keyed by a digest of the
  file's location, capped at the 64 most recent. A launch naming a file opens on its
  place; otherwise on the device's last one.
- **Device state is shared safely.** `DesktopDeviceStateLock` is the named mutex that
  serialises writers of a shared device-state document, including the view-failure and
  agent-failure logs. Readers take no lock; `DesktopStateFile` replaces a document with
  the POSIX rename Windows offers, which a reader that shares delete does not block, and
  otherwise retries for up to half a second. Device settings are read again before each
  listener start and Agent page read, so a choice saved in one window reaches the others.
- **A file another window has open goes to that window.** `DesktopWindowHandoff` reads
  the owner's process from the write-owner sidecar beside the file and sends that
  process's notification-area window a `WM_COPYDATA` request (three-second timeout, after
  `AllowSetForegroundWindow`). The owner shows its window as the tray's *Open* does and
  answers 1; a second launch then exits without drawing. A launch that starts while the
  first is still opening finds no sidecar, is refused by the first's guard, and looks
  again for up to 750 ms. A refusal that names nobody goes straight to the read-only
  offer. When nothing answers (hung, elevated or gone), the open goes ahead and the
  refusal offers read-only, Duplicate and Fork. The recent lists keep a file whose
  sidecar names a live Nendo writing to it. A request names the window and at most one
  routable view; it carries no file and nothing to approve.
- **Each file has its own icon.** `DesktopFileIcon` draws the Nendo mark from the shipped
  icon's frames with a badge bottom left (Windows draws a status badge bottom right), in
  the file's tone with its letter from 24 pixels up (a dot below), the letter set in Segoe
  UI Semibold at four times size and scaled down, and keeps it by look under `icons/` in
  device state. The tones are the light theme's choice tones, which a test holds to
  `02-tokens.css`. A file with its own picture is drawn as that picture alone, read by
  `DesktopSessionController.ReadIconPictureAsync` and kept by SHA-256; an unreadable one
  falls back to the badge. The window icon, tray icon, a notification's `appLogoOverride`
  and the status bar carry it; `Review-ShellRuntime.ps1` reads it back through
  `WM_GETICON`. On About this file the page draws a picked picture onto a transparent
  256-pixel square (192 or 128 if the PNG would not fit one message), sends it with
  `look.embedIcon`, and proposes `application.setIcon`; a colour and a picture chosen
  together are two mutations of one proposal. `DesktopFileIconIndex` keeps the icon drawn
  for each file (64 newest) in `icons/files.json`, and the Jump List gives each Recent row
  that icon, or `DocumentIcon.ico`; a pinned row keeps its icon. Taskbar buttons group
  under one identity, so a grouped button shows one icon.
- **Each window's notifications are its own.** The notification group is
  `nendo-<process>`. Windows hands a click to whichever Nendo holds the activation, so a
  click carries `window=<process>`; a process that receives another's click forwards it
  with the same request and routes it itself only when that process has gone. The click
  also carries `generation=<n>`, the file session that raised it: a window that has since
  opened another file comes forward and goes to no view. A window clears its
  notifications when its file changes or it is activated.

## Studio and safe mode

Every valid file opens with **Nendo Studio**, the permanent host-owned workspace covering
Data, Structure, Screens, History and Health. It is available with no user entities, no
agent, no custom surface, an invalid definition, or a file in restricted safe mode.
Application content cannot remove, replace or hide the route back to Studio
([ADR-0015](decisions/0015-host-owned-database-studio-and-ag-grid-community.md),
[Studio contract](contracts/studio.md)). Open states are explicit: normal, read-only,
recovery and rejected. Safe mode is a permanent host capability
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)).

The [semantic surfaces contract](contracts/semantic-surfaces.md) has the read rules for
each surface. In brief:

- `trendChart` and `activityGrid` group over a range resolved at read time, never a
  stored date; the host makes every bucket before it reads, so empty periods show.
- A `matrixSurface` makes every cell from the cross product of two option sets before it
  reads, in **one** grouped read under the 366-group ceiling (refused when authored,
  stated when read). A `rankedList` adds one predicate of its own, so it carries seven
  authored clauses, not eight.
- A `boardSurface` grouped by a Reference field has the target type's active records as
  columns, in label order, at most `MaximumReferenceBoardColumns` (24); above that it
  draws none and names the bound. This is the one capability the node tree cannot show,
  so `NendoSemanticCapability.RequiredHostVersion` also reads the stored fields; a
  field's storage kind never changes under a board.
- Every section is a disclosure. A closed section reads nothing, and the walkers that
  decide what a page waits for stop at it (`fold-state.ts`, `overview-model.ts`,
  `plan-selection.ts`). Only the initial state, `opens`, is stored; what the person does
  stays on the device under `nendo.sectionFolds.<applicationId>`.
- For every writer, the coordinator raises `Committed` with the change sequence, which the
  shell forwards as `fileChanged`, carrying that number only. The renderer re-reads
  through the bounded chase, at most once a second and never while somebody holds the
  page.

### Size and row bounds

The open inspects the whole file before granting any capability, so a file is bounded at
**256 MiB**. A record carrying 1,306 bytes of text uses 3,554 bytes on disk, a multiple of
2.72, so a file reaches the bound at about 75,500 such records; a cold open at that size
takes about 6.6 seconds.

Each audit and definition table is bounded at 100,000 rows. `__nendo_operation` carries a
row for each record write and each later edit, so a file reaches that bound at about
100,000 writes, whatever their size.

Before it stages a mutation or a promotion, the host refuses a write once the file reaches
a write ceiling: 224 MiB (32 MiB below the size bound) or 1,000 rows below the row bound.
Because one transaction can exceed the reserve, storage also measures the expanded
transaction's pages, schema objects, rows per table and user records against the open
limits, generated operations included, before either write path commits. Crossing a limit
rolls the whole transaction back, and the refusal says nothing changed and the file still
opens (ADR-0012).

### Folding history

A person can fold older history into one checkpoint revision
([ADR-0021](decisions/0021-folding-old-history.md)). History shows how much of the row
bound is used and warns from 80%. The host backs the file up beside itself, then
replaces every revision older than the kept window (the last 1,000, or fewer when those
hold more than 25,000 operation rows) with a checkpoint carrying their counters and a
digest, and records the fold in `__nendo_history_fold`. Records, tombstones, later
revisions, counters and the change sequence do not change. A folded change cannot be
compensated or retried as the same write; its operations are only in the backup.

## Agent surface

MCP is an adapter over application services, not the authority model
([MCP contract](contracts/mcp-interface.md)).

The transport is loopback, stateless Streamable HTTP with no credential. The address,
`http://127.0.0.1:41763/mcp` for the first file on a device, is the whole client
configuration. The host serves the `initialize` handshake on any version the SDK supports
and the `2026-07-28` `server/discover` path. Lease acquisition mints an opaque
`applicationHandle` with the `leaseId`, and every owned operation requires both.
Possession of the handle governs ownership; client names and HTTP connection identity do
not.

Resources are reads and need no lease; tools are writes and need one. The exceptions read
authority or file state and neither hold nor grant it: `nendo.lease.status`,
`nendo.data.get_receipt`, `nendo.health.verify_integrity`, and `nendo.read.resource` and
`nendo.read.list`, which serve the resources as tools from Inspect. `Test-Production.ps1`
asserts both surfaces by name, so a new resource or tool fails the gate until the contract
is updated.

Access modes: *Off*, *Inspect*, *Edit data*, *Shape app* and *Unattended*.
`NendoAccessLevels` in LocalMcp holds the names for the MCP instructions, refusals, tray
and notifications; the Workbench carries the same five (`agentModeLabel` in `format.ts`).

**At Unattended an agent decides for itself.** At that level only,
`nendo.change_set.accept` promotes a proposal the same session validated, through the
same `PromoteProposalAsync` and reviewed digest as the person's Accept, so every staleness
and digest check applies. The host also records this device's consent for the automatic
actions the acceptance installs, and records it once before retrying a data write refused
for lack of it. The mode gives up a real protection on purpose. It is off by default and
confirmed before it takes effect; it ends when the level is lowered or the file closes.
The device remembers the level per file: the same file reopens at it, while a Duplicate,
a Fork or another file starts at Off (a copy made outside Nendo keeps the instance ID and
the level) ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)).

**Bulk data crosses the same boundary as one record.**
`nendo://application/entity/{entityId}/export` is a page of faithful Nendo CSV in the
person's Export profile. `nendo.data.import_records` takes CSV text or typed JSON at *Edit
data* and commits through the same `CreateRecordsAsync` as a single create: fifty rows to
a revision, up to five hundred in a call. Neither carries a path.

The security boundary is this computer, at the owner's chosen access level. While a file
is open with access on, any process on the machine can connect, under any account. Exact
Host and Origin matching keeps out browser-origin requests and DNS rebinding. The owner's
controls are the access level (Off by default), lease revocation, and the approval dialog
for application changes. **It is not an anti-malware boundary, and it is the wrong
posture for a shared machine.**

- Each file has a fixed loopback port, kept by `DesktopAgentPortStore` under its
  application ID: the first file 41763, each further file the next free port. If the port
  is unavailable, the host falls back to an ephemeral port and reports it.
- An edit lease has no expiry; it ends on explicit release or owner revocation.

The Agent page's Connect tab edits both (a port another file keeps is refused by that
file's name), shows the live address, and copies the registration command for Claude
Code or Codex under a server name made from the file (`nendo` for Nendo.nendo,
`nendo-bcm` for BCM.nendo). A controller built without a device-state root, as only a
test does, keeps its settings, grants and ports in a folder of its own. Closing an agent
does not end a lease. Closing, switching, replacing or recovering the file invalidates
all authority; a healthy renderer-only restart preserves it.

There is no embedded agent
([ADR-0014](decisions/0014-drop-embedded-agent-mcp-is-the-agent-surface.md)).

### Launched agents

The Agent page can launch the person's own agent program over ACP
([ADR-0030](decisions/0030-launch-the-persons-own-agent-over-acp.md),
[launched-agents contract](contracts/launched-agents.md)). The host is an ACP client
(`Desktop/Agents/`) with no model client and no credential.

- `DesktopAgentCatalog` knows Copilot CLI, Gemini CLI, the Claude Code and Codex ACP
  adapters, and OpenCode, found on the `PATH` Windows holds now (`AgentEnvironment.cs`),
  plus one command line of the person's; hidden agents and that command are kept in
  `agent-launch.json`, never the file. Launch is offered at Inspect and above. A missing
  or renamed npm package shows the commands to fix it, which the host never runs.
- `AgentProcess` starts the program in a new empty folder under `agent-sessions/` in
  device state, with the person's environment, inside a Job Object whose closing ends it
  and everything it started.
- `AgentConversation` speaks ACP version 1 on stdio: `initialize` declares no file-system
  or terminal capability, and `session/new` names one MCP server, this file's loopback
  address, as `http`. An agent that cannot connect over HTTP or speaks another version is
  refused by name.
- The Agent page has three tabs: Activity (the default), Launch and Connect. The chat tab
  merges message chunks, folds tool calls, thoughts and plans between messages into one
  line, says whether each tool went through Nendo, and redacts the application handle
  from everything the agent writes. The composer offers only options the agent offered
  (`AgentConversation.Options.cs`), its slash commands, and @ mentions of the file's own
  things sent as `nendo://` resources.
- The conversation reaches the tab through the `agentSession.*` bridge methods and the
  `agentSessionChanged` nudge, keyed by `conversationId`. The transcript lives in host
  memory, at most 1,000 entries.
- Turning access Off, closing, switching or replacing the file, a listener returning at
  another address, a handshake refusal, or closing the tab that owns the conversation
  ends the agent.

**What Nendo does not confine.** The program keeps every ability it has on this computer,
including its own shell and file tools. ACP lets an agent ask permission but does not make
it ask. Nendo gives it nothing beyond the MCP address at the person's level.

## File lifecycle

Typed Duplicate, Fork, Backup and Restore have defined identity semantics, and the host
classifies raw copies before any write
([ADR-0010](decisions/0010-file-identity-duplicate-fork-backup-and-restore.md)). An
interrupted replacement is resolved explicitly, never repaired silently. There is no
guessed migration and no identity repair.

A new file of the same application
([ADR-0022](decisions/0022-new-file-keeping-the-records-an-application-ships-with.md))
keeps the definition and only the records kept in new files: a record type's default
(`schema.setKeptInNewFiles`) or a record's mark (`data.setKeptInNewFiles`), on the
`newfile` layout rung, with the application's name for one
(`application.setNewFileLabel`). `NendoWriteCoordinator.NewFile.cs` stages a copy;
`SqliteNendoStore.NewFile.cs` removes what is left out with every tombstone and view
state, restarts sequences and folds every revision into one checkpoint; an identity
transition of kind New gives the copy a new instance ID. A kept record that points at a
left-out one refuses it. The source never changes.

## Product version

The tree has one version, `<Version>` in `Directory.Build.props`. `NendoProduct.Version`
reads it from the assembly; the status bar, the MCP `server/discover` handshake and the
installer's `DisplayVersion` all use it, with a `BuildId` beside `DisplayVersion` for the
payload identity. It is unrelated to `NendoFormat.CurrentHostVersion`, the file-format
capability a `.nendo` file needs, which changes only when the format gains a capability.

## Where things live

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
| Declared hierarchies | `Engine/HierarchyOperations.cs`, `HierarchyTreeWalk.cs`, `NendoApplicationService.Hierarchy.cs`, `NendoWriteCoordinator.Hierarchy.cs`, `Storage/SqliteNendoStore.Hierarchy*.cs` ([ADR-0019](decisions/0019-hierarchies-in-the-schema.md)) |
| Custom-view packages | `Engine/Extensions/ExtensionPackageOperations.cs`, `ExtensionPackageModel.cs` (bounds, paths, media types), `ExtensionPackageDiff.cs`, `ExtensionArchive.cs` (folder, zip, `.nendoview`); `Engine/Storage/SqliteNendoStore.ExtensionPackages.cs`; `Workbench/src/package-diff-markup.ts` |
| Custom-view definitions | `Engine/Extensions/ExtensionViewDefinition.cs`, `NendoSemanticCompiler.Extensions.cs` (`NUI450`, `NUI452` to `NUI454`), `SemanticCapability.cs`, `SemanticDiff.cs` |
| Purpose | `Engine/Storage/SqliteNendoStore.Application.cs`; shown by `Workbench/src/file-actions.ts` |
| Ratings scale | `Workbench/src/rating.ts`, `Engine/Storage/SqliteNendoStore.Scales.cs` |
| Bridge | `Desktop/DesktopShellContract.cs`, `WorkbenchProtocol*.cs` |
| Notification area | `Desktop/DesktopTrayIcon.cs` (one hidden window, `Shell_NotifyIcon`, one menu; it also hears Windows end the session, handled within a bound by `DesktopSessionEnd` in `DesktopWindowChrome.cs`) |
| Notifications | `Desktop/DesktopNotifier.cs` (OS side), `DesktopNotificationContent.cs` (wording and routes, pure), `DesktopNotificationTrigger.cs` (transition, never condition) |
| Close behaviour | `Desktop/DesktopShellStore.cs`, `DesktopCloseAction.cs` (pure), `MainWindow.xaml.cs` |
| Title bar | `Desktop/MainWindow.TitleBar.cs`, `MainPage.TitleBar.cs`, `WorkbenchProtocol.TitleBar.cs`; `Workbench/src/title-bar.ts`, `title-bar-model.ts` (pure), `styles/20-title-bar.css` |
| Shell and tabs | `Workbench/src/workspace-tabs.ts`, `rail-places.ts`, `type-icons.ts`, `styles/21-native.css`; `Desktop/MainPage.xaml` |
| Tab windows | `Desktop/MainWindow.TabWindows.cs`, `WorkbenchProtocol.TabWindows.cs` (`DesktopTabWindowRules`); `Workbench/src/window-role.ts` |
| File icons | `Desktop/DesktopFileIcon.cs` (`DesktopFileIcon`, `DesktopFileIconIndex`) |
| Downloads | `Desktop/Extensions/ExtensionWebViewPolicy.cs` (every download handled, no WebView2 panel), `MainPage.Downloads.cs`, `WorkbenchProtocol.Downloads.cs` (`downloads.show`) |
| View failures | `Desktop/DesktopViewFailureLog.cs` (device state, capped at 50, switched from the tray) |
| Custom views: host | `Desktop/Extensions/ExtensionOrigins.cs`, `ExtensionOriginCarry.cs`, `ExtensionAssetServer.cs`, `ExtensionWebViewPolicy.cs`, `ExtensionFrameDiagnostics.cs`, `DesktopExtensionSettingsStore.cs` (`extension-settings.json`), `DesktopSessionController.Extensions.cs`, `WorkbenchProtocol.Extensions.cs`; `MainPage.xaml.cs` (`extensionFramesFailed`, Restart without custom views), `MainPage.Extensions.cs` (pickers) |
| Custom views: Workbench | `Workbench/src/view-frames.ts`, `view-frame-markup.ts`, `extension-broker.ts` (method table and caps), `extension-model.ts`, `extension-ui.ts`, `view-packages.ts`, `frame-guard.ts`; view controls in `view-toolbar-model.ts`, `view-toolbar-markup.ts`, `view-toolbar.ts`, `view-menu.ts`, `place-pickers.ts` |
| The view API | `Workbench/src/extension-api/nendo-api.ts`, `protocol.ts`, built by `vite.api.config.ts` to `dist/_nendo/api.js` |
| Renderer | `Workbench/src/main.ts` (router and frame; hands `render` and `updateChrome` to `shell.ts`), `app-state.ts` (one `state`, imports no view), `view-*.ts` (one view per file; AG Grid only in `view-data.ts`) |
| Markup | `Workbench/src/record-markup.ts`, `page-markup.ts`, `surface-markup.ts`: pure string builders, under test |
| Reads and writes | `Workbench/src/reads.ts`, `panels.ts`, `actions.ts` (the one write path), `record-window.ts`, `summary-tiles.ts`, `surface-model.ts` |
| Surface models | `Workbench/src/calendar-model.ts`, `timeline-model.ts`, `outline-model.ts`, `outline-surface*.ts` |
| Host bridge (Workbench) | `Workbench/src/host.ts`, `host-types.ts`, `host-desktop.ts`, `host-preview.ts` |
| Stylesheet | `Workbench/src/styles.css`: an ordered `@import` list; the numbered `styles/` slices are one cascade |
| Launched agents | `Desktop/Agents/AcpConnection.cs`, `AgentConversation*.cs`, `AgentProcess.cs`, `DesktopLaunchedAgent.cs`, `DesktopAgentCatalog.cs`, `DesktopSessionController.LaunchedAgent.cs`, `WorkbenchProtocol.Agents.cs`; `Workbench/src/agent-chat-model.ts`, `view-agent-chat.ts`, `view-agent.ts`, `preview-agent-session.ts` |
| Agent tools | `LocalMcp/NendoAuthoringTools.cs`, `NendoAgentAuthoringService.cs`, `NendoAuthoringOperations.cs`, `NendoLeaseTools.cs`, `NendoDataTools.cs`, `NendoHealthTools.cs`, `NendoReadTools.cs`, `NendoUnattendedTools.cs` |
| Resources | `LocalMcp/NendoMcpResources.cs`, `NendoResourceProjection.cs` |

## Running it

Build the Workbench before the host, because the build bundles it into the Desktop
output:

```powershell
cd src/Nendo.Workbench; npm ci; npm run build; cd ../..
dotnet build Nendo.slnx
./artifacts/bin/Nendo.Desktop/debug_win-x64/Nendo.Desktop.exe
```

The host runs on Windows only (WinUI 3, WebView2 Evergreen runtime). It opens with no
file; create one from the File menu and Studio appears.

For UI work without the host, run `npm run dev` in `src/Nendo.Workbench` and append
`?preview=1` for the in-memory protocol double. The preview is visual only and proves
nothing about storage or the bridge.

The Workbench's WebView2 profile is under `%LOCALAPPDATA%\Nendo\WebView2`
(`DesktopBrowserProfile`) unless `WEBVIEW2_USER_DATA_FOLDER` is set; a Debug build uses
`WebView2-debug`, so a development host never shares a browser process or page storage
with the installed Nendo. Views keep unsaved drafts and settings in that page storage; a
file's data is never there.

## Building and verifying

```powershell
pwsh ./tools/Test-Repository.ps1      # fast: skills, manifests, tracked files, binary assets, line endings, ADRs, documents that state the code, MCP surface, shell identity, lane teardown
pwsh ./tools/Test-Production.ps1      # full gate; includes the repository check
```

`Test-Production.ps1` restores, builds and runs the .NET and Workbench suites, the
architecture checks in [Composition](#composition), and the repository check, writing its
progress to `artifacts/gate-progress.json`. It takes several minutes. Do not run it twice
for one change; use `-SkipRestore` only with unchanged dependencies. Which gate a change
needs, and when to rebuild the installer, is in
[AGENTS.md](../AGENTS.md#validation-and-handoff).

**The product has no CI, by choice.** If CI is added, set `DOTNET_INSTALL_DIR` to a
runner-local path and install the SDK from `global.json`: `rollForward` is
`latestFeature`, so a preinstalled SDK would otherwise win over the pin. The Node floor
is the `engines` range in `src/Nendo.Workbench/package.json`; package versions come from
`Directory.Packages.props`.

The one GitHub Actions workflow, `.github/workflows/pages.yml`, builds and deploys the
public website in `site/` ([ADR-0018](decisions/0018-public-website-and-deployment-lane.md))
on a push to `main` touching `site/`, `docs/assets/brand/`, the application icon or the
workflow, or by hand. It builds no .NET project and runs neither gate script.
`tools/Test-Site.ps1` is its local equivalent, outside `Test-Production.ps1`, and also
runs `site/scripts/*.test.mjs`.

### App lanes

Each view package under `extensions/` has its own lane, `tools/Review-<App>.ps1`, driving
`tools/Gate-<App>.mjs`. An app-only change needs that lane plus `Test-Repository.ps1`.
`Test-Production.ps1` runs every app lane except Garden's, which is run by hand.
`Review-WorkbenchShell.ps1` is the Workbench shell's lane, run against the Vite dev
server.

### Native lanes

These drive a real Desktop window, need a desktop session, and are outside the gate:

```powershell
pwsh ./tools/Review-OutcomeRuntime.ps1      # file-action outcomes and recovery; -Executable for the published payload
pwsh ./tools/Review-NeutralityRuntime.ps1   # application-neutral surfaces through MCP
pwsh ./tools/Review-DesktopPerformance.ps1  # startup, edit, memory against the four datasets
pwsh ./tools/Review-ShellRuntime.ps1        # close behaviour, second launch, shell identity, Jump List
pwsh ./tools/Test-JourneyPilot.ps1 -Executable <Nendo.Desktop.exe>   # pilot and behaviour journeys
pwsh ./tools/Test-JourneyDrag.ps1  -Executable <Nendo.Desktop.exe>   # drag journey
pwsh ./tools/Test-AgentAuthoringGate.ps1 -Executable <Nendo.Desktop.exe>    # an application built through MCP only, reopened offline
pwsh ./tools/Test-UnattendedBuildGate.ps1 -Executable <Nendo.Desktop.exe>   # the same at Unattended; the status-bar indicator measured from the DOM
pwsh ./tools/Test-BehaviourAuthoringGate.ps1 -Executable <published Nendo.Desktop.exe>  # calculations, actions, and what an agent still cannot do
```

Each lane runs its host on its own device-state root, MCP discovery folder and browser
profile under its evidence folder (`NENDO_DEVICE_STATE_ROOT`, honoured by every build,
and `WEBVIEW2_USER_DATA_FOLDER`), then checks the person's theme is unchanged and
`agent-ports.json` gained no port for a lane file. A host on its own device-state root
under the product identity writes neither the Jump List nor the notification
registration (`DesktopRuntimeConfiguration.WritesShellState`); a lane that pins
`NENDO_DESKTOP_APP_ID` writes both under its own identity. Lanes close their host through
`Stop-OwnedNendo` in `tools/Lane-NativeHost.ps1`, which stops a window that will not close
and reports it as a warning, keeping the original failure; `Test-Repository.ps1` tests
that teardown and refuses a lane that closes its host another way.

No script can enumerate another process's tray icon or observe a shell notification, so
the tray icon, its menu, notifications and the taskbar drawing of the Jump List and badge
are owner-reported; `Review-ShellRuntime.ps1` prints this limit with its pass. The
behaviour gate takes definition body shapes from the wire, so a published example that
stops working fails it.

### Packaging

Windows x64, unsigned, per-user install:

```powershell
pwsh ./tools/Publish-NendoPayload.ps1
pwsh ./tools/Build-NendoInstaller.ps1     -PilotRoot '<printed payload directory>'
dotnet build tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj -c Debug
pwsh ./tools/Test-NendoInstaller.ps1      -PilotRoot '<printed payload directory>'
pwsh ./tools/Test-NendoSetupIsolated.ps1  # install/upgrade/uninstall against a task-owned root
```

NSIS must be installed. `Test-NendoInstaller.ps1` seeds its journey file through
`artifacts/bin/Nendo.Engine.Tests/debug/Nendo.Engine.dll` and stops with *Build the Engine
tests first* until they are built. Prune old payloads only through
`Remove-NendoBuildPayload.ps1`, which verifies hashes first.

NSIS only extracts the payload to a temporary folder. `Invoke-NendoSetup.ps1` then checks
every file by hash, keeps the installed version in `Nendo.previous` as one hard link per
file, and moves the extracted files into place (`-MovePayload`), so no byte is written
twice. Each step shows in the installer's details list and in `%TEMP%\Nendo-Setup.log`,
which ends each run with its exit code.

- **Changed bytes refuse; a missing file does not.** An owned file whose bytes differ
  from the inventory is an edit setup will not overwrite or delete. A missing owned file
  is put back by rerunning the installer, and does not block an upgrade or uninstall.
- **Nothing is removed until everything can be.** Before an uninstall or backup rotation
  deletes anything, setup opens every owned file exclusively and refuses while one is in
  use, including a Nendo started from `Nendo.previous`. A removal that stops part-way
  counts files already gone as removed, so a rerun finishes it.
- **The backup is named only when complete.** It is built in `Nendo.previous.partial`
  and renamed at the end. A leftover partial or uninventoried backup is removed when every
  file matches the installed payload; otherwise an install refuses over it, and an
  uninstall leaves it and logs it.
- **Links are refused inside the trees setup writes, not above them.** A junction or
  symlink in the install folder, the backup or the payload refuses setup; one above them
  (a moved profile or AppData) does not, and a containment check keeps every owned path
  in its folder.
- **A running Nendo is reported where it is.** The installer checks before extracting and
  offers Retry, and the refusal says to choose *Exit Nendo* from the tray icon. A Nendo in
  another account's session does not block this account. Every failure box shows setup's
  own sentence.
- **The browser profile.** After an install or uninstall succeeds, setup moves a WebView2
  profile left beside the executable (install folder, `Nendo.previous`, or a retired
  pilot's folder) to `%LOCALAPPDATA%\Nendo\WebView2` if nothing is there, and deletes it
  only if a profile already exists there. A move that cannot happen is logged and retried
  next run. `DesktopBrowserProfileTests` pins the `-BrowserProfileRoot` default to the
  application's own.
- **The installer names its release** in its file properties and window title;
  `Build-NendoInstaller.ps1` reads it back from the built file.

`Build-NendoInstaller.ps1` first compiles and runs a silent probe of the installer's
macros from a non-ASCII folder (the log line lands at the end of an existing log, the
failure sentence reads back as written, a running executable reads as in use), compiles
with `/INPUTCHARSET UTF8`, and moves the previous build to `Nendo-Setup.previous.exe`;
`previous-installer-status.json` says which of its lanes ran.

#### NSIS without winget

On a managed machine `winget install NSIS.NSIS` can fail with *This operation is disabled
by Group Policy*, and NSIS's download host may not be approved. NSIS is also on NuGet as
`NSIS-Tool`, a third-party repackaging with a portable `makensis.exe`. The package carries
NuGet.org's repository signature (`dotnet nuget verify` shows it); `makensis.exe` itself is
not Authenticode-signed.

Restore it with a throwaway project in a scratch folder **outside the repository**, so
this repository's `Directory.Build.props` and central package management do not apply:

```xml
<!-- fetch.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageDownload Include="NSIS-Tool" Version="[3.13.0]" />
  </ItemGroup>
</Project>
```

```powershell
dotnet restore fetch.csproj --configfile nuget.config   # nuget.config names only your mirror
$env:Path = "$env:USERPROFILE\.nuget\packages\nsis-tool\3.13.0\tools;$env:Path"
makensis /VERSION
```

Nothing is installed: `makensis` is on `PATH` for that shell only, so package from the
same shell. `Build-NendoInstaller.ps1` records the `makensis /VERSION` it used in
`installer.json`.

#### When `Test-NendoInstaller.ps1` refuses over its own leftovers

The lane writes canary files into the real `Programs\Nendo` folder
(`user-retention-check.txt`, and `upgrade-user-retention.nendo` on an upgrade) to prove
uninstall keeps files it does not own. A run that stops after writing them leaves the
folder behind, and the interlock refuses the next run, naming them when the folder holds
nothing else. Delete those files and the empty folder, then rerun. The lane never deletes
them itself, because that folder is where a real installation lives.

### What gets checked, and what doesn't

`artifacts/installer/installer-status.json` records the first two lanes for the delivered
file.

| Lane | Covers | Runs |
| --- | --- | --- |
| `Test-NendoSetupIsolated.ps1` | The setup logic: install, in-place upgrade, obsolete owned file removal, unowned user file preservation, uninstall, and everything setup registers with Windows (association, *New* menu entry, application identity, Start Menu shortcut), against a task-owned root, class store and Start Menu folder | Always |
| `Test-NendoInstaller.ps1` | The NSIS wrapper: bootstrapper, payload extraction, HKCU uninstall registration, real `Uninstall.exe` | Only on a clean Windows user |
| `Test-ExtensionInstalledJourney.ps1` | The custom-view journey (`DesktopExtensionViewJourneyTests`) against the published payload installed by `Invoke-NendoSetup.ps1` into a task-owned root, checked byte for byte against the manifest, then uninstalled; driven over the browser's debugging port, so it needs no pointer or foreground | On request, after a publish |

The task-owned class store is a run key under a lane key in HKCU
(`Software\Nendo-Isolated-Setup`, `Software\Nendo-Installed-Journey`,
`Software\Nendo-Setup-Tests`). Each lane removes its run key in a `finally` block, then the
lane key once no run is left. A failed run keeps its files under `artifacts/`, not its
registrations.

`Test-NendoInstaller.ps1` installs and then **uninstalls** from the real per-user
location, so it refuses to start when Nendo is installed. That refusal is a safety
interlock protecting the installation, not a failure. On a developer machine the NSIS
wrapper is therefore unchecked; say exactly that, not "unverified".

The setup logic has three fast fixture tests; run them when you change
`Invoke-NendoSetup.ps1`:

```powershell
pwsh ./tools/Test-NendoSetup.ps1          # synthetic cases: install, upgrade, rollback, locks, corrupt extraction, traversal, links, interrupted backup, the old browser profile, registrations
pwsh ./tools/Test-NendoLegacyUpgrade.ps1  # retiring a legacy pilot install
pwsh ./tools/Test-NendoBuildPruning.ps1   # Remove-NendoBuildPayload safety
```

`Test-NendoLegacyUpgrade.ps1` compiles a small NSIS fixture that installs into
`Programs\NendoPilot\<id>` with an `Uninstall\NendoPilot-<id>` key and a Start Menu
shortcut, all named for the run, because RetirePilots only looks where a real pilot
lived. It aims setup at a task-owned root, removes all three in a `finally` block, and
fails if any is left.
