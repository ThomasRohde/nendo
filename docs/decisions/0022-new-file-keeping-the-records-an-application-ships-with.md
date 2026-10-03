# ADR-0022: Start a new file of the same application, keeping the records it ships with

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The survey in Context (2026-10-01): `Archi.nendo`'s records, the deletion and
  reservation rules, and ADR-0021's fold. Accepted on the owner's standing pre-acceptance of ADR
  changes, after the owner's design discussion of the options below; the measurements it asks for
  are its delivery's
- **Amends:** ADR-0010 (a third copy kind, New), ADR-0020 (a new file's sequences restart past
  what it keeps) and ADR-0021 (New folds every revision, with no kept window)
- **Depends on:** ADR-0003 protected metadata, ADR-0005 one write coordinator, ADR-0006 lanes and
  compensation, ADR-0009 MCP, ADR-0010 identity, ADR-0011 copy discipline, ADR-0012 layouts,
  ADR-0021 folding
- **Related design:** [`../design/archi-in-nendo.md`](../design/archi-in-nendo.md)

## Context

`Archi.nendo` holds two kinds of records. Some are the application: 72 Concept type records that
carry ArchiMate's notation defaults, and the nine top-level folders the model tree hangs from.
The rest are one model's work: Archisurance's 296 concepts, 17 views, 448 diagram items, 17
folders of its own and its Model record. A person who wants to model something else wants the
first kind without the second. Any application that seeds lookups is the same: a CRM's stages, a
planner's kinds.

What exists, surveyed 2026-10-01:

