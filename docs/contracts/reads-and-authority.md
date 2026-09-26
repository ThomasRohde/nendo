# Reads and authority contract

A custom view reads the file through the Workbench's own bounded reads, under the
same bounds: `data.queryRecords`, `data.countRecords` and the aggregate reads, which
the Workbench's broker calls for it from a closed method table. It adds no host read
of its own and no MCP endpoint, and it reaches no SQL and no path. See
[custom views](custom-views.md#the-method-table).

This contract covers bounded reads, cursor discipline and the scope of read
authority. It refines the write coordinator. It does not change the file format,
the journal, the operation vocabulary or the trust boundary.

ADR-0008 is delivered. Calculation and action reads use a shared bounded budget,
capture read-record versions, and take conservative data revision preconditions
for related membership. The [historical experiment](../design/adr-0008-evidence.md)
that established them ran in a copied Engine and is history. A schema read carries
each calculated field with its calculation ID and its expression.

The query APIs below still do not expose two things, and this is intentional.
The first is a behaviour grant, which belongs to the person and is given at this
device. The second is any way to suppress a trigger. No read or write here
reaches either of them.

## Bounded reads

`QueryRecordsAsync`, `QueryHistoryAsync` and `QueryRevisionOperationsAsync` use
typed semantic IDs and limits 1–200. Normal writable-session queries run in one
SQLite read transaction. The orders are as follows:

- Records use SQLite BINARY record-ID keyset order.
- History uses the unique change sequence, ascending or descending.
- Revision operations use the immutable ordinal.

SQL identifiers come only from verified storage mappings. Values, continuation
keys and limits are parameters. History summaries exclude operation payloads and
report the operation count. Operation detail is paged separately. An advisory
compensation flag gives only eligibility to request server validation. It does
not promise that an inverse stays applicable.

Cursors authenticate the query scope, the application/instance identity and the
change sequence under a random key for this coordinator. Any coordinated edit or
definition change invalidates continuation with `stale-cursor`. Callers then
restart and replace their displayed page. A cursor from another query, another
file or a reopened coordinator fails with `invalid-cursor`. The MCP wrapper of the
host adds its own agent-access-generation key. This keeps invalidation when
access is disabled and enabled without closing the file. MCP keeps its 1–100
public limit. It has sixteen resources:

- History returns summaries and `operationsUri`.
- The revision operations resource returns only sanitized operation descriptors.
- The CSV export resource returns one page of the faithful profile. The header
  row is on the first page only (see the [CSV contract](csv.md)).
- The packages resource lists every custom-view package in the file, with each
  file's path, media type, SHA-256 and size, and no content.
- The package-file resource returns one package file, a page of bytes at a time. It
  pages by byte `offset` and `length`, at most 131,072 bytes, not by the 1–100
  record limit. Each page carries the whole file's SHA-256 (see the
  [custom-view contract](custom-views.md#packages-in-the-file)).

Clients must follow the declared URI template order (`cursor,limit`).

Read-only recovery uses the immutable inspection snapshot that is already
classified, and bounded projections of that snapshot. It cannot claim a
streaming recovery open. Sort/filter/search controls stay separate
capability-map obligations. The query contract that this section introduces is
explicit stable-ID/sequence ordering only.

## Authority reuse argument

1. The coordinator serializes its one connection. It acquires the existing
   instance ownership, write lease and delete-denying path pin. After normal
   open/inspection validation, initial authority still fingerprints the complete
   schema, mappings, records, definitions, audit, canonical operations, inverse
   evidence and idempotency evidence in one read transaction.
   It uses the existing streaming storage-content fingerprint, which includes the
   raw schema, row IDs, storage types and every audit/inverse value. A second
   typed serialization of the same complete contents is not necessary. The
   inspection comparison of the open path reuses this exact digest only after it
   checks the same connection token again in a read transaction. Every local
   commit invalidates this content-digest cache. Later explicit copy/inspection
   requests compute it again.
   Writable open acquires its read-only, delete-denying path pin before any
   classification. It no longer performs a redundant unpinned full
   classification first. No writer sidecar or writable connection exists until
   a classification permits authority. The active connection still checks the
   complete content against the inspected state. If a cooperative writer changes
   the contents between inspection and authority, the connection rejects it.
   Since 2026-09-26 (W-026), an open that carries the host's observation of the
   same physical file does not classify it again. Only the Engine makes an
   observation, from a full inspection, so the pinned file's physical facts are
   checked instead: no journal or WAL sidecar, within the size bound, a
   rollback-journal header. Under the write lease, the content digest must
   equal the observed one, and SQLite's `integrity_check` runs on the writable
   connection. Any difference refuses with `file-changed-before-open`, and the
   host inspects again. An open without an observation still classifies once.
   During advisory recent-file collision checks, Desktop does not observe the
   same physical candidate a second time. When it records that successful open,
   it reuses the exact observation that the Engine checked. Desktop still
   inspects other physical originals. This device-history reuse never grants
   storage authority. Startup consumes metadata. The renderer then requests its
   selected record window.
2. That connection records SQLite `data_version` while it holds the same read
   snapshot. Later queries and writes fix a read snapshot before they check that
   token. SQLite documents that the value changes for commits on other
   connections. It does not change for commits on the same connection.
   Comparisons are meaningful only on that one connection. See [SQLite PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version).
3. Ordinary writes already acquire `BEGIN IMMEDIATE` before they check
   authority. Another SQLite writer cannot commit between that check and the
   commit of this transaction. Read transactions keep their snapshot through
   projection. See [SQLite transaction isolation](https://www.sqlite.org/isolation.html).
4. Any different external token permanently taints this store. The store fails
   closed. This includes a change that is confined to audit/inverse/schema with
   unchanged manifest counters. The coordinator enters recovery and revokes
   adapters. It never adopts outside content only because the counters match.
   It never computes a new hash again and accepts it silently. Reopen performs
   full classification and validation.
5. A local mutation still performs typed validation, record preconditions,
   replay lookup, revision/audit writes and the manifest update in its
   transaction. It prepares a new internal session token and reads the resulting
   manifest before commit. Only a successful commit publishes that authority in
   memory. Failed/cancelled transactions keep the old authority. Replay returns
   the original receipt and keeps the current authority. Publication does no SQL
   or cancellable work after commit. The next check detects a later outside
   commit.
6. The authority token is expressly connection-scoped. It is not a content
   digest, and it is never an adapter credential. Exact file copying still uses
   the independent full storage-content digest. A second read-only backup
   connection holds one source snapshot. It compares that complete digest before
   copy and through validation/activation. It must not compare the session token
   of another connection. The existing source-authority checks and the
   no-overwrite destination/retained-original checks stay in the coordinator.

Only `ApplyAsync` and `ApplyChangeSetAsync` mutate an authority-bearing active
connection. Creation initializes before authority exists. Identity transition
and legacy migration stay private staged-store operations. They must reject the
reuse of an authority-bearing connection. No raw connection is exposed. This
argument does not protect against malware, hostile VFS/raw-byte writes, physical
failure or cloud synchronization. This optimization does not add support for
those cases.

## Workbench and verification scope

The current renderer opts into `boundedRead` on its version-7 envelope.
This is a projection preference and grants no authority: the opaque
file-generation checks still run under the controller gate. Native/compatibility
full inspection stays available explicitly. An ordinary renderer snapshot or
post-commit view contains metadata and the time/sequence of the last integrity
verification. It contains no records. `data.queryRecords`, `history.query` and
`history.operations` provide windows. In this mode, `semantic.compile` compiles
the definition alone. The renderer binds its separate current record window for
display. The definition digest does not represent a digest of the visible
records.

Data, Use and History show 50-item pages with Previous/Next controls. The
selected Studio entity and the custom entity can each have one loaded window. A
refresh/committed change rebuilds the first pages. A stale continuation causes a
refresh and announces that reset. Metadata, definition and page sequences must
agree before the renderer publishes a refreshed view. Bounded retries handle an
agent write that occurs between them. A failed derivative read keeps the
successful receipt and the existing explicit Refresh view action.
Recent-file inspection runs only for the no-file screen that shows it. For an
application that is already open, the initial view and the file-action refresh
do not scan unrelated recent files. Close still refreshes that list, and native
admission continues to validate every selected file again.

The application service caches unchanged definitions by verified application,
instance and definition revision. Record projection/validation, versions, data
revision and render digest stay current. Ordinary status returns the date and
sequence of the last full integrity check. It also returns how many committed
changes the file has taken since that check. Thus a result measured thirty-two
changes ago is reported as an old result, and not as a current verdict. When a
user enters writable Health, it uses `health.verify` for a new check. An agent
uses `nendo.health.verify_integrity`. This scans only when the file has changed
since the last scan. Otherwise it returns the recorded result unchanged.
Read-only/recovery sessions direct users to explicit reinspection. Open,
classification, staged copy and recovery checks stay full validations.
Instrumentation counts full reads, integrity checks and definition compilations.
It is internal test/benchmark evidence and is not an adapter API.

## Required regression evidence

Keep the suites for delayed replay, cancellation before commit, failure after
commit, compensation, proposal and lifecycle. Add these cases:

- uncounted external schema/audit/inverse/data edits after repeated local commits
- read/receipt/page rejection
- rollback and read-only external connections
- outside commits immediately after a local commit

Record the full-scan counters and the final matrix timings. Correctness alone is
not a performance result.
