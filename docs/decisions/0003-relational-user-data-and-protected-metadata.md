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

The ADR-0004 contract version 3 amendment adds `relatedList`, which reads the
inverse of a reference: the records of one entity whose reference field points at
one record of another. Reference values are an ordinary column and the schema
carried no index on any field column, so that read was a table walk.

EX-0010 lane C
measured it on the production table shape at 1,000 parents and 10,000 children.
A dense parent met the R06 bounded-read target trivially, because SQLite walks
the primary-key index for `ORDER BY __nendo_record_id` and stops as soon as the
page fills. A sparse or empty relation cannot stop early: p50 3.97 ms and 3.86 ms
against a 150 ms target. Both pass, and neither is a failure being repaired.

The cost is linear in table size rather than in result size, and a register with
many parents each owning few children is the ordinary case rather than the edge.
This note therefore accepts one covering index per configured reference field,
created inside the same explicit typed operation that configures the reference:

```sql
CREATE INDEX <name> ON <entity table>(<reference column>, __nendo_record_id);
```

The index is host-owned and created only by the supported schema service, inside
the transaction that configures the reference and after the physical column
exists, since the same change set may add both. It is never created on open and
never as a repair. Ordinary opening of an existing file does not add it; files
configured before this note keep working and read without it. Measured on the
same fixture the index takes the sparse case to p50 0.05 ms and turns the plan
into a covering search.

It is deliberately named outside the `__nendo_` namespace, so it is not part of
the protected schema signature. That signature is a fixed set of recognised
layouts, and the number of reference indexes varies per application; including
them would make every configured reference produce an unrecognised layout and
refuse to open. Losing the index is therefore not drift and not a fault: the
inverse read stays correct without it, only slower. The existing required-
constraint table rebuild already captures and recreates indexes on the table, so
retiring a field does not silently drop it.

This note authorises that index and nothing else. It adds no index for any other
field kind, introduces no user-defined indexes, and changes no storage engine,
journal or copy-discipline decision.

Nendo must support ordinary relational data while retaining stable semantic
identity, mutable human labels, application definitions, history and format
compatibility. A storage model optimized only for renderer convenience would
make recovery and independent inspection unnecessarily difficult. Exposing raw
SQL as the product mutation model would bypass semantic history and validation.

## Decision drivers

1. Useful independent SQLite inspection and recovery.
2. Stable entity/field identity across display-name changes.
3. Typed schema changes with deterministic history and validation.
4. Straightforward filtering, sorting, relationships and indexing.
5. A closed storage boundary with no SQL leakage to UI or MCP adapters.
6. A small format-version-one type system.

## Options considered

### Ordinary relational user tables plus protected metadata

Materialize each entity as a table and map stable semantic IDs to constrained
physical names in host-owned metadata.

### Entity-attribute-value storage

Store all values in generic rows. This simplifies some dynamic-schema changes
but degrades direct inspection, constraints, query planning and type clarity.

### One JSON application document

Store schema, data and UI as a document blob. This couples unrelated edits,
weakens relational behavior and encourages whole-document replacement.

## Decision

Nendo format version 1 uses ordinary relational tables for user data and a
reserved protected metadata namespace for Nendo state.

- Stable semantic entity and field IDs are distinct from mutable display names
  and constrained physical table/column names.
- Protected metadata records the manifest, application/instance identity,
  semantic mappings, UI nodes/properties, revisions, canonical operations and
  idempotency evidence. The exact prototype schema is not frozen by this ADR.
- `format_version` and `minimum_host_version` are mandatory from the first
  production format. SQLite application/user version markers supplement rather
  than replace the protected manifest.
- Only the host schema service may mutate physical DDL or protected metadata.
  Storage-specific SQL and SQLite types remain inside the SQLite adapter.
- External changes are detected as drift and produce a normal, read-only or
  recovery-required open classification; the host does not guess a repair.
- MVP scalar storage kinds are text, integer, decimal, boolean, date, datetime,
  UUID and reference. Long text, single choice, email, URL, color and Markdown
  are presentation/validation semantics over those kinds.
- Scalar multi-choice, JSON-as-a-user-type and binary/assets are deferred.
- Relationships use explicit relational metadata and foreign-key/join
  structures rather than encoded scalar lists.
- Generated display-label recovery views are not part of format version 1.
  Stable physical names plus the semantic map are the inspectability baseline.

## Evidence and validation obligations

- EX-0001 reopened an empty file and a populated Idea Garden file with coherent
  ordinary tables, stable mappings and protected history.
- EX-0002 compiled the stored schema and UI through typed services without
  exposing physical identifiers or SQLite authority.
- Production migrations must be versioned, deterministic, transactional and
  covered by old-file/new-host fixtures before a format version ships.
- Adversarial identifiers, rename collisions, reserved words, relationship
  integrity and externally modified schemas require implementation tests.
- Direct SQLite inspection is a recovery aid, not a supported mutation API.

## Consequences

### Positive

- User data remains understandable and queryable with standard SQLite tools.
- Display-name changes do not break semantic bindings.
- Typed services can enforce history and compatibility independently of the UI.

### Negative

- Schema evolution requires deliberate DDL migration logic.
- Protected metadata and user tables must stay transactionally consistent.
- Some dynamic low-code patterns are harder than with EAV or a document blob.

## Rejected alternatives

EAV and a single JSON document are rejected because their flexibility does not
justify weaker relational semantics, inspectability and operation-level change
tracking for the bounded MVP.

## Revisit triggers

- A required data shape cannot be represented without pathological relational
  complexity.
- Format migrations show that stable physical mappings are insufficient.
- A generated recovery-view experiment proves clear value without collision or
  migration debt.
