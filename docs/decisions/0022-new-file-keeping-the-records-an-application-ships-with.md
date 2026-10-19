# ADR-0022: Start a new file of the same application, keeping the records it ships with

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `NewFileTests`, `NewFileSurfaceTests`, `BatchWriteToolTests` and `NewFileArchiMeasurementTests`
- **Amends:** ADR-0010 (a third copy kind, New), ADR-0020 (a new file's sequences restart past what it keeps) and ADR-0021 (New folds every revision, with no kept window)
- **Depends on:** ADR-0003, ADR-0005, ADR-0006, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0021
- **Contract:** [relationships](../contracts/relationships.md#what-a-new-file-keeps), [Studio](../contracts/studio.md#what-a-new-file-keeps)

## Context

A file holds two kinds of records: those that are part of the application (Archi's 72 concept
types and nine top-level folders, a CRM's stages) and the person's work. Someone who wants to
start again wants the first without the second. Duplicate and Fork copy everything; deleting the
work in place costs an operation row per record, keeps every value in History, leaves each ID
reserved by its tombstone, and is refused wherever a reference still points. One record type can
hold both kinds, so the choice has to be per record and visible.

## Decision

### 1. Kept in new files

Every record is either **kept in new files** or **left out**.

- **A record type's default:** `schema.setKeptInNewFiles { entityId, kept }`, definition lane,
  authored in a change set. A type nobody has set leaves its records out.
- **A record's own mark:** `data.setKeptInNewFiles { entityId, recordId, kept }`, `kept` true,
  false, or null to follow the type. Data lane. It changes no value and no record version, so it
  fires no automatic action and never makes an edit stale. History names it ("Kept *Business* in
  new files"). A revision of record changes may hold marks and is undone as a whole: each mark
  goes back to the one before it, and a mark changed since refuses the undo.
- All three operations in this decision are `ReversibleWithRetainedState`.
- **A deleted record keeps its mark**, so restoring it finds the mark where it was.
- **Storage:** `__nendo_new_file_rule` (entity ID, record ID or empty for the default, kept) and
  `__nendo_new_file_label`, one new rung added by the first write of either (host 1.41.0). A file
  that never sets a mark keeps its layout.

### 2. Shown where data is shown

- **Studio** shows each type's default above its grid, with a button that prepares the change as
  a proposal, and an *In new files* column: *Kept* or *Left out* for a record's own mark, *Kept
  (type)* or *Left out (type)* for one that follows its type. Choosing in the cell sets or clears
  the mark.
- **MCP:** `describe` has a `newFile` section with each type's default and how many records say
  otherwise; a record read carries `keptInNewFiles` when the record has its own mark; the create
  tools and each `nendo.data.apply_writes` write take `keptInNewFiles` in the same revision; and
  `nendo.data.set_kept_in_new_files` sets or clears marks on several records of any types as one
  revision. All need Edit data.
- **Not in the semantic UI vocabulary.** A Use screen cannot show or filter on the mark.

### 3. A kept record's references point at kept records

Every reference a kept record holds, its hierarchy parent included, must point at a kept record.
It is not checked on each write, which would stop ordinary work. New's preview and New itself
check it, and New refuses as `new-file-reference-left-out`, naming each record, field and
target. New never clears a reference to make the rule hold. A declared link rule (ADR-0026) is
checked against the kept table too.

### 4. The application's name for a new file

`application.setNewFileLabel { label }`, definition lane, sets an optional singular noun of 1 to
40 characters on one line, for example *Archi model*. The File menu then offers **New Archi
model…**; without a label, **New empty copy…**.

### 5. Starting the new file

Only the person starts it, as for Duplicate and Fork: not an agent, a view or an automatic
action. A read-only source can be used; New needs no write authority over it.

1. **Preview.** Per record type, how many records are kept and left out; every reference that
   breaks section 3; and what the new file will not have: history, view state, waiting proposals
   and this device's approvals of automatic actions. A save dialog chooses the destination; an
   existing file is never overwritten. A repeated request in the same session answers with the
   file it made.
2. **Stage.** The host copies the source with SQLite's backup API into a stage in the
   destination folder (ADR-0011), reading the source under the write coordinator. The source is
   not changed.
3. **Remove**, as storage rather than operations: every left-out record, every tombstone, the
   marks of removed records, view state (`__nendo_extension_state`), and package content no current
   package file uses. Section 3 is checked again against the stage.
4. **Sequences** restart one past the highest kept value, or at their start (ADR-0020).
5. **Fold.** Every revision after Genesis folds into one checkpoint by ADR-0021's rules, with no
   kept window. The checkpoint says *Started from* the source's file name *at change sequence N*;
   its fold row names the source in place of a backup.
6. **Identity.** One `identity.transition` of the kind New: the application ID is kept and the
   instance ID is new. `irreversible-declared`.
7. **Activate.** The host vacuums the stage and inspects it as if opening it; the read-back must
   match the expected content. Activation rechecks the physical identity and bytes while holding a
   rename handle, moves the held file with writes and deletion excluded, never overwrites, and
   opens the new file in its own window.

**The new file keeps** the definition (record types, fields, rules, references, hierarchies,
screens, behaviour, packages and the content their current files use), the purpose and look, the
marks and the label, and the kept records with their values and versions. **It leaves** every
other record, every tombstone, view state, every revision's operations, waiting proposals and
every device-local approval.

This is not a reset (the open file never changes), not a template library (one application ships
one set of kept records), and not an import or merge.

### Archi

Concept type keeps its records by default; Specialization leaves them out. The nine top-level
folders are marked kept; Model is left out, and the workbench creates an empty Model in a file
that has none. `tools/Build-Archi.mjs` sets the default, the marks and the label *Archi model*.
**New Archi model…** makes a file with 81 records.

## Consequences

- A person starts a second model in one step, with no deletion, no reserved IDs and no history.
- What a new file keeps is a fact about each record, readable in Studio and MCP; with nothing
  marked, New gives the definition alone.
- Two places say whether a record is kept, the type and the record.
- The reference rule is found at New, not at each write; the preview shows it first.
- A new file's change sequence does not start at 1, and its checkpoint digests a history it does
  not hold. Kept records carry their current values, and a view starts without its view state.

## Rejected alternatives

- **A flag per record type only:** fails a type that holds both kinds.
- **Per-type filters evaluated at New:** a record's fate is computed, not visible.
- **A hidden flag chosen at each write:** nobody can see or undo it.
- **New implemented in a custom view:** a view cannot create a file, and in place New is deletion.
- **A template file beside the application:** drifts from the definition and is outside ADR-0011.
- **Resetting the open file:** rewrites the file and its history; a mistake loses the work.
- **Replaying the definition into an empty file:** the host has no whole-definition generator, and
  the new history would start with hundreds of operations.

## Revisit triggers

- A Use screen needs to show or filter on the mark.
- An agent or a view needs to start a new file.
- An application needs more than one set of starting records.
- People meet the reference rule often enough that it belongs on each write.