- **No action starts the same application empty.** New file makes a file with no definition
  (`Nendo.Desktop.exe -new`, Explorer's New menu). Duplicate and Fork copy every record and the
  whole history (ADR-0010). The only route to an empty Archi is `tools/Build-Archi.mjs`, a
  developer script that builds the file over MCP.
- **Deleting the work in place is not a way there.** The Engine never cascades: a record with
  live incoming references is refused (the relationships contract). Each deletion is an operation
  row, 779 for Archisurance, and History keeps every deleted value. A deleted record's ID stays
  reserved by its tombstone, so importing Archisurance again into the same file collides on its
  `ar-` record IDs. Folding (ADR-0021) returns the rows, not the IDs, and a sequence's next number
  is never lowered (ADR-0020).
- **Deleting the Model record removes that one record.** Nothing references it, so the Engine
  allows it; the workbench's tree, which hangs from it, goes blank, and every concept and view
  stays.
- **Nothing in a file says which records belong to the application**, and one record type holds
  both kinds: Folder holds the nine seeded folders and the person's own.

## Decision drivers

1. A person starts a new file of the same application, with the records it ships with and none
   of the work, without deleting anything.
2. Which records are kept is data that Studio and MCP show, not hidden state and not code.
3. It works for a record type that holds both kinds.
4. A record nobody thought about is left out.
5. The source file is never changed.
6. The new file is consistent by rules the Engine already has, with no new kind of history.
7. It works without the application's custom view (data before presentation).

## Options considered

### A. A mark per record, with a default per record type (chosen)

Each record is kept in new files or left out. A record type states the default; a record may say
otherwise. The mark is a typed operation with its own History entry, shown in Studio and MCP.
Handles a mixed type by marking the exceptions, and reads as a fact about each record.

### B. A flag per record type only

Simplest, and enough for Concept type. It fails Folder, which holds both kinds, unless the
application splits a type for the sake of New.

### C. Declare the record types to clean, with a filter per type

The application names keep, clean, or keep what matches a list filter, and New interprets it at
a low level. It handles Folder with a filter (*no parent*). It costs a filter evaluated outside
any screen, and a record's fate is computed rather than visible: nobody can look at a record and
see whether it will be kept.

### D. A hidden flag chosen at each write

What an agent writing over MCP knows at the moment of writing. Hidden, a record survives New for
a reason nobody can see, and nothing undoes a wrong choice. A keeps the per-record choice and
makes it visible.

### E. The application implements New in its custom view

A view writes only to the open file through the typed services (ADR-0013); it cannot create a
file. In place, New becomes deletion, with every cost in Context. It would also be gone whenever
views are off or the view is broken.

### F. A template file kept beside the application

Needs no host change. It is a second file that drifts from the application's definition with
every change, and that the copy discipline (ADR-0011) does not cover.

### G. Reset the open file in place

Removes the work from the active file. It rewrites the file the person has open and its history,
which no flow does today, and a mistaken reset loses the work.

### How the new file is built

- **Copy, remove and fold (chosen).** Stage a copy of the source, remove what is left out as
  storage, and fold every revision into one checkpoint with ADR-0021's machinery. Every step but
  the removal is delivered code, and the result is consistent by ADR-0021's rules.
- **Replay into an empty file.** Expand the definition and the kept records into typed operations
  on a file made by `-new`. The lineage is cleaner, but the host has no generator of a whole
  definition as operations, and the new file's history would start with hundreds of them.

### Do nothing

An empty application stays a developer script, and a person who wants a second model deletes the
first, with the costs in Context.

## Decision

### 1. Kept in new files

Every record is either **kept in new files** or **left out**.

- **A record type's default** is set by `schema.setKeptInNewFiles` `{entityId, kept}`, a
  definition-lane operation authored in a change set like any shape change. It is `Reversible` and
  compensates itself. A type nobody has set leaves its records out.
- **A record's own mark** is set by `data.setKeptInNewFiles` `{entityId, recordId, kept}`, where
  `kept` is true, false, or null to follow the type. It is a data-lane operation. It changes no
  value and no record version, so it triggers no automatic action and never makes an edit stale.
  It is `Reversible`, and History names it ("Kept *Business* in new files").
- **A deleted record keeps its mark.** Its ID stays reserved by its tombstone, so no other
  record can take the mark over, and restoring the record finds the mark where it was. (Written
  first as "deletion carries the mark in its evidence"; keeping the row needs no evidence and
  gives the same result.)
- **Storage** is one new protected table, `__nendo_new_file_rule` (entity ID, record ID or empty
  for the type's default, kept), and the label table in section 4. Both arrive as one new last rung
  of the layout ladder, added by the first write of either. A Nendo that predates the rung refuses
  such a file as a newer layout. A file that never sets a mark keeps its layout.

### 2. Shown where data is shown

- **Studio** shows each type's default above its grid, with a button that prepares the change
  as a proposal, and an *In new files* column on every grid: *Kept* or *Left out* for a record's
  own mark, *Kept (type)* or *Left out (type)* for one that follows its type. Choosing in the
  cell sets or clears the mark.
- **MCP**: `nendo://application/describe` gives each type's default and how many of its records
  say otherwise. A record read carries `keptInNewFiles` when the record has its own mark. The
  record-creating tools take an optional `keptInNewFiles`, which adds the mark in the same
  revision, and one new tool sets or clears a mark. All of them need Edit data, as other data
  writes do.
- **Not in the semantic UI vocabulary.** A Use screen cannot show or filter on the mark.

### 3. A kept record's references point at kept records

Every reference a kept record holds, its hierarchy parent included, must point at a kept record,
or the new file would hold a reference to nothing. The rule is not checked on every write, which
would stop a person in the middle of ordinary work. It is checked by New's preview and by New
itself, which refuses and names each record, field and target. New never clears a reference to
make the rule hold.

### 4. The application's name for a new file

`application.setNewFileLabel` `{label}`, a definition-lane operation, sets an optional singular
noun of 1 to 40 characters on one line, for example *Archi model*. The File menu then offers **New Archi model…**. Without a label
it offers **New empty copy…**. The label is stored in `__nendo_new_file_label`, one row.

### 5. Starting the new file

The action stands where New file is disabled while a file is open. Only the person starts it:
not an agent, a view or an automatic action, as for Duplicate and Fork (ADR-0010).

1. **Preview.** It shows, per record type, how many records are kept and left out; every
   reference that breaks the rule in section 3; and what the new file will not have: the history,
   view state, waiting proposals, and this device's approvals of automatic actions, which the new
   file asks for again. A save dialog chooses the destination. An existing file is never
   overwritten.
   A normal read-only source receives the same counts, label and reference-conflict preview;
   creating a new file does not require write authority over its source.
2. **Stage.** The host copies the source with SQLite's backup API into a stage in the
   destination folder (ADR-0011). The source is read under the write coordinator and is not
   changed.
3. **Remove.** In the stage, as storage rather than operations: every left-out record, every
   tombstone, the marks of the records removed, and the view state in
   `__nendo_extension_state`. The rule in section 3 is checked again here, against the stage.
4. **Sequences.** Each field sequence restarts one past the highest value the kept records hold,
   or at its start when none does. This is the one place a sequence goes down (amends ADR-0020).
5. **Fold.** Every revision after Genesis is folded into one checkpoint by ADR-0021's rules, with
   no kept window (amends ADR-0021 for New only). The checkpoint says *Started from* the source's
   file name *at change sequence N*. Its fold row names the source file in place of a backup,
   because the source keeps the full history.
6. **Identity.** One `identity.transition` of a third kind, New: the application ID is kept and
   the instance ID is new, as for Duplicate (amends ADR-0010). It is `irreversible-declared`.
7. **Activate.** The host vacuums the stage, inspects it as if opening it, activates it with no
   overwrite, and opens it in a window of its own.
   Read-back must match the expected post-transformation, post-vacuum content. Activation
   rechecks the physical identity and bytes while acquiring a Windows rename handle, then
   moves that held file with writes and deletion excluded until activation finishes.

**What the new file keeps:** the definition (record types, fields, rules, references, hierarchies,
screens, behaviour, custom-view packages and the content their current files use), the purpose and look, the marks
and the label, and the kept records with their values and versions. **What it leaves:** every
other record, every tombstone, view state, every revision's operations (folded into one digest),
waiting proposals and every device-local approval.

### What this is not

- **Not a reset.** The open file never changes.
- **Not a template library.** One application ships one set of kept records. Archi's
  `.architemplate` stays Later.
- **Not an import or merge** of another file's records.

### Archi adopts it

- Concept type keeps its records by default. Specialization leaves them out, because profiles
  belong to a model; a person may mark one to keep it.
- The nine top-level folders are marked kept.
- Model is left out. The workbench creates an empty Model record in a file that has none, so a
  new file opens on an empty model.
- `tools/Build-Archi.mjs` sets the default, the marks and the label *Archi model*, and a change
  set and a batch of marks bring the existing `Archi.nendo` to the same state.

**New Archi model…** then makes a file with 81 records: the 72 concept types and the nine folders.

## Consequences

### Positive

- A person starts a second model in one step, with no deletion, no reserved IDs and no history.
- What a new file keeps is a fact about each record, readable in Studio and MCP.
- Every application gets it: with nothing marked, New gives the definition alone.
- The new file is consistent by ADR-0021's rules; the only new history is the third copy kind.

### Negative

- Two places say whether a record is kept, the type and the record, which is one more thing to
  learn.
- The reference rule is checked at New, not at each write, so a conflict is found late. The
  preview shows it before anything is made.
- A new file's change sequence does not start at 1, and its checkpoint digests a history it does
  not hold.
- Kept records carry their current values. A concept type the person edited carries the edit.
- A view that kept its settings in view state starts without them in a new file.

## Evidence and validation obligations

| Obligation | Lane |
| --- | --- |
| A new file holds the source's definition unchanged (equal definition digest), exactly the kept records with their values and versions, no tombstone, no view state, and history of Genesis, one checkpoint and one New transition; it passes `verify_integrity` | Engine test |
| The source is byte-identical before and after, and an existing destination is never overwritten | Engine test |
| A kept record whose reference, or hierarchy parent, points at a left-out record refuses New and names the record, field and target; falsified by removing the check | Engine test |
| A record's mark overrides its type's default both ways, null follows the type, and the mark changes no record version and fires no automatic action | Engine test |
| Compensating a mark, a type default and a deletion of a marked record restores the previous state | Engine test |
| A sequence restarts one past the highest kept value | Engine test |
| An older host refuses a file carrying the new rung as a newer layout | Layout test |
| `describe`, record reads and the record-creating tools carry the mark as stated | LocalMcp test |
| Studio's column and preview show the counts and conflicts the Engine reports | Workbench test and the gate, measured, not by screenshot |
| New Archi model… on `Archi.nendo` gives 81 records, and the workbench opens on an empty model | Archi lane |
| File size and time to make a new file from `Archi.nendo` | Measured at delivery |

## Revisit triggers

- A Use screen needs to show or filter on the mark.
- An agent or a view needs to start a new file.
- An application needs more than one set of starting records.
- People are caught by the reference rule often enough that it belongs on each write.

## History

- 2026-10-01 — written and accepted on the owner's standing pre-acceptance, after the owner
  weighed options A to G: a hidden write-time flag (D) became a visible mark, and the per-type
  declaration (B, C) became its default.
- 2026-10-01 — delivered at host 1.41.0 (W-129): the Engine, MCP, the Desktop File menu and
  Studio. 1.41.0 had been reserved in the documents for ADR-0013's views anywhere, which moves
  to 1.42.0. The operations are `schema.setKeptInNewFiles`, `data.setKeptInNewFiles` and
  `application.setNewFileLabel`; MCP adds `nendo.data.set_kept_in_new_files`, `keptInNewFiles`
  on the create tools and a `newFile` section in `describe`. A repeated request in the same
  session answers with the file it made; across sessions an existing destination is refused,
  as for a backup. Measured: `NewFileTests` (Engine) and `NewFileSurfaceTests` (LocalMcp); the
  reference rule was falsified, and with it removed the test failed with
  `Expected "new-file-reference-left-out"`, the read-back validation catching the file
  instead.
- 2026-10-01 — measured (`NewFileArchiMeasurementTests`, on a Duplicate of the committed
  `Archi.nendo`, marked as `tools/Build-Archi.mjs` marks it): 5,004 KiB, 860 records and 97
  changes became a new file of 1,160 KiB with 81 records, in 352 ms. The first run left 3,492 KiB:
  the stage kept every earlier package version the history held, which a folded history can no
  longer restore. New now drops package content no current file uses.
