# Reads and authority contract

The accepted custom-view slice adds a coherent bounded graph read within the same
Engine storage boundary; see [custom views](custom-views.md). It has no new MCP or
Workbench endpoint yet and does not grant a package query authority.

Bounded reads, cursor discipline and how read authority is scoped. This refines
the write coordinator; it does not change the file format, journal, operation
vocabulary or trust boundary.

ADR-0008 is delivered. Calculation and action reads use a shared bounded budget,
capture read-record versions, and take conservative data revision preconditions
for related membership; the [historical experiment](../design/adr-0008-evidence.md)
that established them ran in a copied Engine and is history. A schema read carries
each calculated field with its calculation ID and its expression.

Two things the query APIs below still do not expose, and both are deliberate: a
behaviour grant, which is the person's and is given at this device, and any way to
suppress a trigger. Neither has a read or a write here that reaches it.

## Bounded reads

`QueryRecordsAsync`, `QueryHistoryAsync` and `QueryRevisionOperationsAsync` use
typed semantic IDs and limits 1–200. Normal writable-session queries run in one
SQLite read transaction. Records use SQLite BINARY record-ID keyset order;
history uses unique change sequence, ascending or descending; revision operations
use immutable ordinal. SQL identifiers come only from verified storage mappings.
Values, continuation keys and limits are parameters. History summaries exclude
operation payloads and report operation count. Operation detail is separately paged.
An advisory compensation flag is only eligibility to request server validation;
it does not promise that an inverse remains applicable.

Cursors authenticate query scope, application/instance identity and change
sequence under a random key for this coordinator. Any coordinated edit or
definition change invalidates continuation with `stale-cursor`; callers restart
and replace their displayed page. A cursor from another query, file or reopened
coordinator fails with `invalid-cursor`. The host's MCP wrapper adds its own
agent-access-generation key, preserving invalidation when access is disabled and
enabled without closing the file. MCP retains its 1–100 public limit. It has fourteen
resources: history returns summaries and `operationsUri`, the revision
operations resource returns only sanitized operation descriptors, and the CSV export
resource returns one page of the faithful profile with the header row on the first page
alone (see the [CSV contract](csv.md)). Clients must
follow the declared URI template order (`cursor,limit`).

Read-only recovery uses the already classified immutable inspection snapshot and
bounded projections of that snapshot. It cannot claim streaming recovery open.
Sort/filter/search controls remain separate capability-map obligations; the query
contract introduced here is explicit stable-ID/sequence ordering only.

## Authority reuse argument

1. The coordinator serializes its one connection. It acquires the existing instance
   ownership, write lease and delete-denying path pin. Initial authority still
   fingerprints the complete schema, mappings, records, definitions, audit,
   canonical operations, inverse evidence and idempotency evidence in one read
   transaction after normal open/inspection validation.
   It uses the existing streaming storage-content fingerprint, including raw
   schema, row IDs, storage types and every audit/inverse value. A second typed
   serialization of the same complete contents is unnecessary. The open path's
   inspection comparison reuses this exact digest only after rechecking the same
   connection token in a read transaction. Every local commit invalidates this
   content-digest cache; later explicit copy/inspection requests recompute it.
   Writable open acquires its read-only, delete-denying path pin before its one
   full classification. It no longer performs a redundant unpinned full
   classification first. No writer sidecar or writable connection exists until
   that pinned classification permits authority. The active connection still
   checks the complete content against the inspected state; a cooperative writer
   changing contents between inspection and authority is rejected.
   Desktop also avoids re-observing the same physical candidate during advisory
   recent-file collision checks, and reuses the exact Engine-checked observation
   when recording that successful open. Other physical originals are still
   inspected. This device-history reuse never grants storage authority. Startup
   consumes metadata; the renderer then requests its selected record window.
2. That connection records SQLite `data_version` while the same read snapshot is
   held. Subsequent queries and writes fix a read snapshot before checking that
   token. SQLite documents that the value changes for commits on other connections
   and does not change for commits on the same connection; comparisons are only
   meaningful on that one connection. See [SQLite PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version).
