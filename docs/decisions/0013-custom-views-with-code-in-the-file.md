# ADR-0013: Custom views with code in the file

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The measured cost of a contained view (2026-09-24, under *Context*);
  the current code paths named under *Context*; the Phase 0 spike, whose findings
  go to `prototypes/iframe-views/FINDINGS.md` and are pending; guards G1–G26, each
  recorded as a planner Check when its phase lands
- **Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007,
  ADR-0008, ADR-0009 and ADR-0012
- **Related design:** [custom-view contract](../contracts/custom-views.md),
  [authoring a custom view](../custom-view-authoring.md),
  [architecture](../architecture.md)

Accepted 2026-09-25 on the owner's standing pre-acceptance of 2026-09-24:
"I pre-accept any ADR change - this is still an experimental project."

## Context

Nendo is an exploratory personal project about malleable software. On 2026-09-25
the owner asked for this decision:

> This is meant to be an exploratory personal project of the concept of malleable
> software. Create a plan to remove these restrictions in order to really explore
> what can be done. We are going for max flexibility.

The restrictions were those of the custom-view slice built from 2026-09-20 to
2026-09-24:

- A view was a read-only renderer. It received a small, bounded projection of
  records. It could not write, run a command or prepare a proposal.
- Each running view had its own contained helper process: a zero-capability
  AppContainer and a Job, with its own browser engine and no network, clipboard or
  storage.
- One running view measured 219 MiB started and 230 to 270 MiB shown (2026-09-24,
  a 41-node graph). The page was about 30 MiB of that. The rest was the view's own
  browser engine, mostly GPU compositing. So embedded views started only on
  request, one at a time per window.
- Packages sat in a device cache, pinned by digest. Every rebuild meant installing
  the package and allowing it again, on each device and for each file. A copy of
  the file did not carry the view.
- MCP could not install or allow a package, so an agent could not deliver a view
  that runs.
- Each widening needed an ADR amendment and a host version rung.

The goal is that a person or an agent can write a view with full powers, keep it
inside the `.nendo` file, and see it run straight away: many views at once,
anywhere in the app.

Three facts in the current code shape the design:

- The Workbench's WebView2 answers 403 to every request outside the Workbench's
  own origin, through a catch-all `"*"` resource filter.
- Every `ProcessFailed` kind sends the app to recovery. A crashed frame would take
  Studio down with it.
- Nendo's MCP endpoint refuses a request whose `Origin` is not its own. A web page
  cannot drive it.

## Decision drivers

1. Maximum flexibility, so that the project can explore what malleable software
   can do.
2. A view travels with its file. Copy the file and the view comes along.
3. Nothing stands between writing a view and seeing it run: no install, no
   consent, no pin.
4. Many views at once, anywhere in the app. A running view costs a renderer, not a
   browser engine.
5. The product axioms hold: Studio is permanent and host-owned, all clients share
   one typed authority path, there is no raw SQL, preview happens on a clone, and
   every operation declares its reversibility.
6. A crashed or spinning view does not take Studio down, and a person can always
   turn views off.
7. Agents author views through the same MCP change sets as everything else.

## Options considered

### A. Frames in the Workbench, code in the file, full API

Each view is a cross-origin frame in the Workbench's own WebView2. The host serves
it from the file, and each package in each file is its own site. The view talks to
a broker in the Workbench, and the broker calls the typed services that the
Workbench already calls. A running package costs a renderer process. The OS
boundary is given up.

### B. Keep the contained helper and widen its API

Keep one AppContainer and Job helper per running view, and add writes to its
channel. The OS boundary stays. But each view keeps its own browser engine, at 219
to 270 MiB measured, so views still run one at a time. The install and consent
steps stay, and so does a child window laid over a scrolling page.

### C. One contained helper for all views

One helper hosts every running view, so the browser engine is paid once. But
different packages then share one AppContainer and one Job, where one package's
memory, CPU or process use stops the others. The second engine, the overlay and
the install and consent steps stay. The 2026-09-24 decision rejected it because of
the shared AppContainer and Job.

