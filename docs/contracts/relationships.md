# Relationships and schema evolution contract

Reference fields, renames, deletion, retirement, reviewed backfill, declared
hierarchies, unique fields, allowed links and what a new file keeps. `ReferenceTests`,
`ReferenceLabelTests`, `SchemaRenameTests`, `RecordDeletionTests`, `RetirementTests`,
`HierarchyTests`, `FieldUniqueTests` and `NewFileTests` under
`tests/Nendo.Engine.Tests/` assert it.

## References and target labels

A reference field targets exactly one stable entity ID and one text field that gives
its readable label. Its stored value is the target record ID, never the label. A
rename of the target type, the label field or the record label keeps the
relationship. Duplicate target labels are allowed; pickers use record IDs to tell
them apart. Lookups are bounded queries. Missing or retired targets cannot be
assigned.

While an active bound reference on an active record type shows a target type by a
field, that field cannot be retired (`reference-label-in-use`); a retired reference,
or one on a retired record type, does not hold it. To retire a label field, change
the label first:

- `schema.setReferenceLabel` `{entityId, fieldId, labelFieldId,
  expectedDefinitionRevision}` points a bound, active reference at another active
  Text field of its target, by the rule `schema.configureReference` applies. Every
  read, reference column, picker and board grouped by it shows the new label. No
  stored value or record version moves.
- It refuses an unbound reference (`reference-unbound`), a retired one
  (`field-retired`), a label that is not an active Text field of the target, an
  unchanged label (`reference-label-unchanged`) and a stale definition revision. It
  states host 1.51.0.

Optional references allow null; required references never do. Adding a required
reference to populated data needs an explicit reviewed backfill in the same proposal,
never a guessed target or implicit default. Assignment checks the expected source
version and the selected target version atomically. Wrong-entity IDs, nonexistent
targets and stale source or target versions fail.

A target with incoming live references, optional ones included, cannot be deleted.
The user first reassigns them or clears the optional ones. There is no cascade.
Self-references follow the same rule. Required cycles are repaired through an
explicit reviewed schema and data change, never by a deletion side effect.

## A declared hierarchy

A self-reference is an ordinary reference until the record type declares it as its
hierarchy with `schema.declareHierarchy { entityId, parentFieldId, orderFieldId? }`
([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)). The parent field must be
an optional reference configured to the same record type; the order field, if named,
an Integer field of it. A record type has at most one hierarchy. The declaration is
stored in `__nendo_hierarchy`, the layout ladder's `-hierarchy-` rung after the
package tables, and a file that carries one needs host 1.35.0.

- **Declaring checks the data.** Every record must be reachable from a top-level
  record within 32 levels. A record on a loop, including one that is its own parent,
  is refused as `hierarchy-cycle-present` with each loop written out (`a → c → b →
  a`); a branch deeper than 32 as `hierarchy-too-deep`. Nothing is repaired.
- **Every parent write obeys the rule.** A create, field write, form save, import,
  command step or automatic action that would put a record under itself or a
  descendant is refused as `hierarchy-cycle`, naming the chain it would close; one
  that would go deeper than 32 levels as `hierarchy-too-deep`. The check walks up
  from the proposed parent inside the write's transaction.
- **The fields stay ordinary.** Parent and order are columns that the table, CSV and
  every read show as they are. While declared, the parent cannot be made required
  (`hierarchy-parent-required`), and neither field nor the record type can be
  retired (`hierarchy-field-in-use`). `schema.removeHierarchy` lifts the rule and
  keeps every value.
- **A move** (`nendo.data.move_record`, `NendoApplicationService.MoveRecordAsync`)
  sets the parent and, with an order field, places the record before a named sibling
  or last. It expands into `data.setField` operations in one revision: the parent,
  the order and, when no integer gap or representable first or last placement
  remains, the smallest run of siblings around the insertion point that fits between
  its ordered neighbours, renumbered, a sibling without an order joining that run,
  each against the version the move read. Placement arithmetic covers the full
  signed Int64 range without wrapping. Each operation keeps its prior value, and the
  revision is undone by compensating its operations; one-click compensation covers a
  revision of record changes of up to 12,800 operations. The fresh result includes
  action writeback to the moved record. An exact retry binds the original request
  terms and replays its historical revision, version and touched IDs before reading
  current geometry ([operation outcomes](operation-outcomes.md)).

