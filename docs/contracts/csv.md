# CSV contract

The faithful Nendo CSV profile for import and export. Asserted by
`tests/Nendo.Engine.Tests/CsvTests.cs`.

## Faithful Nendo profile

- UTF-8, optional BOM accepted, invalid UTF-8 rejected. Comma delimiter, double
  quote escaping, CRLF output; CRLF/LF input accepted. Embedded CR and LF inside
  quoted cells are preserved exactly. No whitespace trimming of text values.
- One header row, with explicit source-column to stable destination-field
  mapping shown before import. Duplicate/missing headers are diagnostics rather
  than silently mapped. Import targets one selected active record type.
- Null is the decoded cell `\N`. Non-null text beginning with a backslash is
  escaped by adding one leading backslash. The importer removes exactly one
  leading backslash from escaped non-null text. Thus null, empty text and literal
  `\N` are distinct. Quoting is CSV syntax, not null semantics.
- Integers and decimals use exact invariant strings; no JavaScript numeric
  conversion. Booleans are `true`/`false`; dates, datetimes and UUIDs use the
  accepted scalar contract. Choice/reference values are stable IDs. References
  must resolve to existing records of the configured target type, with target
  versions captured for accepted mutations. No label matching or inferred repair.
  A rating exports and imports as its plain integer: the scale bounds the drawing,
  not the column, so an imported value outside it is kept and stated rather than
  refused, unlike a choice value that is not one of its options.
- Formula-like text, including leading whitespace and `=`, `+`, `-`, `@`, is
  preserved. This profile does not silently neutralize spreadsheet formulas.
- Import creates new records. File-supplied IDs, versions and history are not
  restored. No implicit overwrite, merge or schema creation. Export describes
  current active fields; retired data remains under the recovery boundary until
  an explicit export choice is specified.

## External CSV

The user explicitly selects External CSV or the Nendo profile. External text is
literal by default, including backslashes; blank text stays empty text. Null
mapping is selected and shown explicitly. Non-text empty cells are validation
errors unless the reviewed null mapping applies. Field types come from the
selected target schema, not guesses based on sample rows.

## The agent path

An agent reads and writes the same profile without a picker, and without a path in
either direction (ADR-0009, 2026-09-22 amendment).

`nendo://application/entity/{entityId}/export{?cursor,limit}` returns one page as CSV
text with the ordinary MCP 1–100 limit and the same revision-bound cursor every page
resource uses. The header row carries display names and appears on the first page only,
so the pages concatenate into one valid document; `fieldIds` gives the stable field ID
behind each column, which is what an import maps by. It is a resource rather than a
tool because Inspect keeps an empty tool list.

`nendo.data.import_records` takes that text back, or typed JSON records, at *Data
mutation*. Both formats decode through the same routine the native importer uses and
then commit through the same canonical `data.createRecord` operations, fifty to a
revision. It does **not** use the proposal-per-batch path below: that exists so a person
can review a hundred rows, and it clones the file to do it.

One call carries at most 500 rows — the 256 KiB request body is the limit met first —
and the response echoes that ceiling, what committed and what remains. Each internal
batch derives its idempotency key from the caller's, and a CSV row's record ID is
derived from that key and the row's position, so an exact retry asks for the same
records rather than a second copy. A batch that is refused stops the run and leaves the
batches before it committed; the response says how many, and never implies the whole
call was atomic.

## Batches and file authority

Native file selection owns paths. The Workbench receives parsed columns, rows,
diagnostics and an opaque import session, never a privileged arbitrary path.
Parsing/preview are bounded and cancellable before mutation. Initial hard limits:
16 MiB input, 100 columns, 10,000 rows, 65,536 characters per cell; oversized files are
rejected explicitly before dispatch. These limits must be shown in Help/UI.

At most 100 reviewed rows form one atomic batch using the existing canonical
data operations and durable outcome path. All rows commit or none do; invalid
rows are not skipped. Each batch has an explicit idempotency key and receipt.
Already committed batches remain committed on cancellation. UI reports exact
committed/remaining counts and does not imply whole-file atomicity. Definition,
source-session and target-version changes invalidate acceptance or require a
fresh preview; delayed requests cannot mutate a switched file.

Normal export reads through typed bounded services into a native-selected output
and preserves the declared value profile. Partial/cancelled output is not
presented as a successful export. Recovery export remains a separate command
with its existing narrower guarantee.

Qualification must include quoted delimiters, escaped quotes, multiline Unicode,
null/empty/marker collisions, formula-like text, every scalar, invalid rows,
stale schema/targets, cancellation, atomic rollback, interrupted acknowledgement,
native picker/mapping/preview, export/import/reopen and Computer checks.
