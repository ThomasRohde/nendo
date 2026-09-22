# Nendo glossary

## Application

The logical schema, data, semantic surfaces, declarative commands, settings and history contained in one `.nendo` file.

## Nendo file

The canonical SQLite artefact. It may be empty of user schema and data while still containing mandatory Nendo metadata and a genesis revision.

## Host

Trusted installed runtime that owns file lifecycle, SQLite connections, validation, revisions, proposal promotion, operating-system integration and Studio.

## Studio

Permanent host-owned human workspace: Data, Structure, Surfaces, History and Health. It cannot be removed by application content or an agent.

## Entity

A semantic record type materialised as an ordinary relational user table.

## Field

A stable semantic property of an entity mapped to a physical column or relationship. Display names and physical names are not its identity.

## Relationship

A typed association between records. Multi-valued relationships are not scalar fields.

## Record

One entity instance with a stable record ID and optimistic record version.

## Semantic ID

Stable identifier used by services, definitions and agents. Labels and physical SQLite names may change without changing the semantic ID.

## Semantic surface

A versioned form, list, board, gallery, calendar, timeline, record page, command or other focused experience interpreted by the selected renderer from Nendo-owned definitions. All but one are about a single record type; the front page (`overviewSurface`) belongs to the file, and each tile on it names the record type it reads.

## What the file is for

Prose a `.nendo` file carries about itself, saying what it is for — set by
`application.setPurpose`, read first from `nendo://application/describe`, and shown to a
person under the file's name. It belongs to the file rather than to a record type or a
node, so a file with no front page has one too; a front page's own `description` is a
separate sentence about that page. A file whose author has said nothing carries nothing,
rather than something derived from its file name.

## UI node

A stable-ID element in a semantic surface tree. Changes use typed operations such as add, set, move and remove.

## Data lane

Direct validated active-file path for ordinary record CRUD, paste and import.

## Application lane

Proposal path for schema, semantic UI, constraints and declarative-command changes. Agent-authored changes are validated and previewed on a clone.

## Change set

Ordered canonical operations sharing one intent, origin, preconditions, validation and description.

## Proposal clone

Physically separate copy used to validate and preview an application-lane change. It has no active-file authority.

## Promotion

Host-owned replay of the exact validated operations against the active file after checking definition and touched-record preconditions. It is not file replacement.

## Definition revision

Version lineage for schema, semantic UI, constraints, commands and application settings.

## Data revision

Version lineage for record state.

## Change sequence

Monotonic audit ordering across data and definition changes.

## Reversibility class

Declared operation property: `reversible`, `reversible-with-retained-state`, or `irreversible-declared`.

## Compensation

A new revision that applies a proven inverse. It does not erase or rewind history.

## Safe mode

Restricted Studio used when compatibility, integrity, drift or trust findings prevent normal custom behaviour or writes.

## MCP adapter

External agent protocol surface over the same application services used by other clients. It is not the authority model.

## Experiment

Disposable executable work with a hypothesis, fixed scope, pass/fail criteria, exact environment and recorded result.

## ADR

Architecture Decision Record governed by ADR-0000. Proposed ADRs describe candidates; Accepted ADRs authorise implementation within their evidence and boundaries.