**Reading the tree.** A tree read returns the hierarchy depth-first, siblings in
order, each record with its parent, depth and child count ([queries](queries.md#tree-read));
a view reads it with `records.tree` and an agent with
`nendo://application/entity/{entityId}/tree`. The `descendantOf` filter on the parent
field reads a record's whole subtree in any query, count or aggregate. Neither refuses
a large tree: the tree read pages by key, and `descendantOf` walks the subtree once
per statement. Only a subtree aggregate keeps a bound,
`limits.hierarchy.maximumAggregatedDescendants` (10,000), because it runs for every
record a read returns.

Declaring and removing are definition-lane operations of class
`ReversibleWithRetainedState`, each compensating the other. A record with children is
refused deletion as `record-referenced`.

## Unique fields

`schema.setFieldUnique { entityId, fieldId, unique }`
([ADR-0020](../decisions/0020-unique-and-generated-fields.md)) declares a field unique.
Only an active single-line Text field (not a single choice, not long text) or a plain
Integer field can be; anything else is `field-unique-invalid`. Text compares
case-insensitively for ASCII letters, so `w-001` collides with `W-001`; an empty value
never collides. The rule is stored in `__nendo_field_rule`, the layout ladder's
`-rule-` rung after the hierarchy table, and a file that carries one needs host
1.37.0.

- **Declaring checks the data.** Records that already share a value are refused as
  `field-values-not-unique`, naming the records group by group (the first 20 groups),
  never the values. Nothing is renumbered.
- **Every write.** A create, set field, form save, batch create, import, command
  step, automatic action, custom-view write or agent write that would give a record a
  value another record holds is refused as `value-not-unique`, naming the record that
  holds it. A record keeps its own value on every later save. A unique partial index
  on the column (`nendo_unique_<table>_<column>`, outside the protected namespace)
  stops a write even on a path that did not check.
- The schema read (`unique` on each field, in the Studio snapshot, MCP and the view
  API) says which fields carry the rule.

Declaring and removing are definition-lane operations of class
`ReversibleWithRetainedState`. Removing leaves every value; compensating a removal
over new duplicates is refused like declaring. A field with a sequence cannot stop
being unique (`field-sequence-in-use`).

**Numbered fields.** `schema.setFieldSequence { entityId, fieldId, prefix, width }`
gives a unique Text field a sequence: a create that leaves the field empty (or empty
text) gets `prefix` and the next number, zero-padded to `width` digits (`W-` and 3
give `W-001`), inside the same write. A prefix is 1 to 16 characters with no spaces
and no final digit, and a width 1 to 9; anything else is `field-sequence-invalid`.

- The next number is one past the highest ever seen. Values of that shape already
  stored (the prefix ignoring ASCII case, then only digits) set it on declaration,
  including the codes deleted records keep in deletion history; a code a client
  writes itself raises it; it is never lowered, so a deleted record's number stays
  spent. The counter is stored with the rule and survives a reopen.
- History records the create with the code in it, and a restored record gets its own
  code back.
- A numbered field may be required: the code is written before the required check.
- The write result's `assigned` (`AssignedValues` in the Engine) names each code the
  host wrote.
- `prefix` and `width` null remove the sequence and leave every code. Compensating a
  removal puts the sequence back no lower than the number it had reached.

## Allowed links

A record type whose records join two others can say which links it allows
([ADR-0026](../decisions/0026-allowed-links.md)) with `schema.declareLinkRule {
entityId, sourceFieldId, targetFieldId, kindFieldId, sourceKindFieldId,
targetKindFieldId, tableEntityId, tableSourceFieldId, tableTargetFieldId,
tableKindFieldId }`. Source and target are configured references of the link type,
and the kind a field of it; each end's kind is a field of the record type that end
points at. The table is another record type whose three fields hold allowed
combinations of source kind, target kind and link kind. Each table field is the same
kind of field as the one it stands for: a reference to the same record type, or
single-line Text. Anything else is `link-rule-invalid`, naming the field. One rule per
link type (`link-rule-already-declared`). It is stored in `__nendo_link_rule`, the
layout ladder's `-linkrule-` rung after the skill table, and a file that carries one
needs host 1.45.0.

- **What is checked.** A link whose source, target and kind are all set is allowed
  when a table record holds its source's kind, its target's kind and its kind,
  compared exactly as stored. An end with no kind, or empty text as its kind, matches
  no row. A link missing its source, target or kind is not checked.
- **Declaring checks the data.** Links that are not allowed are refused as
  `links-not-allowed`, naming the first 20 and how many there are. A declaration in
  the same change as its table type or an endpoint's kind field is checked once that
  change has made them.
- **At the end of every mutation**, after its operations and automatic actions and
  before the revision is recorded, a mutation that leaves a link not allowed is
  refused whole as `link-not-allowed`. That covers a link created, restored, or given
  a new source, target or kind; a link whose end was given a new kind; and every
  link, when a table record is changed or deleted. A batch may pass through a link
  that is not allowed on its way to one that is. The refusal names the link and, for
  a reference kind, the three kind records by ID; a text kind is named by its field.
- **In use.** While declared, the four record types and ten fields the rule reads
  cannot be retired or shown another way (`link-rule-field-in-use`). Renaming is
  allowed.
- **New files.** A new file of the application refuses with `links-not-allowed` when
  a kept link would not be allowed by the kept table.
- An index on the table's three columns (`nendo_link_<table>`, outside the protected
  namespace) makes each check one lookup. The schema read carries `linkRule`, with
  the ten IDs, on the link type (Studio snapshot, MCP and the view API's
  `schema.describe`); Studio's Structure names the rule on the link type and on its
  table.

Declaring and `schema.removeLinkRule { entityId }` are definition-lane operations of
class `ReversibleWithRetainedState`, each the other's inverse. Removing keeps every
record; compensating a removal over links the rule would not allow is refused like
declaring.

## Labels, choices and retirement

Entity and field renames change display labels only. They keep stable IDs and
physical storage mappings, and require the current definition revision. Labels are
unique within their scope, under the same comparison as creation; collisions are
rejected. Choice options have stable IDs separate from their labels, and record
values and board groups bind IDs.

A choice rename keeps values and bindings; labels stay unique within the field. An
option can carry a `tone` from the closed set in the
[semantic surfaces contract](semantic-surfaces.md#colour-on-a-choice-option). The tone
moves with the label and the availability, and compensation restores all three.
Retired choices stay readable on existing records but cannot be newly assigned.

Field and type retirement is reversible metadata and removes no physical data.
Retired data stays available through an explicit Studio view and faithful export.
Retired definitions reject new writes, and custom surfaces cannot silently bind them.
A proposal that retires a bound field or type must also remove or replace its
bindings (`retired-binding`). Behaviour counts as well as screens: a calculation or
trigger condition that reads the field, a trigger on the record type, and an
automatic action that writes the field or a record of the type are all bindings. The
check runs over the final candidate, so one proposal may rewire or remove that
behaviour and retire its target in either order. Retiring a target type with live
incoming references is rejected. There is no hard field or type drop.

## Record deletion and compensation

Record deletion is an explicit data operation with an expected record version. It
removes the active record and keeps its values, entity and version in the revision
evidence. Its ID stays reserved. Compensation restores that ID only while:

- the record is still deleted;
- its schema still supports the retained values;
- all references stay valid.

Restoration advances the version; it does not reuse the old one. Later edits,
invalid targets or an incompatible schema cause an explicit conflict. Compensation
never overwrites another record.

Reference assignments and label changes are reversible with retained state, subject
to current-state checks; a `schema.setReferenceLabel`'s undo sets the previous label
back while it is the latest definition change. Retirement is reversible unless later
definitions prevent restoration. Adding schema is declared irreversible. Proposal
promotion replays these same typed operations and preconditions and never replaces
the active file.

## What a new file keeps

[ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md).

- A record type's default, `schema.setKeptInNewFiles` `{entityId, kept}`, is
  definition: authored in a change set, reversed from History while it is the latest
  definition change. A type nobody set leaves its records out.
- A record's own mark, `data.setKeptInNewFiles` `{entityId, recordId, kept}`, is
  true, false or null to follow its type. It is data but no value: no field or record
  version changes and no automatic action runs. Compensation puts the previous mark
  back, and is refused when the mark changed since. Repeating the current mark is
  refused as `kept-in-new-files-unchanged`.
- One call marks up to 200 records of any types as one revision
  (`SetRecordsKeptInNewFilesAsync`), and a record write batch may set a created or
  updated record's mark in its own revision (`NendoRecordWrite.KeptInNewFiles`; a
  delete carries none). Either revision is undone whole, marks with the record
  writes, and is refused when any of its marks changed since (`BatchWriteToolTests`).
- A deleted record keeps its mark, since its ID stays reserved; a restore finds it.
- `application.setNewFileLabel` `{label}` names one new file, 1 to 40 characters on
  one line.
- A kept record may point only at kept records, its hierarchy parent included. This
  is checked when a new file is previewed and made, not on each write: New is refused
  as `new-file-reference-left-out`, naming a record, field and target, and nothing is
  cleared.
- The new file holds the definition, the kept records with their values, versions
  and marks, and a history of Genesis, one checkpoint and one New transition.
  Tombstones and view state are not carried, so every ID is free again, and each
  sequence restarts one past the highest value kept (the one place a sequence goes
  down). Package content no current file uses is dropped.

## Compatibility and legacy conversion

Protected reference, stable-choice and retirement metadata require a minimum host
version. Existing scalar files open without a rewrite. When an explicit evolution
operation adds choice metadata, existing choice strings keep their values as stable
IDs, with identical labels at first. A Reference field without target metadata is
never guessed into a relationship; it needs an explicit reviewed conversion, a
dedicated two-mutation proposal:

1. `data.convertLegacyReference` maps every source record, nulls included, with
   explicit record IDs and current source and target versions.
2. `schema.configureReference` receives the same `reviewedRecords` with the resulting
   source versions and binds the chosen target entity and text label.

Each row holds `recordId`, `expectedRecordVersion`, `targetRecordId` and
`expectedTargetRecordVersion`. A null target clears an optional value; required
references cannot be cleared. The rows cover every existing source row, and the bound
values match the reviewed mapping exactly. Self-reference target versions advance
with their sources. Both mutations replay in one promotion transaction, and data and
definition revisions stay distinct. Standalone conversion mutations, partial
proposals, insertions, deletions, stale versions, invalid or retired targets and
changed definitions are refused with no partial change; every target is checked
before any source version advances, self-references and cycles included.

At most 100 source records convert at once, within the proposal and transport byte
limits; larger conversions are refused, with no partial batch. Conversion is
`irreversibleDeclared`, and its evidence keeps the original values. Conversion
history and reviewed binding need host 1.10.0; existing configure operations keep
their canonical bytes. Studio uses Structure, the target picker and proposal review;
MCP exposes the same canonical types through the same application service.
