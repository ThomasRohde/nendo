# Relationships and schema evolution contract

Reference fields, renames, deletion, retirement and reviewed backfill. Asserted by
`ReferenceTests.cs`, `SchemaRenameTests.cs`, `RecordDeletionTests.cs` and
`RetirementTests.cs` under `tests/Nendo.Engine.Tests/`.

## References and target labels

A reference field targets exactly one stable entity ID and one text field used
as its readable label. Its stored value is the target record ID, never the label.
Renaming the target type, label field or record label preserves the relationship.
Duplicate target labels are allowed; pickers disambiguate using record IDs.
Lookups are bounded queries. Missing or retired targets cannot be assigned.

Optional references allow null. Required references never allow null. Adding a
required reference to populated data requires an explicit reviewed backfill in
the same proposal; no guessed target or implicit default is allowed. Assignment
checks the expected source version and the selected target version atomically.
Wrong-entity IDs, nonexistent targets and stale source/target versions fail.

Deleting a target with incoming live references is rejected, including optional
references. The user first explicitly reassigns them or clears optional ones.
There is no cascade. Self-references follow the same rule; clear/reassign before
deleting. Required cycles must be repaired through an explicit reviewed schema
and data change, not an implicit deletion side effect.

## Labels, choices and retirement

Entity and field renames change display labels only, keep stable IDs and physical
storage mappings, and require the current definition revision. Labels are unique
within their existing scope under the same comparison as creation. Collisions
are rejected. Choice options have stable IDs separate from display labels;
record values and board groups bind IDs. Renaming a choice preserves values and
bindings. Labels remain unique within the field. An option may also carry a `tone` from the closed set the
[semantic surfaces contract](semantic-surfaces.md#colour-on-a-choice-option) describes; it travels
with the label and availability, and compensation restores all three. Retired choices remain readable
on existing records but cannot be newly assigned.

Field/type retirement is reversible metadata, not physical data removal. Retired
data remains available through an explicit Studio view and faithful export.
Retired definitions reject new writes; custom surfaces cannot silently bind them.
A proposal retiring a bound field/type must also remove or replace its bindings.
Retiring a referenced target type is rejected while live incoming references
remain. No hard field/type drop is included in this MVP.

## Record deletion and compensation

Record deletion is an explicit data operation with an expected record version.
It removes the active record and retains its values, entity and version in the
revision evidence; its ID remains reserved. Compensation restores that ID only
if it is still deleted, its schema still supports the retained values and all
references remain valid. Restoration advances the version rather than reusing
the old one. Later edits, invalid targets or incompatible schema cause an
explicit conflict; compensation never overwrites another record.

Reference assignments and label changes are reversible with retained state,
subject to current-state checks. Retirement is similarly reversible unless
intervening definitions prevent restoration. Adding schema remains explicitly
irreversible as in the current operation model. Proposal promotion replays these
same typed operations and preconditions; it never replaces the active file.

## Compatibility and adapters

Protected reference, stable-choice and retirement metadata requires a new
minimum host version and explicit format qualification. Existing scalar files
open without rewriting. Existing choice strings retain their values as stable
IDs with initially identical labels when an explicit evolution operation adds
choice metadata. A legacy Reference field without target metadata is not guessed
into a valid relationship; explicit reviewed conversion is required.

### Explicit legacy conversion (September 8 closure implementation)

Conversion uses a dedicated two-mutation proposal. `data.convertLegacyReference`
maps every source record, including nulls, using explicit record IDs and current
source/target versions. `schema.configureReference` then receives the same
`reviewedRecords` with the resulting source versions and binds the chosen target
entity/text label. Self-reference target versions advance with their sources.
Both mutations replay within the existing single promotion transaction; data and
definition revisions remain distinct. Standalone conversion mutations and partial
conversion proposals are rejected.

Each row contains `recordId`, `expectedRecordVersion`, `targetRecordId` and
`expectedTargetRecordVersion`. A null target explicitly clears an optional value;
required references cannot be cleared. Every existing source row must be covered,
and the bound values must exactly match the reviewed mapping. Insertions,
deletions, stale versions, invalid/retired targets and changed definitions cause
refusal without partial active changes. All targets are checked before any source
version advances, including self-references and cycles.

The bound is 100 source records per atomic conversion, within existing proposal
and transport byte limits. Larger conversions are explicitly refused; no partial
batch conversion is offered. Conversion is `irreversible-declared`, with original
values retained in operation evidence. Existing configure operations retain their
canonical bytes. New conversion history and reviewed binding require host 1.10.0;
ordinary old-file open remains unchanged. Studio uses the existing Structure,
target picker and proposal review surfaces; MCP exposes the same canonical types.

Every operation travels through the same application service from Studio and
closed MCP tools. Required evidence includes old-host refusal without source
changes, old-file unchanged open, two-entity assignment, protected deletion,
stale source/target, label collisions, retirement, compensation conflicts,
proposal reject/replay/stale acceptance and exact reopen.
