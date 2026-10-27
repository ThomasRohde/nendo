# ADR-0013: Custom views with code in the file

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The WebView2 spike in [`prototypes/iframe-views/FINDINGS.md`](../../prototypes/iframe-views/FINDINGS.md); the guards the [custom-view contract](../contracts/custom-views.md) names
- **Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007,
  ADR-0008, ADR-0009 and ADR-0012
- **Related design:** [custom-view contract](../contracts/custom-views.md),
  [authoring a custom view](../custom-view-authoring.md),
  [architecture](../architecture.md)

## Context

Nendo explores malleable software. A person or an agent should be able to write a view
with full powers, keep it inside the `.nendo` file, and see it run straight away: many
views at once, anywhere in the app, carried by any copy of the file.

A view in its own contained helper process (an AppContainer and a Job) paid for its own
browser engine, measured at 219 to 270 MiB per running view, so views could run only one
at a time. A device cache of packages pinned by digest meant an install and a consent on
every device for every rebuild, and a copy of the file did not carry the view.

Three host facts shape the design: the Workbench's WebView2 serves only its own origin
unless the host answers for another; a main-frame failure sends the app to recovery; and
Nendo's MCP endpoint refuses a request whose `Origin` is not its own, so a web page cannot
drive it.

## Decision

Custom views carry their code in the `.nendo` file. They run inline in the Workbench, as
cross-origin frames, with the full typed API. There is no install step, no consent and no
digest pin. A view that is shown runs. The [custom-view contract](../contracts/custom-views.md)
holds the method table, refusals, limits and review wording.

### Views run as frames in the Workbench

- A view is a cross-origin iframe in the Workbench's own WebView2. There is no helper
  process.
- Each package in each file instance has its own origin, `https://{slug}-{key}.example`:
  - `slug` is the package ID lowercased, every character other than a letter or digit
    changed to `-`, runs of `-` collapsed, cut to 40 characters and trimmed of `-` at both
    ends;
  - `key` is 10 hex characters of SHA-256(`applicationId\ninstanceId\npackageId`). A
    Duplicate keeps its original's application ID ([ADR-0010](0010-file-identity-duplicate-fork-backup-and-restore.md))
    but not its instance ID, so it never shares the original's view storage, drafts or
    unanswered writes. A byte-for-byte copy made outside Nendo keeps the instance ID and
    shares.
  - One instance per application keeps the key SHA-256(`applicationId\npackageId`): the
    one `views\origin-carry.json` in device state names, written once under its lock from
    the recent-file list, so views kept their storage when the instance joined the key.
    Settings and development links stay keyed by application ID.
- `.example` is reserved (RFC 2606), so no real site shares a view's origin, and the host
  answers every request to it.
- Each package site gets its own renderer process, never the Workbench's
  (`app.nendo.local`), and its own browser storage. Two frames of one package share one
  renderer.
- The frame's sandbox allows everything except top-level navigation
  (`allow-top-navigation*`).
- The Workbench cannot be framed: the host cancels any frame navigation to
  `app.nendo.local`, nested frames included, and the Workbench refuses to start when
  `window.top !== window`.
- A redraw does not reload a running view. The Workbench parks each live frame and adopts
  it into its new placeholder by mount key with `Element.moveBefore`, which keeps the
  document. Without `moveBefore` the frame reloads.
- A frame starts when its placeholder comes into view.
- In the browser host and an exported page, a view runs in an opaque-origin frame and loads
  its package from the page, under [ADR-0035](0035-an-app-exported-as-one-web-page.md).

### The host serves each view from the file

- The host answers `WebResourceRequested` for `https://*.example/*`, from every source
  kind, and checks the parsed host itself, because the filter also matches other
  addresses. It reads content with a typed Engine read off the UI thread, maps origins to
  packages from the last view read, and caches content by SHA-256, at most 64 MiB.
