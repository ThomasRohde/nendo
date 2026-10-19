# ADR-0003: Store relational user data with protected semantic metadata

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `SemanticMetadataTests`, `StorageReviewTests`, `ReferenceTests`, `ReferenceLabelTests`, `ChoiceAdditionTests`, `MarkdownPresentationTests` and `ExtensionPackageTests` (Engine)

## Context

Nendo must hold ordinary relational data and also keep stable semantic identity,
mutable labels, application definitions, history and format compatibility. Storage
shaped for renderer convenience would make recovery and independent inspection
hard, and raw SQL as the mutation model would bypass history and validation.

## Decision

Format version 1 stores user data in ordinary relational tables and Nendo state in a
reserved, protected metadata namespace (`__nendo_*`).

### Identity and metadata

- Stable semantic entity and field IDs are distinct from mutable display names and
  from constrained physical table and column names.
- Protected metadata holds the manifest, application and instance identity, semantic
  mappings, UI nodes and properties, revisions, canonical operations and idempotency
  evidence.
- `format_version` and `minimum_host_version` are mandatory in the protected
  manifest. SQLite application and user version markers supplement it.
- Only the host schema service changes physical DDL or protected metadata.
  Storage-specific SQL and SQLite types stay inside the SQLite adapter.
- The host treats an external change as drift and classifies the open as normal,
  read-only or recovery required ([ADR-0012](0012-safe-mode-compatibility-and-migration.md)).
  It does not guess a repair.
- Generated display-label recovery views are not part of format version 1. Stable
  physical names plus the semantic map are the inspectability baseline. Direct
  SQLite inspection is a recovery aid, not a mutation API.

### Custom-view packages

Protected metadata holds custom-view packages
([ADR-0013](0013-custom-views-with-code-in-the-file.md)) in four tables:
`__nendo_extension_package`, `__nendo_extension_blob` (content keyed by SHA-256 and
kept after replacement or removal, so compensation restores exact bytes),
`__nendo_extension_file` and `__nendo_extension_state` (a view's durable state). The
host creates them on the first extension write, never at file creation, and only the
typed `extension.*` operations write them. A file that has them needs host 1.33.0. A
package's files are code and assets that run in the Workbench's WebView2, so the
file deliberately carries an executable payload; ADR-0013 states the trust trade.

### Field types

- Storage kinds are text, integer, decimal, boolean, date, datetime, UUID and
  reference.
- Presentations are validation and display over a kind: `singleLine`, `longText`,
  `markdown` and `media` on Text only, `singleChoice`, `date` and `rating`. Email, URL
  and colour presentations are not implemented. A stored `singleLine` or `longText` on
  a non-Text field reads as no presentation.
- `markdown` (host 1.44.0) shows a fixed subset, escaped before any tag is added,
  with links not followed, and edits the source as plain text.
  `schema.setFieldPresentation` moves a Text field between `singleLine`, `longText`,
  `markdown` and `media` without changing a value; it is reversible with retained
  state.
- Media is a Text field with the presentation `media` holding an address; embedded
  content lives once per distinct content in protected tables outside history
  ([ADR-0031](0031-media-in-user-data.md)), so no user column holds bytes.
- Scalar multi-choice, JSON as a user type and binary or asset fields other than
  media are deferred. A package file's content is a BLOB in protected metadata, not
  a user field.
- A single-choice field's options can grow: `schema.addChoice` appends one stable
  option, with a label and optional tone, under the rules of `schema.addField` and
  `schema.setChoiceMetadata` (an ID of at most 120 characters, new to the field; at
  most 32 options; a unique label of 1 to 200 characters, `label-conflict`). Its undo,
  the compensation-only `schema.removeChoice`, is refused while any record, or a
  deleted record kept for its undo, holds the option. Host 1.7.0, or 1.19.0 with a
  tone. See the [semantic-surfaces contract](../contracts/semantic-surfaces.md).

### Relationships

- Relationships use explicit relational metadata and foreign-key and join
  structures, never encoded scalar lists. See the
  [relationships contract](../contracts/relationships.md).
- The typed operation that configures a reference also creates one covering index,
  inside the same transaction and after the column exists:

  ```sql
  CREATE INDEX nendo_ref_<table>_<column> ON <table>(<column>, __nendo_record_id);
  ```

  The name is outside `__nendo_` on purpose: the protected schema signature is a
  fixed set of layouts, and the number of reference indexes varies. A missing index is
  not drift; the inverse read stays correct and gets slower. The host never creates
  it on open or as a repair. No other field kind gets an index, and there are no
  user-defined indexes.
- A filtered read keeps its host comparison function as the authority and adds,
  where SQLite answers the same way, a plain comparison an index can seek: `column =
  @value` for equality on text, a reference or a date, and `IS NULL` or `IS NOT NULL`.
  UUID equality and every other operator still scan.
- `schema.setReferenceLabel` points a bound, active reference at another active Text
  field of its target and moves no stored value. It refuses an unchanged label
  (`reference-label-unchanged`) and is reversible with retained state while it is the
  latest definition change. Host 1.51.0.

## Consequences

### Positive

- User data stays readable and queryable with standard SQLite tools.
- Display-name changes do not break semantic bindings.
- Typed services enforce history and compatibility independently of the UI.

### Negative

- Schema evolution needs deliberate DDL migration logic, versioned, deterministic and
  transactional.
- Protected metadata and user tables must stay transactionally consistent.
- Some dynamic low-code patterns are harder than with EAV or a document blob.

## Rejected alternatives

- Entity-attribute-value storage: weakens inspection, constraints, query planning
  and type clarity.
- One JSON application document: couples unrelated edits and invites whole-document
  replacement.

## Revisit triggers

- A required data shape cannot be represented without pathological relational
  complexity.
- Format migrations show that stable physical mappings are insufficient.
- A generated recovery view proves clear value without collision or migration debt.