### D. View code in the Workbench's own document or site

Run the view's script in the Workbench page, or serve it from a site the Workbench
shares. This is the cheapest option. But a same-site frame shares the Workbench's
renderer process, so a view in a `while (true)` loop freezes Studio. A same-origin
view can also reach the Workbench DOM and the host bridge.

### Do nothing

Keep the bounded slice. The owner rejected this on 2026-09-25.

## Decision

Custom views carry their code in the `.nendo` file. They run inline in the
Workbench, as cross-origin frames, with the full typed API. There is no install
step, no consent and no digest pin. A view that is shown runs.

### Views run as frames in the Workbench

- A view is a cross-origin iframe in the Workbench's own WebView2. The contained
  helper (`Nendo.ExtensionHost`), its child-window overlay, its Job limits and its
  own browser engine are deleted.
- Each package in each file has its own origin, `https://{slug}-{key}.example`:
  - `slug` is the package ID with `.` changed to `-`, at most 40 characters;
  - `key` is 10 hex characters of SHA-256(`applicationId\npackageId`).
- `.example` is a reserved top-level domain (RFC 2606). No real site shares a
  view's origin, and the host answers every request to it.
- Each package in each file is therefore its own site. Chromium gives it its own
  renderer process, never the Workbench's (`app.nendo.local`), and its own browser
  storage. If frames turn out to share a process, the host turns on
  `--site-per-process`.
- The frame's sandbox allows everything except top-level navigation
  (`allow-top-navigation*`).
- The Workbench cannot be framed. The host cancels any frame navigation to
  `app.nendo.local`, and the Workbench refuses to start when
  `window.top !== window`.
- A redraw does not reload a running view. Before a redraw, the Workbench parks
  each live frame and adopts it into its new placeholder by mount key
  (`Element.moveBefore`). If that does not keep the frame's state, the fallback is
  a reload, and a view keeps what it needs in `nendo.state`.

### The host serves each view from the file

- The host answers `WebResourceRequested` for `https://*.example/*`, from every
  source kind. It takes a deferral and reads the content with a typed Engine read.
  A 64 MiB in-memory cache, keyed by package, path and SHA-256, is cleared
  when the definition revision changes.
- The serving order is: views off → 403; `/_nendo/api.js`; a development folder
  link; the file's content; 404. `/` serves the package's entry point. The path
  `/_nendo/` is reserved on every view origin.
- The catch-all `"*"` filter goes. The Workbench's own content-security policy
  keeps its document local and gains only `frame-src https://*.example`.

### The code lives in the file (rung 1.33.0)

A package is protected definition metadata. Four tables hold it. The host creates
them on the first extension write, never at file creation, as the layout ladder's
new last rung, after the file-purpose table (1.24.0).

| Table | Holds |
| --- | --- |
| `__nendo_extension_package` | ID (3–80 characters), title, version, entry point, description |
| `__nendo_extension_blob` | Content as a BLOB of at most 4 MiB, keyed by its SHA-256. Each distinct content is stored once |
| `__nendo_extension_file` | Package, path, media type, and the SHA-256 of the blob the path holds |
| `__nendo_extension_state` | Package, view (`''` for the whole package), key, JSON of at most 64 KiB, version |

Replaced and removed content stays in the blob store. That is what lets
compensation restore a put's exact bytes, so there is no separate table of
retained content.

Five canonical operations write them.

| Operation | Lane | Reversibility |
| --- | --- | --- |
| `extension.setPackage` | Definition | ReversibleWithRetainedState |
| `extension.putFile` | Definition | ReversibleWithRetainedState |
| `extension.removeFile` | Definition | ReversibleWithRetainedState |
| `extension.removePackage`, refused while files remain | Definition | ReversibleWithRetainedState |
| `extension.setState` | Data | Reversible |

- `putFile` takes the content in one of three forms: `text`, stored as UTF-8
  exactly as written; `base64`, for any bytes; or the `sha256` and `byteLength` of
  content the file already holds. The canonical operation carries the SHA-256, the
  byte length and the media type, never the bytes. The bytes travel beside it into
  the blob store. An optional `expectedSha256` makes a put or a removal
  conditional: a hash, or `absent` for a put that must add a new file. A path is a
  safe relative path, unique ignoring case, and never under `_nendo/`.
