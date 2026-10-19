# Query contract

Bounded typed record queries: sorting, predicates, cursors, search and record
windows. The Engine implements them in `RecordQuerySemantics.cs` and
`NendoQueryCursor.cs`; `TypedRecordQueryTests`, `BoundedQueryTests`,
`CursorCodecTests` and `WorkbenchDeclaredQueryPagingTests` test them.

## Predicates and sort

A typed record query takes one optional sort field, a direction, and up to eight AND
predicates:

- equal and not-equal. Neither matches a record without a value: `ne Done` is "has a
  value other than Done", so a task with no status is not in it. `isNull` finds the
  records without one, and Studio's *Does not equal* says so;
- ordered comparisons;
- text contains: ordinal, case-insensitive and literal, with no wildcard language.
  The UI's field search uses it;
- explicit null and not-null, separate from scalar equality, so null stays distinct
  from empty text;
- `descendantOf`, on the parent field of a declared hierarchy
  ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)): every record under the
  named record, down to 32 levels. It holds in the page, the count and every
  aggregate, and is refused as `hierarchy-not-declared` on any other field. Each
  statement walks the subtree once, so its cost is the subtree's size; no size is
  refused. To read a whole large subtree, use the tree read, which pages by key.

Field IDs must belong to the selected entity, and scalar types must match.

**Comparison.** Text sorts ordinally. Integers and decimals compare exactly.
Datetimes compare their instants; stored offsets do not change. A UUID compares
without regard to case. A single choice sorts in its options' configured order, as
Studio lists them; a value no option holds sorts after the options ascending and
before them descending. A reference sorts by its target's label, the text its cell
shows, compared as the label field's kind. Missing values sort first ascending and
last descending. Equal sort values fall back to ascending record ID. The default
order is record ID. All of this holds on the writable and the read-only path.

**Calculated fields.** The sort field and any predicate may name a calculated field.
It is compared as a stored field of its result type is: `contains` only for a Text
result, never `descendantOf`. A calculated field has no column, so the host first
reads every record the stored predicates leave, with its calculations, and gives the
database the ones that pass and their order. The page, its continuation, the count
and every aggregate read that one set. A value that could not be worked out matches
no predicate, not even null, and sorts last in either direction. The read is refused
as `calculated-query-too-wide` when more than 10,000 records would be worked out; a
stored predicate narrows it.

**Bounds.** Pages are 1–200 records. A query reads only the requested page plus one
row. Sorting and filtering may scan inside SQLite, but no full record set crosses the
storage boundary. Only the storage mappings supply SQL identifiers; predicate values
are parameters. Managed typed comparisons prevent decimal coercion. Performance
qualification includes these scans and does not assume every field is indexed.

## Cursors

Authenticated cursors bind the file identity, the open session, the change sequence
and all sort and filter parameters. A write between pages makes the continuation
stale; changed parameters make it belong to another query. The client offers an
explicit restart, and a query change resets previous-page navigation.

## Tree read

`NendoTreeQuery` (a record type, an optional root, a depth of 1 to 32 and a page of 1
to 200) returns a declared hierarchy depth-first: the records under the root, or the
whole tree from the top level, siblings in the order field's order, unordered ones
last, then by record ID. Each item is the record with its parent, its depth below the
root (1 for the top of the window) and its child count. A page resumes after the
record the previous one ended on: each level asks for the children after one
sibling, by an index of (parent, order, record ID), so a page costs its own records
and the levels above it. No size is refused. The cursor names that record and binds
the change sequence, so a write between pages makes it stale.

## Read-only snapshots

Read-only snapshots use the same typed filtered set for pages, counts, numeric
aggregates, groups, date buckets and cells. Stored, calculated and `descendantOf`
predicates apply before folding. They make the file's field checks too: a field the
type lacks, a kind that cannot be folded, a bucket field that is not a Date and a
whole-number sum past its range are refused as the writable file refuses them.
`ReviewStorageRegressionTests` and `QueryCsvLocaleReviewTests` compare them with the
writable answers.

