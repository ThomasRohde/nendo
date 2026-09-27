# Nendo glossary

## Application

The logical schema, data, semantic surfaces, declarative commands, settings and history that one `.nendo` file contains.

## Nendo file

The canonical SQLite artefact. It may contain no user schema and no data. It still contains mandatory Nendo metadata and a genesis revision.

## Host

The trusted installed runtime. It owns the file lifecycle, SQLite connections, validation, revisions, proposal promotion, operating-system integration and Studio.

## Studio

The permanent host-owned human workspace: Data, Structure, Surfaces, History and Health. Application content and agents cannot remove it.

## Entity

A semantic record type that Nendo materialises as an ordinary relational user table.

## Field

A stable semantic property of an entity. It maps to a physical column or a relationship. Display names and physical names are not its identity.

## Unique field

A field no two records of its type may share a value in ([ADR-0020](decisions/0020-unique-and-generated-fields.md)). The host refuses a duplicate from every client and names the record that holds the value. Text compares ignoring ASCII case; an empty value never collides. A unique Text field can also be numbered: the host writes the next code (W-001) into a new record that leaves it empty, and never hands out a number twice.

## Relationship

A typed association between records. Multi-valued relationships are not scalar fields.

## Hierarchy

A record type's self-reference declared as a tree ([ADR-0019](decisions/0019-hierarchies-in-the-schema.md)). The host refuses any write that would put a record under itself or one of its descendants, or deeper than 32 levels. The parent and order stay ordinary fields.

## Record

One entity instance with a stable record ID and an optimistic record version.

## Semantic ID

A stable identifier that services, definitions and agents use. Labels and physical SQLite names may change, and the semantic ID stays the same.

## Semantic surface

A versioned form, list, board, gallery, calendar, timeline, record page, command or other focused experience. The selected renderer interprets it from Nendo-owned definitions. All surfaces but one are about a single record type. The front page (`overviewSurface`) belongs to the file, and each tile on it names the record type that it reads.

## What the file is for

Prose that a `.nendo` file carries about itself to say what the file is for.
`application.setPurpose` sets it. It is read first from
`nendo://application/describe`, and Nendo shows it to a person under the file's
name in About this file, in the File menu. It belongs to the file and not to a record type or a node. Thus a file with
no front page also has one. The `description` of a front page is a separate
sentence about that page. If the author of a file has said nothing, the file
carries nothing. Nendo does not derive a value from the file name.

## UI node

A stable-ID element in a semantic surface tree. Changes use typed operations such as add, set, move and remove.

## Data lane

The direct validated active-file path for ordinary record CRUD, paste and import.

## Application lane

The proposal path for schema, semantic UI, constraints and declarative-command changes. The host validates and previews agent-authored changes on a clone.

## Change set

Ordered canonical operations that share one intent, origin, preconditions, validation and description.

## Proposal clone

A physically separate copy that validates and previews an application-lane change. It has no active-file authority.

## Promotion

The host-owned replay of the exact validated operations against the active file. The host first checks the definition and touched-record preconditions. Promotion is not file replacement.

## Definition revision

The version lineage for schema, semantic UI, constraints, commands and application settings.

## Data revision

The version lineage for record state.

## Change sequence

The monotonic audit order across data and definition changes.

## Reversibility class

A declared operation property: `Reversible`, `ReversibleWithRetainedState`, or `IrreversibleDeclared`. MCP payloads carry these names in camelCase.

## Compensation

A new revision that applies a proven inverse. It does not erase or rewind history.

## Safe mode

The restricted Studio that Nendo uses when compatibility, integrity, drift or trust findings prevent normal custom behaviour or writes.

## MCP adapter

The external agent protocol surface over the same application services that other clients use. It is not the authority model.

## Experiment

Disposable executable work with a hypothesis, fixed scope, pass/fail criteria, exact environment and recorded result.

## ADR

An Architecture Decision Record that ADR-0000 governs. Proposed ADRs describe candidates. Accepted ADRs authorise implementation within their evidence and boundaries.
