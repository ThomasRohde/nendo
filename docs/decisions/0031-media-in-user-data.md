# ADR-0031: Media in user data

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** the owner, D-010 in the planner (A, 1 and i, as recommended); proposed 2026-10-15
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The survey of the code at a89b63f in Context; the plan in
  [`../design/media.md`](../design/media.md). The open-time measurements this ADR asks for are
  its first slice's
- **Depends on:** ADR-0001 one-file boundary (whose revisit trigger *binary or asset fields
  become a product requirement* this answers), ADR-0003 relational user data, ADR-0004 semantic
  UI, ADR-0005 one coordinator, ADR-0006 revisions and compensation, ADR-0012 format ladder and
  the 1.x promise, ADR-0013 custom views and their asset server, ADR-0021 folding, ADR-0022 new
  files, ADR-0028 search
- **Amends:** ADR-0001 (Negative consequences and the revisit trigger), ADR-0003
  (the deferred binary and asset fields), ADR-0012 (the open bound counts everything except
  embedded media content), [`../vision.md`](../vision.md) (moves *binary and asset fields* from
  Out to In, for media) and `AGENTS.md` (the out-of-scope line)
- **Related design:** [`../design/media.md`](../design/media.md), [`../contracts/media.md`](../contracts/media.md)
- **Delivery:** Stage 1, the Engine, built 2026-10-16 for pictures (W-264, host 1.52.0); stages 2-9 open (I-012)

## Context

The owner asked for Nendo applications to hold media, such as pictures and sound: embedded in
the `.nendo` file, linked to an address on the internet, or linked to a file on the computer.
Today a file cannot do any of the three.

- **No field can show a picture or play a sound.** The storage kinds are Text, Integer,
  Decimal, Boolean, Date, DateTime, Uuid and Reference (`ApplicationModel.cs`). The
  presentations are a closed set, `singleLine`, `longText`, `markdown`, `singleChoice`, `date`
  and `rating` (`Operations.cs`). The Markdown renderer makes links and images inert on
  purpose: an image shows its alt text only (`markdown.ts`).
- **History stores whole values.** An operation row keeps the new value in `canonical_json`
  and the previous one in `inverse_evidence_json`. A picture stored in a cell would be copied
  into history on every edit of it.
- **The file already stores bytes well, for view packages.** `__nendo_extension_blob` keeps
  each distinct content once, keyed by its SHA-256, and operation rows carry the hash, never
  the bytes (ADR-0013). `ExtensionAssetServer` serves those bytes to WebView2 through a
  `WebResourceRequested` filter on `https://*.example/*`, with a single byte range and
  `nosniff`. It reads each file into memory whole, which is fine at 4 MiB and not at 60.
- **A file may be at most 256 MiB.** Opening a file inspects all of it before any capability
  is granted; a cold open at 256 MiB costs about 6.6 seconds (`MaximumInspectionFileBytes`).
  One album of sound fills that.
- **The shell cannot load anything from outside.** The Workbench's CSP is
  `img-src 'self' data:` with no `media-src`, so it falls back to `'self'`. A custom view's frame
  has no CSP and may fetch any address.
- **The host already opens addresses with care.** Only a user-initiated `http(s)` or `mailto`
  new window reaches `Launcher.LaunchUriAsync`. Nothing in the host opens or reads a path that
  came from a record.
- **The axioms hold.** Agents never get file-system or network authority. Studio must show the
  data when every presentation fails. An empty file stays valid.

## Decision drivers

1. One field, three sources: embedded, a web address, a local file, chosen per value.
2. A file that never holds media is byte for byte what it is today.
3. History, undo and proposals stay small: no byte of media in an operation row.
4. Opening a file stays fast however much media it embeds.
5. Data before presentation: Studio and CSV show a media value as readable text.
6. No agent, view or automatic action gains a way to read a local file or reach the network
   through Nendo.
7. A file shared with someone else can carry its media with it.

## Options considered

### A. Media addresses in Text fields, and a content-addressed media store in the file (chosen)

