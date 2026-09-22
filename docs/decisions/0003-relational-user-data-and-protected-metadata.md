# ADR-0003: Store relational user data with protected semantic metadata

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result and EX-0002 result
- **Depends on:** ADR-0001 local one-file product boundary
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

### Accepted note — 2026-09-09 (covering index on configured reference columns)

The ADR-0004 contract version 3 amendment adds `relatedList`. A `relatedList`
reads the inverse of a reference: the records of one entity whose reference field
points at one record of another entity. Reference values are an ordinary column,
and the schema had no index on any field column. Thus that read was a table walk.

EX-0010 lane C
measured the read on the production table shape at 1,000 parents and 10,000
children. A dense parent met the R06 bounded-read target easily. For
`ORDER BY __nendo_record_id`, SQLite walks the primary-key index and stops when
the page is full. A sparse or empty relation cannot stop early: p50 3.97 ms and
3.86 ms against a 150 ms target. Both results pass, and this note does not repair
a failure.

The cost is linear in table size and not in result size. A register with many
parents that each own few children is the ordinary case, not the edge case.
Thus this note accepts one covering index per configured reference field. The
same explicit typed operation that configures the reference creates the index:

```sql
CREATE INDEX <name> ON <entity table>(<reference column>, __nendo_record_id);
```

The index is host-owned. Only the supported schema service creates it. It does so
inside the transaction that configures the reference, after the physical column
exists, because the same change set may add both. The host never creates the
index on open and never creates it as a repair. An ordinary open of an existing
file does not add it. Files configured before this note continue to work and read
without it. On the same fixture, the index took the sparse case to p50 0.05 ms and
changed the plan into a covering search.

The index name is outside the `__nendo_` namespace by design. Thus the index is
not part of the protected schema signature. That signature is a fixed set of
recognised layouts, and the number of reference indexes varies per application.
If the signature included them, every configured reference would produce an
unrecognised layout, and the file would refuse to open. Thus a lost index is not
drift and not a fault: the inverse read stays correct without it, but is slower.
The existing required-constraint table rebuild already captures and recreates
indexes on the table. Thus when a field is retired, the rebuild does not drop the
index without notice.

This note authorises that index and nothing else. It adds no index for any other
field kind and introduces no user-defined indexes. It changes no storage engine,
journal or copy-discipline decision.

Nendo must support ordinary relational data. It must also keep stable semantic
identity, mutable human labels, application definitions, history and format
compatibility. A storage model that is optimized only for renderer convenience
would make recovery and independent inspection unnecessarily difficult. If raw
SQL were the product mutation model, it would bypass semantic history and
validation.

## Decision drivers

1. Useful independent SQLite inspection and recovery.
2. Stable entity/field identity across display-name changes.
3. Typed schema changes with deterministic history and validation.
4. Straightforward filtering, sorting, relationships and indexing.
5. A closed storage boundary with no SQL leakage to UI or MCP adapters.
6. A small format-version-one type system.

## Options considered

### Ordinary relational user tables plus protected metadata

Materialize each entity as a table. Map stable semantic IDs to constrained
physical names in host-owned metadata.

### Entity-attribute-value storage

Store all values in generic rows. This option makes some dynamic-schema changes
simpler. But it degrades direct inspection, constraints, query planning and type
clarity.

### One JSON application document

Store schema, data and UI as a document blob. This option couples unrelated
edits and weakens relational behavior. It also encourages whole-document
replacement.

## Decision

Nendo format version 1 uses ordinary relational tables for user data and a
reserved protected metadata namespace for Nendo state.

- Stable semantic entity and field IDs are distinct from mutable display names
  and constrained physical table/column names.
- Protected metadata records the manifest, application/instance identity,
  semantic mappings, UI nodes/properties, revisions, canonical operations and
  idempotency evidence. This ADR does not freeze the exact prototype schema.
- `format_version` and `minimum_host_version` are mandatory from the first
  production format. SQLite application/user version markers supplement the
  protected manifest. They do not replace it.
- Only the host schema service may mutate physical DDL or protected metadata.
  Storage-specific SQL and SQLite types remain inside the SQLite adapter.
- The host detects external changes as drift. Drift produces a normal, read-only
  or recovery-required open classification. The host does not guess a repair.
- MVP scalar storage kinds are text, integer, decimal, boolean, date, datetime,
  UUID and reference. Long text, single choice, email, URL, color and Markdown
  are presentation/validation semantics over those kinds. (Note, 2026-09-22:
  the schema service accepts the presentations `singleLine`, `longText`,
  `singleChoice`, `date` and `rating`. Email, URL, color and Markdown
  presentations are not implemented.)
- Scalar multi-choice, JSON-as-a-user-type and binary/assets are deferred.
- Relationships use explicit relational metadata and foreign-key/join
  structures. They do not use encoded scalar lists.
- Generated display-label recovery views are not part of format version 1.
  Stable physical names plus the semantic map are the inspectability baseline.

## Evidence and validation obligations

- EX-0001 reopened an empty file and a populated Idea Garden file with coherent
  ordinary tables, stable mappings and protected history.
- EX-0002 compiled the stored schema and UI through typed services. It did not
  expose physical identifiers or SQLite authority.
- Production migrations must be versioned, deterministic and transactional.
  Before a format version ships, old-file/new-host fixtures must cover them.
- Adversarial identifiers, rename collisions, reserved words, relationship
  integrity and externally modified schemas require implementation tests.
- Direct SQLite inspection is a recovery aid, not a supported mutation API.

## Consequences

### Positive

- User data remains understandable and queryable with standard SQLite tools.
- Display-name changes do not break semantic bindings.
- Typed services can enforce history and compatibility independently of the UI.

### Negative

- Schema evolution requires intentional DDL migration logic.
- Protected metadata and user tables must stay transactionally consistent.
- Some dynamic low-code patterns are harder than with EAV or a document blob.

## Rejected alternatives

EAV and a single JSON document are rejected. For the bounded MVP, their
flexibility does not justify weaker relational semantics, inspectability and
operation-level change tracking.

## Revisit triggers

- A required data shape cannot be represented without pathological relational
  complexity.
- Format migrations show that stable physical mappings are insufficient.
- A generated recovery-view experiment proves clear value without collision or
  migration debt.