- History rows carry the hash and the size, never the content, so nothing needs
  eliding. Opening a file does not read every version of every script.
- The definition operations go through change sets and proposals, like every
  other definition change. The review names each change in a sentence:
  - "Add the custom-view package ‹title› (‹id›), starting at ‹entry point›. Its
    code is kept in this file."
  - "Update the custom-view package ‹title› (‹id›): it starts at ‹entry point›."
    When a version is set, the sentence ends "and is version ‹version›."
  - "Add ‹path› to the package ‹title› (‹media type›, ‹size›)."
  - "Replace ‹path› in the package ‹title› (‹size› before, ‹size› after); the old
    version stays in history."
  - "Keep ‹path› in the package ‹title› as it is; the content sent is identical."
  - "Remove ‹path› from the package ‹title›; its content stays in history."
  - "Remove the package ‹title› from this file."
- The review shows a line diff for each text file of at most 1 MiB, with three
  lines of context: at most 400 changed lines per file and 2,000 per proposal, with
  a truncation flag. Any other file shows its sizes.
- The review also carries a fixed sentence that says what view code can do
  (network, clipboard, records). It arrives with Phase 2, when view code runs. In
  Phase 1 nothing runs, so the review carries no such sentence.
- MCP authors packages. The four definition operations are authoring operations.
  `extension.setState` is not exposed. A file larger than one operation's payload
  arrives in parts: a first `putFile`, then `putFile` operations with `append` for
  the same package and path, later in the same change set. `append` is an MCP
  authoring convenience. The adapter joins the parts in order before validation,
  and the Engine never sees it. Two resources read packages:
  `nendo://application/extensions` and
  `nendo://application/extension/{packageId}/file{?path,offset,length}`, with the
  path percent-encoded, in pages of at most 128 KiB.

The Engine declares the package bounds once, in `NendoExtensionLimits`. The
vocabulary publishes them under `limits.extensions`.

| Limit | Value |
| --- | --- |
| Per file | 4 MiB |
| Per package | 16 MiB, 512 files |
| Per `.nendo` file | 64 MiB, 64 packages |
| New content per change set | 4 MiB |
| View configuration | 16 KiB. It arrives with Phase 2's open view definitions |
| MCP `putFile` payload | 96 KiB. The local MCP's 256 KiB request body limits a call to about two such parts |

The write reserve below the open bound ([ADR-0012](0012-safe-mode-compatibility-and-migration.md))
is 32 MiB, so the byte write ceiling is 224 MiB. The largest package commit
carries 4 MiB of new content. Guard G4 asserts that such a commit grows the file by
more than 4 MiB and by less than a quarter of the reserve. The measured growth is
about 4.3 MB, so 32 MiB is the smallest power of two that holds.

### The API: one more client of the typed services

- A package includes `<script src="/_nendo/api.js">`, which sets up
  `window.nendo`. The script opens a `MessageChannel` to the Workbench broker. The
  broker checks `event.source` and `event.origin`.
- The broker has a closed method table. It calls the Workbench's existing host
  bridge with an actor taken from the frame's mount, never from the view's
  parameters. The host accepts that actor only on the permitted methods, and
  refuses it elsewhere with `actor-not-allowed`. The request then takes the
  ordinary path to the application services, under the request context
  `extension:<package>`. History attributes the write to that name.
- A view can:
  - read everything the Workbench reads, calculated fields included, with labels
    and exact decimals;
  - create, update and delete records and run commands, through the same typed
    operations and version checks as a person's edit;
  - prepare a proposal, follow its status and open its review;
  - subscribe to changes (at most 4 events a second per frame), navigate, show a
    toast, set its own height and read the theme;
  - keep durable state in the file through `nendo.state`.
- The broker's table contains none of `proposal.promote`, `proposal.reject`,
  `behaviour.*`, `agent.*`, `file.*`, `session.open*`, `appearance.set` or
  `history.compensate`. The production gate pins the table.
