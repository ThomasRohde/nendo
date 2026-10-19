# ADR-0020: Unique and generated fields

- **Status:** Accepted
- **Date:** 2026-09-27
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `FieldUniqueTests`, `FieldSequenceTests`, `HierarchyPathTests`, `FieldUniqueProtocolTests` and `DesktopUniqueRefusalTests`
- **Amends:** ADR-0008 (a `HierarchyPath` calculation binding)
- **Depends on:** ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0012, ADR-0019
- **Contract:** [relationships](../contracts/relationships.md#unique-fields), [CSV](../contracts/csv.md)

## Context

People name records by short codes (`W-001`, `CAP-1.2.3`). To the host such a code is ordinary
text: without a rule nothing stops two records carrying the same one, and every client has to
scan the type to find the next. Clients that follow a scanning procedure still produce
duplicates, because none of them sees the others' drafts. Only the Engine, which every write
passes through one transaction at a time, can refuse a duplicate and hand out a number.

## Decision

1. **Unique.** `schema.setFieldUnique { entityId, fieldId, unique }` on an active single-line
   Text field (not a single choice, not long text) or Integer field; anything else is
   `field-unique-invalid`. Text compares case-insensitively for ASCII letters (`w-001` collides
   with `W-001`) and exactly otherwise. An empty value never collides. Definition lane,
   `ReversibleWithRetainedState`; removing keeps every value.
2. **Declaring checks the data.** Collisions fail validation as `field-values-not-unique`,
   naming the records group by group (the first 20 groups). Nothing is renumbered.
3. **The rule.** Every write that sets the field (create, set field, form save, batch, import,
   command step, automatic action, custom view, agent) is refused as `value-not-unique` when
   another record holds the value. The check sits in the store's create and field-write hooks. A
   unique partial index (`nendo_unique_<table>_<column>`, outside the protected namespace) is the
   backstop; when that name belongs to another table, the field ID's digest is added as a
   suffix, and a field drops only its own table's index.
4. **Refusals name records, never values.** The refusal carries the holder's record ID
   (`NendoPreconditionException.RecordId`, the bridge's `error.recordId`); the Workbench shows
   the holder's label in its place. MCP's sentence carries no stored value.
5. **Sequences.** `schema.setFieldSequence { entityId, fieldId, prefix, width }` on a unique Text
   field: `prefix` 1 to 16 characters, no spaces and not ending in a digit; `width` 1 to 9
   digits, zero-padded, never truncated (`field-sequence-invalid` otherwise). A create that leaves
   the field empty gets `prefix` and the next number inside the same transaction. The next number
   is one past the highest ever seen: set on declaration from stored values of that shape and the
   codes deleted records keep in deletion history, raised by any code of that shape a client
   writes, and never lowered, so a deleted record's number stays spent. History records the
   create with its code, and a restored record keeps its own. A numbered field may be required:
   the code is written before the required check. The write result's `assigned`
   (`NendoApplyResult.AssignedValues`) names each code the host wrote. Null `prefix` and `width`
   remove the sequence and keep every code; compensating a removal never puts the counter below
   where it was (`minimumNext`). A numbered field cannot stop being unique
   (`field-sequence-in-use`). `ReversibleWithRetainedState`.
6. **A new file numbers again.** A new file of the application (ADR-0022) restarts each sequence
   one past the highest value its kept records hold, or at 1. It is the one place a sequence goes
   down: the new file holds none of the records the higher numbers named.
7. **Paths are calculated, not stored.** ADR-0008's `HierarchyPath` binding, on a record type
   with a declared hierarchy, gives the record's 1-based position among its siblings and each
   ancestor's, joined with dots (`1.2.3`), with an optional literal `prefix` (`CAP-1.2.3`).
   Siblings count in the tree read's order. It changes when a record moves, so it is never stored
   and never a unique identity; a code people repeat next week is a sequence. `prefix` enters the
   canonical body only when set. A path holds the hierarchy in place (`hierarchy-field-in-use`).
8. **Storage.** One protected table, `__nendo_field_rule` (entity, field, unique, prefix, width,
   high-water mark), the layout ladder's `-rule-` rung (host 1.37.0). A file that declares neither
   keeps its layout and minimum host.
9. **Where it shows.** The schema read (MCP describe, the view API's `schema.describe`, Studio)
   carries `unique` and `sequence { prefix, width }`. Studio's Structure offers **Make unique**,
   **Allow duplicates**, **Number automatically** and **Stop numbering** as reviewed proposals. A
   form leaves a numbered field empty on a new record and says *Assigned when saved*. MCP's create
   tools accept a create without the code and return the one assigned.
10. **Import by code.** A CSV mapping for a reference column may name a *match field*, a unique
    field of the target type (`matchFieldId` on `nendo.data.import_records`). A cell names a row
    of the same import first, then a record of the file, compared as uniqueness compares. The
    import refuses, by row: a code that names nothing, a code on two rows, a code naming both an
    import row and a different file record, and a match field that is not unique. When a declared
    hierarchy's parent is matched by codes the import carries, rows are ordered parents first, each
    keeping its line number; loops are refused. What commits is the resolved record IDs through
    `data.createRecord`. Labels are never matched: they may repeat.

## Consequences

- A client creates a numbered record without reading every record of the type, and duplicates
  stop at the Engine, whoever writes them.
- Display codes such as `CAP-1.2.3` come from the tree.
- A new refusal on every write path, one index per unique field, and a ladder rung.
- A path code is not an identity, and people will be tempted to use it as one.

## Rejected alternatives

- **A generated reference field kind:** cannot adopt an existing Text field; Nendo has no kind change.
- **Client conventions and a next-code helper:** cannot stop Studio, an import or a second agent.
- **Stored path codes:** every move would rewrite a subtree of codes.
- **Unicode case folding:** SQLite's `NOCASE` folds ASCII only; full folding needs a collation the
  file cannot carry.

## Revisit triggers

- A code format a prefix and a number cannot express (a year, a per-parent sequence).
- Uniqueness across two fields, or across record types.
- The index cost becomes visible on large imports.