A chart range (`last30Days`, `thisYear`, …) and a command step's `today` resolve
against the machine's civil day. The Engine rereads the machine's time zone from
Windows at most once a minute, so a zone changed while Nendo runs moves its today as
it moves the Workbench's.

## Search

A **search** ([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)) is a
separate read, not a filter operator; declared filters have no free-text operator
([ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md)). `NendoSearchQuery`
takes what the person typed, an optional list of record types and of fields, a page
of 1 to 100 records (20 by default) and a cursor, and returns
`NendoPage<NendoSearchHit>`.

**What it reads.** The file's full-text index: every active Text field that is not a
choice, on every active record type. A file has an index once
`application.buildSearchIndex` has run; before that, a writable file refuses a search
with `search-index-missing`. A file open read-only is searched from its records.

**Syntax:**

- **Words:** every word is required, matched per record, so one word may sit in the
  title and another in the body.
- **Phrases:** text in double quotes.
- **Leaving out:** `-word` leaves out every record that contains it.
- **Prefix:** the last word also matches as a prefix, unless a space follows it or it
  is a single letter.
- **Folding:** case and accents are folded.
- **Nothing else:** every term reaches FTS5 quoted, so `title:x`, `NEAR(…)`, `AND`,
  `*` and an unclosed quote are text, or ignored when they hold no letter or digit.
  More than 256 characters or 16 terms is refused (`search-too-long`,
  `search-too-many-terms`).
- **Unknown names:** an unknown record type is refused with `entity-not-found`, and
  a field of none of the named types with `field-not-found`.

**Order.** Records rank by BM25, by their best-matching field, then by record type
and record ID.

**Scripts written without spaces.** The index splits text into words at spaces and
punctuation (`unicode61`). Thai, Lao, Khmer, Burmese, Chinese and Japanese are
written without spaces, so a word inside such a sentence is not found: `学生` does not
find `北京大学的学生`, and a Japanese run is found only by its beginning. Thai is also
split at every vowel sign and tone mark. Turkish dotless `ı` is not folded to `i`.
This is a known limitation. A term counts as a word when it holds a letter or digit
by code point, so a word of letters outside the Basic Multilingual Plane is searched.

**A hit** carries the record's version; a label (its first searched field, first
line, at most 200 characters); a score, higher is better and comparable only within
one answer; and for each matching field a plain-text excerpt, never markup, with the
matched words as UTF-16 `{start, length}` ranges.

**Paging** is by position. The cursor binds the scope and the change sequence, so a
write between pages makes it stale.

The Engine implements search in `Search.cs` and `Storage/SqliteNendoStore.Search.cs`.
`SearchIndexTests` tests it, with a drift check that compares the index with the
records after every kind of write.

## Bounded record windows

`QueryRecordWindowAsync` takes the same typed query as `QueryRecordsAsync`, with
`start`, a `limit` of 1–200, an optional `queryToken` and an optional
`locateRecordId`. The first read opens the query and returns its authenticated
token; later reads present it. The token binds the query, the open file instance and
session, and the change sequence. A write makes it stale; changing the query or
reopening the file makes it invalid. A page cursor is not a window token and cannot
be supplied in the window's nested query. Negative and overflowing positions are
refused.

The response holds records, start, hasMore, changeSequence, queryToken and
locatedIndex. A locate reads the block holding that record in the filtered order and
returns its absolute index; a missing record leaves locatedIndex null and returns
the first block. Ranking and offsets stay inside storage; a stored query
materializes only the requested records and one lookahead. The read-only path keeps
the same typed comparisons, and calculated queries keep their candidate bound. No
read holds a transaction open between calls.

Studio uses 100-row blocks and a five-block AG Grid cache, with at most two requests
in flight and one bounded opening block. A write opens a new query; record identity,
not the old row number, anchors a restored viewport. External changes stop
continuation and offer Refresh. This is a named Workbench read, not an MCP tool or a
custom-view capability.