- At most 8 requests are in flight per frame, with a queue of 64, so that a busy
  view does not starve a person's save.
- `nendo.apiVersion` and `nendo.has(name)` version the API. Adding a method costs a
  line in the contract's History. It needs no ADR change and no rung.

### The browser is open

A view origin may use the network, loopback included. It may read and write the
clipboard, make several downloads, show script dialogs and open DevTools, in every
build. A user-initiated `http(s)` or `mailto` pop-up opens in the system browser.
Context menus work inside frames. Any asset type is served. Other permission
requests get WebView2's default prompt. The Workbench origin is denied every
permission.

### A view's failure stays with the view

- Only a main-frame or browser-process failure sends the app to recovery. A
  frame's renderer exit becomes `extensionFramesFailed`, naming the frames. Each
  of them shows an overlay with Reload. Other failure kinds are logged.
- The broker pings each frame every 5 seconds. After 10 seconds without an answer,
  the overlay says "not responding", with Stop and Reload. Stop ends the frame's
  renderer.

### Views anywhere, many at once

- Views appear on Use screens (`extensionGraphSurface`,
  `extensionRecordsSurface`), in record-page panels (`extensionRecordPanel`,
  started lazily, with no cap), as an `extensionView` root, and as an
  `extensionTile` on the front page and dashboards.
- **Open view definitions (rung 1.34.0).** The pins `packageVersion`,
  `packageDigest`, `protocolVersion` and `configurationVersion` become optional.
  They are kept and ignored. `configuration` may be any JSON object. A
  `fieldBinding` may name any active field, calculated ones included. A
  `filterClause` may use any value kind. The panel cap goes. A view whose package
  is not in the file gets the warning NUI452, with one step: "Add package to
  file…". NUI451 and the binding digest are retired.
- **`extensionView` and `extensionTile` (rung 1.35.0).** `extensionView` is a root
  with a package, a title, a configuration and an optional `entityId`. It appears
  in the Use "Showing" picker. `extensionTile` is a child of `overviewSurface`,
  `section` or `tabGroup`, sized `tile` or `wide`, with a height.

### No install, no consent, no pins

A view that is shown runs. The controls are kill switches, all of them
device-local:

- **Run custom views**, a device setting;
- a switch for each file;
- safe mode, recovery, and any file whose health is not `normal`;
- **Restart without custom views**, in the recovery panel.

Each switch is enforced twice: the Workbench mounts no frame, and the host answers
403 on the view's origin.

### Kept on purpose

These are architecture, not security, and they stay:

- Studio never hosts extension code, and it stays reachable.
- Writes go only through the typed services. There is no SQL and no generic
  invocation.
- Definition changes go through proposals. A view can prepare a proposal but never
  promote or reject one. Acceptance stays with the person, or with an agent at
  [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)'s Unattended
  level.
- A file with automatic actions still needs this device's
  [ADR-0008](0008-general-scripting-and-capability-isolation.md) behaviour approval
  before any write, a view's write included.
- Every operation declares its reversibility.

### The trust trade

A received file's code runs when its view is shown. It can read and change all of
that file's records through the API. It can reach the network, loopback included,
and the clipboard, and it can trigger downloads. A proposal's code diff is read
only where the change is made: a received file's code arrives already accepted,
and nobody on this device has read it. At ADR-0009's Unattended level, an agent
can accept its own package proposal, so its code can run before anybody reads it.

View code cannot:

- reach the Workbench DOM, the host bridge, SQL, file paths, other files or device
  settings;
- use Nendo's MCP endpoint, which refuses browser origins;
- accept a proposal.

The owner chose this over consent steps. The kill switches are the whole control.

### Compatibility

- A file that carries packages needs host 1.33.0. A view definition that only the
  open rules accept needs 1.34.0. A definition that the earlier rules accept keeps
  its rung, 1.29.0 to 1.32.0. `extensionView` and `extensionTile` need 1.35.0.
- An older host refuses writable open of such a file by the rung rule of
  ADR-0012. There is no downgrade-in-place.
