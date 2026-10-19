# CSV contract

The faithful Nendo CSV profile for import and export. `CsvTests.cs` asserts it, and
`CsvPicturesTests.cs` the pictures section.

## Faithful Nendo profile

- **Encoding.** UTF-8; an optional BOM is accepted, invalid UTF-8 is rejected. The
  native export starts with the BOM, so a spreadsheet opened on it reads UTF-8 rather
  than the ANSI code page; the agent's export resource is text and carries none.
  Comma delimiter, double-quote escaping, CRLF output; input may use CRLF or LF.
  CR and LF inside quoted cells are kept exactly. Text is not trimmed.
- **Blank lines.** A line on which nothing is read, not even a quote, is not a row:
  a trailing blank line adds no record, and a blank line between rows does not
  refuse a wider file. A quoted empty cell, `""`, is a value. A refusal names a row
  by its place in the file, blank lines counted.
- **Header.** One header row. Before import, Nendo shows an explicit mapping from
  each source column to a stable destination field; headers are never mapped
  silently. A trailing column whose header and every cell are empty is dropped. Any
  other blank or repeated header refuses the file before the mapping, naming the
  column numbers and the header (`CSV columns 1 and 3 are both “Name”`). Import
  targets one selected active record type.
- **Null.** Null is the decoded cell `\N`. Non-null text that begins with a
  backslash is exported with one more leading backslash, and the importer removes
  exactly one. Null, empty text and literal `\N` are distinct. Quoting has no null
  meaning.
- **Scalars.** Integers and decimals use exact invariant strings, with no
  JavaScript numeric conversion. Booleans are `true`/`false`. Dates, datetimes and
  UUIDs use the scalar contract. A cell not in its kind's form is refused with the
  form it expects and the value it got: `Invalid Boolean value: expects true or
  false, in lower case, got “TRUE”.`
- **Choices and ratings.** Choice values are stable IDs; a value that is not one of
  the options is refused. A rating is its plain integer. The scale bounds the
  drawing, not the column, so a value outside it is kept and stated.
- **References.** A reference holds a record ID or, when its mapping names a match
  field (`matchFieldId`), the value of a unique field of the target type such as a
  code ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)). A code names a
  row of the same import first and a record the file holds second, compared without
  regard to case, and is refused by its row when it names nothing, two rows, or a
  row and a different record. A code is read as the decode reads it: an empty or
  null cell holds none, and an escaped leading backslash is one literal backslash.
  References resolve only to records of the configured target type; accepted
  mutations capture the target versions. There is no label matching and no inferred
  repair.
- **Hierarchies.** A declared hierarchy whose parent column is matched by a code the
  import carries is imported parents first. Each row keeps its line number, a row
  with an empty or null parent cell is at the top level, and parents that lead back
  to themselves are refused. History names a batch by its rows in the file, which
  need not be consecutive (`Import 3 CSV rows: 4, 3, 2`).
- **Formula-like text** is kept, leading whitespace and `=`, `+`, `-` and `@`
  included. The profile does not neutralize spreadsheet formulas.
- **Scope.** Import creates new records. It does not restore file-supplied IDs,
  versions or history, and never overwrites, merges or creates schema. Export
  describes the current active fields. Retired data stays under the recovery
  boundary.

## Pictures

A media field ([ADR-0031](../decisions/0031-media-in-user-data.md)) exports and imports its
address as text. A cell that is not a picture's address, or names a `media:` picture
the file does not hold, is refused by its row when the batch is prepared, before
review: `CSV row 3, Cover: this file does not hold the picture media:…`.

The native export offers **Export with pictures** for a record type with a media
field. It writes each embedded picture its rows name, once, into a `Media` folder
beside the CSV under the picture's own name (a different picture already holding
that name gets the name and the start of its hash), and the CSV names it as
`.\Media\{file}`. A file opened in the folder that holds the CSV reads those
addresses as linked pictures, and **File → Embed linked pictures…** copies a record
type's linked picture files into the file, one revision each, setting each field to
the embedded address. A file that is missing or not a picture is listed and left
linked; web pictures stay links. The same bytes arrive under the same `media:`
address. The agent's export resource writes addresses as they are.

## External CSV

The user explicitly selects External CSV or the Nendo profile. External text is
literal, backslashes included, and blank text stays empty text. The user selects
the null mapping explicitly, and the UI shows it. Non-text empty cells are
validation errors unless the reviewed null mapping applies. Field types come from
the target schema, never from sample rows.

## The agent path

An agent reads and writes the same profile, with no picker and no path.

`nendo://application/entity/{entityId}/export{?cursor,limit}` returns one page as
CSV text, with the ordinary MCP 1–100 limit and revision-bound cursor. The header
row carries display names and appears on the first page only, so the pages
concatenate into one document. `fieldIds` gives the stable field ID behind each
column, and an import maps by it. A client that cannot read resources reads it
through `nendo.read.resource`.

`nendo.data.import_records` takes that text back, or typed JSON records, at *Edit
data*. Both decode through the native importer's routine and commit through
canonical `data.createRecord` operations, fifty to a revision. It does **not** use
the reviewed batch path below.

- One call carries at most 500 rows; the 256 KiB request body is usually reached
  first. The response echoes that ceiling, what committed and what remains.
- Each internal batch's idempotency key is the caller's key, `#` and the batch
  ordinal while that fits 200 characters, otherwise `import.sha256.`, the SHA-256 of
  the key, `#` and the ordinal. A CSV row's record ID derives from that key and the
  row's position, so an exact retry requests the same records.
- A CSV row carries no reference target versions, so decoding reads the current
  ones. A retry gives the rows of batches its key already committed the versions
  their own revision recorded, so it still replays after a referenced record is
  edited. Uncommitted rows are validated against the file as it is now.
- If a later batch is refused, the run stops and earlier batches stay committed.
  `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, the first
  uncommitted data row (one-based, header excluded, in parents-first order for a
  tree), the committed revision IDs and the cause. Retry the identical call with the
  identical key; earlier batches replay without duplicates. No response implies that
  the whole call was atomic.
- Invalid mappings, and a call that supplies both CSV and JSON, are refused before
  any write.

## Batches and file authority

Native file selection owns paths. The Workbench receives parsed columns, rows,
diagnostics and an opaque import session, never a path. Parsing and preview are
bounded and cancellable before mutation. Oversized input is refused before dispatch,
and Help and the UI state the limits:

- 16 MiB input;
- 100 columns;
- 10,000 rows;
- 65,536 characters per cell.

One atomic batch holds at most 100 reviewed rows, through the canonical data
operations and the durable outcome path, with its own idempotency key and receipt.
All rows commit or none do; invalid rows are not skipped. On cancellation, committed
batches stay committed, and the UI reports exact committed and remaining counts.
Definition, source-session and target-version changes invalidate acceptance or
require a new preview. A delayed request cannot mutate a switched file.

Normal export reads through typed bounded services into an output native selection
chooses, keeps the value profile, and never presents a partial or cancelled output
as a success. Recovery export is a separate command with a narrower guarantee: one
table's scalar values, each reference as the target record ID under
`field/<fieldId>`, and record IDs and versions, in a UTF-8 file with the BOM. Only an
unsupported or over-limit field is left out, and the export is then partial.