- The serving order is: views off → 403; `/_nendo/api.js`; a development folder link;
  the file's content; 404. `/` serves the package's entry point. `/_nendo/` is reserved
  on every view origin. Responses carry the stored media type, `no-store` and `nosniff`,
  and honour a single byte range for media.
- The Workbench's own content-security policy keeps its document local and allows only
  `frame-src https://*.example` beyond it.

### The code lives in the file (rung 1.33.0)

A package is protected definition metadata. The host creates its four tables on the first
extension write, never at file creation, as a rung of the layout ladder.

| Table | Holds |
| --- | --- |
| `__nendo_extension_package` | ID (3–80 characters), title, version, entry point, description |
| `__nendo_extension_blob` | Content as a BLOB of at most 4 MiB, keyed by its SHA-256. Each distinct content is stored once |
| `__nendo_extension_file` | Package, path, media type, and the SHA-256 of the blob the path holds |
| `__nendo_extension_state` | Package, view (`''` for the whole package), key, JSON of at most 64 KiB, version |

Replaced and removed content stays in the blob store, so compensation restores a put's
exact bytes.

| Operation | Lane | Reversibility |
| --- | --- | --- |
| `extension.setPackage` | Definition | ReversibleWithRetainedState |
| `extension.putFile` | Definition | ReversibleWithRetainedState |
| `extension.removeFile` | Definition | ReversibleWithRetainedState |
| `extension.removePackage`, refused while files remain | Definition | ReversibleWithRetainedState |
| `extension.setState` | Data | Reversible |

- `putFile` takes the content as `text` (stored as UTF-8 exactly as written), `base64`, or
  the `sha256` and `byteLength` of content the file already holds. The canonical operation
  carries the hash, length and media type, never the bytes. An optional `expectedSha256`
  (a hash, or `absent`) makes a put or removal conditional. A path is a safe relative
  path, unique ignoring case, and never under `_nendo/`.
- History rows carry the hash and size, never the content.
- Definition operations go through change sets and proposals. The review names each change
  in a sentence, shows a line diff for each text file of at most 1 MiB (three lines of
  context, at most 400 changed lines per file and 2,000 per proposal, with a truncation
  flag) and the sizes of any other file. Each file a proposal adds or replaces can be read
  whole before accepting, through `proposal.readPackageFile`, from the proposal's copy and
  bound to the reviewed digest.
- A proposal that puts code into the file carries one fixed sentence: "This code runs when
  a view that uses its package is shown. It can read and change this file's records
  through Nendo, reach the network and use the clipboard."
- MCP authors packages through the four definition operations; `extension.setState` is not
  exposed. A file larger than one operation's payload arrives as a first `putFile` and then
  `putFile` operations with `append` for the same path in the same change set; the adapter
  joins them before validation, and the Engine never sees `append`. Packages are read
  through `nendo://application/extensions` and
  `nendo://application/extension/{packageId}/file{?path,offset,length}`, in pages of at
  most 128 KiB.

The Engine declares the bounds once, in `NendoExtensionLimits`, and the vocabulary
publishes them under `limits.extensions`.

| Limit | Value |
| --- | --- |
| Per file | 4 MiB |
| Per package | 16 MiB, 512 files |
| Per `.nendo` file | 64 MiB, 64 packages |
| New content per change set | 4 MiB |
| View configuration | 16 KiB, any JSON object |
| MCP `putFile` payload | 96 KiB. The local MCP's 256 KiB request body limits a call to about two such parts |

The write reserve below the open bound ([ADR-0012](0012-safe-mode-compatibility-and-migration.md))
is 32 MiB, so the byte write ceiling is 224 MiB: the smallest power of two that holds the
growth of a commit carrying 4 MiB of new content.

### The API: one more client of the typed services

- A package includes `<script src="/_nendo/api.js">`, which sets up `window.nendo` and
  opens a `MessageChannel` to the Workbench broker. The broker checks `event.source` and
  `event.origin`.
