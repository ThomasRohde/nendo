# Relationships and schema evolution contract

This contract covers reference fields, renames, deletion, retirement and reviewed
backfill. `ReferenceTests.cs`, `SchemaRenameTests.cs`, `RecordDeletionTests.cs`
and `RetirementTests.cs` under `tests/Nendo.Engine.Tests/` assert it.

## References and target labels

A reference field targets exactly one stable entity ID and one text field that
gives its readable label. Its stored value is the target record ID, never the
label. A rename of the target type, the label field or the record label keeps
the relationship. Duplicate target labels are allowed. Pickers use record IDs to
disambiguate them. Lookups are bounded queries. Missing or retired targets
cannot be assigned.

Optional references allow null. Required references never allow null. To add a
required reference to populated data, the same proposal must contain an explicit
reviewed backfill. A guessed target or an implicit default is not allowed.
Assignment checks the expected source version and the selected target version
atomically. Wrong-entity IDs, nonexistent targets and stale source/target
versions fail.

If a target has incoming live references, its deletion is rejected. This
includes optional references. The user first reassigns them explicitly or
clears the optional ones. There is no cascade. Self-references follow the same
rule: clear or reassign them before the deletion. Required cycles must be
repaired through an explicit reviewed schema and data change. An implicit
deletion side effect must not repair them.

## Labels, choices and retirement

Entity and field renames change display labels only. They keep stable IDs and
physical storage mappings, and they require the current definition revision.
Labels are unique within their existing scope, under the same comparison as
creation. Collisions are rejected. Choice options have stable IDs that are
separate from display labels. Record values and board groups bind IDs.

A choice rename keeps values and bindings. Labels stay unique within the field.
An option can also carry a `tone` from the closed set that the
[semantic surfaces contract](semantic-surfaces.md#colour-on-a-choice-option)
describes. The tone moves with the label and the availability, and compensation
restores all three. Retired choices stay readable on existing records, but they
cannot be newly assigned.

Field/type retirement is reversible metadata. It does not remove physical data.
Retired data stays available through an explicit Studio view and faithful
export. Retired definitions reject new writes. Custom surfaces cannot silently
bind them. A proposal that retires a bound field/type must also remove or
replace its bindings. While live incoming references remain, the retirement of
a referenced target type is rejected. This MVP includes no hard field/type drop.

## Record deletion and compensation

Record deletion is an explicit data operation with an expected record version.
It removes the active record and keeps its values, entity and version in the
revision evidence. Its ID stays reserved. Compensation restores that ID only if
all of these conditions are true:

- the record is still deleted;
- its schema still supports the retained values;
- all references stay valid.

Restoration advances the version. It does not reuse the old version. Later
edits, invalid targets or an incompatible schema cause an explicit conflict.
Compensation never overwrites another record.

Reference assignments and label changes are reversible with retained state,
subject to current-state checks. Retirement is also reversible, unless
definitions that came after it prevent restoration. Adding schema stays
explicitly irreversible, as in the current operation model. Proposal promotion
replays these same typed operations and preconditions. It never replaces the
active file.

## Compatibility and adapters

Protected reference, stable-choice and retirement metadata requires a new
minimum host version and explicit format qualification. Existing scalar files
open without a rewrite. When an explicit evolution operation adds choice
metadata, existing choice strings keep their values as stable IDs, with labels
that are identical at first. Nendo does not guess a legacy Reference field
without target metadata into a valid relationship. An explicit reviewed
conversion is required.

### Explicit legacy conversion (September 8 closure implementation)

Conversion uses a dedicated two-mutation proposal:

1. `data.convertLegacyReference` maps every source record, including nulls. It
   uses explicit record IDs and current source/target versions.
2. `schema.configureReference` then receives the same `reviewedRecords` with the
   resulting source versions. It binds the chosen target entity/text label.

Self-reference target versions advance with their sources. Both mutations replay
within the existing single promotion transaction. Data and definition revisions
stay distinct. Standalone conversion mutations and partial conversion proposals
are rejected.

Each row contains `recordId`, `expectedRecordVersion`, `targetRecordId` and
`expectedTargetRecordVersion`. A null target explicitly clears an optional
value. Required references cannot be cleared. The rows must cover every existing
source row, and the bound values must exactly match the reviewed mapping.
Insertions, deletions, stale versions, invalid/retired targets and changed
definitions cause refusal without partial active changes. Nendo checks all
targets before any source version advances, including self-references and
cycles.

The bound is 100 source records per atomic conversion, within the existing
proposal and transport byte limits. Nendo explicitly refuses larger conversions.
It offers no partial batch conversion. Conversion is `irreversible-declared`,
and operation evidence keeps the original values. Existing configure operations
keep their canonical bytes. New conversion history and reviewed binding require
host 1.10.0. Ordinary old-file open stays unchanged. Studio uses the existing
Structure, target picker and proposal review surfaces. MCP exposes the same
canonical types.

Every operation from Studio and from closed MCP tools goes through the same
application service. The required evidence includes:

- old-host refusal without source changes;
- old-file unchanged open;
- two-entity assignment;
- protected deletion;
- stale source/target;
- label collisions;
- retirement;
- compensation conflicts;
- proposal reject/replay/stale acceptance;
- exact reopen.
