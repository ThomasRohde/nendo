# Media in user data

The Engine half of [ADR-0031](../decisions/0031-media-in-user-data.md), pictures first (W-264).
How the bytes reach a page, how the Workbench and Studio show them, and what agents and views
call are later slices of the [plan](../design/media.md); this contract grows with them.

## A media field

A media field is a Text field with the presentation `media`. Its value is an address, and
nothing else is stored in the cell.

| Address | Example | Source |
| --- | --- | --- |
| `media:` and 64 lowercase hexadecimal digits | `media:3f9a…` | Embedded: content the file holds, by its SHA-256 |
| An absolute `https:` address | `https://example.org/cover.jpg` | The web |
| A drive-letter path | `C:\Pictures\cover.jpg`, `D:/Music/front.png` | A file on this computer |
| A path that starts `.\`, `./`, `..\` or `../` | `.\Media\cover.jpg` | A file beside the `.nendo` file |

The grammar is `NendoMediaAddress` (`src/Nendo.Engine/Media/NendoMedia.cs`). Refused, with
`media-address-invalid`, on every write path: an empty value, `http:`, a network share, a bare
file name, a web address with a user name or whitespace, a path that ends in a folder or holds a
character Windows does not allow in a name, and any other scheme. An ordinary text field keeps
accepting any text.

- **Adding one:** `schema.addField` with `presentation: "media"` on Text storage; any other
  storage kind is refused.
- **Switching:** `schema.setFieldPresentation` moves a Text field between `singleLine`,
  `longText`, `markdown` and `media`. Into `media` only while every stored value is an address
  and every embedded one names content the file holds; the refusal names the first record by ID,
  never by what it holds. Out of `media` at any time. A unique field stays a single line.
- **Search** leaves media fields out: their values are addresses (ADR-0028).
- **Formulas** read the address as text.

The accept set of ADR-0031 point 2 is pictures in this host; it gains its own storage when
sound or video is built.

## Pictures

The picture types are PNG, JPEG, GIF, WebP, AVIF and SVG (`NendoMedia.PictureTypes`). A put reads
the type from the content's first bytes; a stated type that differs is refused with
`media-type-mismatch`, and so is content that begins as none of them. An SVG is recognised by an
`svg` element after any XML declaration, comments and doctype. The width and height are read
from the header of PNG, GIF, JPEG and WebP, and left empty for AVIF and SVG.

## Embedding

`media.put { sha256, mediaType, byteLength, name?, width?, height? }` is a data-lane operation.
The bytes travel beside it, as `extension.putFile`'s do; the operation row holds the payload
above and the evidence `{stored, address}`, never the bytes. `NendoApplicationService.PutMediaAsync`
builds it from the bytes, computing the hash, size, type and picture size itself, and with a
target sets that media field to the address in the same revision.

- **Stored once.** Content the file already holds is not stored again; the put commits and
  reports `stored: false`.
- **Bounds.** At most 64 MiB per item (`media-too-large`), at most 64 MiB carried by one change
  (`media-too-large`), and at most 2 GiB of embedded content per file (`media-budget-exceeded`).
- **Reversibility.** `ReversibleWithRetainedState`. Undoing a revision undoes its record changes
  and leaves the picture stored. A revision that only embedded a picture has nothing to undo, and
  says so.
- **Removal.** Nothing removes embedded content from an open file in this slice. A new file of
  the application (ADR-0022) keeps only the pictures its kept records name.

## Holding together

At the end of every mutation, after automatic actions and beside the link rule's check, a
`media:` address that the mutation wrote and whose content the file does not hold refuses the
whole mutation with `media-missing`, naming the record type, the record by ID and the field.
Creates and restores read every media field of their record; a set reads its own field. A put and
the set that names it may come in either order within one mutation.

## Storage and opening

The ladder's media rung, after search, holds two protected tables, created by the first put and
never at file creation:

| Table | Holds |
| --- | --- |
| `__nendo_media` | `sha256`, `media_type`, `byte_length`, `name`, `width`, `height` |
| `__nendo_media_content` | `sha256` and `content` |

The rung below is the search index. A file without one has it built from its records by the
first put, so it gains a whole index rather than an empty one. A file with the rung states
`1.52.0`; so does a file with a media field.

Opening leaves the media content out (ADR-0031 point 7, the ADR-0012 2026-10-16 amendment):

- **The open bound** of 256 MiB counts every page but the media content's, estimated from the
  metadata as each item's bytes over an overflow page's room, rounded up. Before SQLite opens the
  file, its length may be up to 256 MiB plus 2 GiB plus the 32 MiB write reserve.
- **The write ceiling** and the commit measurement count the same way.
- **The integrity check** at open reads every table but `__nendo_media_content`, each with its
  indexes, and pairs every item with its content. A file without media is checked whole, as
  before. `IntegrityCheckCount` counts it as one check.
- **The content digest** hashes the media content's keys, not its bytes: the key is the hash of
  the bytes.
- **The explicit integrity check** (`VerifyIntegrityAsync`, `nendo.health.verify_integrity`)
  reads the whole file and hashes every picture, naming the first whose bytes no longer match.

Measured on 2026-10-16 (W-264), cold, at SQLite level, on a 201 MiB file and the same file with
2 GiB of embedded pictures: the open with the media left out took a median of 10.5 s against 9.6 s
(+8.7%; 12 and 11 runs, spread 7.9-12.7 s); the full check, as an open did it before, 14.6 s
against 8.2 s. `tools/media-open/Measure-MediaOpen.ps1` repeats it.

## Where the assertions live

`tests/Nendo.Engine.Tests/MediaTests.cs`: the address grammar; type and size from the first bytes;
a put and its set as one revision, the rung, the stated host and an operation row that does not
grow with the picture; a file that never embeds keeping its layout; `media-missing` on create,
set, a form save and a batch, with nothing written, and a set before its put in one mutation;
`media-address-invalid` on a media field only; switching a text field into media; undo keeping the
picture; the per-change bound; a 300 MiB file of pictures that opens, writes and verifies; and the
explicit check finding a changed picture.