A media field is a Text field with the presentation `media`. Its value is an address:
`media:` and a SHA-256 for embedded content, an `https:` address, or a local path. Embedded
bytes live in protected tables, once per distinct content, outside history. Every client that
reads text already reads the value; only the presentation is new.

Costs: a new rung, a new operation that carries bytes, a media origin in the host, and an open
inspection that must leave the media content out of its whole-file read.

### B. A new storage kind

A `media` column type. Every switch over storage kinds (formulas, CSV, Studio, compare,
scalars, search, the view API) gains a case, and the value must still say which of three
sources it is, which is text. More change for the same result.

### C. A host-owned Media record type that fields reference

One description per item (alt text, credit) reused from many records. References cannot target a
protected type today, a list would show a label instead of a picture, and a person who wants
this can model it under A: a record type of their own with a media field.

### D. A folder of media beside the file

Rejected by ADR-0001: the file stops being the unit a person copies.

### E. Links only, never embedded

The cheapest. A file mailed to someone arrives without its pictures, which defeats the point of
one file.

### Do nothing

Media stays in custom views that bundle pictures in their package, and nowhere a person can add
one.

## Decision

**Option A.**

1. **What media is.** Pictures (`image/png`, `image/jpeg`, `image/gif`, `image/webp`,
   `image/avif`, `image/svg+xml`), sound (`audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/flac`,
   `audio/mp4`, `audio/webm`) and video (`video/mp4`, `video/webm`). Nothing else is media. The
   list is the Engine's; adding a type is an amendment.
2. **A media field.** A Text field with the presentation `media`, and a declared accept set:
   any of *picture*, *sound* and *video*, all three by default. `schema.addField` takes it;
   `schema.setFieldPresentation` may switch a Text field to `media` when every stored value is
   empty or a valid address, and back to `singleLine` at any time. The accept set is field
   metadata on the media rung (point 9), set by `schema.setMediaAccept`. A field holds one item;
   many items are child records.
3. **The address.** The stored value is one of:
   - `media:` and 64 lowercase hexadecimal digits: embedded content, by its SHA-256;
   - an absolute `https:` address: on the internet;
   - a local file: an absolute Windows path (`C:\Music\take 3.flac`) or a path relative to the
     folder that holds the `.nendo` file, starting `.\` or `..\`.

   Anything else in a media field is refused with `media-address-invalid`, on every write path.
   `http:` is refused: the Workbench is an `https` page and would block it. A relative path keeps
   working when the file and its media folder move together.
4. **Embedded content.** Two protected tables: `__nendo_media` (SHA-256, media type, byte length,
   the name it was added under, and the picture's or video's width and height and the sound's or
   video's duration where the host could read them) and `__nendo_media_content` (SHA-256 and the
   bytes). Each distinct content is stored once. The bytes enter only through `media.put
   { sha256, mediaType, byteLength, name }`, with the bytes beside the operation as
   `extension.putFile` carries them. The Engine checks the hash, the length and that the content
   begins as its media type says (`media-type-mismatch` otherwise). `media.put` is a data-lane
   operation, `ReversibleWithRetainedState`: its inverse leaves the content stored, unreferenced.
5. **Holding together.** At the end of every mutation, as ADR-0026's rule is checked, a `media:`
   address that the mutation wrote and whose content the file does not hold refuses the mutation
   with `media-missing`, naming the record and field. History, undo, restore and a CSV import all
   reach that check.
6. **Bounds.** At most 64 MiB per item and 2 GiB of embedded content per file. A put over either
   is refused before anything is staged (`media-too-large`, `media-budget-exceeded`). The 256 MiB
   open bound and the write ceiling count every page of the file except those of
   `__nendo_media_content`.
7. **Opening stays fast.** The open inspection checks the media tables' shape and metadata and
   that their totals are inside the bounds. It does not read the content. Content is hashed by
   `nendo.health.verify_integrity` and Studio's integrity check, which report a mismatch by
   address. The obligation in Evidence holds this point to a number.
8. **Removing.** Content stays until the person runs *Remove unused media*, a host operation of
   the open file like a fold (ADR-0021): never an agent, a view or an automatic action. It makes a
   backup first, removes content that no current value and no retained operation names, and
   compacts the file. To free content that only old history names, the person folds first.
9. **Format.** One rung, `-media-`, holding the two tables and `__nendo_field_media` (field ID,
   accept set). It is added by the first media field or the first put. A file that never has
   either keeps its layout and minimum host version. A file that has them needs the host that
   introduces the rung; an older host refuses it rather than misread it (ADR-0012).
10. **Serving.** The host answers one media origin per open file instance,
    `https://media-{key}.example`, through the existing `WebResourceRequested` filter:
    - `/m/{sha256}`: embedded content, streamed from the database with single byte ranges, its
      stored media type, `nosniff`, and `Cache-Control: private, immutable`, because the address
      is the content.
    - `/f/{token}`: a local file the page asked for by its address. Served only when the path
      resolves to a file, never a folder; its extension is one of the media types; and its first
      bytes match that type. Anything else is 404. Read-only; never written, moved or opened in
      another program.
    - No response carries `Access-Control-Allow-Origin`. The Workbench and a view can show the
      bytes in an `img`, `audio` or `video` element; script on another origin cannot read them.
    - An SVG is served with `Content-Security-Policy: sandbox` and shown only through `img`, which
      runs none of its script.
