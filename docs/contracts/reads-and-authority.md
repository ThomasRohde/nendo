# Reads and authority contract

This contract covers bounded reads, cursor discipline and the scope of read authority. It
refines the write coordinator and changes no file format, journal, operation vocabulary or
trust boundary.

A custom view reads through the Workbench's own bounded reads (`data.queryRecords`,
`data.treeRecords`, `data.searchRecords`, `data.countRecords`, the aggregate reads), called
by the broker from a closed method table (`extension-broker.ts`): no host read of its own, no
MCP endpoint, no SQL, no path ([custom views](custom-views.md#the-method-table)).

Calculation and action reads share a bounded budget, capture read-record versions and take
conservative data revision preconditions for related membership. A schema read carries each
calculated field with its calculation ID and expression. No read or write exposes a
behaviour grant (the person's, given at this device) or a way to suppress a trigger.

## Bounded reads

`QueryRecordsAsync`, `QueryHistoryAsync` and `QueryRevisionOperationsAsync` take typed
semantic IDs and limits 1–200, in one SQLite read transaction. Records use BINARY record-ID
keyset order, or a named sort field with record ID as the final key; history the unique
change sequence, either direction; revision operations the immutable ordinal. A record query
takes up to eight AND filters (`RecordQuerySemantics` refuses a ninth); the
[query contract](queries.md) governs sorting, predicates and cursors.

SQL identifiers come only from verified storage mappings; values, continuation keys and
limits are parameters. History summaries exclude payloads and report the operation count;
detail is paged separately. An advisory compensation flag only permits requesting server
validation.

`SearchRecordsAsync` ([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)) reads
1–100 records over the file's FTS5 index, ranked by BM25, paged by position under the same
cursor. A read-only session indexes the snapshot into a private in-memory database. Read-only
recovery uses bounded projections of the classified inspection snapshot.

Cursors authenticate the query scope, the application/instance identity and the change
sequence under a random per-coordinator key. Any edit or definition change makes
continuation `stale-cursor`: restart and replace the displayed page. A cursor from another
query, file or reopened coordinator is `invalid-cursor`. The MCP wrapper adds its
agent-access-generation key, so disabling and re-enabling access also invalidates cursors.
MCP's own page limit, query rules and resources are in the
[MCP interface](mcp-interface.md#paging).

## Authority reuse argument

1. **One connection, one fingerprint.** The coordinator serializes one connection holding
   the instance ownership, write lease and delete-denying path pin, taken before any
   classification; no writer sidecar or writable connection exists until a classification
   permits authority. Initial authority takes the streaming storage-content fingerprint
   (schema, mappings, records, definitions, audit, operations, inverse and idempotency
   evidence, row IDs, storage types) in one read transaction. Inspection reuses that digest
   only after re-checking the connection token; every local commit invalidates the cache.
2. **An observed open is not classified twice.** Only the Engine makes an observation, from
   a full inspection. An open carrying it checks the pinned file's physical facts instead (no
   journal or WAL sidecar, within the size bound, a rollback-journal header); under the write
   lease the content digest must equal the observed one, and the first authority read runs
   `integrity_check` and refuses anything but `ok`. Any difference is
   `file-changed-before-open`, and the host inspects again. Desktop records a successful open
   with the observation the Engine checked. This reuse never grants storage authority.
3. **`data_version`.** The connection records SQLite `data_version` under the same read
   snapshot; later reads and writes fix a snapshot before checking it. It changes only for
   commits on other connections
   ([SQLite PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version)).
4. **Writes check under `BEGIN IMMEDIATE`**, so no other writer commits between the check and
   this commit ([SQLite isolation](https://www.sqlite.org/isolation.html)).
5. **Any outside change taints the store.** A different external token, even confined to
   audit/inverse/schema with unchanged counters, fails closed: recovery, adapters revoked. It
   never adopts outside content or a recomputed hash. Reopen classifies and validates fully.
6. **Authority is published only on commit.** A local mutation validates, checks
   preconditions and replay, writes revision, audit and manifest, and prepares its new token
   inside the transaction; only a successful commit publishes it. Failure or cancellation
   keeps the old authority; replay returns the original receipt. Nothing cancellable runs
   after commit.
7. **The token is connection-scoped**: not a content digest, never an adapter credential.
   Exact copying compares the full content digest on a separate read-only backup connection,
   never another connection's token.

Only `ApplyAsync` and `ApplyChangeSetAsync` mutate an authority-bearing connection.
Identity transition and legacy migration are private staged-store operations that reject
one. No raw connection is exposed. The argument does not cover malware, hostile VFS or
raw-byte writes, physical failure or cloud synchronization.

## Workbench and verification scope

The renderer opts into `boundedRead` on its version-7 envelope, a projection preference
that grants no authority. A snapshot or post-commit view carries metadata and the last
integrity verification, no records. `data.queryRecords`, `history.query` and
`history.operations` provide windows; each `history.operations` entry carries its automatic
action's `attribution`, or null
([calculations-and-actions.md](calculations-and-actions.md#identity-retries-and-history)).
`semantic.compile` compiles the definition alone, so its digest is not a digest of visible
records.

Data, Use and History show 50-item pages. A refresh or commit rebuilds the first pages; a
stale continuation refreshes and announces it. Metadata, definition and page sequences must
agree before a refreshed view is published, with bounded retries. A failed derivative read
keeps the receipt and offers Refresh view.

The no-file screen and the Jump List read each recent file's identity only, through
`NendoWriteCoordinator.IdentifyAsync` (physical key, declared application and instance,
behind the sidecar and header guards): no integrity check, classification or digest, so a
damaged file can be listed and opening it inspects it in full. Only the no-file screen asks
for the list. The Jump List refreshes at startup and on every open, outside the request gate.

Status reports the date and sequence of the last full integrity check and how many changes
the file has taken since, so an old result reads as old. Writable Health runs `health.verify`;
`nendo.health.verify_integrity` scans only when the file changed since the last scan.
Open, classification, staged copy and recovery stay full validations.

Inspection writes nothing, with one exception
([ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md)): when the host says
the person opened the file themselves outside a synced folder
(`NendoInterruptedWrite.RollBack`), a lone rollback journal beside it could by plain reads be
the file's, and a read-only connection reports it hot, SQLite plays it back on one
read-write connection under the write-ownership lease, after keeping the file and journal
beside it under names SQLite does not pair. The kept copy is never removed automatically. On
that open a journal with nothing to roll back is removed under the RESERVED lock. Every other
observation, the recent-file check and a Restore backup included, refuses untouched.

## Regression coverage

The suites cover delayed replay, cancellation before and failure after commit,
compensation, proposals, lifecycle, uncounted external edits after local commits, read,
receipt and page rejection, rollback and read-only external connections, and outside
commits right after a local commit. A performance claim records the full-scan counters
(internal instrumentation, not an adapter API) and matrix timings.
