# Media in Nendo files

Status: **planned**; nothing is built as of 2026-10-15. [ADR-0031](../decisions/0031-media-in-user-data.md)
is Proposed, and decision D-010 in the planner asks the owner its three questions.

The owner asked on 2026-10-15 for Nendo applications to hold media, such as pictures and sound:
embedded in the `.nendo` file, linked to a web address, or linked to a file on the computer. On
2026-10-16 they asked for **images first**, as initiative I-012 in the planner; this plan is
W-252, and the image slices are W-263 to W-274. Sound and video use the same design and are not
yet planned.

This document is the plan: what a media value is, where its bytes live, how big a file may get,
how the bytes reach the screen, what agents and views may do, and the slices that build it. The
ADR holds the decision and its evidence obligations; this document holds the reasoning and the
order of work.

## The answers in brief

| Question | Recommendation |
| --- | --- |
| What media is | Pictures (PNG, JPEG, GIF, WebP, AVIF, SVG), sound (MP3, Ogg, WAV, FLAC, M4A, WebM) and video (MP4, WebM). Nothing else |
| The field | A **Text field with the presentation `media`**, accepting any of picture, sound and video. One item per value; many items are child records |
| The value | An **address**: `media:` + SHA-256 (embedded), an `https:` address (web), or a local path, absolute or relative to the file's folder (`.\Media\cover.jpg`) |
| Embedded bytes | Two protected tables, **once per distinct content**, outside history. Operation rows carry the hash, never the bytes, as view packages already do |
| How big | **64 MiB per item, 2 GiB per file**, left out of today's 256 MiB open bound, provided the open-time measurement holds |
| Opening | The open inspection checks the media tables' shape and totals and does not read the content; integrity checks hash it on demand |
| Removing | Content stays until the person runs *Remove unused media*, after a backup, as with a fold |
| Serving | One media origin per open file, on the existing `WebResourceRequested` filter, streamed with byte ranges; local files allow-listed by extension and signature; **no CORS**, so script cannot read link bytes |
| The internet | WebView2 loads a web picture when it is shown; a device setting, on by default, turns that off |
| Agents and views | Write addresses as text; embed bytes they already hold (chunked put, typed API); read embedded content. Never make Nendo read a local file or fetch a web address |
| Everything else | Formulas, CSV, Studio and search read the address as text; *Export with media* carries embedded content in a folder |
| ADRs | ADR-0031, which amends ADR-0001, ADR-0003, ADR-0012 and the vision on acceptance |

## Why an address in a Text field

A media value has to say which of three sources it is. That is text whatever the storage kind,
so a new storage kind would add a case to every switch (formulas, CSV, Studio, compare, scalars,
search, the view API) for no gain. A presentation is the narrow change: everything that reads
text already reads a media value, and Studio shows the address when every preview fails, which
is the *data before presentation* axiom.

The value must never hold the bytes. History keeps the whole new value and the whole previous
value of every set (`canonical_json` and `inverse_evidence_json`), so a picture in a cell would be
copied twice on every edit. The view-package store already solved this: bytes are stored once,
keyed by their SHA-256, and operations carry the hash (ADR-0013). Media reuses the pattern in
tables of its own, so its bounds and its removal are its own.

A host-owned Media record type was considered and set aside: references cannot target a protected
type, a list would show a label instead of a picture, and a person who wants one description per
item reused across records can model it today, as a record type of their own with a media field.

## The address

| Kind | Example | Notes |
| --- | --- | --- |
| Embedded | `media:3f9a…` (64 hex digits) | Must name content the file holds, checked at the end of every mutation (`media-missing`) |
| Web | `https://example.org/cover.jpg` | `http:` is refused: the Workbench page is `https` and would block it |
| Local, absolute | `C:\Music\take 3.flac` | Breaks when the file moves; shows as missing |
| Local, relative | `.\Media\cover.jpg`, `..\Shared\logo.png` | Resolved against the `.nendo` file's folder, so file and folder move together |

Anything else in a media field is `media-address-invalid`. The grammar is the Engine's, so every
client gets the same answer.

## Where the bytes live

A new layout rung, `-media-`, added by the first media field or the first put:

| Table | Holds |
| --- | --- |
| `__nendo_media` | SHA-256, media type, byte length, the name it was added under, width and height, duration |
| `__nendo_media_content` | SHA-256 and the bytes |
| `__nendo_field_media` | Field ID and its accept set |

