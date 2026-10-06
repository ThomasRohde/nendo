# ADR-0028: Full-text search in the file

- **Status:** Accepted
- **Date:** 2026-10-06
- **Delivery:** All five stages done 2026-10-06 at host 1.46.0: the Engine, Desktop and the view API, Ctrl K and Studio, MCP, and Garden 0.9.0. Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24), with the owner choosing, on 2026-10-06, that the index lives inside the file rather than beside it
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `tests/Nendo.Engine.Tests/SearchIndexTests.cs`; the falsification in Evidence below
- **Depends on:** ADR-0003 relational user data and protected metadata, ADR-0004 (no free-text operator in declared filters, which this leaves as it is), ADR-0005 host application services, ADR-0007 proposal validation and replay, ADR-0009 MCP reads, ADR-0010 backup and restore digests, ADR-0012 minimum host version, ADR-0013 custom views, ADR-0021 history folding, ADR-0022 new files
- **Related design:** [`../contracts/queries.md`](../contracts/queries.md)

## Context

Nendo had no way to find a record by what it says. Every search a person saw was one of two kinds:

- **A `contains` filter on one field.** Studio's filter row, the reference picker and the outline find
  each test a substring of one text field, record by record, in host code.
- **A view's own matching.** Garden's Find loaded every note and matched titles and slugs in the
  browser. A word that sat only in a note's body was never found.

Neither ranks, neither spans fields, and neither scales past what a view can load.

The facts that bound a solution:

- **SQLite already has the engine.** The bundled `e_sqlite3` (SQLitePCLRaw 2.1.13) is compiled with
  `ENABLE_FTS5`.
- **The file's structure is policed.**
  - A table outside `__nendo_` must be a declared record type, or the file shows mapping drift.
  - A protected table must match a known rung of the layout ladder, or the file does not open.
  - Triggers and views put a file into recovery.
- **The content digest reads every table by rowid.** Two of FTS5's own tables (`_idx`, `_config`)
  are `WITHOUT ROWID`.
- **Every write already passes two choke points.** These are the single-write path (`ApplyAsync`) and
  the change-set path (`ApplyChangeSetAsync`). Behaviour-generated writes, undo and promotion all go
  through one of them.

## Decision drivers

1. Search must find a word in any text field, across fields, ranked, through the same typed service
   for every client (ADR-0005).
2. An empty file, an old file and a file that never searches must stay exactly as they are.
3. The index must never disagree with the records, and a disagreement must be detectable.
4. Nothing a person types may reach SQLite as syntax.

## Options considered

### Option A: an index beside the file

Build an in-memory FTS5 index when a file opens and keep it current from the commit stream.

- **For:** no format change.
- **Against:** every open of a large file pays for the build, and the index is not where the data is.

### Option B: an index inside the file (chosen)

The index is a protected rung of the layout ladder, maintained in the same transaction as every write.

- **For:** a file carries its own index, so opening costs nothing extra and a copy is searchable at once.
- **Against:**
  - The file grows by about the size of its text.
  - The digest, the layout signature and the commit ceilings each need to know about the index.
  - An older host cannot open a file once it has one.

### Do nothing

Views go on matching what they load, and a word in a body stays unfindable.

## Decision

**What is searched.** Every active field with Text storage kind, on every active record type, in all
of its presentations: one line, long text and Markdown.

- A choice keeps an option ID in its text column, so choices are left out.
- A retired field or record type is removed from the index. Reactivating it puts it back.
- A deleted record has no row and so no index rows. Restoring it indexes it again.

**Where it lives.** The index is a new last rung of the layout ladder, `-search-`, at host 1.46.0. It
is two protected objects:

- `__nendo_search_doc(doc INTEGER PRIMARY KEY, entity_id, record_id, field_id, UNIQUE(entity_id, record_id, field_id))`:
  one row per record and searched field with text.
- `__nendo_search`: an FTS5 table (`unicode61 remove_diacritics 2`, prefixes of 2 and 3 indexed) whose
  rowid is the `doc`.

The index keeps its own copy of the text, so FTS5 can excerpt it and check its own consistency. It is
keyed by record ID, never by a record table's rowid, which a required-field rebuild or a VACUUM
renumbers. It is derived data: never an operation, never history, never in a proposal diff.

