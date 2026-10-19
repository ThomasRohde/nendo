# ADR-0031: Media in user data

- **Status:** Accepted
- **Date:** 2026-10-16
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `MediaTests`, `DesktopMediaServingTests`, `McpMediaTests`, `MediaRemovalTests` and `CsvPicturesTests`; `tools/media-open/Measure-MediaOpen.ps1` measures open time with media left out
- **Amends:** ADR-0001 (Negative consequences and the revisit trigger), ADR-0003 (binary and asset fields), ADR-0012 (the open bound counts everything except embedded media content), [`../vision.md`](../vision.md) and `AGENTS.md` (media moves in scope)
- **Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0012, ADR-0013, ADR-0021, ADR-0022, ADR-0028
- **Contract:** [media](../contracts/media.md), [CSV](../contracts/csv.md)

## Context

Applications need media: pictures, sound and video, embedded in the `.nendo` file, linked to a
web address or linked to a file on the computer. History stores whole values, so media in a cell
would be copied on every edit. The file already stores bytes once by SHA-256 for view packages
(ADR-0013) and serves them to WebView2. Opening inspects the whole file before granting any
capability, under a 256 MiB bound. The axioms hold: agents get no file-system or network
authority, Studio shows the data when every presentation fails, and an empty file stays valid.

## Decision

**A media value is an address in a Text field; embedded bytes live once per content in protected
tables outside history.**

1. **What media is.** Pictures (`image/png`, `image/jpeg`, `image/gif`, `image/webp`,
   `image/avif`, `image/svg+xml`), sound (`audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/flac`,
   `audio/mp4`, `audio/webm`) and video (`video/mp4`, `video/webm`). The list is the Engine's;
   adding a type is an amendment.
2. **A media field** is a Text field with the presentation `media` and a declared accept set of
   *picture*, *sound* and *video*. `schema.addField` takes it; `schema.setFieldPresentation`
   switches a Text field into `media` while every stored value is empty or a valid address, and
   out at any time. A field holds one item; many items are child records.
3. **The address** is one of: `media:` and 64 lowercase hexadecimal digits (embedded, by SHA-256);
   an absolute `https:` address; an absolute Windows path or a path relative to the `.nendo` file's
   folder (`.\`, `..\`). Anything else is `media-address-invalid` on every write path; `http:` is
   refused. The grammar is `NendoMediaAddress`.
4. **Embedded content.** `__nendo_media` (SHA-256, media type, byte length, name, and a picture's
   width and height where the host can read them) and `__nendo_media_content` (SHA-256 and bytes). Bytes enter only
   through `media.put { sha256, mediaType, byteLength, name }`, carried beside the operation as
   `extension.putFile`'s are; the operation row never holds them. The Engine checks the hash, the
   length and that the content begins as its type says (`media-type-mismatch`). Data lane,
   `ReversibleWithRetainedState`: undo leaves the content stored, and a revision that only embedded
   says there is nothing to undo.
5. **Holding together.** At the end of every mutation, beside ADR-0026's check, a `media:` address
   the mutation wrote whose content the file does not hold refuses the mutation as
   `media-missing`, naming the record and field.
6. **Bounds.** 64 MiB per item and per change (`media-too-large`), 2 GiB of embedded content per
   file (`media-budget-exceeded`), refused before anything is staged.
7. **Opening stays fast.** The 256 MiB open bound and the write ceiling count every page except
   the media content's. Open-time integrity checks read every table but the content and pair items
   with content; `nendo.health.verify_integrity` reads the whole file and hashes every item. The
   content digest hashes the content's keys.
8. **Removing.** Content stays until the person runs *Remove unused media*, a host operation like
   a fold (ADR-0021), never an agent, a view or an automatic action. It needs a backup first,
   removes content that no current value, restorable deleted record, kept view value, retained
   operation or the file's icon names, and compacts the file. To free content only old history
   names, the person folds first.
9. **Format.** The `-media-` rung, after the search rung, added by the first media field or put.
   The first put builds the search index if the file has none. A file with neither keeps its
   layout and minimum host; a file with them needs host 1.52.0.
10. **Serving.** One media origin per open file instance, `https://media-{key}.example`, through
    the existing `WebResourceRequested` filter: `/m/{sha256}` streams embedded content with single
    byte ranges, `nosniff` and an immutable private cache; `/f/` serves a local file only when it
    is a file whose extension and first bytes match a media type, else 404, read-only. No answer
    carries `Access-Control-Allow-Origin`, so an element can show the bytes and no script on
    another origin can read them. An SVG is served with `Content-Security-Policy: sandbox` and
    shown only through `img`.
11. **The internet.** WebView2 loads a web address as a browser loads a picture; the shell's CSP
    allows the media origin and `https:`. A device setting blocks web media and shows the address
    instead. Nendo itself fetches a web address only when the person chooses *Embed a copy*.
12. **Agents and views** write addresses as text and may embed content they hold (an agent through
    a chunked `nendo.data.put_media`, a view through the typed API, committed in its package's
    name). An agent may read embedded content within a bound. Neither can make Nendo read a local
    file, fetch a web address or return their bytes: *Embed a copy* and every local file read are
    the person's.
13. **Where media shows.** A record page shows a picture fitted to its column, larger on click;
    lists, boards, outlines and a gallery's cover show it small. Studio shows the address and a
    preview, and its editor embeds, links or takes a web address. A Markdown field shows
    `![alt](address)` as a picture when the address is a media address. Content that is absent
    shows as *missing* with the address and never stops the page.
14. **Everything else reads text.** Formulas read the address. CSV exports and imports addresses,
    and can write embedded items into a `Media` folder beside the CSV as relative paths. A new file
    (ADR-0022) keeps the content its kept records and its icon name. Search leaves media fields
    out.

**Built for pictures.** Every point above holds for pictures. Sound and video are not built yet:
the host knows only pictures, so a media field accepts pictures and the accept set has no storage
(`schema.setMediaAccept` and `__nendo_field_media` arrive with the first other kind). The device
setting is *Load pictures from the internet*.

## Consequences

- A file holds the pictures its records are about and stays one file; linked media cost the file
  nothing.
- Studio, CSV and formulas need no new type: a media value is readable text everywhere.
- Files grow, and embedded content stays until the person removes unused media.
- A local link breaks when its file moves, a web address when its site changes; a file sent to
  someone carries only its embedded media.
- A web address is fetched when shown, which tells that site the file was opened; the device
  setting turns this off.
- Backup and copy time grow with the file.

## Rejected alternatives

- **A new storage kind:** the same result with a case in every switch over storage kinds.
- **A host-owned Media record type:** references cannot target a protected type; a person can
  model it with a media field.
- **A folder of media beside the file:** ADR-0001.
- **Links only:** a shared file would arrive without its media.
- **Content in the cell:** history would copy it on every edit.

## Revisit triggers

- A media type outside point 1 (documents such as PDF, 3D models).
- An item over 64 MiB, or a file over 2 GiB of content, that the owner needs.
- Many values per field, if child records read badly.
- Recording sound or taking a picture inside Nendo.
- Help pages that need pictures (ADR-0027), if the media origin should serve package files too.
