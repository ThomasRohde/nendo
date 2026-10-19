# ADR-0028: Full-text search in the file

- **Status:** Accepted
- **Date:** 2026-10-06
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `SearchIndexTests` (with the `SearchIndexDriftAsync` drift check) and `ABuildInAReviewedProposalIsDescribedAndPromoted`; `SearchIndexMeasurementTests` measures size and speed on workspace files
- **Depends on:** ADR-0003, ADR-0004, ADR-0005, ADR-0007, ADR-0009, ADR-0010, ADR-0012, ADR-0013, ADR-0021, ADR-0022
- **Contract:** [queries, Search](../contracts/queries.md#search)

## Context

Without an index, the only ways to find a record by what it says are a `contains` filter on one
field and whatever a view matches among the records it loaded: neither ranks, neither spans
fields, and neither scales. The bundled SQLite has FTS5. The file's structure is policed: a table
outside `__nendo_` must be a record type, a protected table must match a layout rung, triggers and
views put a file into recovery, and the content digest reads every table by rowid. Every write
passes one of two choke points, `ApplyAsync` and `ApplyChangeSetAsync`.

## Decision

The index lives inside the file, maintained in the same transaction as every write.

**What is searched.** Every active field with Text storage on every active record type, in all
of its text presentations. Choices (an option ID in the column) and media fields (an address) are
left out. A retired field or type leaves the index and comes back when reactivated; a deleted
record has no index rows until restored.

**Where it lives.** The `-search-` rung (host 1.46.0), two protected objects:

- `__nendo_search_doc(doc INTEGER PRIMARY KEY, entity_id, record_id, field_id, UNIQUE(entity_id, record_id, field_id))`:
  one row per record and searched field with text.
- `__nendo_search`: an FTS5 table (`unicode61 remove_diacritics 2`, prefixes of 2 and 3) whose
  rowid is the `doc`.

The index keeps its own copy of the text, so FTS5 can excerpt it and check itself. It is keyed by
record ID, never a record table's rowid. It is derived data: never an operation, never history,
never in a proposal diff.

**When a file gets one.** `application.buildSearchIndex`, definition lane,
`IrreversibleDeclared` (it changes no record and no definition). The first build climbs the
ladder and indexes every record; a file that never builds one keeps its layout and minimum host.
Building again rebuilds from the records, which is the repair. Searching a file without an index
is refused as `search-index-missing`; a file open read-only is searched through a private
in-memory index built from its records.

**Upkeep.** `MaintainSearchIndexAsync` runs at the end of each mutation in both choke points: a
record write reindexes that record; a definition change to a type's searched fields reindexes the
type; the build and the new-file transform (ADR-0022) rebuild the whole index. A history fold
needs nothing.

**What the file's checks see.**

- **Content digest:** leaves every search object out, so a file and its indexed twin digest equally.
- **Layout signature:** counts the index's own statement and the doc table, and skips the five
  tables FTS5 writes itself (`_config`, `_content`, `_data`, `_docsize`, `_idx`); a test pins their
  DDL.
- **Row ceiling:** skips the search tables, which the record count and the file bound already limit.
- **Integrity check:** `PRAGMA integrity_check` checks FTS5's structure; a damaged index refuses
  the file at open like any damage.

**What a search means.** `NendoSearchQuery(Text, Limit = 20, Cursor)`, with optional `EntityIds`
and `FieldIds`, returns `NendoPage<NendoSearchHit>`.

- All words are required, per record, not per field. Double quotes make a phrase, `-word` leaves
  out records containing it, and the last word also matches as a prefix unless followed by a
  space. A last word of one letter is searched as a whole word, not a prefix.
- Nothing else is syntax: every term is quoted before FTS5 sees it, so `title:x`, `NEAR(…)`,
  `AND`, `*` and an unclosed quote are text, or ignored when they hold no letter or digit (by code
  point).
- At most 256 characters, 16 terms and 100 records a page.
- BM25, by each record's best-matching field.
- A hit carries the record's version, a label (its first searched field's first line, at most 200
  characters) and, per matching field, a plain-text excerpt with the matches as ranges. Never
  markup.
- Paging is by offset, bound to the change sequence like every record cursor.

**Where it is reached.** `data.searchRecords` over the Workbench protocol, `nendo.records.search`
for views, records in Ctrl K, a search box and the build on Studio's per-type table, and a
`search` resource and the build operation for agents.

**Scripts written without spaces are not segmented.** `unicode61` splits at spaces and
punctuation, so a word inside Thai, Lao, Khmer, Burmese, Chinese or Japanese text is not found
unless it starts the run, and Turkish dotless `ı` is not folded to `i`. Finding them needs a
second, script-routed index (trigram or bigrams), which changes the protected layout and needs
its own ADR.

## Consequences

- A word anywhere in a record's text finds it from every client, ranked, with an excerpt, and a
  copied or restored file is searchable at once.
- An indexed file is larger by about its text plus the index, and an older host refuses it.
- Every write to an indexed file also writes the index rows of the records it touched.

## Rejected alternatives

- **An index beside the file:** every open pays for the build, and the index is not where the data is.
- **Triggers to maintain it:** any trigger puts a file into recovery and cannot be reviewed.
- **An external-content FTS5 table:** records span many tables, and index and content could disagree unnoticed.
- **Building on every first write:** raises every touched file's minimum host without anyone asking.
- **A free-text operator in declared filters:** ADR-0004 rules it out; search has its own ranking and paging.

## Revisit triggers

- A file whose text makes the index's size matter; a contentless index would roughly halve it.
- A need to repair a damaged index from recovery rather than from a backup.
- A request to search choices, numbers or dates.
- A person who searches text written without spaces.
