# Media in user data

Media fields under [ADR-0031](../decisions/0031-media-in-user-data.md). The accept set
is pictures.

## A media field

A media field is a Text field with the presentation `media`. Its value is an address,
and nothing else is stored in the cell.

| Address | Example | Source |
| --- | --- | --- |
| `media:` and 64 lowercase hexadecimal digits | `media:3f9a…` | Embedded: content the file holds, by its SHA-256 |
| An absolute `https:` address | `https://example.org/cover.jpg` | The web |
| A drive-letter path | `C:\Pictures\cover.jpg`, `D:/Music/front.png` | A file on this computer |
| A path that starts `.\`, `./`, `..\` or `../` | `.\Media\cover.jpg` | A file beside the `.nendo` file |

The grammar is `NendoMediaAddress` (`src/Nendo.Engine/Media/NendoMedia.cs`). Refused
with `media-address-invalid` on every write path: an empty value, `http:`, a network
share, a bare file name, a web address with a user name or whitespace, a path that
ends in a folder or holds a character Windows does not allow in a name, and any other
scheme. An ordinary text field accepts any text.

- **Adding one:** `schema.addField` with `presentation: "media"` on Text storage; any
  other storage kind is refused.
- **Switching:** `schema.setFieldPresentation` moves a Text field between
  `singleLine`, `longText`, `markdown` and `media`. Into `media` only while every
  stored value is an address and every embedded one names content the file holds;
  the refusal names the first record by ID, never by what it holds. Out of `media` at
  any time. A unique field stays a single line.
- **Search** leaves media fields out: their values are addresses.
- **Formulas** read the address as text.

## Pictures

The picture types are PNG, JPEG, GIF, WebP, AVIF and SVG (`NendoMedia.PictureTypes`).
A put reads the type from the content's first bytes; a stated type that differs is
refused with `media-type-mismatch`, and so is content that begins as none of them. An
SVG is recognised by an `svg` element after any XML declaration, comments and
doctype. Width and height are read from the header of PNG, GIF, JPEG and WebP, and
left empty for AVIF and SVG.

## Embedding

`media.put { sha256, mediaType, byteLength, name?, width?, height? }` is a data-lane
operation. The bytes travel beside it, as `extension.putFile`'s do; the operation row
holds the payload above and the evidence `{stored, address}`, never the bytes.
`NendoApplicationService.PutMediaAsync` builds it from the bytes, computing hash,
size, type and picture size itself, and with a target sets that media field to the
address in the same revision.

- **Stored once.** Content the file already holds is not stored again; the put
  commits and reports `stored: false`.
- **Bounds.** At most 64 MiB per item and 64 MiB carried by one change
  (`media-too-large`), and at most 2 GiB of embedded content per file
  (`media-budget-exceeded`).
- **Reversibility.** `ReversibleWithRetainedState`. Undoing a revision undoes its
  record changes and leaves the picture stored. A revision that only embedded a
  picture has nothing to undo, and says so.
- **New file.** A new file of the application
  ([ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md))
  keeps only the pictures its kept records name.

## Holding together

At the end of every mutation, after automatic actions and beside the link rule's
check, a `media:` address that the mutation wrote and whose content the file does not
hold refuses the whole mutation with `media-missing`, naming the record type, the
record by ID and the field. Creates and restores read every media field of their
record; a set reads its own field. A put and the set that names it may come in either
order within one mutation.

## Storage and opening

The media rung of the layout ladder, after the search index, holds two protected
tables, created by the first put and never at file creation:

| Table | Holds |
| --- | --- |
| `__nendo_media` | `sha256`, `media_type`, `byte_length`, `name`, `width`, `height` |
| `__nendo_media_content` | `sha256` and `content` |

A file without the search index has it built from its records by the first put, so
it gains a whole index rather than an empty one. A file with the media rung, or with
a media field, states host `1.52.0`.

Opening leaves the media content out
([ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md)):

- **The open bound** of 256 MiB counts every page but the media content's, estimated
  from the metadata as each item's bytes over an overflow page's room, rounded up.
  Before SQLite opens the file, its length may be up to 256 MiB plus 2 GiB plus the
  32 MiB write reserve.
- **The write ceiling** and the commit measurement count the same way.
- **The integrity check** at open reads every table but `__nendo_media_content`, each
  with its indexes, and pairs every item with its content. A file without media is
  checked whole. `IntegrityCheckCount` counts it as one check.
- **The content digest** hashes the media content's keys, not its bytes: the key is
  the hash of the bytes.
- **The explicit integrity check** (`VerifyIntegrityAsync`,
  `nendo.health.verify_integrity`) reads the whole file and hashes every picture,
  naming the first whose bytes no longer match.

A backup copies every page, so it grows with the pictures; the open does not read
them. `tools/media-open/Measure-MediaOpen.ps1` and `tools/Build-Herbarium.ps1
-Measure` measure both. The reference file is `workspace/Herbarium.nendo`, built by
`tools/Build-Herbarium.ps1` with the `Herbarium pictures` folder beside it: pictures
in the file, linked from the folder and from the web.
`tools/Capture-SiteScreenshots.ps1` opens a copy in a real host and measures that
every source shows, that a picture fits its column in both themes, that the page
cannot read a picture's bytes, and that the media origin answers with no CORS header
and an SVG sandboxed.

## Removing unused pictures

A picture stays in the file while anything the file keeps names it: a value of a
media field, retired fields included; a deleted record that can be brought back; a
kept value of a view; a retained operation, in its encoding or its undo evidence,
matched by the picture's hash; or the file's own icon, `__nendo_application_icon`,
which a new file of the application keeps too. A put names its picture, so a picture
leaves only after folding history lets go of every change that named it.

`ReadMediaUsageAsync` (`media.usage`) answers the count and bytes, the unused count
and bytes, and the 2 GiB budget; History shows them under the fold.
`RemoveUnusedMediaAsync(backupPlanId)` (`media.removeUnused`, started from History)
follows the fold's rules: a backup of the file as it stands, made in the session
first, or `media-removal-needs-backup` / `media-removal-backup-stale`;
`media-removal-nothing` when nothing is unused, asked before the host makes its
backup. The removal is one write transaction that records no revision and moves no
counter; the file is then compacted and inspected as if opened. The answer gives the
count and bytes removed, the file's paged size before and after, the backup's name
and whether compaction ran.

## Serving

Each open file instance has one media origin, `https://media-{16 hex}.example`,
answered by `ExtensionAssetServer` through the view origins' `WebResourceRequested`
filter (`DesktopMedia.cs`, `DesktopSessionController.Media.cs`); the Workbench reads
it as the session's `mediaOrigin`.