- A file without packages gains no table and keeps its layout.
- `.nendoview` archives from the contained slice stay importable. The old device
  state (`extension-packages/`, `extension-grants.json`, `extension-runs/`) is left
  alone, and the contract lists it as obsolete.

## Effect on other decisions

- [ADR-0001](0001-local-one-file-product-boundary.md): view code may travel in the
  file.
- [ADR-0003](0003-relational-user-data-and-protected-metadata.md): protected
  metadata includes extension packages, an executable payload.
- [ADR-0004](0004-versioned-semantic-ui-contract.md): `extensionView` and
  `extensionTile` join the vocabulary by the ordinary new-kind path, and view
  definitions open up at 1.34.0.
- [ADR-0008](0008-general-scripting-and-capability-isolation.md): its bounded
  expressions stay the formula language. View code needs no behaviour approval.
  The approval still gates every write in a file with automatic actions. Its grant
  binds the definition revision, so in such a file an accepted package change asks
  for approval again, as any definition change does.
- [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md): MCP authors
  packages through change sets. The perimeter does not change.
- [ADR-0012](0012-safe-mode-compatibility-and-migration.md): safe mode and
  recovery never run view code.
- [ADR-0002](0002-containing-desktop-architecture-and-process-model.md) and
  [ADR-0017](0017-production-composition-and-build-layout.md) still describe the
  contained helper. They are rewritten in the change that deletes it (Phase 2).

## Delivery

This ADR decides the whole design, and the design lands in phases. The
[custom-view contract](../contracts/custom-views.md) states what is delivered at
any moment. Until Phase 2 ships, the contained helper that the contract describes
is what runs.

| Phase | Delivers | Rung |
| --- | --- | --- |
| 0 | A disposable spike that answers the WebView2 questions below | — |
| 1 | Code in the file: the tables, the operations, the review and MCP authoring. Nothing runs yet | 1.33.0 |
| 2 | Views run inline from the file, and the helper is deleted: serving, the read API, the kill switches, open definitions and the four packages ported | 1.34.0 |
| 3 | Views that write: records, commands, proposals to prepare, and state | — |
| 4 | Develop from a folder: a device-local link, reload on save, saving the folder as proposals, and export | — |
| 5 | Views anywhere: `extensionView` and `extensionTile` | 1.35.0 |

## Evidence and validation obligations

**Measured.** The cost of a contained view, 2026-09-24, under *Context*. It is the
reason the helper goes.

**Pending: the Phase 0 spike.** It is a WebView2 harness in
`prototypes/iframe-views/`, pinned to the Desktop's SDK, and it records its
answers in `FINDINGS.md` there. It answers:

- whether each package site gets its own renderer (the fallback is
  `--site-per-process`);
- whether a spinning frame leaves the Workbench responsive, whether removing a
  hung frame ends its renderer, and whether the failure event names the frame;
- whether `moveBefore` keeps a frame's state (the fallback is a reload);
- the memory for 1, 5, 10 and 20 frames, which sets the budget for G15;
- serving speed for a 5 MB file; clipboard, loopback fetch, downloads, storage
  across restarts, workers and a secure context on `.example`; the sandbox;
  navigation events for nested frames; and that `chrome.webview` is inert inside a
  frame.

The spike settles the named particulars, not the choice. Each particular has its
fallback above.

**Guards.** Each phase lands with guards. Each guard measures its property, is
falsified once, and has the failure text quoted in its planner Check.

| Property | Guards |
| --- | --- |
| Packages round-trip byte-exact, compensate exactly, fit the write reserve and review as a code diff | G1–G7 |
| A spinning, hung or crashed view leaves the Workbench and Studio responsive, with no recovery, and can be stopped or reloaded | G8, G9, G14 |
| A view cannot reach the Workbench or navigate the top frame, and the Workbench's content-security policy holds | G10, G12 |
| Network, clipboard, storage, downloads and pop-ups work in a view | G11 |
| A redraw keeps frames, and many views run within the memory budget | G13, G15 |
| Every kill switch gives no frame and a 403 | G16 |
| Code runs only after its proposal is accepted | G17 |
| Reads are exact; writes are attributed, version-checked and approval-gated; a view cannot promote; state round-trips; a busy view does not starve a save | G18–G22 |
| Develop from a folder | G23–G25 |
| `extensionView` and `extensionTile` | G26 |