Content and metadata are split so that the open inspection, Studio's file information and the
budget check read the small table only. `media.put { sha256, mediaType, byteLength, name }` carries
the bytes beside the operation, as `extension.putFile` does; the Engine checks the hash, the length,
and that the content begins as its type says. Width, height and duration are read by the host when
it can, and left empty when it cannot.

## How big a file may get

Today a file may be 256 MiB because opening inspects all of it before granting anything; a cold
open at that size costs about 6.6 seconds. One album would fill it. So the plan:

- **The open bound counts everything except `__nendo_media_content`.** The inspection checks the
  media tables' shape and that the stored totals are inside the budget, and does not read the
  content pages. SQLite's `integrity_check` takes a table argument, so the whole-file read can
  become a read of every other table.
- **The budget is 64 MiB per item and 2 GiB per file.** 64 MiB holds a FLAC album track or a short
  1080p clip. 2 GiB is a photo library of a few thousand pictures.
- **The measurement decides.** W-264 starts by measuring a cold open of a file holding 2 GiB of
  content against the same file without it. If it is not within 10%, the budget comes down to what
  is, and the ADR says so.

Backup and copy remain whole-file and grow linearly; the reference file records their times.

## How bytes reach the screen

The host already serves view packages through a `WebResourceRequested` filter on
`https://*.example/*`. Media gets one more origin per open file instance, `https://media-{key}.example`:

- `/m/{sha256}` streams embedded content from the database (not a whole `byte[]`, as the package
  server does today), with single byte ranges so audio and video can seek, and
  `Cache-Control: private, immutable` because the address is the content.
- `/f/{token}` serves a local file the page asked for by its address: only a file, never a folder;
  only at a media extension; only when its first bytes match that type.
- **No response carries `Access-Control-Allow-Origin`.** An `img`, `audio` or `video` element shows
  the bytes; a script's `fetch` from another origin cannot read them. That keeps a received file's
  view from turning a local link into a way to read the disk.
- SVG is served with `Content-Security-Policy: sandbox` and shown only through `img`.

Web addresses load straight from the internet. The shell's CSP (`img-src 'self' data:`, no
`media-src` today, pinned by `scripts/csp.test.mjs`) gains the media origin and `https:`. The device
setting *Load media from the internet* blocks those requests when off, and the field then shows the
address. Loading a picture tells its site the file was opened; the setting is the answer for
privacy and for offline use. Nendo itself only fetches a web address when the person chooses
*Embed a copy*.

## What agents and views may do

| | Agent (MCP) | View (typed API) | Person |
| --- | --- | --- | --- |
| Set an address | Yes, as text | Yes, as text | Yes |
| Embed bytes it holds | Chunked put | `media.put` | Drop or pick a file |
| Read embedded content | Pictures and sound as MCP content, bounded | `media.read` | Save a copy |
| Show a link | n/a | Through the media origin, display only | Yes |
| Read a local file's bytes | No | No | *Embed a copy* |
| Fetch a web address | No | No (through Nendo) | *Embed a copy* |
| Remove unused media | No | No | Yes |

A view could already fetch any web address itself, since its frame has no CSP; that is unchanged
and not a path through Nendo.

## Native UI

The look is the canvas's job (W-263); this is what it must cover:

- **Record page.** A picture fitted to its column, with a larger view on click; sound and video with
  their own controls; a line naming the source (In file, Linked file, Web), the name and the size.
- **Editor.** Drop or pick a file to embed it. A menu offers Link to file instead, Web address,
  Replace, Remove, Embed a copy (for a link), Show in folder (for a local file, through
  `explorer /select`; the file itself is never opened in another program) and Save a copy.
- **Lists and boards.** A thumbnail for a picture, a glyph for sound and video.
- **Gallery.** A media field as the cards' cover, a new property on the gallery node (ADR-0004).
- **Studio.** The address and a small preview; the same editor.
- **Markdown.** `![alt](address)` shows the picture when the address is a media address; every other
  image and every link stays inert, as `markdown.ts` makes them today.
- **Missing.** An address whose content is absent shows the address and a quiet *missing* mark;
  it never stops the page.

Thumbnails are the browser scaling the original in this plan. A thumbnail cache is a later item if
a gallery of large pictures measures slow.