- `/m/{sha256}` streams an embedded picture from the file a buffer at a time through
  SQLite's incremental blob reader, with one byte range,
  `private, max-age=31536000, immutable` and `nosniff`.
- `/f/?a={address}` serves a local file only when it is a file, its extension is a
  picture type's and its first bytes begin as that type, with `no-store`; anything
  else is 404.

No answer carries a CORS header, so an `img` shows a picture and no script on another
origin reads it. An SVG carries `Content-Security-Policy: sandbox`. The Workbench's
own policy allows `https:` in `img-src`; the device setting *Load pictures from the
internet*, on unless turned off from a web picture's menu, keeps web pictures from
loading and shows their address instead.

## In the Workbench and Studio

On a record page a picture field takes the document column: the picture fitted to
it, opening larger on a click; a line with its source (In file, Linked file, Web),
its name and a menu; a dashed drop zone when empty; a quiet *Picture not found* row
with the address when it does not load. The menu embeds a picked or pasted picture,
links a file, takes a web address, saves a copy, embeds a copy of a link, shows a
linked file in its folder and removes the picture; each writes at once, and is
refused while the record has unsaved typing. Files, the clipboard and the web are
read by the host (`media.embed`, `media.link`, `media.embedCopy`, `media.saveCopy`,
`media.reveal`), so no picture crosses the bridge, and a dropped picture's path comes
from WebView2's own file object. Lists, boards and outlines show a thumbnail; a
gallery's `coverFieldId` tops each card with the picture. Studio's cell shows a small
preview beside the address and edits the address, and Structure adds a field of type
Picture.

A Markdown field on a record page, and in its editor, shows `![alt](address)` as the
picture when the address is a media address: drawn from the media origin, or from the
web while the device loads web pictures, fitted to the column, with a *Picture not
found* line and the alt text when it does not load. Any other address stays the alt
text with the address as its tooltip. Markdown elsewhere (an agent's chat, Help)
shows no pictures.

## For agents and views

An agent embeds with `nendo.data.put_media` and reads with
`nendo://application/media/{sha256}` ([MCP contract](mcp-interface.md)). A view calls
`nendo.media.describe`, `urlFor`, `read` and `put`
([custom-view contract](custom-views.md)); its puts are staged and committed in its
package's name through `media.stage` and `media.commit`, the two picture methods a
view's actor may reach.

## Where the assertions live

| Test | Covers |
| --- | --- |
| `MediaTests` (Engine) | Address grammar; type and size from first bytes; a put and its set as one revision, the rung and host; `media-missing` on every write route; switching into media; undo keeping the picture; the bounds; a large file of pictures that opens, writes and verifies; a new file carrying only named pictures; search leaving addresses out |
| `DesktopMediaServingTests` | The origin, ranges, streaming without whole allocation, local file rules, headers |
| `DesktopExtensionWriterTests` | A view's picture staged, committed in its name, described and read back |
| `McpMediaTests` | Chunked put that sets its field, a retried final call, an unfinished put leaving nothing, the image read, the refusals |
| `media-model.test.mjs`, `media-markup.test.mjs`, `markdown-pictures.test.mjs` | The Workbench's address grammar, every state's markup, pictures in Markdown |
| `GallerySurfaceTests` | The gallery cover and `NUI459` |
| `MediaRemovalTests`, `DesktopMediaRemovalTests`, `media-usage.test.mjs` | What removal keeps, the backup first, the size reclaimed, History's section |
| `CsvPicturesTests` | CSV with pictures ([CSV contract](csv.md#pictures)) |
