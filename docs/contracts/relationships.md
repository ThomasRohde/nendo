# Relationships and schema evolution contract

This contract covers reference fields, renames, deletion, retirement, reviewed
backfill, declared hierarchies and unique fields. `ReferenceTests.cs`,
`SchemaRenameTests.cs`, `RecordDeletionTests.cs`, `RetirementTests.cs`,
`HierarchyTests.cs` and `FieldUniqueTests.cs` under `tests/Nendo.Engine.Tests/`
assert it.

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

## A declared hierarchy

A self-reference is an ordinary reference until the record type declares it as its
hierarchy with `schema.declareHierarchy { entityId, parentFieldId, orderFieldId? }`
([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)). The parent field must be an
optional reference configured to the same record type; the order field, if named, an
Integer field of it. A record type has at most one hierarchy. The declaration is stored in
`__nendo_hierarchy`, the last rung of the layout ladder, and a file that carries one needs
host 1.35.0.

- **Declaring checks the data.** Every record must be reachable from a top-level record
  within 32 levels. A record on a loop, including one that is its own parent, is refused as
  `hierarchy-cycle-present` with each loop written out (`a → c → b → a`); a branch deeper
  than 32 as `hierarchy-too-deep`. Nothing is repaired, and the file is unchanged.
- **Every parent write obeys the rule.** Once declared, a create, a field write, a form
  save, an import, a command step or an automatic action that would put a record under
  itself or one of its descendants is refused as `hierarchy-cycle`, naming the chain it
  would close; one that would put anything deeper than 32 levels as `hierarchy-too-deep`.
  The check walks up from the proposed parent inside the write's transaction.
- **The fields stay ordinary.** The parent and order are columns that the table, CSV and
  every read show as they are. While declared, the parent cannot be made required
  (`hierarchy-parent-required`), and neither field nor the record type can be retired
  (`hierarchy-field-in-use`). `schema.removeHierarchy` lifts the rule and keeps every value.
- **A move** (`nendo.data.move_record`, `NendoApplicationService.MoveRecordAsync`) sets
  the parent and, with an order field, places the record before a named sibling or last.
  It expands into `data.setField` operations in one revision: the parent, the order, and,
  when no integer gap or representable first/last placement remains, every sibling renumbered in steps of
  1,024, each against the version the move read. Each operation keeps its prior value;
  the revision is undone by compensating its operations, since the one-click
  compensation covers supported retained operations, up to 128. Placement arithmetic covers the
  full signed Int64 range without wrapping. The fresh result includes action
  writeback to the moved record; exact retries bind the original request terms
  and replay its historical revision, version and touched IDs before reading
  current geometry ([operation outcomes](operation-outcomes.md)).

**Reading the tree.** A tree read returns the hierarchy depth-first, siblings in order,
each record with its parent, depth and child count ([queries](queries.md)); a view reads it
with `records.tree` and an agent with `nendo://application/entity/{entityId}/tree`. The
`descendantOf` filter on the parent field reads a record's whole subtree in any query,
count or aggregate.

Declaring and removing are definition-lane operations of class
`ReversibleWithRetainedState`, and each compensates the other. A record with children is
still refused deletion as `record-referenced`.

## Unique fields

A field can be declared unique with `schema.setFieldUnique { entityId, fieldId, unique }`
([ADR-0020](../decisions/0020-unique-and-generated-fields.md)). Only an active single-line
Text field (not a single choice, not long text) or a plain Integer field can be unique;
anything else is `field-unique-invalid`. Text compares case-insensitively for ASCII letters,
so `w-001` collides with `W-001`; an empty value never collides. The rule is stored in
`__nendo_field_rule`, the last rung of the layout ladder, and a file that carries one needs
host 1.37.0.

- **Declaring checks the data.** Records that already share a value are refused as
  `field-values-not-unique`, naming the records group by group (the first 20 groups) and
  never the values. Nothing is renumbered.
- **Every write.** Once declared, a create, set field, form save, batch create, import,
  command step, automatic action, custom-view write or agent write that would give a record
  a value another record holds is refused as `value-not-unique`, naming the record that holds
  it. A record keeps its own value on every later save. A unique partial index on the column
  (`nendo_unique_<table>_<column>`, outside the protected namespace) stops a write even on a
  path that did not check.
- The schema read (`unique` on each field, in the Studio snapshot, MCP and the view API)
  says which fields carry the rule.

Declaring and removing are definition-lane operations of class
`ReversibleWithRetainedState`; removing leaves every value, and compensating a removal over
new duplicates is refused like declaring. A field with a sequence cannot stop being unique
(`field-sequence-in-use`).

**Numbered fields.** `schema.setFieldSequence { entityId, fieldId, prefix, width }` gives a
unique Text field a sequence: a create that leaves the field empty (or empty text) gets
`prefix` and the next number, zero-padded to `width` digits (`W-` and 3 give `W-001`), inside
the same write. Anything else is `field-sequence-invalid`; a prefix is 1 to 16 characters with
no spaces and no final digit, and a width 1 to 9.

- The next number is one past the highest ever seen: values of that shape already stored (the
  prefix ignoring ASCII case, then only digits) set it on declaration, a code a client writes
  itself raises it, and it is never lowered, so a deleted record's number stays spent. The
  counter is stored with the rule and survives a reopen.
- History records the create with the code in it, and a restored record gets its own code
  back, never a new one.
- A numbered field may be required: the code is written before the required check.
- The write result's `assigned` (`AssignedValues` in the Engine) names each code the host wrote.
- `prefix` and `width` null remove the sequence and leave every code. Compensating a removal
  puts the sequence back no lower than the number it had reached.

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
replace its bindings (`retired-binding`). This covers behaviour as well as
screens: a calculation or trigger condition that reads the field, a trigger on the
record type, and an automatic action that writes the field or a record of the type
all count as bindings. The check runs over the final candidate, so one proposal
may rewire or remove that behaviour and retire its target in either order. While live incoming references remain, the retirement of
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

## What a new file keeps

[ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md);
`NewFileTests.cs` asserts it.

- A record type's default, `schema.setKeptInNewFiles` `{entityId, kept}`, is definition:
  authored in a change set, reversed from History while it is the latest definition change.
  A type nobody set leaves its records out.
- A record's own mark, `data.setKeptInNewFiles` `{entityId, recordId, kept}`, is true, false or
  null to follow its type. It is data, but no value: no field or record version changes and no
  automatic action runs. Compensation puts the previous mark back, and is refused when the
  mark changed since. Repeating the current mark is refused as `kept-in-new-files-unchanged`.
- A deleted record keeps its mark, since its ID stays reserved; a restore finds it.
- `application.setNewFileLabel` `{label}` names one new file, 1 to 40 characters on one line.
- A kept record may point only at kept records, its hierarchy parent included. The rule is
  checked when a new file is previewed and made, not on each write: New is refused as
  `new-file-reference-left-out`, naming a record, field and target, and nothing is cleared.
- The new file holds the definition, the kept records with their values, versions and marks,
  and history of Genesis, one checkpoint and one New transition. Tombstones and view state are
  not carried, so every ID is free again, and each sequence restarts one past the highest value
  kept (the one place a sequence goes down). Package content no current file uses is dropped:
  with the history folded, nothing could restore it.

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
