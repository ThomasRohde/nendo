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

- the `extensionTile` on the front page and dashboards (Phase 5; the `extensionView` root
  of the same phase is delivered, below).

Nothing in this contract describes them as available.

## The trade

A view that is shown runs. A received file's code therefore runs when its view is
shown, and nobody on this device has read it: a proposal's code is reviewed only
where the change was made. At the Unattended access level, an agent can accept its
own package proposal, so its code can run before anybody reads it.

A view's code can read every record of its file through Nendo, reach the network
(loopback included), read and write the clipboard, read a file the person chooses or
drops on it, and download files. It cannot
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
| `__nendo_extension_state` | `package_id`, `view_id`, `state_key`, `value_json` of at most 64 KiB, `version`. Created with the others. Written by `nendo.state` through `extension.setState` ([below](#state)) |

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
`ReversibleWithRetainedState`. Each raises the file's minimum host to 1.33.0, and
`extension.setPackage` with `kind: "skill"` to 1.43.0 ([Skill packages](#skill-packages)).

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
not overwritten. The package's metadata is checked the same way: the inverse of a
metadata change expects the title, entry point, version and description that the
change left, and the inverse of a removal expects no package. A package whose
metadata changed since, or that was created again, refuses the compensation as
`extension-package-changed`, so an older undo never replaces the entry point a
newer change chose. An exact retry of a compensation that succeeded returns its
receipt and runs nothing again.

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
| `extension-package-changed` | A compensation finds the package's metadata, or its absence, different from what the reversed revision left |
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
- "Add the skill package ‹title› (‹id›): instructions for an agent, read from
  SKILL.md, offered as the skill ‹name›. Nothing in it runs." and "Update the skill
  package ‹title› (‹id›)", ending ": it is version ‹version›." when a version is set.

A proposal that puts any file into a view package also carries one more line, once,
as its own entry (`extensionCode`): "This code runs when a view that uses its package
is shown. It can read and change this file's records through Nendo, reach the network
and use the clipboard." The line states the whole ADR's grant. A proposal that puts a
file into a skill package carries its own line instead, or as well (`extensionSkill`):
"These are instructions for an agent working on this file. Nendo never runs them; an
agent's client offers them to its model when the agent connects, after asking you if it
asks at all. Read them as you would read instructions given to someone editing your
file."

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
change continues past what the review shows. Each file is a disclosure that starts
folded. Folded, it still shows its path, what happened to it, its sizes and, for text,
how many lines it adds and removes, so a long list reads as an overview, and a change cut
short says "longer than the review shows" there too. The lines open by pointer or keyboard
(W-098). The MCP preview carries the same list.

**Reading a proposed file whole** (review R-017, 2026-10-06). Every file a proposal adds or
replaces offers *Read the whole file*. The Workbench calls the host's
`proposal.readPackageFile` with `proposalId`, `reviewedDigest` (the digest on screen),
`packageId`, `path`, `offset` and `length` (1 to 262,144 bytes). The host answers from the
copy the proposal was validated on, never from the active file: `{mediaType, sha256,
totalBytes, offset, content}` with `content` in base64 and `sha256` the whole file's. It
refuses a digest other than the one reviewed (`idempotency-conflict`), a proposal that is not
waiting for review, and a file the proposal removes or does not touch. The Workbench puts
the windows together, checks them against `sha256`, and shows valid UTF-8 as text in its own
dialog with Copy, or the size and digest of anything else. A view cannot call it: it is not
in the broker's table. Accept stays bound to the same digest.
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

A third, `nendo://application/view-api`, is [the view API as a read](#the-view-api-as-a-read):
what a view's code can call, for an agent about to write one.

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

### Skill packages

Host rung **1.43.0**, [ADR-0024](../decisions/0024-a-file-carries-its-own-agent-skill.md),
W-160. A package of kind `skill` holds instructions for an agent instead of a view's
code: a `SKILL.md` at its root and any supporting files beside it, in the Agent Skills
format. It has no entry point, and nothing in Nendo runs it. It is written, reviewed,
accepted, reversed, imported and exported as every package is.

- `extension.setPackage` takes `kind`: `view` (the default, every package before it)
  or `skill`. A skill package names no `entryPoint`: one is refused where the
  operation is sent, naming the file it names. The skill's name is the last segment
  of the package ID, so that segment must be a skill name: lowercase letters and
  digits in hyphen-separated runs, at most 64 characters. A package keeps the kind
  it was created with; setting the other kind is `extension-package-kind`.
- At validation, every skill package the file would carry, not only the ones the
  change set touches, holds a `SKILL.md` that opens with frontmatter: a line `---`,
  `name:` equal to that last segment, `description:` of 1 to 1,024 characters, and a
  closing `---`. A missing file, missing frontmatter, another name or no description
  is `NPROP012`, an error naming the file, with the package ID as its semantic ID and
  `SKILL.md` as its property path. The proposal is `Invalid`.
- A view that names a skill package does not compile (`NUI454`). A write in a skill
  package's name is `actor-not-allowed`, and view state for one is refused.
- The kind is a row in `__nendo_extension_kind` (`package_id`, `kind`), the ladder's
  last rung after the new-file tables. The first skill package creates it, so a file
  of view packages keeps its layout and host. The package table's text is fixed by
  released layouts, so a skill package's required `entry_point` holds `SKILL.md`; every
  read takes the kind from the new table and gives a skill package no entry point.
  The layout is
  `production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-v1`,
  with its `production-p1-` twin, and open refuses a `-skill-` layout stating less than
  1.43.0 as `layout-version-mismatch`.
- A view package's canonical payload is unchanged: `kind` is written only for a skill,
  so no earlier digest moves.

The local MCP host lists each skill package in `skills/list` after its own
`nendo-authoring` skill, and serves its files under `skill://{packageId}/{name}/` with
the digests of the stored bytes ([MCP interface](mcp-interface.md)). The Desktop host
lists a skill package with no origin, so nothing serves it to a frame, and it cannot be
developed from a folder.

### Help pages

[ADR-0027](../decisions/0027-a-file-carries-its-own-help.md). Every file under `help/`
whose name ends in `.md`, in any package the file carries, is one of the file's help pages,
shown first under *About this app* in Help ([Help contract](help.md)). Nothing about the
package changes: the pages are package files, written, reviewed, accepted and exported as
every file is, and served to the package's own frames like its other files. The Desktop
host reads them for Help with `help.readPages`; an agent reads them as any package file,
under `nendo://application/extension/{packageId}/file`. Nothing in them runs, and Help
renders them through the Workbench's Markdown renderer, which escapes every character first
and does not follow links. A page larger than 128 KiB, past the fortieth, past 1 MiB together
or not UTF-8 is left out of Help and counted in `omitted`.

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
- **A screen of the file** (`placement` `screen`, W-106). An `extensionView` root
  belongs to the file, as the front page does. The first picker of the Use
  breadcrumb lists the front page, then each view of the file in authored order,
  then the record types, and the view's frame fills the screen. The view's declared
  controls share the row under the address row. Nendo's Add is there only when the view
  names an `add`, because a view of the file has no record type of its own to add to.
  Back and Forward know it as a place, `ui.openScreen` opens it by its node ID, and
  Studio lists it under *Screens of the file*.
- **The screen a file opens on.** `opensFile: true` on one `extensionView` makes the
  file open on it, rather than on the front page or the first record type. When
  custom views do not run in the file (the device or file switch, safe mode, a
  restart without custom views, the file's health), the file opens as if no view
  said so, and the view keeps its place in the picker with its notice.
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

Step 5 has a development step in front of it (Phase 4, see
[Developing from a folder](#developing-from-a-folder)): a package this device develops
answers from its folder instead of the file, by the same rules from step 5 on. A folder
that no longer reads as a package is answered 503 with the reason as plain text, never
with the file's code.

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
- **Downloads.** A view may download files. Each goes to the person's Downloads
  folder under a name that overwrites nothing, `Name (1).xml` beside `Name.xml`, and
  WebView2's own downloads panel never opens (F-237). That panel opened when a view
  saved an `.xml` file from a command in Nendo's row, which carries no click into the
  view, to ask whether the file "can harm your device"; after Keep the browser
  process spun and Nendo's window stayed white until every one of its processes was
  ended. So the browser's question about a file type is not asked, and the view says
  what it saved. When the file is complete, Nendo says so in its own notice line, with
  the file's name, its folder and **Show in folder**, which opens Explorer on it. The
  host posts `downloadSaved` with an identifier, and `downloads.show` takes that
  identifier, so the page never hands the host a path.
- **Files a person hands it** (W-104). A view's own `<input type="file">`, clicked
  by the person, opens Windows' Open dialog, owned by Nendo's window. The chosen
  file arrives as a `File`, with its name, size and bytes, never its path. `accept`
  filters the dialog, whose *All files* stays, so a view checks what it got. Cancel
  reaches the view as the input's `cancel` event. Nendo sets no size limit: the view
  reads the file in its package's own renderer. The browser refuses
  `showOpenFilePicker`, `showSaveFilePicker` and `showDirectoryPicker` to a frame of
  another origin, so a view never holds a file it could write back to; it saves by
  download.
- **The clipboard from a command** (W-123). A command chosen in Nendo's row reaches a view
  whose frame does not have focus, and the browser refuses a clipboard write there:
  "Document is not focused." A view that writes the clipboard from a command calls
  `window.focus()` first. A key pressed inside the view leaves the focus there, so its
  command needs nothing more.
- **Drops** (W-104). A file dragged over a view is the view's. It takes the file by
  cancelling `dragover` and reads the drop's `dataTransfer.files`. A view that does
  not take drops lets one fall: nothing opens and nothing moves. Nendo's drop hint
  (`.file-drop-target`) takes no pointer, so it shows while the drag is over Nendo's
  own parts and steps aside over a view. A file dropped on Nendo's parts is Nendo's,
  as before: a Nendo file opens, and another is refused by name.
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
| View | `{t: 'key', keys}` | A key pressed inside the view that is one of Nendo's own, or one its toolbar declares, normalised (`Ctrl+K`). The Workbench runs it as if it had been pressed there, and nothing answers ([Nendo's toolbar, menus and keys](#nendos-toolbar-menus-and-keys)) |

A request without a safe-integer `id` is dropped without an answer.

### The method table

The broker has a closed method table. Each method becomes one of the Workbench's
own typed reads, one of the four record writes a person's edit uses, a move in a
declared tree or several record writes as one revision, preparing or
reading a proposal of the view's own package, or something the Workbench does for the
person. Parameters are
rebuilt key by key: nothing else a view sends reaches the host, and nothing a view
sends is used as a method name, a host payload or an identity.
`scripts/extension-broker.test.mjs`, which the production gate runs with the
Workbench suite, pins the table name by name.

| Method | Parameters | Becomes | Answers |
| --- | --- | --- | --- |
| `schema.describe` | none | The Workbench's own session snapshot | [The schema](#records-and-the-schema) |
| `records.query` | `entityId`, `limit` (1–200, default 100), `cursor`, `filters`, `sortFieldId`, `descending` | `data.queryRecords` | `{items, nextCursor, changeSequence}` |
| `records.get` | `entityId`, `recordId` | `data.queryRecords` for that one record | A record, or null |
| `records.search` | `text` (1–256 characters), `limit` (1–100, default 20), `cursor`, `entityIds`, `fieldIds` (each at most 64 IDs) | `data.searchRecords` | `{items: [{entityId, recordId, version, label, score, fields: [{fieldId, snippet, ranges}]}], nextCursor, changeSequence}`, best match first ([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)); refused with `search-index-missing` until the file has an index |
| `records.tree` | `entityId`, `rootRecordId` (optional), `depth` (1–32, default 1), `limit`, `cursor` | `data.treeRecords` | `{items: [{record, parentRecordId, depth, childCount}], nextCursor, changeSequence}`, depth-first ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)) |
| `records.count` | `entityId`, `filters` | `data.countRecords` | The host's count |
| `records.aggregate` | `entityId`, `aggregate`, `fieldId`, `filters` | `data.aggregateRecords` | The host's exact aggregate |
| `records.groupAggregate` | `entityId`, `groupByFieldId`, `aggregate`, `fieldId`, `filters` | `data.groupAggregateRecords` | The host's grouped aggregate |
| `records.bucketAggregate` | `entityId`, `dateFieldId`, `bucket`, `range`, `aggregate`, `fieldId`, `filters` | `data.bucketAggregateRecords` | The host's date buckets |
| `records.cellAggregate` | `entityId`, `rowByFieldId`, `columnByFieldId`, `aggregate`, `fieldId`, `filters` | `data.cellAggregateRecords` | The host's grid of cells |
| `records.create` | `entityId`, `values`, `recordId` (optional), `targetVersions` (optional) | `data.createRecord`, with `targetVersions` as `expectedTargetVersions` | The record as it now stands |
| `records.update` | `entityId`, `recordId`, `version`, `values`, `targetVersions` (optional) | `data.setFields`, with `targetVersions` as `expectedTargetVersions` | The record as it now stands |
| `records.delete` | `entityId`, `recordId`, `version` | `data.deleteRecord` | null |
| `records.move` | `entityId`, `recordId`, `version`, `parentRecordId` (null for the top level), `parentVersion` (with a parent), `beforeRecordId` (optional) | `data.moveRecord`, with `parentVersion` as `expectedParentVersion` ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)) | The record as it now stands |
| `records.batch` | `writes` (1–200, each `{op: 'create', entityId, recordId?, values, targetVersions?}`, `{op: 'update', entityId, recordId, version, values, targetVersions?}` or `{op: 'delete', entityId, recordId, version}`), `label` (1–80 characters, optional), `writeKey` (1–64 letters, digits, `-` or `_`, optional; [below](#writes)) | `data.writeRecords`, one revision ([below](#writes)) | `{records: [{entityId, recordId, version}], revision}`, version null for a deleted record |
| `records.undo` | `revision` (a batch's or a redo's, this frame's), `label` (1–80 characters, optional) | `data.undoRecordWrites` ([below](#writes)) | `{records, revision}`, as a batch |
| `records.redo` | `revision` (an undo's, this frame's), `label` (optional) | `data.undoRecordWrites` with `redo` | `{records, revision}`, as a batch |
| `commands.run` | `commandId`, `entityId`, `recordId`, `version` | `data.executeCommand` | The record as it now stands |
| `proposals.prepare` | `title` (1–200 characters), `operations` (1–128 canonical operations) | `proposal.prepareChangeSet`, then the Workbench's review | `{proposalId, title, state, diagnostics, opened}` |
| `proposals.get` | `proposalId` | `proposal.get`, for the package's own proposals | `{proposalId, title, state, diagnostics}` |
| `proposals.open` | `proposalId` | `proposal.get`, then the Workbench's review | `{proposalId, title, state, diagnostics, opened}` |
| `state.get` | `key`, `scope` | `extension.state.read` | `{key, value, version}`, or null |
| `state.keys` | `scope` | `extension.state.read` | `[{key, version}]` |
| `state.set` | `key`, `value`, `expectedVersion`, `scope` | `extension.state.set` | `{key, value, version}` |
| `state.delete` | `key`, `expectedVersion`, `scope` | `extension.state.set` with a null value | null |
| `ui.openRecord` | `entityId`, `recordId` | Workbench navigation | `{opened}` |
| `ui.openScreen` | `surfaceId` | Workbench navigation | `{opened}` |
| `ui.openStudio` | `entityId` (optional) | Workbench navigation | `{opened}` |
| `ui.toast` | `text`, 1–300 characters | The Workbench's outcome line | null |
| `ui.setHeight` | `pixels` | The frame's height | `{pixels}` |
| `ui.setToolbar` | `items`, `add` | Nendo's toolbar for the view (W-090) | null |
| `ui.showMenu` | `items`, `x`, `y` | Nendo's menu at a point in the view (W-090) | `{id, value}` of the item picked, or null |
| `ui.setPlace` | `place`, `label`, `replace` | The view's place in Back and Forward (W-127) | null |

Numbers in the host's answers arrive as plain JSON numbers, which a JavaScript number
can round. A record keeps each number's exact digits in `exact`, and the aggregate
answers carry them as `valueLexeme` beside each `value`.

A filter is `{fieldId, operator, value}`, with `operator` one of `eq`, `ne`, `lt`,
`le`, `gt`, `ge`, `contains`, `isNull` and `isNotNull`, and no `value` for the last
two. The broker takes at most 64 clauses, and the host refuses a query of more than
eight. The [query contract](queries.md) has the rest: exact comparisons, cursors
that bind the file's change sequence, and a filter or sort by a calculated field worked out
over at most 10,000 records.
The aggregate words are the ones the Workbench's own tiles and charts use, and the
vocabulary publishes the closed `bucket` and `range` words.

### Writes

Since 2026-09-26 (ADR-0013 Phase 3, W-065) a view writes records and runs record
commands, through the same typed operations and version checks as a person's edit.

- **The actor is the mount's.** The broker adds `actor: extension:‹package›` from the
  view definition it mounted, never from the view's parameters. The host admits an
  actor on `data.createRecord`, `data.setFields`, `data.deleteRecord`,
  `data.executeCommand` and, since 2026-09-28, `data.moveRecord` alone
  (`WorkbenchMethods.ExtensionWriterMethods`), and
  refuses it on every other method with `actor-not-allowed`. Since 2026-10-04 it also
  admits one on `data.undoRecordWrites` ([below](#writes)). It refuses an actor
  whose package the open file does not carry the same way, and any write while
  views are off with `views-off`.
- **History names the package.** Each write is a revision whose origin is
  `extension:‹package›`, read and compensated in History like any other.
- **Versions.** `version` is the record's version as the view last read it. A write
  over another version is refused and changes nothing. Each call carries a fresh
  idempotency key, so a call made again is a new write.
- **An unanswered write** (review R-011, 2026-10-06). `host-timeout` and
  `disconnected` mean Nendo never said; the write may have been kept. A view finishes
  one by sending the same `records.batch` again under the same `writeKey` (1–64
  letters, digits, `-` or `_`): the broker writes it under the idempotency key
  `view-‹package›-‹writeKey›`, so the host keeps it once and answers a repeat as it
  answered the first; the same key with other writes is refused. The package is part
  of the key, so one package's key never answers for another's. Without a `writeKey`
  a batch sent again is a new batch. A single write that was kept but could not be
  read back is answered `written-not-read`, never as a refusal.
- **Values.** Each value is null, text, true or false, a number, or
  `{"$nendoNumber": "‹digits›"}` for a decimal a JavaScript number would round. The
  broker rebuilds the map field by field, at most 64 fields. Valid field IDs such as
  `__proto__`, `constructor` and `toString` remain own properties through reads and
  writes; JSON state and place keys obey the same rule.
- **The answer** is the record read back after the write, with its new version, or
  null after a delete.
- **Not the person's save.** A view's write does not take the Workbench's pending-save
  slot, so it never holds the person's next save behind it. A view whose answer is
  lost reads the record again, or sends its batch again under its `writeKey`.
- **Drafts are the view's** (review R-001, 2026-10-06). Nendo stops a view that is no
  longer on screen: another screen, another tab, Studio, a reload, Stop and the
  kill switches all end its frame, and nothing asks first. A view that holds unsaved
  typing keeps it recoverable itself, in its origin's browser storage, which is this
  file's and this package's on this device, never as records and never saved on the
  person's behalf; it restores the draft when it starts again, over the version the
  draft was made from, and lets the person discard it. Garden and Swarm do.
- **No confirmation** is drawn by the host (ADR-0013, the trust trade). A view that
  wants the person to confirm an act asks them itself.
- A file open read-only refuses a view's writes with `read-only` before the host is
  asked. A file with automatic actions still needs this device's behaviour approval
  before any write, a view's included.

**Several writes as one revision** (`records.batch`, W-102). A gesture such as moving a
selection, pasting or deleting an element with its connections is many writes that
belong together.

- The batch is one mutation. Every write commits or none does, and History shows one
  entry, named by `label` or, without one, by what it does ("Create 3 Tasks", "Change
  5 records"). The host's `data.writeRecords` admits a view's actor like the single
  writes, and the Engine's `ApplyRecordWritesAsync` expands each write to the canonical
  operations its single form makes.
- A record appears at most once, so the version a view read is the version its write
  expects; the broker and the Engine both refuse a second write to it. Put a record's
  changes in one `update`.
- A reference to a record created or updated earlier in the same batch needs no
  target version: the Engine checks it against the version that write leaves, which the
  view cannot know. A reference to a record the batch deletes earlier is refused as a
  missing target. Each target version is keyed by its target type and record ID;
  another type holding the same record ID cannot alter that check. A batch may
  write the same record ID in two different types.
- There is no move in a batch, because a move reads its siblings from the committed
  file. Set a tree's parent and order fields in an `update`, or call `records.move`.
- The answer is each record's new version, in the order written, and null for a
  deleted one, including a record deleted by an automatic action in the same
  revision; an automatic action that wrote back to a record is counted. Read a record
  again for its values and calculations.
- History compensates a batch as one, creates included: a created record is deleted
  ([ADR-0023](../decisions/0023-a-view-undoes-its-own-revisions.md)).
- The answer names the revision the batch wrote, which `records.undo` takes.

**Undo and redo** (`records.undo`, `records.redo`, [ADR-0023](../decisions/0023-a-view-undoes-its-own-revisions.md),
W-103). A view undoes a batch it wrote by the revision the batch answered, and redoes the
undo by the undo's revision.

- **One new revision.** The host compensates the batch whole, in reverse order: a field
  put back, a deleted record restored under its own record ID, a created record deleted.
  History links it to the batch and names it "Undo" and the batch's label, or "Redo" and
  the label, or `label`. Its origin is the view's package.
- **Version-checked.** Each record is expected as the batch left it. A record changed by
  anybody else since, deleted since or newly pointed at refuses the whole step, and nothing
  is written. A record whose later changes the view has itself undone is as the batch left
  it, so a view walks back any number of steps on one record.
- **Only its own.** The broker answers `not-this-view`, without asking the host, for a
  revision this frame was not answered in this visit; a frame mounted again starts with
  none. The host admits the view's actor on `data.undoRecordWrites` and answers
  `revision-not-yours` for a revision another origin wrote, `not-an-undo` for a redo of a
  revision that is not a compensation, and `compensation-not-supported` for one already
  undone or redone, or for a revision that changes more than records.
- **The steps are the view's.** The host keeps no undo stack: the view keeps its steps,
  their order and their names, and may mix them with its own (an editor's waiting edits).
  Ctrl+Z and Ctrl+Y reach a view, which may declare them in Nendo's row with the `undo`
  and `redo` icons; while the person types in a field, the field's own undo has them.
- **Reversibility.** A step of `data.setField` (reversible with retained state),
  `data.deleteRecord` (reversible with retained state), `data.createRecord` and
  `data.restoreDeletedRecord` (declared irreversible, and compensated by a delete: the
  record ID stays reserved) is undone. Nothing else a view writes is: a move or a command
  is a revision of its own and has no `revision` in its answer.

### Proposals

Since 2026-09-26 (ADR-0013 Phase 3, W-069) a view prepares a definition change in its
package's name, and the person decides it in the ordinary review.

- **Operations.** `operations` is a list of canonical operations,
  `{operationType, payload, operationId}`, the same vocabulary the Workbench's own
  proposals and MCP use (`nendo://application/vocabulary`). `operationId` is optional;
  the broker makes one. The broker makes the proposal ID and the idempotency key, and
  sends the whole list as one mutation titled like the proposal. The host validates it
  exactly as it validates the Workbench's own, diagnostics included.
- **The origin is the package.** The host admits the actor on
  `proposal.prepareChangeSet` and `proposal.get` as well as the record writes. The
  proposal and its mutation carry `extension:‹package›` as their origin, the preview
  says so in `origin`, and History attributes the accepted change to the package.
- **The review opens at once**, over the screen the view is on, and says "Prepared by
  the custom view ‹title› (‹package›). Nothing changes until you accept." The view
  that asked stays running, parked, while the review is open, and the person comes
  back to it after accepting or rejecting. `opened` is false when the review could not
  open (another action was running, or a record page held unsaved typing): the
  proposal waits, and `proposals.open` opens it later.
- **State** is `previewable`, `invalid`, `stale`, `active` once accepted, `rejected`,
  or `failed`. The host remembers what each view prepared in this file session, so a
  view reads an accepted or rejected proposal's outcome after the Engine has let it go:
  accepted when the file holds its receipt, rejected otherwise.
- **One waiting per package.** While a proposal the package prepared is
  `previewable`, another `proposals.prepare` is refused with `proposal-waiting`,
  naming it. A person's own proposals and other packages' are not counted.
- **Only its own.** `proposals.get` and `proposals.open` answer `proposal-not-found`
  for any proposal the package did not prepare in this session.
- **Never decided by a view.** Promoting and rejecting are the person's (or an agent's
  at Unattended). The host refuses the actor on `proposal.promote` and
  `proposal.reject` with `actor-not-allowed`.
- A file open read-only refuses `proposals.prepare` with `read-only` before the host is
  asked.

### State

Since 2026-09-26 (ADR-0013 Phase 3, W-069) a view keeps small JSON values with the
file through `nendo.state`.

- **Where.** A value belongs to the view that kept it, by its view definition's node
  ID, or, with `scope: 'package'`, to the package's views together. The broker takes
  the view ID and the package from the mount; a view names only the key.
- **The operation.** Each write is one canonical `extension.setState` operation in a
  Data revision: reversible, attributed to `extension:‹package›`, and described in
  History as "Keep ‹key› for the view ‹title›" ("for the views of ‹package›" for shared
  state; "Forget" for a deletion). Compensation puts back the value it replaced, and
  refuses when the key has been written again since.
- **Versions.** Each key has a version, 1 on its first write. `expectedVersion` makes a
  write conditional: the key's version, or 0 for a key that must not exist yet. A
  stale one is refused with `state-version-conflict` and changes nothing. Without it,
  the last write wins.
- **Bounds.** A key is 1 to 128 characters; a value is JSON of at most 64 KiB, stored
  without whitespace, so an object's keys may come back in another order; 256 keys per
  view; 1 MiB per package. Past a bound the write is refused with `state-too-large`.
- **Two a second.** The broker sends at most two state writes a second from one view
  and answers the next with `busy`. `api.js` sends a view's writes 550 ms apart and
  coalesces writes to one key made meanwhile: every caller hears the one answer, and
  History has one row.
- **Host methods.** `extension.state.read` `{viewId, key}` answers `{entries}`: the
  key's `{key, value, version}`, or, with no key, every key's `{key, version}` without
  its value. `extension.state.set` `{viewId, key, value, expectedVersion, description,
  idempotencyKey}` answers the mutation. The host admits both only with a view's
  actor and takes the package from it (`actor-not-allowed` without one), and refuses a
  write while views are off (`views-off`).
- **The file's.** State is in the file (`__nendo_extension_state`, since host 1.33.0),
  so a copy carries it and no rung is needed. Export does not carry it. Removing a
  package keeps its state, so compensating the removal brings it back. MCP neither
  reads nor writes it. A state write changes no record, so it triggers no action.

### Nendo's toolbar, menus and keys

Since 2026-09-28 (ADR-0013, *Views in Nendo's own chrome*; W-090) a view's controls can be
Nendo's own. A view declares them. The Workbench draws them with its own markup, lists them
in Ctrl K, shows and runs their keys, and sends each press back as the event `command`.

- **The declaration.** `ui.setToolbar` takes `items` and `add`. The broker rebuilds it key
  by key (`src/Nendo.Workbench/src/view-toolbar-model.ts`) into a closed set of kinds:
  - `button` and `toggle` (`pressed`), each with a `label`, an optional `icon`, `iconOnly`
    and `keys`;
  - `choice` and `select`, with `options` of `{value, label}` and a `value` that is one of
    them, or null;
  - `search`, with a `placeholder`, a `value` and `keys`;
  - `menu`, with `items`: `item` (a `detail` line, an icon, keys, `danger`), `check`
    (`checked`), `radio` (a shared `id`, its own `value`, `checked`), `label` and `separator`;
  - `group`, a joined row of buttons and toggles;
  - `text`, optionally `mono`, then `separator` and `spacer`.

  Any other key is dropped. Any other kind, or an icon outside Nendo's named set, is
  refused. A declaration past a bound is refused whole, with `invalid-params` naming the
  rule, and the Workbench keeps drawing the last one it accepted. An empty list with no
  `add` removes the toolbar.
- **One name, one control.** An `id` is 1 to 64 letters, digits and `. _ : -`. No two
  controls share one, except the items of one radio set. No two declare the same key.
- **Words are text.** Every label, option and detail line is escaped where it lands.
  Nothing a view declares becomes markup, a class, a style or an attribute name. The icons
  are the Workbench's own outline icons, by name.
- **Where it is drawn.** On a screen, the toolbar is drawn in the Workbench's markup in the
  Use toolbar's one row under the address row, before Nendo's Add (W-092): the breadcrumb above
  holds the record type and the view, so that row holds only what acts on the screen. A
  page without that row draws the strip at the top of the view's placeholder, above the
  Development strip and the frame. It uses the view switcher's segments, the labelled
  select, bordered buttons, a search box and the File menu's panel for a menu, and a
  non-mono `text` item takes the row's free space and is cut short with its whole text as a
  title rather than push the controls onto a second line. The row keeps to one line beside
  Add, which keeps its own width (W-115): controls that do not fit go, from the end, into
  Nendo's **More** menu at the row's end, and come back as the row widens. In More a button is
  a command, a toggle a check, a menu's or a group's items stand under its label, and a
  select's or a choice's options are radio items under its label; a search box stays in the
  row, and a text, a separator or a spacer says nothing there. A choice in More sends the
  command with the source `menu`. On a record page the same
  controls sit in the panel's header, beside its title. The frame cannot reach either. The
  toolbar is drawn again from the Workbench's copy on every redraw, and a search box the
  person is typing in is kept, caret and all.
- **Commands.** A press sends `{id, value, source}` to the view. `value` is:
  - the new state of a toggle or a check;
  - the option chosen;
  - the text searched for, sent after 180 ms of rest and at once on Enter (an Enter always
    leaves the view hearing the same text twice in a row);
  - a radio item's value;
  - null for a button or a menu item.

  The Workbench shows the new state at once, and the view's next declaration decides it. A
  view that connects, stops, crashes or reloads loses its toolbar until it declares one
  again.
- **Add.** `add` names a command. While a view that took Add runs on a screen, Nendo's own
  Add button sends that command, with the source `add`, instead of opening Nendo's form.
  Without `add`, or on a record page, Add stays Nendo's.
- **Ctrl K** lists the commands of every view on the page, the screen's first, each under
  its view's title:
  - a button;
  - a toggle, as "Turn on ‹label›" or "Turn off ‹label›";
  - each option of a choice or a select that is not already chosen, as "‹label›: ‹option›";
  - the search box;
  - each item of a menu, as "‹menu›: ‹item›".

  A disabled control is left out.
- **Keys.** A declared key is `Ctrl`, `Alt` and `Shift`, in that order, and one key: a
  letter, a digit, a symbol, `Plus`, an arrow, Home, End, PageUp, PageDown, Delete,
  Backspace, Enter, Space, Tab, or F2 to F12. Every key but F2 to F12 needs Ctrl or Alt. Shift on
  a symbol is left to the keyboard. Nendo's own keys (`hostKeys` in `protocol.ts`, the
  shortcut table's) are refused. The Workbench runs a declared key wherever focus is in its
  document, except in a text field. It shows the key in the control's `aria-keyshortcuts`,
  its tooltip, the hints and Ctrl K.
- **Keys inside a view.** A key pressed in a cross-origin frame never reaches the
  Workbench's document, so `api.js` hands keys to the Workbench as `{t: 'key', keys}`:
  - each of Nendo's own keys, before the view's listeners hear it;
  - each key the accepted toolbar declares, once the view's own listeners have let it pass,
    unless the person is typing in a field.

  Alt and an arrow stay in a field. The broker takes only Nendo's keys and the keys the
  view's toolbar declares, eight a second, and only while views run.
- **Menus.** `ui.showMenu` takes menu items and a point in the view's own pixels.
  - The Workbench draws its menu in its own document at that point on the frame. A point
    outside the frame is brought inside it. The first item has focus.
  - Arrow keys, Home and End move. Enter or Space picks.
  - Escape, Tab, a press elsewhere, the window losing focus, a scroll or a resize dismiss
    the menu. So does opening another menu, or Ctrl K.
  - The answer is `{id, value}`, where `value` is a check's new state, a radio item's
    value, or null. A dismissed menu answers null.
  - The keys on a menu item are only shown.
- **What stays the Workbench's.** The read-only and busy sweeps leave a view's controls
  alone: the view is told the file is read-only, and the host refuses its writes anyway.
  The toolbar reaches nothing the method table does not already reach.

The table holds none of `proposal.promote`, `proposal.reject`, `behaviour.*`,
`agent.*`, `file.*`, `session.open*`, `appearance.set` or `history.compensate`, and
never will: acceptance stays with the person. A view's reads carry no actor. They
are the Workbench's reads, under its file session.

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

### Back and Forward

Since 2026-09-29 (ADR-0013 History; W-127) a view takes part in Nendo's Back and Forward. A
view keeps its own state in its frame, so before this Back from a record the view had opened
rebuilt the screen and the view started over, and moving between the view's own pages was
never a step.

- **Declaring.** `ui.setPlace` takes `place`, plain JSON of at most 4 KiB, a `label` of 1–80
  characters that the Back and Forward buttons show after the screen's title (the view's title
  when left out), and `replace`. A new place is a step on the trail. With `replace: true` it
  corrects the step the person is on instead: for a selection, and for the place the view
  starts at. Declaring the place the view already has, value and label, does nothing, so a
  view may declare its place after restoring it. At most 20 a second from one view.
- **Where it is kept.** The Workbench keeps each view's place against the Nendo place it was
  declared on (the view, record type, front page, screen and record) and the view's identity
  there (placement, view ID, and the page's record). A trail entry carries the places of the
  views on it, and `placeKey` compares their values, not their labels. Kept places are this
  session's, at most 200, forgotten with the file; nothing reaches the file.
- **Handing it back.** Back and Forward put the entry's places back before they redraw. A view
  whose frame kept running hears the event `place` with its place, or null when it had declared
  none there; a view that starts again, because its screen was left, finds it in
  `context.place`. The view is never handed back the place it declared itself.
- **What the view does.** Show the place, and do not declare a step in answer. Anything the
  model no longer holds, the view drops quietly.

The Archi workbench (`extensions/archi`) declares its open view as a step and its selection as
a correction.

### The context

`nendo.ready` resolves with the context, and `nendo.context` holds the latest one.

| Key | Holds |
| --- | --- |
| `apiVersion` | `1` |
| `viewId` | The view's node ID |
| `kind` | `extensionGraphSurface`, `extensionRecordsSurface`, `extensionView` or `extensionRecordPanel` |
| `placement` | `screen` or `recordPage` |
| `title` | The view's title |
| `packageId` | The package the view runs |
| `entityId` | The record type the view is about; on a record page, the page's; for an `extensionView`, the one it names, or null |
| `recordId` | The page's record, for a view on a record page; null elsewhere |
| `bindings` | `labelFieldId`, `statusFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId`; `fields`, each `{fieldId, entityId}` in authored order; `filters`, each `{fieldId, entityId, operator, value, valueKind, storageKind}` |
| `configuration` | The definition's configuration, parsed; `{}` when there is none |
| `theme` | `{mode, tokens}`: `light` or `dark`, and the Workbench's colour tokens |
| `locale` | The browser's language, or `en` |
| `readOnly` | True when the open file does not accept edits |
| `methods` | Every method name the broker answers, in table order |
| `place` | The view's place as it last declared it on this page, or null (W-127). Kept current by the event `place` |

Each field and filter names the record type that holds it: the view's own record
type first, then its link type. A filter's `operator` is already the query's word
(`le` rather than `lte`), and `valueKind` says whether `value` is the literal to
compare or a word such as `today`, which the reader resolves when it reads.
`storageKind` is the field's stored kind: `today` is the person's civil date,
`2026-09-26`, for a `date` field, and the instant that date begins where the person
is, with its offset, `2026-09-26T00:00:00+02:00`, for a `dateTime` field.

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

- Each entity is `{entityId, displayName, fields, hierarchy, linkRule}`. `hierarchy` is the tree
  the record type declares ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)),
  `{parentFieldId, orderFieldId}` with a null order when it has none, or null when it
  declares no tree. `linkRule` is the links it allows
  ([ADR-0026](../decisions/0026-allowed-links.md)): `{sourceFieldId, targetFieldId,
  kindFieldId, sourceKindFieldId, targetKindFieldId, tableEntityId, tableSourceFieldId,
  tableTargetFieldId, tableKindFieldId}`, or null. A batch that leaves a link no record of the
  table allows is refused whole with `link-not-allowed`, naming the link. Each field is `{fieldId, displayName, storageKind, required,
  presentation, calculated, expression, choices, reference, scale}`. A calculated field
  has `calculated: true`, its formula in `expression` and its result type as
  `storageKind`. Each choice is `{id, displayName, retired, tone}`. Retired record types
  and fields are left out.
- Each screen is `{id, surfaceId, kind, title, entityId}`: a root node of the file.
- Each command is `{id, entityId, label, steps}`. Each step is `{fieldId, valueKind,
  value}`, in the order it runs: `valueKind` is `literal` (the value is `value`),
  `null`, `today` or `now`. The host resolves `today` to the same civil day a filter
  does, where the person is: the date for a `date` field, and the instant that day
  begins, stored in UTC, for a `dateTime` field. A command is spent on a record when every step with a fixed
  value (`literal` or `null`) already holds it, which is when the record page greys its
  button. `steps` arrived 2026-09-26; a view on an earlier host finds it missing.

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
name other than these five throws `unknown-event`.

| Event | Data | When |
| --- | --- | --- |
| `context` | The context | On every connect, and when the view's context changes, for example after its definition changed |
| `theme` | `{mode, tokens}` | When the person's theme changes between light and dark |
| `changes` | The file's change sequence | When anything commits to the open file: at most one every 250 ms to one view, carrying the latest sequence |
| `command` | `{id, value, source}` | The person pressed one of the controls the view declared: in Nendo's toolbar, one of its menus, Ctrl K, by its key, or Nendo's Add. `source` is `toolbar`, `menu`, `palette`, `key` or `add` (W-090) |
| `place` | The view's place, or null | Back or Forward moved the person to a place of this view's that differs from the one it has (W-127) |

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
| A batch | 1–200 record writes, each of 1–64 values, and at most 250,000 characters once the broker has added its keys |
| A toolbar | 32 controls in the row, 8 buttons in a group, 12 options in a choice, 64 in a select, 48 items in a menu, labels and options of 80 characters, a menu item's detail of 120, and 16 KiB of JSON in all |
| Toolbars | 20 a second from one view; `api.js` sends the latest at most every 100 ms |
| Menus | 4 a second from one view |
| Keys handed back | 8 a second from one view; any more that second are dropped |
| Places | 4 KiB of JSON each, a label of 80 characters, 20 a second from one view; 200 kept in a session |

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
| `disconnected` | Script | The Workbench reconnected the view before it answered. Send a read again; a write may have been kept, so read first or send a batch again under its `writeKey` |
| `host-timeout` | Workbench | Nendo did not answer within 15 seconds. As `disconnected` |
| `written-not-read` | Broker | The write was kept, but reading the record back failed. Read it; do not write it again |
| `not-framed` | Script | The page was opened on its own, outside any frame, so nothing can connect it |
| `unknown-event` | Script | `nendo.on` was given a name other than `context`, `theme`, `changes` or `command` |
| `failed` | Broker | The answer could not be sent, or the failure had no code |

A read the host refuses keeps the host's own code, for example `validation`,
`stale-cursor`, `invalid-cursor` or `stale-file-session`.

### The view API as a read

Since 2026-09-28 (W-094) the api build also writes `dist/_nendo/view-api.json` beside
`api.js`, from `src/Nendo.Workbench/src/extension-api/reference.ts`, and the local MCP
carries that file as built and serves it at `nendo://application/view-api`. It is this
section as an agent reads it before it writes a view's code: every method with the call
that reaches it, its parameters and answer, the helpers, the context and record shapes,
the events, the filter words, write values, toolbar kinds, icons and keys, theme tokens,
limits and refusals, a whole view to start from, and how a person develops a package from
a folder.

- **Generated.** The method names, events, icons, theme tokens, Nendo's own keys and
  limits come from the tables `api.js` and the broker are built from. A broker method
  without a line stops the build, and `scripts/view-api-reference.test.mjs` holds every
  function on `window.nendo`, every toolbar kind and menu item, and the example to the
  real modules: the example runs against the real `api.js`.
- **Read only to write a view.** Nothing an agent reads by default carries it. The
  resource's own description, the vocabulary's `extension.setPackage`, the example
  `put-a-custom-view-in-the-file` and describe's `reads` each name it with the condition
  that it is for a view's code. The server instructions do not name it at all (review
  R-006), and `ViewApiResourceTests` fails when they name it or when any of these
  carries its content.
- **One trap it names.** A filter clause in a view definition says `lte` and `gte`;
  `records.query` takes only the query's words, `le` and `ge`, and refuses the others.

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

Shared switch and development-link updates reread current device state while
holding a cross-process document lock, preserving other files' choices. A stale
controller cannot restore global On while changing its own file. Open controllers
poll for changes every 250 ms and notify the Workbench to remove affected frames;
this is an interval, not a delivery-time guarantee. Host authority checks also
read the switches synchronously. If the shared document cannot be locked or
saved, the choice remains in the session and the panel reports the persistence
notice instead of overwriting shared state.
An explicit later device or same-file switch choice supersedes an older unsaved
choice; unrelated file or development-link changes preserve it.

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

The host checks a view's write, state change or proposal twice: when the request
arrives, and again once it holds the session's request gate, immediately before
anything runs. The second check reads the switches and the file's own package list,
so a switch thrown, or a package removed, while the write waited behind it refuses
the write with `views-off` or `actor-not-allowed` rather than letting it commit after.
A write that already held the gate when the switch was thrown finishes, and reports
the commit it made. The Engine checks the package a third time, inside the write
transaction that would commit the write: a direct mutation whose origin is
`extension:<package>` for a package the file does not carry at that moment is
refused with `actor-not-allowed`. That covers a removal committed by a writer the
request gate does not serialize with, such as an agent at Unattended accepting its
own proposal. An exact retry of a write that did commit still returns its receipt.
A view's proposal accepted by a person is the person's act and is not checked this
way.

`extension-settings.json` sits in the device-state root, `%LocalAppData%\Nendo`
unless `NENDO_DEVICE_STATE_ROOT` names another. It is device preference, never
application data, so a file cannot turn its own views on, and a received file
cannot turn off anyone else's. Both switches default to on. The store holds at
most 256 KiB and 4,096 files. If it cannot be read, views run with the defaults
for the session, and the panel says: "The saved custom view settings could not be
read. Views run with the defaults for this session." If a change cannot be saved,
it applies for the session, and the panel says so. A save that would exceed the
256 KiB reader bound keeps the previous readable document and reports the same
session-only notice.

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
  and description, with **Export…** and **Remove…**. A skill package's card starts its
  facts with "Agent skill", says "Instructions for an agent connected to this file,
  offered to it as the skill ‹name›. Nothing in it runs in Nendo.", and offers neither
  **Add view…** nor **Develop from folder…**;
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
| `skill` | "‹title› cannot be shown: ‹package› is a skill package, instructions for an agent that never run." | None |
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
| `entryPoint` | Default: `index.html`. It must be one of the package's files. A skill package names none |
| `description` | Optional |
| `kind` | `view` (default) or `skill`. A skill folder needs a `SKILL.md` whose frontmatter names it, checked here and refused by the file's name |

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
| `extension.develop.link` | `{packageId}` | The host opens its folder picker, then the session view, whose package names the folder by `developmentFolder`; or `{cancelled: true}`. `extension-link-mismatch` when the folder's `nendo-package.json` names another package, `extension-package-not-found` when the file does not carry the package |
| `extension.develop.stop` | `{packageId}` | The session view. Stopping a package that is not developed is not an error |
| `extension.develop.save` | `{packageId}` | The proposal preview Import would prepare from the folder; `extension-not-linked` when the package is not developed on this device |
| `help.readPages` | `{}` | `{pages, omitted}`: each page `{packageId, packageTitle, path, markdown}`, packages by title then package ID, pages by path; `omitted` counts the pages left out at a bound or as not UTF-8. Needs an open file |
| `diagnostics.frameProcesses` | `{}` | Only when `NENDO_NATIVE_DIAGNOSTICS=1`, otherwise `unknown-method`: each browser process with its ID, kind, private working set in bytes and the frames it holds, each `{name, source}` |

The host reports renderer failure through `extensionFramesFailed`, which carries
`{fileSessionId, frames}`, the names of the view frames whose renderer ended. The
Workbench ignores it for another file session, and ignores a payload with no
frames, more than 256, or a name that is not `nendo-view-` and twelve hex digits.
A view's `changes` events come from the existing `fileChanged` event.

`extensionSettingsChanged` carries null: a shared device control changed without
changing the file's data sequence. The Workbench rereads the session, discards
late replies from a replaced file session, and removes disabled frames, including
those held for proposal review. A focused or retained record draft stays in place.

`extensionDevelopmentChanged` carries `{packageId}` and nothing else: the folder
behind a developed package changed, or a link started or stopped. The Workbench
reloads every running view of that package. It ignores a payload whose `packageId`
is not a string of 1 to 80 characters.

### Developing from a folder

A development link (ADR-0013 Phase 4) runs one package of one file from a folder on
this device, so an edit shows the moment it is saved, without a proposal.

- **Where it lives.** In this device's custom-view settings
  (`extension-settings.json` under the device state root), keyed by the file's
  application ID and the package ID, with the folder's full path. At most 64 links.
  A link that does not read as one when the settings load is dropped. Nothing about a
  link is written to the file, so a copy of the file, or the file on another device,
  runs the package the file carries.
- **What the Workbench is told.** Each package in the session view has
  `developmentFolder`: the folder's name, or null. Never its path.
- **Starting.** The folder must read as a package by Import's rules and name the same
  `packageId`, and the file must already carry the package: a new package goes in by
  Import first.
- **Reload.** The host watches the folder and its subfolders. A burst of changes
  becomes one `extensionDevelopmentChanged` 250 ms after the last; the next request
  reads the folder again.
- **The strip.** Every view of a developed package is drawn with a strip above its
  frame, in the Workbench's own markup: "Development", then "This computer runs
  ‹package› from the folder ‹name›, not the code in the file.", with **Save to file…**
  and **Stop developing**. The package's card in Studio says "Developing from ‹name›"
  with the same two buttons, and **Develop from folder…** otherwise.
- **Save to file** is `extension.develop.save`: Import's proposal from the folder, in
  the ordinary review. The link stays until **Stop developing**.
- **Unchanged.** The kill switches stop a developed view like any other (403); safe
  mode and recovery run none; the API, the broker's table and the actor are the same.

## View definitions

A view definition is a node in the file's semantic surfaces, authored through the
ordinary `ui.addNode`, `ui.setProperty` and `ui.removeNode` operations in a change
set that a person accepts. There is no second pipeline: Studio's Add view form
(W-062, `custom-view-recipe.ts`) sends those same operations through
`proposal.prepareChangeSet`, as every Studio proposal does. A definition names its
package by `packageId`, and the view runs that package from the file.

### The four kinds

| Kind | Where | Required | Optional | Children |
| --- | --- | --- | --- | --- |
| `extensionView` | A root of the file, up to eight | `definitionVersion` (3), `title`, `packageId` | `entityId`, `configuration`, `opensFile` | none |
| `extensionGraphSurface` | A root, up to eight per record type | `definitionVersion` (3), `entityId`, `title`, `packageId`, `labelFieldId`, `edgeEntityId`, `sourceFieldId`, `targetFieldId` | `statusFieldId`, `configuration` | `fieldBinding`, `filterClause` |
| `extensionRecordsSurface` | A root, up to eight per record type | `definitionVersion` (3), `entityId`, `title`, `packageId`, `labelFieldId` | `statusFieldId`, `configuration` | `fieldBinding`, `filterClause` |
| `extensionRecordPanel` | A child of a `detailSurface`, a `recordForm` or a `section`, inside a tab too | `title`, `packageId`, `labelFieldId` | `statusFieldId`, `configuration` | `fieldBinding` |

The three bound kinds also accept `packageVersion`, `packageDigest`, `protocolVersion`
and `configurationVersion`, the pins earlier hosts required. They are kept when present
and read by nothing. `extensionView` never had pins and accepts none.

- A view of the file (`extensionView`) names no fields and no filters: its code reads
  the file through the API. `entityId`, when present, must name an active record type
  (`NUI450`) and reaches the view as `context.entityId`. It does not make the view a
  screen of that type. At most one view of a file says `opensFile` (`NUI453`), and a
  ninth view is refused (`NUI391`).

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
| An `extensionView` (a view of the file) | **1.42.0** |

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
| `NUI452` | Warning | "The package ‹id› is not in this file, so the view has no code to run yet." Remedy: "Add the package to the file: Studio → Surfaces → Custom views → Import, or extension.setPackage and extension.putFile in this change set or a later one." The view says the same where it is shown. Validation compiles the change set after all its operations, so a package and the view naming it in one change set draw no `NUI452` (W-170) |
| `NUI454` | Error | "The package ‹id› is a skill package, which holds text for an agent and never runs, so a view cannot use it." Remedy: "Name a view package, one created without kind skill, or remove the view." |
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
- write under any name but its own package's;
- accept or reject a proposal, ever.

Studio never hosts extension code, and it stays reachable. A file with automatic
actions still needs this device's behaviour approval
([ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md))
before any write. View code needs no approval of its own.

## Compatibility

- A file that carries packages needs host 1.33.0. A view that only the open rules
  accept needs 1.34.0. An `extensionView` needs 1.42.0, and a skill package 1.43.0.
  `extensionTile` will need the rung after that, and is not yet delivered.
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

### Downloads without the browser's panel (F-237)

Measured on 2026-10-02. In the owner's installed Nendo, Archi's Save as Exchange XML from Nendo's
row opened WebView2's downloads panel, "Archisurance.xml can harm your device. Do you want to keep
it anyway? Keep | Delete", and after Keep the browser process held a core and the window went
white; a restarted Nendo joined the same process and stayed white. Reproduced in a Debug build on
a copy of Archi.nendo: the download stayed `Unconfirmed … .crdownload` under an
`edge://downloads-hub/` target. With the download handled by the host, the file was saved whole and
no panel opened. G41 in `tools/Review-FileView.mjs` has the probe view save a 200 kB XML file
with no click in it and measures the file in the journey's own downloads folder, every target the
browser has, and the page answering. With the host's handling taken out it failed:
`{"file":{"name":"Probe model.xml","bytes":200055,"pending":[]},"panels":["edge://downloads-hub/"],"answers":"yes"}`.
The owner then had the file but no word of it, so G41 also measures Nendo's notice: `Saved Probe
model.xml to downloads.` with Show in folder. While the host looked its window up by the event's
sender, which WinRT can hand over as another wrapper of the same browser, the notice never came:
`"notice":null`.

### A view as a screen of the file (W-106)

Measured on 2026-10-02 against a Debug build. `DesktopExtensionViewJourneyTests` seeds a file with
a Tasks list and an `extensionView` run by a probe package that says `opensFile`, starts a real
host on it, and `tools/Review-FileView.mjs` measures over the debugging port. G37: the file opens
on the view, running, and the Showing picker lists `view:workbench` then `tasks`. G38: inside its
frame the view is handed `{"viewId":"workbench","kind":"extensionView","placement":"screen","entityId":"tasks","recordId":null}`
and reads records through the API. G39: Studio lists it under *Screens of the file*, Use returns
to it, and the picker reaches Tasks and the view again, and Back from Tasks names the view.
G40: after the view declares its place, the breadcrumb is the picker alone, naming the view. A
view's place refreshes Nendo's header between two draws (W-127), and that refresh brought the
eyebrow back beside the pickers, naming the first record type: the owner saw "Use · Concepts /
Use · Archi". Against the code before the fix G40 failed with `{"eyebrow":"Use · Tasks",
"heading":"Tasks","picker":"Probe workbench"}`. With the opening decision taken out of the
Workbench, G37 failed: `Timed out: the file opening on its view, running (last: null)`.
`scripts/file-views.test.mjs` runs the Workbench's own opening decision: with views off for the
device, the file opens on its front page. `ExtensionScreenViewTests` holds the compiler's rules
and rung, and that a file whose screens all belong to the file keeps them: without the fix its
front page was dropped (`Expected:<front>. Actual:<>`), so such a file opened on Studio.

### The clipboard from a command (W-123)

Measured on 2026-10-01 against a Debug build. `DesktopExtensionViewJourneyTests` (G36) clicks a
button the probe view declared in Nendo's row with real mouse input, and presses its declared
key inside the view. From the row, `navigator.clipboard.write` of a PNG is refused with
`NotAllowedError: Failed to execute 'write' on 'Clipboard': Document is not focused.`; after
`window.focus()` it is copied. From the key pressed inside the view it is copied as it is.
G36 also copies a 730 × 1240 picture drawn from SVG, as Archi copies a view, and reads the
Windows clipboard back as another program would: PNG, bitmap and DIBV5 each hold it intact
(`730x1240 corner=255,255,255,255 centre=255,255,0,0`). The lane writes the system clipboard of
the machine it runs on. The window runs hidden, so the lane emulates a focused window, as G30 does. The Archi lane
measures the workbench's Copy as picture with focus in the fixture broker's page, and failed
without its `window.focus()`: `Layered View could not be copied: Failed to execute 'write' on
'Clipboard': Document is not focused.`

### Files a person hands a view (W-104)

Measured on 2026-10-01 against a Debug build. `DesktopExtensionViewJourneyTests` (G34, G35)
drives the probe view in a real host.

- G34: the view's file input, clicked with the person's activation, opens a dialog titled
  "Open" whose owner window is Nendo's. The lane finds it with `EnumWindows` and closes it
  with `WM_CLOSE`, which reaches the view as `cancel`. A file set on the input over CDP
  arrives with its name, its 88 bytes and its text, non-ASCII included.
  `showOpenFilePicker`, `showSaveFilePicker` and `showDirectoryPicker` each throw
  `SecurityError: … Cross origin sub frames aren't allowed to show a file picker.`
- G35: real drags carrying a file on disk, through `Input.dispatchDragEvent`. A drop on a
  view that does not take drops leaves no message, no hint, no reload and no navigation.
  Once the view takes drops, the file reaches it straight on and after crossing the rail,
  where Nendo's hint shows and then steps aside. Dropped on the rail,
  `journey model.archimate` is refused by name. `dropped.nendo` is handed to the host as
  `file.openDropped`; the lane catches it on its way out, so the file is not opened.

Before the fix, and again when falsified by taking `pointer-events: none` off
`.file-drop-target`: `A file dropped on the view (across Nendo first) did not reach it:
{"dropped":{"refusedByNendo":"journey model.archimate is not a Nendo file. Nendo opens .nendo
files."},"hintBefore":true,"hintOver":{"shown":true,"leaves":3,"overs":4}}`.

Limits:

- CDP sends each drag event to the renderer under its point, and it has no leave for a
  renderer: its `dragCancel` ends the drag. So once the browser's hit test has moved the
  drag into the view, the lane raises the Workbench document's `dragleave` itself and
  enters the view, as the window's drag does.
- A drag from Explorer cannot be scripted, so a real Windows drop on a view is not
  measured.
- The dialog's list of file types is not read.

### Back and Forward (W-127)

Measured on 2026-09-29. `DesktopExtensionViewJourneyTests` (G33) drives the probe view in a real
host: two places make a step whose Back button names "Page one"; declaring the second again makes
none; Back hands the view `{page: 'one'}` as the event `place` and in `context.place`; Forward hands
it back; Back from a record the view opened returns it to its page. Falsified by leaving out the
restore in `settle`: `Timed out: Back handing the view its first page (last: null)`.
`Review-ArchiWorkbench.ps1` measures the Archi workbench over the fixture broker: opening a second
diagram is a step carrying the box selected on the first; `place` returns it to the first diagram
with that box outlined, and a workbench started again from `context.place` opens there, with no
echo either way. Falsified twice: without the `place` listener, `Back did not return the workbench
to the first view with its box selected.`; without the start place, `A workbench started again
after Back did not open the view and the box it was left on.`

### One line beside Add (W-115)

Measured on 2026-10-03 in a Debug build, G42 in `tools/Review-FileView.mjs`
(`DesktopExtensionViewJourneyTests.AFileOpensOnItsOwnViewAndStudioStaysReachable`): the probe
view declares a row as full as the Archi workbench's while editing, 21 controls with Add, and
the journey sets the window 1,100 pixels wide over the debugging port. Add stays whole inside
the window, the row is one line ending with More, every control the row does not show is in
More, and Discard chosen there reaches the view as `{id: 'discard', source: 'menu'}`; at 2,600
pixels More goes and every control is in the row. Before the change the owner saw the row
wrap to three lines with Add cut off at the window's edge, and the guard failed against that
code with `In a window 1100 pixels wide the row does not keep Add inside it on one line with
More: {"width":1100,"add":{"left":1059,"right":1124,...},"lines":4,...,"actions":{"left":1059,
"right":1084,...,"width":25}}`: the row had squeezed Add's place to 25 pixels and its button
stood 24 pixels past the edge. `scripts/view-toolbar.test.mjs` holds what More lists for each
kind of control.

### One row above a view (W-092)

Measured on 2026-09-28. The journey (`DesktopExtensionViewJourneyTests` with
`tools/Review-ExtensionViews.mjs`) ran in a Debug build: G31 found the record type and the
view as pickers in the top bar's breadcrumb, none in the Use toolbar, and the probe's
controls in the Use toolbar's row with Add. 84 px stood between the top bar and the probe's
frame, the height of that one row, which the probe's long toolbar wraps onto two lines.

`Review-SystemsLens.ps1`, `Review-NendoGraph.ps1`, `Review-Gantt.ps1` and
`Review-WorkDependencies.ps1` measured the other half on the fixture broker. Each view put
its summary in Nendo's row as `text` and declared About, its header and explanation were
not displayed, and its drawing started within 12 px of the frame's top. About showed the
explanation over the view, and Escape put it away. A refused read was said in the frame,
whole, with no text in Nendo's row, and the next read put things back.

A one-off look in a Debug Nendo on a copy of Nendo Station found the same: the Lens's frame
started 47 px below the top bar, and its row read *Focus, Take out, 41 components · 48 feeds
· 12 declared sources · 9 in a circuit, Fit, Text view, Add Components*.

Each guard was seen to fail with its defect put back:

- The view's controls in a strip of their own again: `More than one row stands between the
  top bar and the view, or the pickers are not in the breadcrumb:
  {"between":131,"row":47,"headerHeight":82,"frameTop":213,"pickers":true,"rowPickers":false,"sameRow":false,"stripInMount":true}`.
- The Lens's explanation left in the frame: `The schematic still spends lines of its frame
  on its summary or its explanation: {"header":"none","hint":"block","drawingTop":60}`.
- The graph treating a problem as a summary: `A problem reading the file was not said in the
  frame, whole.`
- The Gantt's About showing nothing: `About in Nendo’s row did not show the explanation.`
- Work dependencies' summary kept out of the row: `The view declared another toolbar:
  [..."toggle:focus","spacer","group:zoom-out@Ctrl+-,fit@Ctrl+0,zoom-in@Ctrl+Plus",...]`.

### Nendo's chrome in the other three views (W-091)

Measured on 2026-09-28. `Review-SystemsLens.ps1`, `Review-NendoGraph.ps1` and
`Review-Gantt.ps1` measure each view twice, as the W-090 lanes do: every earlier measurement
on a fixture broker that does not offer the chrome, then the view again on one that does.
There the Systems Lens and the Dependency graph draw no controls of their own and no page
title, and declare them: Focus and Take out in the Lens, zoom with Fit on Ctrl -, Ctrl 0 and
Ctrl +, and the text view. Commands from the toolbar do what the view's own buttons did,
and the Lens's take-out answers the same question from Nendo's toolbar and from its menu. A
right-click on a component, a record or a Gantt row asks for Nendo's menu and not the
browser's, and each pick is carried out. The Gantt's title gives way on a screen, where it
declares a Find box with Ctrl F; a chart of one on a record page declares nothing and asks
for no menu. The Dependency graph draws with the Workbench's colour tokens: a canvas and a
surface token it is sent are the colours it draws with.

The fixture broker now reads each toolbar and menu by the Workbench's own rules, from
`view-toolbar-model.ts` built by `Graph-FixtureServer.mjs`, and refuses what Nendo would
refuse. That holds for all five lanes, so the Capability Atlas and Work dependencies are
measured against the rules too.

Each guard was seen to fail with its defect put back:

- An icon outside Nendo's set: `Nendo would refuse what the view declared:
  [{"method":"ui.setToolbar","code":"invalid-params","message":"items[0].icon must be one of
  Nendo's icons: plus, minus, …"}]`.
- The Lens's own controls left showing: `The view still draws its own controls or title on
  a host that draws them: {"native":true,"tools":"flex","title":"block"}`. The same for the
  graph: `The graph still draws its own controls or title on a host that draws them:
  {"native":true,"tools":"flex","title":"block"}`.
- The Gantt's title left showing: `The chart still draws its own title on a host that names
  the screen: {"native":true,"title":"block"}`.
- Take it out from the Lens's menu doing nothing: `Take it out from the menu took nothing
  out.`
- Find in the Gantt dimming nothing: `Find in Nendo’s toolbar dimmed no row.`
- The graph back on its own palette: `The graph does not draw with the Workbench's canvas
  token.`

Not measured in a product lane: the three views in the real app. The fixture does not draw
Nendo's strip; the W-090 journey measures the strip itself with its probe.

### Nendo's chrome (W-090)

Measured on 2026-09-28 against a Debug build. The journey (`DesktopExtensionViewJourneyTests`
with `tools/Review-ExtensionViews.mjs`) ran in the real app, with probe A declaring a toolbar
and asking for a menu:

- G27: the declared toolbar is drawn by the Workbench above the frame, in its own controls,
  and a label that looks like markup stays text. With the key hints on, each key stays inside
  its control: an icon button grows to hold it.
- G28: a press in the strip, Nendo's Add (its form left closed) and a Ctrl K entry each reach
  the view as a command, and the strip shows the press at once.
- G29: the menu is the Workbench's, drawn on its document at the view's point (40, 30), and
  answers the pick. Escape answers nothing.
- G30: Ctrl K pressed with the view focused opens the palette before the view hears it. A key
  the view keeps reaches it. A declared key runs its command from inside the view and from
  the Workbench.

The Workbench suites measure the same at the broker (`extension-broker.test.mjs`) and in
`api.js` (`extension-api.test.mjs`): the command event, the coalesced toolbar and the keys
handed back. `view-toolbar.test.mjs` measures the markup, Ctrl K's entries, the keys and the
table of Nendo's own keys. `Review-BcmAtlas.ps1` and `Review-WorkDependencies.ps1` measure
each view twice: on a fixture broker that offers the chrome, and on one that does not.

Each guard was seen to fail with its defect put back:

- A button's label unescaped: `A button’s label was not escaped where it lands.`
- The broker taking any kind: `{"items":[{"kind":"html","id":"x","label":"X"}]} was drawn.`
- A menu passed on as the view sent it:
  `The menu reached the Workbench as the view sent it rather than rebuilt.`
- The broker running any key a view hands back:
  `A key the view never declared, or not a key at all, was run.`
- `api.js` leaving Ctrl K to the view:
  `Ctrl K pressed inside the view was left to the view instead of handed to Nendo.` In the
  real app: `Timed out: Ctrl K pressed inside the view opening the palette (last: false)`.
- Ctrl K without the views' commands: `Timed out: the probe’s commands in Ctrl K (last: null)`.
- Add ignoring the view that took it: `Timed out: Nendo’s Add reaching the view (last: null)`.
- The Atlas's own toolbar left showing: `The Atlas still draws its own controls on a host that
  draws them: {"native":true,"toolbar":"flex","subbar":"none","crumbs":true}`.
- An icon button kept at 30 pixels with the hints on, a defect found while looking at the
  strip: `With the key hints on, a control spills its key over the control beside it:
  {"shown":3,"spill":["zoom-in"],"overlaps":0}`.

Not measured in a product lane:

- a right-click made with a real pointer (the lanes dispatch the event);
- Ctrl F and other keys the browser also claims, in the installed app;
- the two views in the owner's own files.

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

Not measured in a product lane (the clipboard since W-123's G36, and downloads since F-237's G41, are):
pop-ups, script dialogs,
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
- 2026-09-26 — Phase 3 begins, product 0.16.x: `records.create`, `records.update`,
  `records.delete` and `commands.run`. The host admits a view's actor on the four
  record writes alone, and History attributes each write to `extension:‹package›`.
  No host confirmation (ADR-0013). Proposals and `nendo.state` are still to come
  (W-065).
- 2026-09-26 — `schema.describe` gives each command its `steps`, so a view can tell,
  as the record page does, that a command is spent on a record (W-068).
- 2026-09-26 — Phase 4: developing a package from a folder on this device, with a
  reload on every save, the Development strip, and Save to file as Import's proposal.
  `extension.develop.link`, `.stop` and `.save`, and the
  `extensionDevelopmentChanged` event (W-063).
- 2026-09-26 — Phase 3 continues: `proposals.prepare`, `proposals.get` and
  `proposals.open`. A view's proposal carries its package as its origin, opens in the
  review naming the package, and one waits per package. The host admits the actor on
  `proposal.prepareChangeSet` and `proposal.get` (W-069).
- 2026-09-26 — Phase 3 completes: `state.get`, `state.keys`, `state.set` and
  `state.delete`, through the `extension.setState` operation and the host's
  `extension.state.read` and `extension.state.set` (W-069).
- 2026-09-26 — `records.create` and `records.update` take `targetVersions`, the
  version of each reference target the write assigns, passed to the host as
  `expectedTargetVersions`. Without it no view could set a reference (R-002).
- 2026-09-26 — each filter binding carries its field's `storageKind`, and `today` on a
  DateTime field resolves to the zoned instant the person's day begins rather than a
  bare date the host refuses (R-003).
- 2026-09-28 — `records.move`: a view moves a record in its record type's declared tree,
  under a parent or to the top level and before a sibling or last, through the host's
  `data.moveRecord`, which now admits a view's actor. The Engine refuses a loop and renumbers
  the siblings in one revision (ADR-0019 stage 8, W-079).
- 2026-09-28 — a view's controls in Nendo's own chrome: `ui.setToolbar`, `ui.showMenu`, the
  `command` event and the `key` message. Nendo's Add can be taken by a view, a view's commands
  are in Ctrl K with their keys, and Nendo's own keys work while a view has focus (ADR-0013
  2026-09-28, W-090).
- 2026-09-28 — one row above a view: on a screen the toolbar is drawn in the Use toolbar's row
  before Add, the breadcrumb holds the record type and the view, and a `text` item gives way
  rather than wrap the row (ADR-0013, *One row above a view*; W-092). No change to the wire.
- 2026-09-28 — the view API as a read: the api build writes `view-api.json` from the tables
  it is built from, and the local MCP serves it at `nendo://application/view-api`, named
  only with the condition that it is for writing a view's code (W-094).
- 2026-09-29 — `records.batch`: several creates, updates and deletes as one revision,
  through the host's new `data.writeRecords`, which admits a view's actor. A record appears
  once; a reference to a record written earlier in the batch is checked against the version
  that write leaves (W-102).
- 2026-09-29 — `ui.setPlace`, the event `place` and `context.place`: a view's own places are
  steps in Nendo's Back and Forward, kept by the Workbench for the session and handed back
  (W-127, the owner's F-215).
- 2026-09-29 — each file in a review's **Code** section starts folded, and its folded row
  says the lines it adds and removes (W-098). No change to the wire.
- 2026-10-06 — `schema.describe` names each record type's `linkRule` (ADR-0026), so a view
  can offer only the links the file allows; a write that leaves another is refused with
  `link-not-allowed` (W-105). A view on an earlier host finds the key missing.
- 2026-09-27 — `schema.describe` names each record type's declared `hierarchy`, so a view
  that writes a parent knows which field holds it rather than guessing among the record
  type's references to itself. A view on an earlier host finds the key missing (W-077).
- 2026-09-29 — the view kit (W-064): `tools/view-kit/nendo-view-kit.js`, a versioned file a
  package copies, for a focus ring, keyboard traversal, a text alternative, fitting and a
  status tone. No new theme keys: text scale, reduced motion and high contrast reach a view
  through the standard media queries and the page's zoom. No change to the wire.
- 2026-10-01 — files a person hands a view (W-104): the browser's own file input and a drop on
  the view's frame, measured in a real host (G34, G35). The system file pickers are refused to
  a view by the browser. Nendo's drop hint takes no pointer, so it steps aside over a view. No
  method, no rung.
- 2026-10-01 — the clipboard from a command (W-123): a command chosen in Nendo's row reaches a
  frame without focus, where the browser refuses a clipboard write; a view takes focus first.
  Measured in a real host (G36). No method, no rung.
- 2026-10-02 — a view as a screen of the file (W-106, ADR-0013 Phase 5): the `extensionView`
  root, listed in the first picker of the Use breadcrumb, and `opensFile`, the screen a file
  opens on where views run. Rung 1.42.0. Measured in a real host (G37–G39). `extensionTile`
  moves to the next rung.
- 2026-10-02 — downloads without WebView2's panel (F-237): a view's download goes to Downloads
  under a name that overwrites nothing, and the browser's panel, whose question about an `.xml`
  file froze Nendo after Keep, never opens. Measured in a real host (G41).
- 2026-10-03 — one line beside Add (W-115): on a screen the row keeps to one line, and what
  does not fit goes into Nendo's More menu; Add keeps its width, where a full row had pushed it
  off the window. Four icons join the set: `clipboard`, `layout`, `undo` and `redo`. An older
  Nendo refuses a row that names them, so a view that wants to run there declares it again
  without them. Measured in a real host (G42). No method, no rung.
- 2026-10-06 — three icons for a page's width (W-174): `widthNarrow`, `widthMedium` and
  `widthFull`, Lucide's rectangle-vertical, square and rectangle-horizontal. The Garden view
  declares them as three toggles, and on an older Nendo, which refuses them, declares its
  width again as a choice of words. Measured by `tools/Review-Garden.ps1`. No method, no rung.
- 2026-10-06 — an unanswered write and a view's drafts (review R-011, R-001): `records.batch`
  takes an optional `writeKey`, so a batch whose answer was lost is sent again and kept once;
  `written-not-read` for a write kept but not read back; `disconnected` and `host-timeout`
  no longer say to send a write again. A view keeps its own drafts recoverable, because Nendo
  stops views off screen without asking. Measured by `scripts/extension-broker.test.mjs`,
  `tools/Review-Garden.ps1` and `tools/Review-Swarm.ps1`. No rung.
- 2026-10-06 — a proposed package file read whole (review R-017): `proposal.readPackageFile`
  answers windows of a file as the proposal under review leaves it, bound to its reviewed
  digest, and each review offers *Read the whole file*; a cut-short change says so folded.
  Measured by `ExtensionPackageTests` and `scripts/package-diff.test.mjs`. No rung.