**When a file gets one.** A file gets the rung through a new operation, `application.buildSearchIndex`.

- **Lane and reversibility:** it is in the Definition lane and declared `IrreversibleDeclared`. It
  changes no record and no definition, so there is nothing to undo.
- **How the rung climbs:** the first build climbs the whole ladder and indexes every record. Climbing
  only when a feature is first used is the ladder's existing rule, so a file that never builds an index
  keeps its layout and its minimum host.
- **After the build:** every commit maintains the index inside its own transaction.
- **Building again:** the operation rebuilds the index from the records, which is the repair.
- **No index yet:** searching a file without one is refused with `search-index-missing`. A file that is
  open read-only is searched from its records through a private in-memory index, so read-only search
  needs no build.

**How the index is maintained.** `MaintainSearchIndexAsync` runs at the end of each mutation in both
choke points: after the mutation's tables exist and before the commit is measured. What it reindexes
depends on what the mutation did:

- **A record write** (create, set, delete, restore or backfill, generated writes included): that
  record is reindexed from its row.
- **A definition change** that alters a record type's searched fields: the whole record type is
  reindexed.
- **The build operation:** the whole index is rebuilt.
- **The new-file transform**, which deletes left-out records outside any mutation: the whole index is
  rebuilt.

A history fold changes no record and needs nothing.

**What the file's checks see.**

- **Content digest:** the digest leaves every search object out, so a file and its indexed twin digest
  equally. Backup, restore and identity checks compare content, not the derived index.
- **Layout signature:** the signature counts the index's own statement and the doc table. It skips the
  five tables FTS5 writes itself (`_config`, `_content`, `_data`, `_docsize`, `_idx`), whose DDL comes
  from SQLite. A test pins that DDL, so a SQLite upgrade that writes it differently is noticed.
- **Row ceiling:** the per-table row ceiling at commit skips the search tables. They hold one row per
  record and text field, and the record count and the 256 MiB file bound already limit them.
- **Integrity check:** `PRAGMA integrity_check` checks FTS5's structure. A damaged index fails it, and
  the file is refused at open like any damaged file.

**What a search means.** `NendoSearchQuery(Text, Limit = 20, Cursor)` takes an optional
`EntityIds` and `FieldIds`, and returns `NendoPage<NendoSearchHit>`.

- **Syntax:** words are all required, and are matched per record, not per field: one word may be in
  the title and another in the body. Text in double quotes is a phrase, `-word` leaves out every record
  containing it, and the last word also matches as a prefix unless followed by a space.
- **Nothing else is syntax.** Every term is quoted before FTS5 sees it, so `title:x`, `NEAR(…)`, `AND`,
  `*` and an unclosed quote are searched for as text, or ignored when they hold no letter or digit.
- **Bounds:** at most 256 characters, 16 terms and 100 records a page.
- **Ranking:** BM25, by each record's best-matching field. A short field such as a title outranks a
  long body that mentions the word once.
- **What a hit carries:** the record's version, a label (its first searched field, first line, at most
  200 characters) and, for each matching field, a plain-text excerpt with the matched words as ranges.
  An excerpt is never markup.
- **Paging:** paging is by offset, bound to the file's change sequence like every record cursor, so a
  write ends a paging run.

**Delivery stages.**

1. **The Engine** (done 2026-10-06): the rung, the operation, upkeep, the search read and the
   read-only path.
2. **Desktop and the view API** (done 2026-10-06): `data.searchRecords` over the Workbench protocol, and
   `nendo.records.search` for custom views.
3. **Ctrl K and Studio** (done 2026-10-06): records in the command palette, a search box on Studio's per-type table, and
   building the index from there.
4. **MCP** (done 2026-10-06): a `search` resource for agents, and the build operation in the authoring union.
5. **Garden** (done 2026-10-06, Garden 0.9.0): Find searches note bodies through the service, matching title, slug and body itself until the answer arrives or where there is no index; the graph's Find uses the same hits; `Build-Garden.mjs` builds the index in its `search` stage and in `upgrade`.

## Evidence and validation obligations