## Consequences

### Positive

- A person or an agent writes a view with full powers, keeps it in the file and
  sees it run when the proposal is accepted. A copy of the file carries the view.
- There is no install, consent or pin step. An agent can deliver a working view
  through MCP alone.
- Many views run at once, anywhere, at the cost of a renderer each.
- A view is one more client of the typed services. Validation, versions, History,
  attribution and reversibility cover its writes.
- The API grows without an ADR change or a rung.

### Negative

- A received file's code runs when its view is shown, and nobody here has read it.
  It can change all of that file's records, reach the network and the clipboard,
  and download files.
- The OS boundary is gone. Views share the WebView2 browser and GPU processes with
  the Workbench. A view that floods the broker with huge messages can crash the
  Workbench renderer. **Restart without custom views** is the way back.
- Chromium changes under the Evergreen runtime can move this boundary. The guards
  run on every production check.
- Packages make files larger, and the larger write reserve lowers the writable
  ceiling.
- View state writes add History rows. They are debounced to 2 a second.
- A file that carries packages can be written only by host 1.33.0 or later.

## Rejected alternatives

- **The contained helper, per view or shared** (options B and C). Each view needs
  a browser engine, measured at 219 to 270 MiB, or shares one AppContainer and Job
  with other packages. The install and consent steps and the child window over a
  scrolling page stay. Views one at a time do not meet the owner's goal.
- **Packages in a device cache, pinned by digest.** Every rebuild is an install
  and an approval on each device, and a copy of the file does not carry the view.
- **Same-site or same-document views** (option D). A spinning view would freeze
  Studio, and a view could reach the Workbench DOM and the host bridge.
- **Consent per package or per digest.** The owner chose flexibility over consent
  steps. The kill switches replace it.

## Revisit triggers

- A received file's code causes harm that the kill switches do not cover.
- A guard shows that a view can reach the Workbench or the host bridge, or can
  stall Studio, and the fallback does not restore the boundary.
- Nendo is used with files from people the owner does not trust, or on a shared
  computer.
- Extensions without a view are wanted: contributed commands, event handlers or
  background work. They are the natural next step, and they need their own
  decision.
- A view needs to accept proposals, or an extension needs raw SQL. Both stay out
  of scope.

## History

- 2026-09-02 — deferred: the general extension model stayed out of the MVP.
  Format 1 carried no plug-in, script or executable payload.
- 2026-09-10 — scheduled for P7. Scheduling granted no implementation authority.
- 2026-09-12 — bounded behaviour accepted separately as
  [ADR-0008](0008-general-scripting-and-capability-isolation.md): calculations,
  functions, local actions and triggers. The extension model stayed deferred.
- 2026-09-20 — accepted for a bounded slice: read-only custom views over a host
  projection, each in its own zero-capability AppContainer and Job helper, with
  packages in a device cache pinned by digest and device consent per file and
  view; `extensionGraphSurface` at host 1.29.0. The owner: "I accept the
  architecture changes. Proceed".
- 2026-09-24 — protocol 2: a view discloses more typed fields and narrows its
  record types with literal filters, all bound into its consent; host 1.30.0
  (W-060).
- 2026-09-24 — a record-set shape (`extensionRecordsSurface`, host 1.31.0) and a
  record-page placement (`extensionRecordPanel`, host 1.32.0), started on request
  and one at a time per window, because a running view measured 219 to 270 MiB
  (W-061).
- 2026-09-25 — opened: code in the file, views inline in the Workbench, the full
  typed API, no install and no consent; the helper goes. Accepted on the owner's
  standing pre-acceptance of 2026-09-24.
- 2026-09-25 — storage refined in implementation: a content-addressed blob store
  and a hash-only canonical form.
