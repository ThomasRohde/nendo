# Query contract

This contract covers bounded typed record queries: sorting, predicates and
cursor discipline.

The existing typed record query gets one optional sort field, a direction, and
up to eight AND predicates. The predicates are:

- equal and not-equal. Neither matches a record without a value: `ne Done` is
  "has a value other than Done", so a task with no status is not in it (ESQ-05,
  the owner's choice of 2026-10-13). `isNull` finds the records without one, and
  Studio's *Does not equal* says so;
- ordered comparisons;
- text contains;
- explicit null and not-null;
- `descendantOf`, on the parent field of a declared hierarchy
  ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)): every record under the
  named record, down to 32 levels. It holds in the page, the count and every aggregate,
  and it is refused as `hierarchy-too-wide` when more than 10,000 records sit under that
  record, and as `hierarchy-not-declared` on any other field.

The sort field and any predicate may name a **calculated field** (2026-09-30, F-222). It is
compared as a stored field of its result type is: `contains` only for a Text result, and
never `descendantOf`. A calculated field has no column, so the host first reads every record
the stored predicates leave, with its calculations, and gives the database the ones that pass
and their order. The page, its continuation, the count and every aggregate read that one set.
A value that could not be worked out matches no predicate, not even null, and sorts last in
either direction. The read is refused as `calculated-query-too-wide` when more than 10,000
records would be worked out; a stored predicate narrows it.

A **tree read** (`NendoTreeQuery`: a record type, an optional root, a depth of 1 to 32 and
a page of 1 to 200) returns a declared hierarchy depth-first: the records under the root,
or the whole tree from the top level, siblings in the order field's order, unordered ones
last, then by record ID. Each item is the record with its parent, its depth below the root
(1 for the top of the window) and its child count. The walk is refused as
`hierarchy-too-wide` when it would cover more than 10,000 records. Pages are cut by
position; the cursor binds the change sequence, so a write between pages makes it stale,
as for any query.

The field search in the UI uses contains. Contains is ordinal, case-insensitive
and literal (no wildcard language). Text sort is ordinal. Integers and decimals
compare exactly. Datetimes compare their instants, and the stored offsets do not
change. A UUID compares without regard to case in every predicate and in the
sort, since both cases spell one value (ESQ-17). A single choice sorts in its
options' configured order, as Studio lists them; a value no option holds sorts
after the options ascending and before them descending, and a missing value is
missing as above; a reference sorts by its target's label, the text its cell shows,
compared as the label field's kind (ESQ-16). Both hold on the writable and the
read-only path. Missing values sort first in ascending order and last in descending
order. When sort values are equal, ascending record ID is the deterministic
final key. The default order remains record-ID order.

Pages keep the 1–200 limit. A query reads only the requested page plus one row.
Sorting and filtering may scan inside SQLite. No full record set crosses the
storage boundary. Only the storage mappings supply SQL identifiers. Predicate
values are parameters. Managed typed comparisons prevent decimal coercion.
Performance qualification must include these scans. It does not assume that
every field is indexed.

Authenticated cursors bind the file identity, the open session, the change
sequence and all sort and filter parameters. If a write occurs between pages,
the host rejects the continuation as stale. If the query parameters changed, the
host rejects the continuation as belonging to another query. The client must
offer an explicit restart. A query change resets previous-page navigation. Field
IDs must belong to the selected entity, and scalar types must match. Null checks
are separate from scalar equality, so the query keeps null distinct from empty
text.

The Engine implements this contract in `RecordQuerySemantics.cs` and
`NendoQueryCursor.cs`. `TypedRecordQueryTests`, `BoundedQueryTests`,
`CursorCodecTests` and `WorkbenchDeclaredQueryPagingTests` test it. This file does
not map each rule to a test case.

## Search

A **search** ([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)) is a separate
read, not a filter operator. Declared filters still have no free-text operator (ADR-0004).
`NendoSearchQuery` takes what the person typed, an optional list of record types and of
fields, a page of 1 to 100 records (20 by default) and a cursor. It returns
`NendoPage<NendoSearchHit>`.

**What it reads.** It reads the file's full-text index: every active Text field that is not a
choice, on every active record type. A file has an index once
`application.buildSearchIndex` has run. Before that, a writable file refuses a search with
`search-index-missing`. A file open read-only is searched from its records instead.