11. **The internet.** A web address is loaded by WebView2 itself, as a browser loads a picture. The
    shell's CSP gains the media origin and `https:` in `img-src` and `media-src`. A device setting,
    *Load media from the internet*, on by default, blocks those requests when it is off, and the
    field then shows the address instead. Nendo itself fetches a web address only when the person
    chooses *Embed a copy*.
12. **What agents and views can do.** An agent or a view writes an address as text, and may embed
    content it holds: an agent through a chunked put over MCP, a view through the typed API. An
    agent may read embedded content (pictures and sound as MCP content, within a bound). Neither
    can make Nendo read a local file, fetch a web address or return their bytes: *Embed a copy* of
    a link and every local file read are the person's. A view shows links through the media origin
    like the Workbench does, and cannot read their bytes (point 10).
13. **Where media shows.** A record page shows a picture fitted to its column, with a larger view on
    click, and sound and video with their own controls. Lists, boards and the gallery show a
    thumbnail or the kind's glyph; a gallery may name a media field as its cards' cover (an
    ADR-0004 property). Studio shows the address and a small preview, and its editor embeds a
    dropped or picked file, links a file instead, or takes a web address. A Markdown field shows
    `![alt](address)` as a picture when the address is a media address; other images stay inert.
    An address whose content is absent shows as *missing*, with the address, and never stops the
    page.
14. **Everything else reads text.** A formula reads the address as text. CSV exports and imports
    addresses; *Export with media* also writes each embedded item into a `Media` folder beside the
    CSV and the address becomes a relative path, so an import beside that folder links them. A new
    file of the application (ADR-0022) keeps the content its kept records name; Duplicate, Fork and
    Backup copy the file whole. Search indexes the name an embedded item was added under, not the
    address.

**Delivery order.** (1) The Engine: the rung, the field, the address, `media.put`, the end-of-mutation
check, the bounds and the open inspection, measured. (2) The host's media origin and CSP. (3) The
Workbench and Studio. (4) MCP. (5) The view API. (6) Markdown pictures. (7) CSV with media. (8)
*Remove unused media*. (9) A reference file. The contracts and `../architecture.md` change with each
stage. The plan holds the slices.

## Evidence and validation obligations

- **Open time.** A file holding 2 GiB of embedded content opens within 10% of the same file without
  it, cold, measured with `Review-DesktopPerformance.ps1`'s stage markers. If it cannot, the budget
  in point 6 comes down to what does, and this ADR says so.
- **Every write path.** A test per path (set field, form, import, command step, automatic action,
  view, agent, undo, restore) that a `media:` address without content is refused naming it, and
  that an invalid address is refused; each guard seen to fail with its check removed.
- **History stays small.** The operation rows of a put and of a field set hold no content: their
  size does not grow with the item's.
- **Layout.** A file with no media field and no put keeps its layout name and minimum host; the rung
  is recognised on reopen; the 1.x format promise's fixtures still open.