## Everything else reads text

- **Formulas** read the address as text; no new function.
- **CSV** exports and imports addresses. *Export with media* writes each embedded item into a
  `Media` folder beside the CSV and the address becomes `.\Media\…`, so an import beside that folder
  links them, and *Embed all linked media* on a record type pulls them in.
- **New files** (ADR-0022) keep the content their kept records name. Duplicate, Fork and Backup
  copy the file whole.
- **Search** (ADR-0028) indexes an embedded item's name, not the address.
- **Help pages** (ADR-0027) are out of this plan; its *pages need pictures* trigger could later reuse
  the media origin for package files.

## Build slices

The slices build pictures: PNG, JPEG, GIF, WebP, AVIF and SVG. Each is a planner work item under
I-012, with its own acceptance criteria. Every guard a slice adds is falsified once, and the
failure text goes in a Finding (`AGENTS.md`).

| Slice | What | Acceptance and gate |
| --- | --- | --- |
| **W-263** Image canvas | Directions for every state under [Native UI](#native-ui), pictures only, Light and Dark | The owner's pick recorded here and on the item; artboards in `docs/design/image-canvas/` |
| **W-264** Engine | The rung, field, accept set, address, `media.put` for picture types, `media-missing`, the bounds, the open inspection, integrity, new files, minimum host | Engine tests per write path, each falsified; operation rows independent of a picture's size; layout and Format1 fixtures unchanged; **the open-time measurement first**; `Test-Production.ps1` |
| **W-265** Serving | The media origin, streaming, local allow-list, no CORS, SVG sandbox, the shell CSP's `img-src`, the device setting | A lane measuring 404s, view `fetch` refused while `img` shows, SVG script not run, remote not requested when off; a 64 MiB picture not allocated whole |
| **W-266** Record page | The picture with its width and height reserved, the larger view, the editor (drop, pick, paste from the clipboard, link, web address, embed a copy, show in folder, save a copy), the missing state | Workbench shell lane in both themes; a real-pointer drop and a paste each embed in one revision; installer rebuilt; the owner asked to look |
| **W-267** Thumbnails and covers | Thumbnails in lists and boards; a gallery cover property (ADR-0004 amendment first) | Lane geometry in both themes; a gallery of 200 large pictures measured before any thumbnail cache |
| **W-268** Studio | The cell's preview and editor; adding an image field in Structure | The address readable when the preview is refused; safe mode shows text |
| **W-269** MCP | Vocabulary, chunked put, the picture as MCP image content, audited refusals, skill text | Protocol tests; surface count and description lint |
| **W-270** View API | `media.urlFor`, `describe`, `put`, `read` | A view test round-trips a picture; `read` of a link refused; the contract updated |
| **W-271** Markdown pictures | `markdown.ts` renders media addresses | SSR markup tests, including `javascript:` and `data:` staying inert |
| **W-272** CSV, new files, search | Export with pictures, import, embed all linked, search on names | A round trip between two files compared by hash; a missing `media:` refused at review |
| **W-273** Remove unused pictures | The host operation and Studio's totals | Named content never removed; backup first; size falls by what was removed |
| **W-274** Reference file and guide | A built demo file with all three sources, the site guide and screenshots, the measurements as Checks | `Test-BinaryAssets.ps1`, `Test-Site.ps1` |

The order is W-264 first, with W-263 alongside since it changes no code. W-265 follows W-264;
W-266, W-267 and W-268 need the canvas and W-265. W-269, W-272 and W-273 need only W-264; W-270 and
W-271 need W-265; W-274 comes last. The planner holds these as dependencies.

Sound and video would add their types to the accept set and their players to the record page, on
the same store, address and origin; nothing in these slices is picture-only plumbing.

## Open questions

These are D-010's three, each with the recommendation.

1. **Storage: an address in a Text field (A), a new storage kind, a host Media type, or links
   only?** A: no new type for any client to learn, and history stays free of bytes.
2. **Bounds: 64 MiB per item and 2 GiB per file outside the open bound, or everything under
   today's 256 MiB?** The first, held to the open-time measurement. 256 MiB is one album.
3. **Web media: loaded when shown with a device setting to turn it off, or asked per file?**
   Loaded when shown. It matches how the owner weighs setup steps against local security, and the
   setting covers privacy and offline use.