**The syntax:**

- **Words:** every word is required, matched per record, so one word may sit in the title and
  another in the body.
- **Phrases:** text in double quotes is a phrase.
- **Leaving out:** `-word` leaves out every record that contains it.
- **Prefix:** the last word also matches as a prefix, unless a space follows it or it is a single
  letter, which is searched as that word (PERF-09).
- **Folding:** case and accents are folded.
- **Nothing else:** every term reaches FTS5 quoted, so `title:x`, `NEAR(…)`, `AND`, `*` and an
  unclosed quote are text, or ignored when they hold no letter or digit. A search of more than
  256 characters or 16 terms is refused (`search-too-long`, `search-too-many-terms`).
- **Unknown names:** an unknown record type is refused with `entity-not-found`, and a field of
  none of the named types with `field-not-found`.

**The order.** Records rank by BM25, by their best-matching field, then by record type and
record ID.

**Scripts written without spaces.** The index splits text into words at spaces and
punctuation (`unicode61`, ADR-0028). Thai, Lao, Khmer, Burmese, Chinese and Japanese are
written without spaces between words, so a word inside such a sentence is not found: `学生`
does not find `北京大学的学生`, and a Japanese run is found only by its beginning. Thai is
also split at every vowel sign and tone mark. Turkish dotless `ı` is not folded to `i`. This
is a recorded limitation, not a defect (R2LAT-02; ADR-0028, 2026-10-13 note). A term counts
as a word when it holds a letter or digit by code point, so a word of letters from outside
the Basic Multilingual Plane is searched.

**A hit** carries:

- the record's version;
- a label: its first searched field, the first line, at most 200 characters;
- a score, where higher is better and which compares only within one answer;
- for each matching field, a plain-text excerpt with the matched words as UTF-16
  `{start, length}` ranges. An excerpt is never markup.

**Paging** is by position. The cursor binds the scope and the change sequence as every record
cursor does, so a write between pages makes it stale.

The Engine implements search in `Search.cs` and `Storage/SqliteNendoStore.Search.cs`;
`SearchIndexTests` tests it, including a drift check that compares the index with the records
after every kind of write.

Read-only snapshots use the same typed filtered set for pages, counts, numeric
aggregates, groups, date buckets and cells. Stored, calculated and `descendantOf`
predicates apply before folding. `ReviewStorageRegressionTests` compares all five
folds with their writable answers and checks the corresponding page. They also make
the file's field checks, so a field the type lacks, a kind that cannot be folded, a
bucket field that is not a Date and a whole-number sum past its range are refused
read-only as the file refuses them (ESQ-10; `QueryCsvLocaleReviewTests`).

A chart range (`last30Days`, `thisYear`, …) and a command step's `today` resolve against the
machine's civil day. The Engine reads the machine's time zone again from Windows at most once
a minute, so a zone changed while Nendo keeps running moves its today as it moves the
Workbench's (R2LAT-06).

## Bounded record windows

Owner accepted on 2026-10-14 with the lazy-data-views implementation plan (W-233).
`QueryRecordWindowAsync` uses the same typed query as `QueryRecordsAsync`, with
`start`, a `limit` of 1–200, an optional `queryToken` and optional `locateRecordId`.
The first read opens the query and returns its authenticated token; further reads
must present that token. It binds the query, open file instance/session and change
sequence. A write makes it stale; changing the query or reopening the file makes
it invalid. A page cursor cannot be used as a window token or supplied in the
window's nested query. Negative and overflowing positions are refused.

The response contains records, start, hasMore, changeSequence, queryToken and
locatedIndex. A locate reads the block containing that record in the filtered
order and returns its absolute index. A missing record leaves locatedIndex null
and returns to the first block. Ranking and offset work stay inside storage;
only the requested records and one lookahead are materialized for a stored query.
The read-only snapshot path preserves the same typed comparisons. Calculated
queries retain their existing candidate bound. No read holds a transaction open
between calls, and no full result crosses the storage boundary.

Studio uses 100-row blocks and a five-block AG Grid cache, with at most two
requests in flight and one bounded opening block. A write opens a new query;
record identity, rather than the old row number, anchors a restored viewport.
External changes stop continuation and offer Refresh. Existing cursor consumers
keep their contract. This addition is a named Workbench read, not a new MCP tool
or custom-view capability.