- The broker has a closed method table. It calls the Workbench's host bridge with an actor
  taken from the frame's mount, never from the view's parameters. The host accepts that
  actor only on permitted methods and refuses it elsewhere with `actor-not-allowed`. The
  request runs under the context `extension:<package>`, and History attributes the write to
  that name.
- A view can read everything the Workbench reads, calculated fields included, with labels
  and exact decimals; create, update and delete records and run commands with the same
  version checks as a person's edit; undo and redo its own batches
  ([ADR-0023](0023-a-view-undoes-its-own-revisions.md)); prepare a proposal; subscribe to
  changes (at most 4 events a second per frame); navigate, show a toast, set its height,
  read the theme and keep a place in Back and Forward (`ui.setPlace`); keep state in the
  file; and read its package's declared settings and keep this computer's value of them
  (`settings.*`, [ADR-0038](0038-settings-in-one-place.md)).
- The table holds none of `proposal.promote`, `proposal.reject`, `behaviour.*`, `agent.*`,
  `file.*`, `session.open*`, `appearance.set` or `history.compensate`. The production gate
  pins it. A view may message the person's launched agent through `assistant.*`, under
  [ADR-0033](0033-a-view-messages-the-launched-agent.md).
- At most 8 requests are in flight per frame, with a queue of 64, so a busy view does not
  starve a person's save.
- A view that moves the page on its own, its frame not focused, does so at most once a
  second (`ui.openRecord`, `ui.openScreen` and `ui.openStudio` together; the next is
  `busy`). A view held off screen while the person reviews its proposal may not move the
  page, draw a menu or keep a place.
- `nendo.apiVersion` and `nendo.has(name)` version the API. A new method is a line in the
  contract and needs no ADR change and no rung.

### Views that write (Phase 3)

**Records.** A view's record writes and commands take effect without a host-drawn
confirmation, like a person's edit. The person reads them in History under the package's
name and compensates them there. A view that wants confirmation draws its own.

**Unanswered writes.** `records.batch` takes an optional `writeKey`. The broker writes the
batch under the idempotency key `view:‹package›:‹writeKey›`, so a batch whose answer was
lost is kept once however often it is sent, and the same key with other writes is refused.
A single write kept but not read back answers `written-not-read`. The person's form journal
is not shared with views.

**Drafts.** Nendo ends a view's frame whenever it leaves the screen, and on reload, Stop,
revocation and the kill switches, without asking. A view that holds unsaved typing keeps it
recoverable in its origin's storage and restores it when it starts again; it never saves it
as records for the person.

**Proposals.** A view prepares a definition change; the person decides.

- `nendo.proposals.prepare({title, operations})` uses the same path as the Workbench's
  `proposal.prepareChangeSet`: the same operations, validation and diagnostics. The host
  admits the frame's actor on `proposal.prepareChangeSet` and `proposal.get`.
- The proposal's origin is `extension:‹package›`. The review says above the changes:
  "Prepared by the custom view ‹title› (‹package›). Nothing changes until you accept."
  Preparing opens the review at once, over the view.
- `nendo.proposals.get(id)` reports its state (`previewable`, `active`, `rejected`,
  `stale`, `invalid`, `failed`) and diagnostics; `nendo.proposals.open(id)` opens the
  review again. A view reads only proposals its own package prepared; another origin's
  answers `not-found`.
- One waiting proposal per package: while one is `previewable`, another `prepare` is
  refused with `proposal-waiting`, naming it.
- A view never promotes or rejects. A proposal that changes a package reviews like any
  other, code diff and fixed sentence included.

**State.** `nendo.state` keeps small JSON values with the file.

