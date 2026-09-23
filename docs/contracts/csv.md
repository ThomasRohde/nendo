# CSV contract

This contract gives the faithful Nendo CSV profile for import and export.
`tests/Nendo.Engine.Tests/CsvTests.cs` asserts it.

## Faithful Nendo profile

- The encoding is UTF-8. An optional BOM is accepted, and invalid UTF-8 is
  rejected. The profile uses a comma delimiter, double-quote escaping and CRLF
  output. Input can use CRLF or LF. Embedded CR and LF inside quoted cells are
  kept exactly. Text values are not trimmed of whitespace.
- There is one header row. Before import, Nendo shows an explicit mapping from
  each source column to a stable destination field. Duplicate/missing headers
  are diagnostics. They are not mapped silently. Import targets one selected
  active record type.
- Null is the decoded cell `\N`. If non-null text begins with a backslash, the
  exporter escapes it by adding one leading backslash. The importer removes
  exactly one leading backslash from escaped non-null text. Thus null, empty text
  and literal `\N` are distinct. Quoting is CSV syntax and has no null semantics.
- Integers and decimals use exact invariant strings. There is no JavaScript
  numeric conversion. Booleans are `true`/`false`. Dates, datetimes and UUIDs
  use the accepted scalar contract. Choice/reference values are stable IDs.
  References must resolve to existing records of the configured target type.
  Accepted mutations capture the target versions. There is no label matching and
  no inferred repair.
  A rating exports and imports as its plain integer. The scale bounds the
  drawing, and it does not bound the column. Thus an imported value outside the
  scale is kept and stated, and it is not refused. A choice value that is not one
  of its options is refused.
- Formula-like text is kept. This includes leading whitespace and `=`, `+`, `-`
  and `@`. This profile does not silently neutralize spreadsheet formulas.
- Import creates new records. It does not restore file-supplied IDs, versions or
  history. There is no implicit overwrite, merge or schema creation. Export
  describes the current active fields. Retired data stays under the recovery
  boundary until an explicit export choice is specified.

## External CSV

The user explicitly selects External CSV or the Nendo profile. External text is
literal by default, and this includes backslashes. Blank text stays empty text.
The user selects the null mapping explicitly, and the UI shows it. Non-text empty
cells are validation errors unless the reviewed null mapping applies. Field types
come from the selected target schema. They are not guessed from sample rows.

## The agent path

An agent reads and writes the same profile. It uses no picker and no path in
either direction (ADR-0009, 2026-09-22 amendment).

`nendo://application/entity/{entityId}/export{?cursor,limit}` returns one page as
CSV text. It uses the ordinary MCP 1–100 limit and the same revision-bound cursor
that every page resource uses. The header row carries display names and appears
on the first page only. Thus the pages concatenate into one valid document.
`fieldIds` gives the stable field ID behind each column, and an import maps by
this ID. It is a resource and not a tool, because Inspect keeps an empty tool
list.

`nendo.data.import_records` takes that text back, or typed JSON records, at *Data
mutation*. Both formats decode through the same routine as the native importer.
They then commit through the same canonical `data.createRecord` operations, with
fifty operations in each revision. It does **not** use the proposal-per-batch
path below. That path lets a person review a hundred rows, and it clones the file
to do so.

One call carries at most 500 rows. The 256 KiB request body is the limit that a
call reaches first. The response echoes that ceiling, what committed and what
remains. Each internal batch derives its idempotency key from the key of the
caller. The record ID of a CSV row derives from that key and the position of the
row. Thus an exact retry requests the same records and does not create a second
copy. If a later batch is refused, the run stops, and the batches before it stay
committed. `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, the
first uncommitted data row (one-based, excluding the header), the committed
revision IDs and the refusal cause. Retry the identical call with the identical
key; earlier batches replay without duplicates. Invalid CSV mappings and a call
that supplies both CSV and JSON payloads are refused before any write. No
response implies that the whole call was atomic.

## Batches and file authority

Native file selection owns paths. The Workbench receives parsed columns, rows,
diagnostics and an opaque import session. It never receives a privileged
arbitrary path. Parsing/preview are bounded and cancellable before mutation. The
initial hard limits are:

- 16 MiB input;
- 100 columns;
- 10,000 rows;
- 65,536 characters per cell.

Nendo rejects oversized files explicitly before dispatch. Help/UI must show these
limits.

One atomic batch contains at most 100 reviewed rows. It uses the existing
canonical data operations and the durable outcome path. All rows commit, or none
commit. Invalid rows are not skipped. Each batch has an explicit idempotency key
and receipt. On cancellation, batches that already committed stay committed. The
UI reports exact committed/remaining counts, and it does not imply whole-file
atomicity. Definition, source-session and target-version changes invalidate
acceptance or require a new preview. Delayed requests cannot mutate a switched
file.

Normal export reads through typed bounded services into an output that native
selection chooses. It keeps the declared value profile. Nendo does not present a
partial/cancelled output as a successful export. Recovery export stays a separate
command with its existing narrower guarantee.

Qualification must include:

- quoted delimiters and escaped quotes;
- multiline Unicode;
- null/empty/marker collisions;
- formula-like text;
- every scalar;
- invalid rows;
- stale schema/targets;
- cancellation and atomic rollback;
- interrupted acknowledgement;
- native picker/mapping/preview;
- export/import/reopen;
- Computer checks.
