# Custom views

Authority: [ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md),
accepted 2026-09-25. The ADR decides the whole design, and the design lands in
phases. This contract states what is delivered now: what the host guarantees and
what it refuses. To write a view, read
[authoring a custom view](../custom-view-authoring.md).

**Phases 0 to 2 are delivered, in product 0.14.0.** A custom view's code lives in
the `.nendo` file as a package. A view that is shown runs that code inline in the
Workbench, as a cross-origin frame, and reads the file through `window.nendo`.
There is no install step, no consent and no digest pin. The contained helper that
ran views before 2026-09-25 is deleted. The [History](#history) says what it was.

Not yet delivered:

- a view that writes records, runs commands, prepares proposals or keeps state in
  the file (Phase 3);
- developing a view from a folder on disk, with reload on save (Phase 4);
- the `extensionView` root and the `extensionTile` (Phase 5).

Nothing in this contract describes them as available.

## The trade

A view that is shown runs. A received file's code therefore runs when its view is
shown, and nobody on this device has read it: a proposal's code is reviewed only
where the change was made. At the Unattended access level, an agent can accept its
own package proposal, so its code can run before anybody reads it.

A view's code can read every record of its file through Nendo, reach the network
(loopback included), read and write the clipboard, and download files. It cannot
reach the Workbench's document, the host bridge, SQL, a file path, another file or
a device setting (see [What a view cannot reach](#what-a-view-cannot-reach)).

The owner chose this over consent steps. The [kill switches](#kill-switches) are
the whole control.

## Packages in the file

Host rung **1.33.0**. Packages arrived in product 0.13.0 (Phase 1), when the file
stored them and nothing ran them. Since product 0.14.0 (Phase 2), a view that is
shown runs its package's code. A package is protected definition metadata. It
changes only through canonical operations in a change set, like a screen, and a
person reviews it as code before it reaches the file.

### Storage

Four protected tables hold packages. The Engine creates all four together on the
first extension write, never at file creation. They are the last rung of the
layout ladder, after the file purpose. A file that never carries a package keeps
its layout and the host version it states.

| Table | Holds |
| --- | --- |
| `__nendo_extension_package` | `package_id`, `title`, `version`, `entry_point`, `description` |
| `__nendo_extension_blob` | `sha256`, `byte_length`, `content`: each distinct content once, at most 4 MiB |
| `__nendo_extension_file` | `package_id`, `path`, `media_type`, and the `sha256` of the blob the path holds |
| `__nendo_extension_state` | `package_id`, `view_id`, `state_key`, `value_json` of at most 64 KiB, `version`. Created with the others. Nothing writes it yet: view state arrives with Phase 3 |

Content is addressed by its SHA-256. A file row names a blob, and identical
content is stored once, however many paths hold it. A replaced or removed version
stays in the blob store, so compensation can restore the exact bytes. Nothing
deletes a blob, so every version of every file stays in the `.nendo` file.
Removing every package leaves the tables, the layout and the stated host in place.

The layout with these tables is
`production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1`.
An upgraded file has its twin,
`production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1`.
Open refuses an `-extension-` layout whose stated minimum host is below 1.33.0, as
`layout-version-mismatch`.

### Operations

The four operations are in the definition lane, and each one declares
`ReversibleWithRetainedState`. Each raises the file's minimum host to 1.33.0.

- `extension.setPackage` {`packageId`, `title`, `entryPoint`, `version`,
  `description`} creates a package or changes its metadata. `entryPoint` defaults
  to `index.html`. `version` is an optional semantic version of at most 40
  characters. A title has 1–200 characters, and a description at most 1,000.
- `extension.putFile` {`packageId`, `path`, `mediaType`, `expectedSha256`, and
  exactly one of `text`, `base64`, or `sha256` with `byteLength`} adds a file or
  replaces what the path holds:
  - `text` is stored as UTF-8 exactly as written, and `base64` carries any bytes.
  - `sha256` with `byteLength` names content the file already holds. That is how a
    reversal, or a copy to another path, is written.
  - A `sha256` sent beside `text` or `base64` is checked against those bytes.
  - `mediaType` defaults from the path's extension, or to
    `application/octet-stream` when the extension names none.
  - `expectedSha256` makes the put conditional: a hash, or `absent` for a path that
    must not hold a file yet.
- `extension.removeFile` {`packageId`, `path`, `expectedSha256`} removes one file.
  Its content stays in the blob store. `expectedSha256` makes the removal
  conditional.
- `extension.removePackage` {`packageId`} removes an empty package. It is refused
  while the package still holds files. Remove them first, in the same change set if
  you like.

The canonical operation and its history row carry the SHA-256, the byte length
and the media type, never the bytes. The bytes travel beside the operation into
the blob store. So history stays small: the history row of a 300 KB file is under
1 KB. Opening a file does not read every version of every script.

A revision made only of package operations is compensated as a whole, in reverse
order, so files leave before the package that holds them. Studio's History offers
Compensate on such a revision, and one compensation reverses at most 128
operations. A revision that mixes package operations with other operations is not
compensated. Each inverse states the content it expects to find. A file changed
since then therefore refuses the compensation as `extension-file-changed` and is
not overwritten.

### Bounds and refusals

`NendoExtensionLimits` declares the bounds once. The vocabulary publishes them
under `limits.extensions`. The Engine refuses a change past a bound and never
truncates it.

| Bound | Value |
| --- | --- |
| One file | 4 MiB |
| One package | 512 files and 16 MiB |
| One `.nendo` file | 64 packages, and 64 MiB of current package bytes |
| New content in one change set | 4 MiB. Validation refuses more and says: "Split the files across several change sets." Content the file already holds does not count |
| Path | At most 240 characters: letters, digits, `_ - . ~`, and `/` between segments. No empty, `.` or `..` segment, no segment that ends in a dot, no Windows device name, and nothing under `_nendo/`. Unique within its package, ignoring case |
| Package ID | 3–80 characters, lowercase, at least two dotted segments, each starting with a letter and holding only letters, digits and `-` |
| Media type | A bare lowercase `type/subtype`, without parameters |

A path, ID, media type or size outside its rule is refused when the operation is
built, before anything is staged. The file's own state is checked when the
operation runs:

| Code | Meaning |
| --- | --- |
| `extension-package-not-found` | A file is put into a package the file does not carry, or a missing package is removed |
| `extension-package-not-empty` | A package that still holds files is removed |
| `extension-path-conflict` | A path differs only in case from a path the package holds |
| `extension-content-missing` | A put names, by its hash, content the file does not hold |
| `extension-file-changed` | The path does not hold what `expectedSha256` states. A compensation of a file changed since then fails in the same way |
| `extension-file-not-found` | A removal names a path the package does not hold |
| `extension-limit` | The change would pass the bound on files or bytes in the package, packages in the file, or bytes across all packages |

### The write reserve

The byte write ceiling sits 32 MiB below the 256 MiB open bound, at 224 MiB
([ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md)). The
largest commit a change set can make is 4 MiB of new package content. A test
commits exactly that and asserts that the file grows by more than 4 MiB, so the
content was stored, and by less than a quarter of the reserve. The measured growth
is about 4.3 MB. So 32 MiB is the smallest power of two that keeps the growth
under a quarter of the reserve.

### Review

A proposal names each package change in a sentence:

- "Add the custom-view package ‹title› (‹id›), starting at ‹entry point›. Its code
  is kept in this file."
- "Update the custom-view package ‹title› (‹id›): it starts at ‹entry point›."
  When a version is set, the sentence ends "and is version ‹version›."
- "Add ‹path› to the package ‹title› (‹media type›, ‹size›)."
- "Replace ‹path› in the package ‹title› (‹size› before, ‹size› after); the old
  version stays in history."
- "Keep ‹path› in the package ‹title› as it is; the content sent is identical."
- "Remove ‹path› from the package ‹title›; its content stays in history."
- "Remove the package ‹title› from this file."

A proposal that puts any file also carries one more line, once, as its own entry
(`extensionCode`): "This code runs when a view that uses its package is shown. It
can read and change this file's records through Nendo, reach the network and use
the clipboard." The line states the whole ADR's grant. In this phase a view reads
and does not yet change records.

In a file below 1.33.0, a package change also raises the file's minimum host to
1.33.0. The review shows that as its own entry, and it cannot be undone.

The proposal preview also carries `packageChanges`. It compares the active file
with the validated clone, so it shows what acceptance commits, not what the author
said it would. Each changed file is `added`, `replaced` or `removed`, with its
media types and sizes before and after:

- A text file is diffed by line, with three lines of context. It must be at most
  1 MiB on both sides, have a text media type and be valid UTF-8.
- The review shows at most 400 changed lines per file and 2,000 per proposal. It
  sets `truncated` where it stops early.
- Any other file is said by its sizes.
- A change of line endings counts as a change, but the carriage return is not
  shown.

Studio's proposal review and the agent review both show these files in a **Code**
section: each file with its lines, a binary file by its sizes, and a note where the
change continues past what the review shows. The MCP preview carries the same list.
A proposal that only brings code says beside it: "Read the code beside this panel:
once you accept, it runs wherever a screen or a record page shows its view."

Code that waits in a proposal is not served. Only the active file's packages have
an origin that answers.

### MCP

The four operations are authoring operations, listed under `operations` in the
vocabulary. One `extension.putFile` payload is at most 96 KiB
(`limits.extensions.putFilePayloadBytes`). Every other operation keeps its 32 KiB.
A larger file is sent in parts:

1. a first `putFile` with the first part;
2. then `putFile` operations with `append: true` for the same package and path,
   later in the same change set.

The adapter joins the parts in order at validation, so the Engine sees one whole
file. A part sent with `append` and no earlier put of its path in the change set is
refused when it is sent. The local MCP's 256 KiB request body fits about two parts
in one call.

Two resources read packages back:

- `nendo://application/extensions` lists every package, with each file's path,
  media type, SHA-256 and size.
- `nendo://application/extension/{packageId}/file{?path,offset,length}` returns one
  file, in pages of at most 131,072 bytes. The path is percent-encoded, for example
  `tiles%2Fworld.bin`. A text page arrives as `text`, and any other page as
  `base64`. `sha256` and `byteLength` describe the whole file, and `nextOffset` is
  null on the last page.

`nendo://application/describe` lists the packages under `extensions`. Two examples
in `nendo://application/examples` are complete change sets to copy:
`put-a-custom-view-in-the-file` writes a package, and `show-a-custom-graph` defines
a view that names one. MCP cannot reach the device's custom-view switches: the
production gate refuses an MCP source file that names the settings store, the
switch or the restart without views. The [MCP interface contract](mcp-interface.md)
has the rest.

### Integrity

An ordinary open checks the package tables' shape: every ID, path and media type,
every bound, and case-unique paths. A table outside them is `mapping-drift`, and
editing is disabled. An explicit integrity verification, `health.verify` in the
Workbench or `nendo.health.verify_integrity` over MCP, also reads every stored
content and compares it with its SHA-256. A mismatch puts the file into recovery.

## Where a view runs

### One frame per view

A view is an `<iframe>` in the Workbench's own WebView2, in the placeholder that its
screen or record page draws. There is no second browser, no helper process and no
native pane. The Workbench sets the frame's attributes in this order, the source
last:

| Attribute | Value |
| --- | --- |
| `name` | `nendo-view-` and twelve hex digits, fresh for every frame. The host names a frame whose renderer ended by it |
| `title` | The view's title |
| `sandbox` | `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation`. No form of `allow-top-navigation` |
| `allow` | `clipboard-read; clipboard-write; fullscreen; web-share; autoplay; encrypted-media; picture-in-picture; geolocation` |
| `loading` | `lazy` |
| `src` | The package's origin and its entry point, each path segment encoded |

The Workbench frames an origin only when it is `https`, one label, under
`.example`. A package whose origin is not one is never framed, and its placeholder
says the view cannot be shown.

### One origin per package per file

Each package in each file has its own origin, `https://{slug}-{key}.example`
(`src/Nendo.Desktop/Extensions/ExtensionOrigins.cs`):

- `slug` is the package ID in lower case. Each character that is not a letter or a
  digit becomes `-`, a run of `-` is kept as one, and a leading `-` is dropped. The
  result is cut to 40 characters and trimmed of `-` at both ends.
- `key` is the first 10 hex characters, lower case, of the SHA-256 of the UTF-8
  text `applicationId + "\n" + packageId`.

For example, `org.nendo.gantt` in some file runs at
`https://org-nendo-gantt-‹10 hex›.example`. The origin is stable for a package in a
file, so its browser storage survives a restart. Two files that carry one package
have different origins and separate storage. A frame left over from a closed file
reaches nothing.

`.example` is reserved by RFC 2606 and never resolves. Each origin is a site of its
own, so Chromium puts each package in a renderer process of its own, never the
Workbench's (`app.nendo.local`). Two frames of one package share one renderer.

### Placement

A view is shown in one of two places:

- **A screen** (`placement` `screen`). An `extensionGraphSurface` or an
  `extensionRecordsSurface` root is a Use screen of its record type, beside the
  other screens of that type. Its frame fills the screen's area.
- **A record page** (`placement` `recordPage`). An `extensionRecordPanel` is a
  titled panel at its authored place on a record page or a record form, about that
  page's record. It starts 360 pixels tall until the view sets its height. On a
  record that is not saved yet, the panel says "Save this record to show its custom
  view." and starts nothing.

### Starting, keeping and ending a frame

- A frame starts when its placeholder comes within 120 pixels of the visible area.
  The Workbench sets the frame's source only then, from an `IntersectionObserver`:
  `loading="lazy"` alone started frames about 2,400 pixels early in the spike (S17).
- A redraw does not reload a running view. Before a redraw, the Workbench parks
  each live frame in a hidden container with `Element.moveBefore`, and the new
  placeholder adopts it, which keeps the frame's document. A browser without
  `moveBefore` reloads the view instead.
- A frame is kept across redraws only for the same file session, placement, view,
  record, package ID, origin, entry point, version, file count, total size and
  content digest. So an accepted change to a package's code starts its views again
  on the new code, even when the change keeps every size.
- A frame that no placeholder adopts after a redraw is ended: the Workbench points
  it at `about:blank`, which ends its renderer in about half a second (S3), and
  removes the element one second later.

### The Workbench cannot be framed

A view is a frame, and a frame can hold frames. The host cancels any frame
navigation to `app.nendo.local`, nested frames included. The Workbench also refuses
to start when `window.top !== window`: it clears its page and throws before any
other module runs. Its content-security policy is exactly:

```text
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src https://*.example
```

`frame-src https://*.example` is the only term Phase 2 added. The policy keeps the
Workbench's own document local. It does not apply inside a view's frame.

## Serving

The host serves every view from the open file
(`src/Nendo.Desktop/Extensions/ExtensionAssetServer.cs` and
`DesktopSessionController.Extensions.cs`). Nothing is written to disk.

The Workbench's browser raises `WebResourceRequested` for `https://*.example/*`,
from every resource context and every source kind, so workers and modules are
covered. The filter also matches other addresses, so the handler checks the parsed
address itself: `https`, and a host that is one label under `.example`. Anything
else is left alone. The catch-all `"*"` filter is gone, and the production gate
refuses one.

A request is answered in this order:

1. A method other than `GET` or `HEAD`: 405, with `Allow: GET, HEAD`.
2. Views are off: 403, "Custom views are off." This covers every path, the API
   script included.
3. An origin the open file does not have: 404.
4. `/_nendo/api.js`: the view API, read from the installed Workbench
   (`Workbench/_nendo/api.js`), not from the file. If the installation lacks it,
   500.
5. `/` is the package's entry point. A path that ends in `/` means that folder's
   `index.html`.
6. A file of the package: 200, with its content.
7. Anything else: 404, "Not in this package."

The path `/_nendo/` is reserved on every view origin, and a package cannot hold a
file under it. If the file cannot be read at that moment, the answer is 503, "The
file is not readable right now." Any other failure is 500.

Every answer carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
`Content-Type` is the stored media type, with `; charset=utf-8` added to a text
type. A 200 carries `Accept-Ranges: bytes`. A single byte range is honoured with
206 and `Content-Range`. Any other `Range` header, a range past the end or several
ranges, gets 416. A `HEAD` answer has no body. The host adds no content-security
policy to a view's answers.

The host knows which origin is which package from the last session view it
produced, so serving never waits behind the Workbench's own requests. The bytes
come from a content cache or from a typed Engine read, off the UI thread. The cache
holds content by its SHA-256, at most 64 MiB, and drops the least recently used
first, so cached content is never stale.

## The browser a view gets

A view gets most of what a web page gets
(`src/Nendo.Desktop/Extensions/ExtensionWebViewPolicy.cs`):

- **Network.** A view may fetch any address, loopback included, and open a
  WebSocket. Runtime 153 has no local-network gate for it (S11), and the host
  sends no content-security policy.
- **Storage.** `localStorage`, IndexedDB and the other browser stores belong to
  the view's origin. They are kept in the Workbench's browser profile on this
  device, not in the file.
- **Context menus and DevTools.** A right-click in a view opens the browser's own
  menu, with Inspect. DevTools are enabled in every build. The Workbench's own
  document keeps its own menus: the host suppresses the browser's menu when the
  click is in the Workbench, and tells the two apart by the frame's address,
  because the browser's main-frame flag is false for both (S13).
- **Script dialogs.** `alert`, `confirm` and `prompt` show the browser's own
  dialog.
- **Permissions.** The browser raises a view's permission request with the
  Workbench's origin, whichever view asked (S10). So the host answers each view
  on its own frame. A clipboard read and several automatic downloads are allowed.
  Anything else gets WebView2's default prompt. No answer is saved in the profile,
  where it would cover every view. The Workbench's own requests are denied. The
  frame's `allow` attribute delegates only the features it names.
- **Downloads.** A view may download files. The browser's own download handling
  applies.
- **New windows.** No second browser window opens. A window the person opened, by
  a click on an `http`, `https` or `mailto` link, opens in the system's default
  browser, unless it points at a view origin or the Workbench. A window a script
  opens by itself opens nowhere.
- **The top frame.** A view cannot navigate the Workbench away: the sandbox has no
  top navigation, and the Workbench's own navigation allowlist is the second line.
- **`window.chrome.webview`** exists inside a frame and reaches nothing. The host
  answers only messages whose source is the Workbench, and subscribes no frame's
  messages (S8). The production gate refuses a package source under `extensions/`
  that names it.

## The view API

The view API is `window.nendo`. The Workbench build writes it to
`dist/_nendo/api.js`, from `src/Nendo.Workbench/src/extension-api/nendo-api.ts` and
`protocol.ts`, and every view origin serves it at `/_nendo/api.js`. The broker it
talks to is `src/Nendo.Workbench/src/extension-broker.ts`. `apiVersion` is `1`.

### Loading it

A package takes it with one classic script tag, before its own scripts:

```html
<script src="/_nendo/api.js"></script>
```

The script defines `window.nendo` as a frozen object that cannot be replaced. A
second copy of the script does nothing. A page opened on its own, outside any frame,
is told so: `nendo.ready` rejects with `not-framed`, and so does every request.

### The handshake

1. On load, the script posts `{nendo: 'hello', apiVersion: 1}` to its parent
   window.
2. The broker answers a hello only from a frame the Workbench mounted, only from
   the origin it mounted that frame at, and only while views run. Anything else is
   ignored, without an answer.
3. The broker closes any earlier channel of that frame, makes a new
   `MessageChannel`, and posts `{nendo: 'connect', apiVersion: 1, context}` to the
   frame at its origin, with one end of the channel.
4. The script accepts a connect only from its parent window, with exactly one port
   and a context. `nendo.ready` resolves with the context on the first connect.
5. A later connect means the Workbench restarted the channel. Every request still
   waiting fails with `disconnected`, and later requests use the new port.

Everything after the handshake travels on the port.

### Messages on the port

| From | Message | Meaning |
| --- | --- | --- |
| View | `{t: 'req', id, m, p}` | A request. `id` is a safe integer the view chooses, `m` a method name, `p` its parameters, an object |
| Workbench | `{t: 'res', id, ok: true, r}` | The answer to request `id` |
| Workbench | `{t: 'res', id, ok: false, e: {code, message}}` | A refusal of request `id` |
| Workbench | `{t: 'evt', n, d}` | An event: `context`, `theme` or `changes`, with its data |
| Workbench | `{t: 'ping', id}` | A heartbeat. The script answers `{t: 'pong', id}` |
| View | `{t: 'ping', id}` | The broker answers `{t: 'pong', id}` |

A request without a safe-integer `id` is dropped without an answer.

### The method table

The broker has a closed method table. Each method becomes one of the Workbench's
own typed reads, or something the Workbench does for the person. Parameters are
rebuilt key by key: nothing else a view sends reaches the host, and nothing a view
sends is used as a method name, a host payload or an identity.
`scripts/extension-broker.test.mjs`, which the production gate runs with the
Workbench suite, pins the table name by name.

| Method | Parameters | Becomes | Answers |
| --- | --- | --- | --- |
| `schema.describe` | none | The Workbench's own session snapshot | [The schema](#records-and-the-schema) |
| `records.query` | `entityId`, `limit` (1–200, default 100), `cursor`, `filters`, `sortFieldId`, `descending` | `data.queryRecords` | `{items, nextCursor, changeSequence}` |
| `records.get` | `entityId`, `recordId` | `data.queryRecords` for that one record | A record, or null |
| `records.count` | `entityId`, `filters` | `data.countRecords` | The host's count |
| `records.aggregate` | `entityId`, `aggregate`, `fieldId`, `filters` | `data.aggregateRecords` | The host's exact aggregate |
| `records.groupAggregate` | `entityId`, `groupByFieldId`, `aggregate`, `fieldId`, `filters` | `data.groupAggregateRecords` | The host's grouped aggregate |
| `records.bucketAggregate` | `entityId`, `dateFieldId`, `bucket`, `range`, `aggregate`, `fieldId`, `filters` | `data.bucketAggregateRecords` | The host's date buckets |
| `records.cellAggregate` | `entityId`, `rowByFieldId`, `columnByFieldId`, `aggregate`, `fieldId`, `filters` | `data.cellAggregateRecords` | The host's grid of cells |
| `ui.openRecord` | `entityId`, `recordId` | Workbench navigation | `{opened}` |
| `ui.openScreen` | `surfaceId` | Workbench navigation | `{opened}` |
| `ui.openStudio` | `entityId` (optional) | Workbench navigation | `{opened}` |
| `ui.toast` | `text`, 1–300 characters | The Workbench's outcome line | null |
| `ui.setHeight` | `pixels` | The frame's height | `{pixels}` |

Numbers in the host's answers arrive as plain JSON numbers, which a JavaScript number
can round. A record keeps each number's exact digits in `exact`, and the aggregate
answers carry them as `valueLexeme` beside each `value`.

A filter is `{fieldId, operator, value}`, with `operator` one of `eq`, `ne`, `lt`,
`le`, `gt`, `ge`, `contains`, `isNull` and `isNotNull`, and no `value` for the last
two. The broker takes at most 64 clauses, and the host refuses a query of more than
eight. The [query contract](queries.md) has the rest: exact comparisons, cursors
that bind the file's change sequence, and no filter or sort by a calculated field.
The aggregate words are the ones the Workbench's own tiles and charts use, and the
vocabulary publishes the closed `bucket` and `range` words.

The table holds no write, no command, no proposal and no state method in this
phase. It holds none of `proposal.promote`, `proposal.reject`, `behaviour.*`,
`agent.*`, `file.*`, `session.open*`, `appearance.set` or `history.compensate`, and
never will: acceptance stays with the person. A view's reads carry no actor of
their own. They are the Workbench's reads, under its file session.

The navigation methods follow the rules a click follows. Nothing moves while
another action runs (`busy`) or while a record page holds unsaved typing
(`not-allowed`). `ui.openRecord` opens a record on its record type's Use page when
Use shows that type, beside the view when the view is that type's screen, and in
Studio's Data view otherwise. `ui.openScreen` takes a screen's root node ID, as
`schema.describe` lists it, or its surface ID; the front page is a screen too.
`ui.openStudio` opens Data, on one record type when it is named. A toast shows as
"‹view title›: ‹text›", at most one a second from one view. `ui.setHeight` bounds
the height to 80–4,000 pixels and sets it on a record-page panel; a screen fills its
area, and the answer is the height it has.

### The context

`nendo.ready` resolves with the context, and `nendo.context` holds the latest one.

| Key | Holds |
| --- | --- |
| `apiVersion` | `1` |
| `viewId` | The view's node ID |
| `kind` | `extensionGraphSurface`, `extensionRecordsSurface` or `extensionRecordPanel` |
| `placement` | `screen` or `recordPage` |
| `title` | The view's title |
| `packageId` | The package the view runs |
| `entityId` | The record type the view is about; on a record page, the page's |
| `recordId` | The page's record, for a view on a record page; null elsewhere |
| `bindings` | `labelFieldId`, `statusFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId`; `fields`, each `{fieldId, entityId}` in authored order; `filters`, each `{fieldId, entityId, operator, value, valueKind}` |
| `configuration` | The definition's configuration, parsed; `{}` when there is none |
| `theme` | `{mode, tokens}`: `light` or `dark`, and the Workbench's colour tokens |
| `locale` | The browser's language, or `en` |
| `readOnly` | True when the open file does not accept edits |
| `methods` | Every method name the broker answers, in table order |

Each field and filter names the record type that holds it: the view's own record
type first, then its link type. A filter's `operator` is already the query's word
(`le` rather than `lte`), and `valueKind` says whether `value` is the literal to
compare or a word such as `today`, which the reader resolves when it reads.

`nendo.has(name)` answers whether `methods` holds a name. A method added later is
feature-detected this way.

### Records and the schema

A record, from `records.query`, `records.get` and the loaders below:

| Key | Holds |
| --- | --- |
| `entityId`, `recordId`, `version` | Its record type, its ID and its record version |
| `values` | Plain JSON by field ID. A number is a number, a choice is its option ID, a reference is the target record's ID, and a calculated field is its value, or null when it has none |
| `exact` | The exact digits of every numeric value, stored or calculated, which a JavaScript number can round |
| `labels` | For each reference, the label of the record it points at |
| `calculated` | Each calculated field: `state` (`value`, `empty`, `error` or `pending`), `value`, `exact`, `errorCode`, `errorMessage` |

`schema.describe` answers `{purpose, changeSequence, entities, screens, commands}`:

- Each entity is `{entityId, displayName, fields}`. Each field is `{fieldId,
  displayName, storageKind, required, presentation, calculated, expression, choices,
  reference, scale}`. A calculated field has `calculated: true`, its formula in
  `expression` and its result type as `storageKind`. Each choice is `{id,
  displayName, retired, tone}`. Retired record types and fields are left out.
- Each screen is `{id, surfaceId, kind, title, entityId}`: a root node of the file.
- Each command is `{id, entityId, label}`.

The script adds three readers on top of the table. None of them is a method of its
own:

- `nendo.records.queryAll(query, {max})` pages through `records.query`, 200 at a
  time, up to `max` records (default 10,000). When the file changes between pages
  (`stale-cursor` or `invalid-cursor`), it reads again from the top, at most three
  times, and then fails with `stale-cursor`.
- `nendo.view.loadRecords()` reads the records the view is about: its record type
  under its authored filters, with `today` and `now` resolved as it reads, or on a
  record page that page's one record.
- `nendo.view.loadGraph()` reads the view's records as nodes and its link records
  as edges: `{nodes, edges, fields, hiddenEdges}`. A node is `{id, label, status,
  values, record}` and an edge `{id, source, target, values, record}`. `values`
  holds the fields the view binds on that record type. An edge whose source or
  target is not among the nodes is left out and counted in `hiddenEdges`. `fields`
  names each bound field with its record type, display name and storage kind. The
  label is a reference's target label, a choice's display name, a number's exact
  digits, or the text.

### Events

`nendo.on(name, listener)` subscribes and returns a function that unsubscribes. A
name other than these three throws `unknown-event`.

| Event | Data | When |
| --- | --- | --- |
| `context` | The context | On every connect, and when the view's context changes, for example after its definition changed |
| `theme` | `{mode, tokens}` | When the person's theme changes between light and dark |
| `changes` | The file's change sequence | When anything commits to the open file: at most one every 250 ms to one view, carrying the latest sequence |

`nendo.changes.subscribe(listener)` is the same as `nendo.on('changes', listener)`.
An event is a nudge: the view decides what to read again.

The script applies the theme itself, before any listener runs. It sets each token
as a custom property on the document's root, `--nendo-‹name›`, and sets
`data-nendo-theme` to the mode. It also adds a `color-scheme` meta element after
any of the view's own, so a view that states its own scheme keeps it. The tokens
are `canvas`, `surface`, `surface-raised`, `surface-soft`, `ink`, `muted`, `line`,
`line-strong`, `cobalt`, `cobalt-soft`, `violet`, `healthy`, `warning`, `danger`,
`shadow`, and the eight choice tones `tone-red`, `tone-orange`, `tone-amber`,
`tone-green`, `tone-teal`, `tone-blue`, `tone-violet` and `tone-grey`, with the
values the Workbench's stylesheet gives the theme in effect. `nendo.ui.theme`
holds the latest theme.

### Limits

| Limit | Value |
| --- | --- |
| Parameters of one request, as UTF-8 JSON | 256 KiB |
| Requests in flight for one view | 8. The script holds further requests back, so a busy view is slowed rather than refused |
| Requests waiting at the broker for one view | 64. The next one is refused as `busy` |
| `changes` events | At most one every 250 ms to one view |
| Toasts | One a second from one view, 1–300 characters |
| Heartbeat | A ping every 5 s while no ping waits |
| Not responding | A ping has waited 2 s and the view has said nothing for 10 s |
| Height | 80–4,000 pixels; a record-page panel starts at 360 |
| A page of records | 1–200 records, 100 by default |

The in-flight bound keeps a busy view from starving a person's own save of the
Workbench's bridge.

### Refusals

A refused request rejects with a `NendoError`, which carries a stable `code` and a
sentence.

| Code | From | Meaning |
| --- | --- | --- |
| `unknown-method` | Broker | The name is not in the method table |
| `invalid-params` | Script or broker | The parameters are not a JSON object, or one of them breaks its rule |
| `too-large` | Script or broker | The parameters take more than 256 KiB |
| `busy` | Broker or Workbench | 64 requests already wait, a second toast came within a second, or another action is running |
| `views-off` | Broker | Views were off when the request ran |
| `not-allowed` | Workbench | A record page holds unsaved changes, so Nendo stays where it is |
| `not-found` | Workbench | The record type or the screen is not in this file |
| `disconnected` | Script | The Workbench reconnected the view while the request waited. Send it again |
| `not-framed` | Script | The page was opened on its own, outside any frame, so nothing can connect it |
| `unknown-event` | Script | `nendo.on` was given a name other than `context`, `theme` or `changes` |
| `failed` | Broker | The answer could not be sent, or the failure had no code |

A read the host refuses keeps the host's own code, for example `validation`,
`stale-cursor`, `invalid-cursor` or `stale-file-session`.

## When a view fails

A view's failure stays with the view. Only the Workbench's own processes going away
send the app to recovery: `BrowserProcessExited`, and `RenderProcessExited` or
`RenderProcessUnresponsive` of the Workbench's own renderer. The browser restarts a
GPU or utility process by itself, and the Workbench is not told.

- **A crash.** When a view's renderer exits, the browser reports
  `FrameRenderProcessExited` with the names of the frames it held: every frame of
  that package, because they share the renderer (S4). The host sends the Workbench
  the event `extensionFramesFailed`. Each named view shows "This view stopped. Its
  page ended unexpectedly; the rest of Nendo is unaffected." with Reload. Reload
  loads the same frame again, in a new renderer.
- **A hang.** Nothing in the browser reports a spinning frame (S2), so the broker
  pings each view every 5 seconds. A view that has waited 2 seconds on a ping and
  said nothing for 10 seconds shows "This view is not responding." with Stop and
  Reload. It clears when the view answers again.
- **Stop** points every frame of that package at `about:blank`, which ends a
  spinning renderer in about half a second (S3), and removes them. Each shows
  "This view is stopped." with Reload.
- **Reload** of a view that was not responding ends every frame of its package
  first, and starts them again a second later, once the renderer has gone.

The placeholder's `data-view-state` says where a view is: `waiting`, `starting`,
`running`, `unresponsive`, `stopped` or `crashed`, or the notice it shows instead
(see [Studio](#studio)).

If a view brings the whole Workbench down, the native recovery panel offers
**Restart view** and **Restart without custom views**.

## Kill switches

A view that is shown runs. Views are off when any of these holds:

| Switch | Off reason | Where | Kept |
| --- | --- | --- | --- |
| **Run custom views** is off | `device` | Studio → Surfaces → Custom views | In `extension-settings.json`, for every file on this device |
| **Run this file's views** is off | `file` | Studio → Surfaces → Custom views | In `extension-settings.json`, by the file's application ID |
| The file's health is not `normal` | `health` | Health says why | While the file is read-only or needs recovery |
| **Restart without custom views** | `recovery` | The native recovery panel | Until **Run custom views** is turned on again or Nendo starts again; never saved |

When more than one holds, `offReason` names the first of `recovery`, `device`,
`file` and `health`, in that order.

Safe mode and recovery never run a view. A recovery session view carries no
`extensions`, and closing the file, a recovery view and a change of file session
each stop every view origin of the file.

Each switch is enforced twice: the Workbench mounts no frame, and the host answers
403 on every view origin, the API script included. A frame inserted by hand gets
the 403. The broker also connects no view while views are off, and refuses every
request with `views-off`. A view that is running when views go off loses its frame
at the next redraw, which the switch itself causes.

`extension-settings.json` sits in the device-state root, `%LocalAppData%\Nendo`
unless `NENDO_DEVICE_STATE_ROOT` names another. It is device preference, never
application data, so a file cannot turn its own views on, and a received file
cannot turn off anyone else's. Both switches default to on. The store holds at
most 256 KiB and 4,096 files. If it cannot be read, views run with the defaults
for the session, and the panel says: "The saved custom view settings could not be
read. Views run with the defaults for this session." If a change cannot be saved,
it applies for the session, and the panel says so.

The session snapshot carries the switches and the packages as `extensions`:

```text
extensions: {
  run, offReason (recovery | device | file | health, or null),
  deviceEnabled, fileEnabled, notice,
  packages: [{ packageId, title, version, entryPoint, description,
               origin, fileCount, totalBytes, contentDigest }]
}
```

The host computes each `origin`. `contentDigest` is 16 hex characters that change
whenever any file's content or path, or the entry point, changes. `extensions` is
absent when no file is open and in a recovery session view.

## Studio

**Studio → Surfaces → Custom views** is the panel for views. **File → Custom
views…** opens it. It shows:

- whether views run here, as **Running** or **Off** with the reason in words;
- **Run custom views again**, when views are off after a restart without them;
- the host's notice about the switches, when there is one;
- the two switches: **Run custom views** ("On this device, for every file") and
  **Run this file's views** ("On this device, for ‹file name›");
- **Packages in this file**: each package's title, ID, version, file count, size
  and description, with **Export…** and **Remove…**;
- **Import package…**: "A folder, a .zip or a .nendoview file. Importing prepares
  a proposal; nothing runs until you accept it."

The switches are device settings, like the theme. They never reach the file, and
they stay usable in a file opened read-only, because turning views off is how a
person gets away from a view that misbehaves. Import and removal change the file's
definition, so each opens a proposal in Studio's review. Back returns to where it
began, and accepting a proposal that only brings code returns there too.

**Studio → Health** has a Custom views card: Running, or Off with the reason, and
how many packages the file carries.

Where a view cannot run, its placeholder says why, with the one step that changes
it:

| Notice | Says | Step |
| --- | --- | --- |
| `off`, device or file | "Custom views are off on this device." or "…off for this file on this device." | **Open Custom views** |
| `off`, health | "Custom views do not run while this file needs attention." | **Open Health** |
| `off`, recovery | "Custom views are off because Nendo was restarted without them." | **Run custom views again** |
| `missing` | "‹package› is not in this file, so ‹title› has no code to run." | **Add package to file…**, which is Import |
| `preview` | Custom views run in Nendo Desktop, not in the browser preview of the Workbench | None |
| `unservable` | The package has no address Nendo serves views from | None |
| `unavailable` | "Custom views are not available in this session." | None |

## Import, export and remove

**Import** (`extension.import`) opens a native file picker for `.json`, `.zip`
and `.nendoview` files, with the button **Add to file**. Picking a folder's
`nendo-package.json` means that folder. A zip or a `.nendoview` means itself. The
host reads the whole package, off the UI thread, and bounds it before it proposes
anything (`src/Nendo.Engine/Extensions/ExtensionArchive.cs`):

- **A folder** brings every file under it except `nendo-package.json` itself,
  hidden and system files, links (never followed), and any path with a segment that
  starts with `.` or is `node_modules`.
- **A zip** has its `nendo-package.json` at its root or inside its single top-level
  folder, the way zipping a folder leaves it. Entries outside that folder are
  ignored.
- **A `.nendoview`** from the contained slice has a `manifest.json` instead. Its
  package ID, version and entry point come from that manifest, and its title is its
  package ID. Its files are taken as they are, not converted.

`nendo-package.json` is a JSON object of at most 64 KiB. Comments and trailing
commas are allowed, and keys other than these are ignored:

| Key | Rule |
| --- | --- |
| `packageId` | Required. A package ID by the rule above |
| `title` | Default: the package ID |
| `version` | An optional semantic version |
| `entryPoint` | Default: `index.html`. It must be one of the package's files |
| `description` | Optional |

The manifest is never stored as a file: the package row holds what it says.

A package that cannot be carried is refused by name before anything is proposed:
more than 512 files, more than 16 MiB, a file over 4 MiB, a path the rules refuse,
two paths equal apart from case, no files, an entry point that is not one of the
files, a manifest that is missing or not a JSON object, or an invalid package ID.

The proposal holds `extension.setPackage`, then a removal of each file the package
holds and the source lacks, then a put of each file that is new or differs by its
SHA-256 or its media type. Each put and removal names the content it replaces, or
`absent`, so a proposal prepared against an older package is refused rather than
replayed over a newer one. A file the package already holds byte for byte is left
alone, so importing an edit proposes only the edit. If nothing differs, the import
is refused with `extension-unchanged`: "The file already carries ‹title› exactly as
it is here." The proposal is titled "Add the custom view package ‹title›" or
"Update the custom view package ‹title›". The 4 MiB bound on new content in one
change set applies to it.

**Export** (`extension.export {packageId}`) reads the package and every file's
bytes, then opens a native folder picker, with the button **Export here**. It
writes the files to a new folder named by the package ID inside the folder
picked, and a `nendo-package.json` that names the package ID, title, version,
entry point and description, so exporting and importing again gives the same
package. It refuses when a folder of that name already holds anything
(`extension-export-exists`). Nothing in the file changes. The answer names the
folder, never a path.

**Remove** (`extension.remove {packageId}`) prepares a proposal, "Remove the custom
view package ‹title›": a removal of each file, with the content it expects, then
`extension.removePackage`. After acceptance, a view that names the package shows
the `missing` notice. The content stays in history, and the revision can be
compensated.

## Host methods and events

The Workbench reaches the host over the bridge (protocol 7) with these methods:

| Method | Payload | Answer |
| --- | --- | --- |
| `extension.settings.set` | `{scope: 'device' \| 'file', enabled}` | The session view, with `extensions`. Turning the device switch on also ends a restart without custom views. Another scope is refused (`validation`), and the file scope needs an open file (`no-file-open`) |
| `extension.import` | `{}` | A proposal preview, or `{cancelled: true}` |
| `extension.export` | `{packageId}` | `{exported, fileCount, folderName}`; `exported` is false when the person cancels |
| `extension.remove` | `{packageId}` | A proposal preview; `extension-package-not-found` for a package the file does not carry |
| `diagnostics.frameProcesses` | `{}` | Only when `NENDO_NATIVE_DIAGNOSTICS=1`, otherwise `unknown-method`: each browser process with its ID, kind, private working set in bytes and the frames it holds, each `{name, source}` |

The host sends one event of its own for views. `extensionFramesFailed` carries
`{fileSessionId, frames}`, the names of the view frames whose renderer ended. The
Workbench ignores it for another file session, and ignores a payload with no
frames, more than 256, or a name that is not `nendo-view-` and twelve hex digits.
A view's `changes` events come from the existing `fileChanged` event.

## View definitions

A view definition is a node in the file's semantic surfaces, authored through the
ordinary `ui.addNode`, `ui.setProperty` and `ui.removeNode` operations in a change
set that a person accepts. There is no second pipeline. A definition names its
package by `packageId`, and the view runs that package from the file.

### The three kinds

| Kind | Where | Required | Optional | Children |
| --- | --- | --- | --- | --- |
| `extensionGraphSurface` | A root, up to eight per record type | `definitionVersion` (3), `entityId`, `title`, `packageId`, `labelFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId` | `statusFieldId`, `configuration` | `fieldBinding`, `filterClause` |
| `extensionRecordsSurface` | A root, up to eight per record type | `definitionVersion` (3), `entityId`, `title`, `packageId`, `labelFieldId` | `statusFieldId`, `configuration` | `fieldBinding`, `filterClause` |
| `extensionRecordPanel` | A child of a `detailSurface`, a `recordForm` or a `section`, inside a tab too | `title`, `packageId`, `labelFieldId` | `statusFieldId`, `configuration` | `fieldBinding` |

Each kind also accepts `packageVersion`, `packageDigest`, `protocolVersion` and
`configurationVersion`, the pins earlier hosts required. They are kept when present
and read by nothing.

- A graph's node type is its `entityId`. Its links are records of `edgeEntityId`,
  whose two distinct active Reference fields `sourceFieldId` and `targetFieldId`
  both target the node type.
- A record set names no edge type: `edgeEntityId`, `sourceFieldId` and
  `targetFieldId` are refused.
- A record-page panel takes its record type from the page it is on and names no
  `entityId`, no edge type and no filter. It must sit inside a record page or a
  record form, through any sections and tabs. A page carries as many as it likes.
  Its `fieldBinding` children are the view's, never the form's: the compiled plan
  carries the panel with no children, so no walk of the page takes them for fields
  to edit.

### Fields and filters

- `labelFieldId`, `statusFieldId` and every `fieldBinding` may name any active
  field of the view's record type, stored or calculated. A graph's `fieldBinding`
  may also name a field of its edge type; the field's own record type decides
  which. A field is shown once.
- A `filterClause` has `fieldId`, `operator`, an optional `valueKind` (default
  `literal`) and a `value`. It names an active stored field of the view's record
  type, or of a graph's edge type: a calculated field is shown, not filtered. The
  operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull` and `isNotNull`, and
  the value kinds `literal`, `today`, `now` and `null`, the same words every screen
  uses. A literal must suit the field. `isNull` and `isNotNull` take no value.
- A view carries at most 64 `fieldBinding` and `filterClause` children together.
  Every read under its filters meets the host's bound of eight filters in one
  query.

### Configuration

`configuration` is optional JSON text holding an object, at most 16 KiB of UTF-8
and 32 levels deep. Without it, a view's configuration is `{}`. The host does not
interpret it. The view reads it, parsed, as `context.configuration`.

### Host rungs

A definition keeps the rung its shape needs. The first four rows apply to a view
that the 1.32 rules accept:

| Shape | Minimum host |
| --- | --- |
| An `extensionGraphSurface` | 1.29.0 |
| A view that declares `protocolVersion` 2 | 1.30.0 |
| An `extensionRecordsSurface` | 1.31.0 |
| An `extensionRecordPanel` | 1.32.0 |
| A view that only the open rules accept | **1.34.0** |

A view needs 1.34.0 when it says something the 1.32 rules refused
(`src/Nendo.Engine/SemanticCapability.cs`):

- it lacks any of `packageVersion`, `packageDigest`, `protocolVersion`,
  `configurationVersion` or `configuration`;
- its configuration is an object with anything in it;
- it is at protocol 1 and has children;
- a filter's value kind is not `literal`;
- its page carries more than four panels;
- it binds more than sixteen fields, or more than eight of one record type;
- its label is not a stored Text field, or its status not a stored field other
  than a Reference;
- it binds or filters by a field that is not stored on its record types, such as a
  calculated one.

A definition that the earlier rules accept keeps its earlier rung, because raising
it would disable editing in the host that opened it. A file that carries a package
needs 1.33.0 in any case. As everywhere, the review shows a raise as its own
irreversible entry, and the host never lowers a recorded minimum.

### Review

The review names a view and each of its properties in a sentence:

- "Add a custom graph view. It runs its package's code from this file when shown;
  records remain available in Studio."
- "Add a custom view of these records as typed columns. It runs its package's code
  from this file when shown; records remain available in Studio."
- "Add a custom view of each record to its page. It runs its package's code from
  this file when the page shows it, and the page stays editable."
- `packageId`: "Draw this view with the package ‹id› carried in this file."
- A pin: "Keep the earlier pin ‹property›; this host reads the package from the
  file instead."
- `configuration`: "Give the view this configuration, which its code reads:
  ‹configuration›"
- `labelFieldId`: "Label each graph node with ‹field›." or "Label each record with
  ‹field›."
- `statusFieldId`: "Show ‹field› as each record's status."
- A `fieldBinding` under a view: "Show ‹field› in the custom view "‹title›"."
- The graph's edge type and its two references: "Read graph relationships from
  ‹type›.", "Follow ‹field› to each edge's source node." and "Follow ‹field› to each
  edge's target node."

A binding is not a permission. The view's code reads through the file's API.

### Diagnostics

| Code | Severity | Meaning |
| --- | --- | --- |
| `NUI450` | Error | The definition names a package, a record type, a label, fields or filters that do not exist or break the rules above. The message names which. "Name a package, a record type and fields that exist; the view's code reads the rest through the file's API." |
| `NUI452` | Warning | "The package ‹id› is not in this file, so the view has no code to run yet." Remedy: "Add the package to the file: Studio → Surfaces → Custom views → Import, or extension.setPackage and extension.putFile in a change set." The view says the same where it is shown |
| `NUI013` | Error | A child kind its parent does not take, as for every node |

The definition is sound without its package: it can be reviewed, accepted, copied
and reopened without it. `NUI451` and the binding digest are retired.

### Removal and retirement

Removing a view never removes records. The removal of a view root with no children
can be compensated from History while the definition revision has not moved since.
To retire a record type or a field that a view binds, the same proposal must remove
or replace the view (`retired-binding`).

## What a view cannot reach

View code cannot:

- reach the Workbench's document: it is another origin, and `parent.document`
  throws;
- reach the host bridge: `window.chrome.webview` in a frame reaches nothing;
- use SQL, a file path, another file or a device setting: the method table has no
  such method;
- use Nendo's MCP endpoint, which refuses a request whose `Origin` is not its own
  ([ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md));
- navigate the Workbench away, load the Workbench in a frame, or connect a window
  it made to the broker;
- write records, run commands, prepare a proposal or keep state in the file (not
  yet: Phase 3);
- accept or reject a proposal, ever.

Studio never hosts extension code, and it stays reachable. A file with automatic
actions still needs this device's behaviour approval
([ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md))
before any write. View code needs no approval of its own.

## Compatibility

- A file that carries packages needs host 1.33.0. A view that only the open rules
  accept needs 1.34.0. `extensionView` and `extensionTile` will need 1.35.0, and
  are not yet delivered.
- An older host refuses writable open of such a file by the rung rule of
  [ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md). There is
  no downgrade in place.
- A file without packages gains no table and keeps its layout.
- A definition authored for the contained slice keeps working as a definition. Its
  pins are kept and ignored, and it runs the package the file carries under its
  `packageId`, whatever version or digest it pinned. Until the file carries that
  package, the view compiles with `NUI452` and shows the `missing` notice.
- A `.nendoview` archive from the contained slice still imports. Its code spoke the
  retired `window.chrome.webview` protocol, which nothing answers in a frame, so it
  draws nothing until it is ported to `window.nendo`. The four packages under
  `extensions/` are ported.
- The contained slice's device state is obsolete: `extension-packages/` (the
  package cache), `extension-grants.json` (device consent) and `extension-runs/`
  (the helper's run folders), all in the device-state root. This host neither reads
  nor writes them, and leaves them where they are.

## Evidence

### Phase 2

The live journey `DesktopExtensionViewJourneyTests`, with
`tools/Review-ExtensionViews.mjs`, launches the real app with an isolated device
state and browser profile, and a file of three probe packages: a record-set screen
and six record-page panels. It drives the page and each frame over the browser's
debugging port, and reads which process holds which frame from
`diagnostics.frameProcesses`, so it needs no pointer and no foreground. It passed on
2026-09-25, against a Debug build, with these measured lines:

- G18: a view reads records with calculated values and exact decimals, and knows
  it is a screen.
- G10: `parent.document` throws, top navigation is refused, a nested Workbench
  stays `about:blank`, and a forged hello is ignored.
- G11: a view fetches loopback, opens a WebSocket and keeps `localStorage`. G12: the
  Workbench document stays local.
- G13: a write reaches the view as a change, and the redraw keeps its document.
- G15: seven views from three packages run in three renderers apart from the
  Workbench: 46.3 MiB of view renderers, 240.3 MiB in all. The journey asserts the
  spike's budget, at most 160 MiB and 420 MiB.
- G8: while a view spins, the Workbench answers in at most 1 ms, from another
  process.
- G14: a spinning view shows not responding after 10,177 ms, and Stop ends its
  renderer in 630 ms.
- G9: a crashed renderer marks its views, leaves the Workbench running, and Reload
  starts them again.
- G16: with views off for the device or the file, no frame is drawn, and a frame
  inserted by hand gets the 403.

The journey is a Desktop test, so `Test-Production.ps1` runs it with the other .NET
tests. `tools/Test-ExtensionInstalledJourney.ps1` runs the same journey against the
published payload as setup installs it. This contract records no run of that lane.

The lanes that cover the parts:

- `DesktopExtensionServingTests` (Desktop): origins, serving from the open file,
  403 and 404, both switches, the restart without views, closing the file, import
  and removal as proposals, code waiting in a proposal not served, and byte ranges.
- `ExtensionArchiveTests` (Engine): folders, zips and legacy archives, refusal by
  name, a re-import that proposes only what changed, and an export that imports as
  the same package.
- `ExtensionViewDefinitionTests` (Engine): open definitions and their rungs, a view
  that keeps its earlier rung, panels, filters, `NUI452`, the review lines and the
  trust line, the configuration bound, and a removal that keeps records.
- The Workbench suites `view-frames`, `extension-broker`, `extension-api` and `csp`:
  frame attributes, notices, overlays, the mount key, the closed method table, the
  handshake, the caps, the context, the theme tokens, the loaders, the policy and
  the refusal to be framed.

The [Phase 0 spike](../../prototypes/iframe-views/FINDINGS.md) measured the
browser particulars (S1–S22) on a synthetic harness, not the Workbench, on
2026-09-25 with WebView2 runtime 153.

Not measured in a product lane: the clipboard, downloads, pop-ups, script dialogs,
DevTools and context menus in a view (the spike measured them, S10, S13, S15, S19
and S22); the memory budget against the four real packages rather than the probes;
and every property of Phases 3 to 5.

### Phase 1

`ExtensionPackageTests` (26 cases, Engine lane), `ExtensionPackageProtocolTests`
(2 cases, LocalMcp lane) and `package-diff.test.mjs` (3 cases, Workbench lane)
passed. Each guard below was falsified, seen to fail and then restored:

- With the bytes put back into the canonical payload:
  `The history row for a 300 KB file is 400336 characters; it carries the bytes rather than their hash.`
- With the reserve put back at 4 MiB:
  `A package commit of 4194304 content bytes grew the file by 4308992 bytes against a reserve of 4194304.`
- With an integrity check that never reads the content:
  `Expected exception type:<Nendo.Engine.NendoRecoveryRequiredException> but no exception was thrown.`
- With the diff computed against the clone on both sides, the replaced file
  vanished from the review: `Sequence contains no matching element`.
- With a reversal that restored the applied content instead of the previous one:
  `Content efbeb26b7d6b5954cceef4b8f5fa5a58a06a5f302da8da0d481eb33d7fde8999 is not 90 bytes long.`
- With the MCP adapter not joining the parts,
  `AMegabyteFileArrivesInPartsAndReadsBackExactly` failed.

## History

- 2026-09-20 — the bounded slice: a read-only view in a contained helper process,
  `Nendo.ExtensionHost`, in a zero-capability AppContainer and a Job Object, with
  its own WebView2. Packages were `.nendoview` archives in a device cache, pinned by
  digest, installed and then allowed through native consent for each file and view.
  The view opened in a native pane beside the Workbench and spoke a closed message
  protocol over `window.chrome.webview` (`ready`, `selectRecord`, `reportError`).
  `extensionGraphSurface` at host 1.29.0.
- 2026-09-21 — the pane's boundary could be dragged; the contained window stopped
  moving during a drag, because resizing it along a drag exhausted its memory
  allowance.
- 2026-09-24 — protocol 2 (disclosed fields and literal filters, 1.30.0), a
  record-set shape (`extensionRecordsSurface`, 1.31.0) and a record-page placement
  (`extensionRecordPanel`, 1.32.0), started on request and one at a time per
  window, because a running view measured 219 to 270 MiB.
- 2026-09-25 — Phase 1, product 0.13.0: packages in the file at host 1.33.0,
  reviewed as code and read back over MCP. Nothing ran them.
- 2026-09-25 — Phase 2, product 0.14.0: views run inline from the file as frames of
  the Workbench, with `window.nendo`, the kill switches and open definitions at host
  1.34.0. Deleted: the contained helper, the device package cache, device consent,
  digest pins, the native pane and its splitter, the message protocol, the host's
  graph projection read and the `extension.panel.*` methods.