- `get(key)`, `set(key, value, {expectedVersion})`, `delete(key)` and `keys()`. A value is
  scoped to the view that set it (its view definition's node ID); `{scope: 'package'}`
  shares one across the package's views, stored with the view `''`.
- A write is `extension.setState`: Data lane, Reversible. A deletion is a set to null.
  History describes it as "Keep ‹key› for the view ‹title›" under the package's name.
- Each row has a version. A stale `expectedVersion` is refused with
  `state-version-conflict`; without one the last write wins.
- Bounds: a key of 1 to 128 characters, a value of at most 64 KiB of JSON, at most 256 keys
  per view and 1 MiB per package. `api.js` coalesces writes to one key and sends at most 2 a
  second per frame.
- A state write changes no record and triggers no action, but passes the same gates as a
  record write: views on, the file writable, and behaviour approval where the file has
  actions. It raises the `changes` event.

**Settings.** A package declares its settings in `nendo-package.json`, and a view reads them
through `nendo.settings` ([ADR-0038](0038-settings-in-one-place.md)). A choice a person would
look for in Settings is a declared setting, not view state or page storage.
- No rung of its own. A copy of the file carries state; Export does not. Removing a package
  keeps its rows. MCP neither reads nor writes view state.

### The browser is open

- A view origin may use the network, loopback included. It may read and write the
  clipboard, make several downloads, show script dialogs and open DevTools, in every build.
- A user-initiated `http(s)` or `mailto` pop-up opens in the system browser; a window a
  script opens by itself opens nowhere. A frame navigation to a scheme other than
  `http(s)`, `data`, `blob`, `about` or `javascript` is cancelled.
- Context menus work inside frames. The host tells a view's menu from the Workbench's by the
  frame's address.
- A permission request carries the Workbench's origin, not the view's, so the host answers
  each view on its own frame: a clipboard read and several downloads are allowed, anything
  else is refused, and no answer is saved. The frame does not delegate location. The
  Workbench's own requests are denied.
- A download goes to the person's Downloads folder under a name that overwrites nothing,
  and WebView2's downloads panel is never shown. Nendo's notice line says where each file
  went, with Show in folder. A view cannot open or run what it saved.
- **Files a person hands a view.** A view's own `<input type="file">` opens Windows' Open
  dialog; the choice is the consent, and the view gets a `File` without its path. Nendo adds
  no size limit and no file call. The browser refuses `showOpenFilePicker`,
  `showSaveFilePicker` and `showDirectoryPicker` to a cross-origin frame, so a view saves by
  download. A file dragged over a view is the view's if it cancels `dragover`; Nendo's drop
  hint steps aside over a view.

### A view's failure stays with the view

- Only a main-frame or browser-process failure sends the app to recovery. A frame
  renderer's exit becomes `extensionFramesFailed`, naming every frame of that package. Each
  shows an overlay with Reload.
- The broker pings each frame every 5 seconds. After 10 seconds without an answer the
  overlay says "not responding", with Stop and Reload. Stop points every frame of the
  package at `about:blank`, which ends a spinning renderer, and then removes them.
- A hung or crashed view's overlay takes focus when the view had it.

### Views anywhere, many at once

- Views appear on Use screens (`extensionGraphSurface`, `extensionRecordsSurface`), in
  record-page panels (`extensionRecordPanel`, started lazily, no cap) and as an
  `extensionView` root.
- **Open view definitions (rung 1.34.0).** `packageVersion`, `packageDigest`,
  `protocolVersion` and `configurationVersion` are optional, kept and ignored.
  `configuration` may be any JSON object. A `fieldBinding` may name any active field,
  calculated ones included, and a `filterClause` may use any value kind. A view whose
  package is not in the file gets the warning `NUI452`, with "Add package to file…".
- **A view as a screen of its own (`extensionView`, rung 1.42.0).** A root of the file, as
  the front page is; a file holds at most eight. It carries `definitionVersion`, `title` and
  `packageId`, and may carry `configuration` and `entityId`, which reaches the view in its
  context without moving the screen under that type. It has no children. The first picker of
  the Use breadcrumb lists the front page, then each view in authored order, then the record
  types; it is a place in Back and Forward, and `ui.openScreen` opens it. `opensFile: true` on
  one view makes the file open on it; at most one may say so (`NUI453`). When views do not
  run, the file opens as if no view said so. A missing record type refuses the view
  (`NUI450`).
- **`extensionTile`** (a child of `overviewSurface`, `section` or `tabGroup`, sized `tile`
  or `wide`, with a height) is decided but not built. It takes the next free rung when it
  lands.

### Views in Nendo's own chrome

A view draws its content, and Nendo draws its controls.

- **The toolbar.** `ui.setToolbar({items, add})` declares the view's controls as data:
  buttons, toggles, choices, selects, a search box, menus, joined groups, text, separators
  and spacers. Nendo draws them with its own controls: on a screen in the one row under the
  top bar, before Nendo's Add; on a record page in the panel's header. Each call replaces
  the whole toolbar. The declaration is text and a closed set of kinds and icons, so nothing
  a view sends becomes markup. It is bounded: 32 items in the row, 16 KiB of JSON in all, labels of 80 characters.
- **One row.** On a Use screen the breadcrumb's two names are the record-type picker and
  the view picker, and a custom view's controls share that row. A view may declare its
  summary as `text` in the row and keep an explanation behind a `toggle`. The row keeps to
  one line: what does not fit goes, from the end, into Nendo's **More** menu. Add keeps its
  width.
- **Commands.** A press, a menu pick, a palette entry or a declared key reaches the view as
  the event `command`, `{id, value, source}`. Nendo shows the new state at once; the view's
  next declaration decides it.
- **Add.** `add` names one of the view's command IDs; Nendo's Add then sends that command
  instead of opening Nendo's form.
- **Menus.** `ui.showMenu({items, x, y})` draws Nendo's menu at a point in the frame and
  answers the item picked, or null. One menu is open at a time, a view asks at most four
  times a second, and a menu is drawn only while the view's frame has focus or within two
  seconds of a command from Ctrl K, a declared key or Add.
- **Keys.** A command may declare a key, shown beside the control, in the palette and in
  the shortcut hints, and run wherever focus is in the window except while the person types
  in a field. Nendo's own keys stay Nendo's; when one is pressed inside a view, `api.js`
  hands it to the Workbench, which runs it only while the view's frame has focus. That is
  the only way a key crosses the frame.
- **Ctrl K** lists a view's commands under its title, each option and menu item as its own
  entry.

A view on a host without these methods draws its own controls; it asks with
`nendo.has('ui.setToolbar')`. None of this reaches the file.

### No install, no consent, no pins

A view that is shown runs. The controls are device-local kill switches:

- **Run custom views**, a device setting;
- **Run this file's views**, per file;
- safe mode, recovery, and any file whose health is not `normal`;
- **Restart without custom views**, in the recovery panel, until the person turns **Run
  custom views** on again or starts Nendo again.

Each switch is enforced twice: the Workbench mounts no frame, and the host answers 403 on
the view's origin. A switch pressed while an action runs is made when the action ends, and
never dropped.

### Develop from a folder (Phase 4)

A development link shows an edit the moment it is saved, on one device, for one package of
one file, and never reaches the file.

- **The link.** **Develop from folder…** in Studio's Custom views, on a package the file
  carries, picks a folder holding a `nendo-package.json` with the same `packageId`. The host
  keeps the link in this device's custom-view settings, keyed by application ID and package
  ID. The Workbench is told only the folder's name, never its path.
- **Serving.** While the link stands and views run, the origin answers from the folder,
  read with Import's rules (`NendoExtensionArchives.ReadFolder`), so what runs is what Save
  would propose. A folder that no longer reads answers 503 with the reason, never the
  file's code.
- **Reload on save.** The host watches the folder. A burst of changes becomes one
  `extensionDevelopmentChanged` event about a quarter of a second after the last, and the
  Workbench reloads every running view of the package.
- **The banner.** Every view of a linked package has a strip above its frame, outside the
  view's reach: Development, the folder's name, **Save to file…** and **Stop developing**.
- **Save to file** prepares Import's proposal, only what differs. **Stop developing**
  removes the link.
- The kill switches stop linked views. Safe mode and recovery run no view. A copy of the
  file, or another device, runs the reviewed code. A linked view writes as its package.
- No rung.

### Kept on purpose

- Studio never hosts extension code, and it stays reachable.
- Writes go only through the typed services. There is no SQL and no generic invocation.
- Definition changes go through proposals. A view never promotes or rejects one.
  Acceptance stays with the person, or with an agent at
  [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)'s Unattended level.
- A file with automatic actions needs this device's
  [ADR-0008](0008-general-scripting-and-capability-isolation.md) behaviour approval before
  any write, a view's included. View code needs no approval of its own, but the grant binds
  the definition revision, so an accepted package change asks again in such a file.
- Every operation declares its reversibility.

### The trust trade

A received file's code runs when its view is shown, and nobody on this device has read it.
It can read and change all of that file's records, reach the network and the clipboard, and
download files. At the Unattended level an agent can accept its own package proposal, so
its code can run before anybody reads it. The owner chose this over consent steps; the kill
switches are the whole control.

View code cannot reach the Workbench DOM, the host bridge, SQL, file paths, other files or
device settings; cannot use Nendo's MCP endpoint; and cannot accept a proposal.

### Compatibility

- A file that carries packages needs host 1.33.0. A view only the open rules accept needs
  1.34.0; a definition the earlier rules accept keeps its rung, 1.29.0 to 1.32.0.
  `extensionView` needs 1.42.0. An older host refuses writable open by the rung rule of
  ADR-0012; there is no downgrade in place.
- A file without packages gains no table.
- `.nendoview` archives from the contained slice still import. Its device state
  (`extension-packages/`, `extension-grants.json`, `extension-runs/`) is obsolete and left
  alone.

## Consequences

**Positive.** A view travels with its file and runs when its proposal is accepted. An agent
delivers a working view through MCP alone. Many views run at once, at a renderer each. A
view is one more client of the typed services, so validation, versions, History,
attribution and reversibility cover its writes. The API grows without an ADR change or a
rung.

**Negative.** A received file's code runs unread and can change all of that file's records.
There is no OS boundary: views share the WebView2 browser and GPU processes, and a view
that floods the broker can crash the Workbench renderer (**Restart without custom views**
is the way back). Evergreen Chromium can move this boundary, so the guards run on every
production check. Packages make files larger, the write reserve lowers the writable
ceiling, and view state adds History rows. A file with packages is writable only by host
1.33.0 or later.

## Rejected alternatives

- **A contained helper per view, or one shared helper.** A browser engine per view, or one
  AppContainer and Job shared across packages; install and consent steps; a child window over
  a scrolling page.
- **Packages in a device cache, pinned by digest.** An install and approval per device per
  rebuild, and a copy does not carry the view.
- **Same-site or same-document views.** A spinning view would freeze Studio and could reach
  the Workbench DOM and host bridge.
- **Consent per package or per digest.** The kill switches replace it.
- **A `files.open` call.** A second picker beside the browser's, with no added protection.
- **A host leave prompt for a view's drafts.** It cannot cover Stop, a crash or a kill
  switch; recovery in the view's storage covers every way a frame ends.

## Revisit triggers

- A received file's code causes harm the kill switches do not cover.
- A guard shows a view can reach the Workbench or the host bridge, or stall Studio.
- Nendo is used with files from people the owner does not trust, or on a shared computer.
- Extensions without a view are wanted: contributed commands, event handlers or background
  work. They need their own decision.
- A view needs to accept proposals, or an extension needs raw SQL. Both stay out of scope.