- `SearchIndexTests` uses a drift check, `SearchIndexDriftAsync`, that rebuilds what the index should
  hold from the records and names every row that differs. It is asserted in empty after each of these:
  - record writes: create, set field, clear a field, delete, undo a deletion, and a batch;
  - definition changes: retire and reactivate a field and a record type, add a field, and require a
    field (a table rebuild);
  - a promoted proposal;
  - a new file, a history fold, and a backup.
- **Falsified** on 2026-10-06. With the upkeep call removed from the single-write path,
  `EveryDataWriteKeepsTheIndexInStep` failed with "The index drifted from the records:
  missing notes n1 title Kitchen garden …". With the call restored, all thirteen tests passed and so
  did the Engine suite (1,108).
- The digest test drops the index from a copy and shows the digest unchanged. The damaged-index test
  shows `integrity-failed` at open. The pinned-DDL test fails if SQLite writes FTS5's tables
  differently.
- `tools/Review-Garden.ps1` runs Find against a fixture broker that offers `records.search`. A
  word that only one note's body says marks that note alone, with its matched line. With the
  search refused for want of an index, the view still finds the note in the bodies it holds.
  **Falsified** 2026-10-06 with the finder told search is unavailable: the unit test failed
  ("a pause in typing sends one search, of the latest text") and so did the browser check ("Find
  must be answered by the index: unavailable").
- **Reported broken** 2026-10-06, on the first real upgrade of `Garden.nendo`: a proposal holding
  `application.buildSearchIndex` was refused at validate with "Operation type
  application.buildSearchIndex has no semantic diff mapping". Every test had built the index
  directly or promoted data writes, never the build itself in a proposal. Fixed in
  `SemanticDiff.cs`. Guarded by `ABuildInAReviewedProposalIsDescribedAndPromoted`, which sends the
  build as canonical JSON through validation and promotion. Falsified: with the mapping removed, it
  fails with the same refusal.
- **Measured** 2026-10-06 with `SearchIndexMeasurementTests` on copies of the workspace files (set
  `NENDO_MEASURE_SEARCH` to run it):

  | File | Size before and after the index | First build | Rebuilds | Search median, slowest |
  | --- | --- | --- | --- | --- |
  | Garden | 1.9 to 2.0 MiB | 55 ms | 15 and 15 ms | 0.8 ms, 24 ms |
  | BCM | 5.8 to 10.0 MiB | 314 ms | 425 and 445 ms | 2.7 ms, 11 ms |
  | Archi | 34.3 to 34.6 MiB | 61 ms | 48 and 46 ms | 0.9 ms, 1.2 ms |
  | Nendo Station | 1.7 to 1.9 MiB | 26 ms | 25 and 23 ms | 0.7 ms, 1.2 ms |

  BCM's growth (4.2 MiB, about 72%) is the cost the Consequences name: its text is copied once
  more into the index, with the index beside it. It is the first revisit trigger's case.
- **Not measured:** the row-ceiling exemption, because the ceiling is 100,000 rows. It is covered by
  review of `IsSearchStorage`.

## Consequences

### Positive

- A word anywhere in a record's text finds it, from every client, ranked, with an excerpt.
- A copied, backed-up or restored file is searchable at once.
- The index is checked against the records by a test helper, and against itself by SQLite's integrity
  check.

### Negative

- An indexed file is larger by about its text plus the index, and an older host refuses it.
- Every write to an indexed file also writes the index rows of the records it touched.
- A file needs one build before it can be searched. A file opened read-only does not, but its search
  builds a private index on every query.

## Rejected alternatives

- **Option A (beside the file).** The owner chose the index in the file on 2026-10-06, accepting the
  format change for an index that travels with the data.
- **Triggers to maintain the index.** Any trigger puts a file into recovery, and a trigger cannot be
  reviewed as an operation.
- **An external-content FTS5 table over the record tables.** Records span many tables, and external
  content would let the index and the content disagree without FTS5 noticing.
- **Building on every first write.** This would raise the minimum host of every file the new host
  touches, without anyone asking for search.
- **A free-text operator in declared filters.** ADR-0004 rules it out, and search is a separate read
  with its own ranking and paging.

## Revisit triggers

- A file whose text makes the index's size matter. A contentless index with excerpts built from the
  records would roughly halve it.
- A need to repair a damaged index from recovery instead of from a backup.
- A request to search choices, numbers or dates.