3. Ordinary writes already acquire `BEGIN IMMEDIATE` before checking authority.
   Another SQLite writer cannot commit between that check and this transaction's
   commit. Read transactions retain their snapshot through projection. See
   [SQLite transaction isolation](https://www.sqlite.org/isolation.html).
4. Any different external token permanently taints this store. It fails closed,
   including a change confined to audit/inverse/schema with unchanged manifest
   counters. The coordinator enters recovery and revokes adapters. It never
   adopts outside content merely because counters match, or recomputes a new hash
   and silently accepts it. Reopen performs full classification and validation.
5. A local mutation still performs typed validation, record preconditions, replay
   lookup, revision/audit writes and manifest update in its transaction. It prepares
   a new internal session token and reads the resulting manifest before commit.
   Only successful commit publishes that authority in memory. Failed/cancelled
   transactions retain the old authority; replay returns the original receipt
   while retaining the current authority. Publication does no SQL or cancellable
   work after commit. A later outside commit is detected on the next check.
6. The authority token is expressly connection-scoped, not a content digest and
   never an adapter credential. Exact file copying still uses the independent
   full storage-content digest. A second read-only backup connection holds one
   source snapshot and compares that complete digest before copy and through
   validation/activation; it must not compare another connection's session token.
   Existing source-authority checks and no-overwrite destination/retained-original
   checks remain in the coordinator.

Only `ApplyAsync` and `ApplyChangeSetAsync` mutate an authority-bearing active
connection. Creation initializes before authority exists. Identity transition and
legacy migration remain private staged-store operations and must reject reuse of
an authority-bearing connection. No raw connection is exposed. This argument
does not protect against malware, hostile VFS/raw-byte writes, physical failure,
or cloud synchronization; those are not newly supported by this optimization.

## Workbench and verification scope

The current renderer opts into `boundedRead` on its existing version-5 envelope.
This is a projection preference, not authority: the opaque file-generation checks
still run under the controller gate. Native/compatibility full inspection remains
available explicitly. An ordinary renderer snapshot or post-commit view contains
metadata and last integrity verification time/sequence, with no records.
`data.queryRecords`, `history.query` and `history.operations` provide windows.
`semantic.compile` in this mode compiles the definition alone. The renderer binds
its separate current record window for display; the definition digest is not
represented as a digest of the visible records.

Data, Use and History display 50-item pages with Previous/Next controls. The
selected Studio entity and custom entity may each have one loaded window. A
refresh/committed change rebuilds first pages; a stale continuation refreshes and
announces that reset. Metadata, definition and page sequences must agree before
the renderer publishes a refreshed view; bounded retries handle an intervening
agent write. A failed derivative read preserves the successful receipt and the
existing explicit Refresh view action.
Recent-file inspection runs only for the no-file screen that displays it. An
already open application's initial view and file-action refresh do not scan
unrelated recent files; close still refreshes that list, and native admission
continues to revalidate every selected file.

Unchanged definitions are cached inside the application service by verified
application, instance and definition revision. Record projection/validation,
versions, data revision and render digest remain current. Ordinary status returns
the date and sequence of the last full integrity check, and how many committed
changes the file has taken since — a result measured thirty-two changes ago is
reported as what it is rather than as a current verdict. Entering writable Health
uses `health.verify` for a new check; an agent uses
`nendo.health.verify_integrity`, which scans only when the file has moved since
the last scan and otherwise returns the recorded result unchanged.
Read-only/recovery sessions direct users to explicit reinspection. Open, classification, staged copy and recovery checks remain
full validations. Instrumentation counts full reads, integrity checks and
definition compilations; it is internal test/benchmark evidence, not an adapter API.

## Required regression evidence

Keep delayed replay, cancellation before commit, failure after commit, compensation,
proposal and lifecycle suites. Add uncounted external schema/audit/inverse/data
edits after repeated local commits, read/receipt/page rejection, rollback and
read-only external connections, and outside commits immediately after local
commit. Record full-scan counters and final matrix timings; correctness
alone is not a performance result.