- **Serving.** Measured in a lane: a range request returns exactly its bytes; a folder, a renamed
  executable and a text file at a media extension are 404; a view's `fetch` of each kind of media
  address fails while its `img` shows it; an SVG's script does not run.
- **Removing.** Content that a current value or a retained operation names is never removed; the
  backup exists before anything is removed.

## Delivery note — 2026-10-16, stage 1 (W-264)

The Engine, for pictures. Details the code settled:

- **The accept set has no storage yet.** Pictures are the only kind this host knows, so a media
  field accepts pictures and `schema.setMediaAccept` and `__nendo_field_media` wait for the first
  other kind (point 2).
- **The media rung needs the search rung.** The ladder is linear, so the first put builds the
  file's search index from its records when the file has none, rather than leave an empty index
  that later writes would fill in part. Media fields are left out of the index.
- **One change carries at most 64 MiB of new pictures**, beside the 64 MiB per item.
- **Opening.** The open bound and the write ceiling subtract the media content's pages, estimated
  from the metadata; a file over 256 MiB that is not SQLite is still refused by length alone. Every
  open-time integrity check (inspection, authority, health) checks every table but the content and
  pairs items with content; the explicit check reads the whole file and hashes every picture. The
  content digest hashes the content's keys.
- **Undo.** A revision's `media.put` has no inverse to run; a revision that only embedded a picture
  says there is nothing to undo.

Evidence: `MediaTests` (11); `MarkdownPresentationTests` updated for the switch's new wording, and
`FileInspectionTests`' one-byte-over refusal kept by refusing a non-SQLite file by length alone; the
Engine suite then passed whole. Falsified, each guard
removed and its test seen to fail: the end-of-mutation check (*"Expected exception
type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown"*), the open bound's
subtraction (*"inspection-limit: This file exceeds the current 256 MiB inspection limit"*), the
explicit check's hashing (*"Expected exception type:<Nendo.Engine.NendoRecoveryRequiredException>
but no exception was thrown"*) and the address check on a media field (as the first). Measured with
`tools/media-open/` (the media contract has the numbers): +8.7% median open with 2 GiB of pictures
left out, inside the run-to-run noise; the 2 GiB budget stands.

## Consequences

### Positive

- A file can hold the pictures and sound its records are about, and stay one file.
- Linked media cost the file nothing and keep working while the files they point at stay put.
- Studio, CSV and formulas need no new type: a media value is readable text everywhere.

### Negative

- Files grow. Embedded content is never removed until the person asks, so replacing a 50 MiB
  recording five times stores 250 MiB until *Remove unused media* runs.
- A local link breaks when the file it names moves, and a web address when its site changes; both
  show as missing. A file sent to someone else carries only its embedded media.
- A web address in a received file is fetched when it is shown, which tells that site the file was
  opened. The device setting turns this off.
- Backup and copy time grow with the file: about linear in its size.

## Rejected alternatives

- **A new storage kind (B).** The same result with a case in every switch.
- **A host-owned Media type (C).** References cannot reach it, and A lets a person model it.
- **A folder beside the file (D).** ADR-0001.
- **Links only (E).** A shared file would arrive without its media.
- **Content in the cell.** History would copy it on every edit.

## Revisit triggers

- A media type outside the list in point 1 (documents such as PDF, 3D models).
- An item over 64 MiB, or a file over 2 GiB of content, that the owner needs.
- Many values per field, if child records read badly.
- Recording sound or taking a picture inside Nendo.
- Help pages that need pictures (ADR-0027's trigger), if the media origin should serve package
  files too.

## History

- 2026-10-15 — proposed, with the plan in [`../design/media.md`](../design/media.md).
- 2026-10-16 — accepted by the owner, as recommended at each of D-010's three points: an address
  in a Text field (A), 64 MiB per item and 2 GiB per file outside the open bound (1), and web
  media loaded when shown with a device setting to turn it off (i). Images are built first (I-012,
  W-263 to W-274). The amendments it names are made in ADR-0001, ADR-0003, ADR-0012, the vision
  and `AGENTS.md`. Nothing is built yet.
