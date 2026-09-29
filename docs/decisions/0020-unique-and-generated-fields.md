# ADR-0020: Unique and generated fields

- **Status:** Accepted
- **Date:** 2026-09-27
- **Delivery:** Stages 1 (unique fields), 2 (sequences), 3 (`HierarchyPath`) and 4 (Studio and forms) done 2026-09-27, at host 1.37.0; stage 5 (planner adoption) accepted by the owner 2026-09-27. Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24, "I pre-accept any ADR change - this is still an experimental project"), with the recommended option taken at every open point
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The code survey in Context (2026-09-27) and the planner's own duplicate codes (W-074 names them)
- **Amends:** ADR-0008 (a `HierarchyPath` calculation binding), on delivery
- **Depends on:** ADR-0003 relational user data and protected metadata, ADR-0005 host application services, ADR-0006 revisions and compensation, ADR-0008 bounded calculations, ADR-0012 minimum host version, ADR-0019 hierarchies
- **Related design:** [`../dogfooding.md`](../dogfooding.md) (the reference ledger), [`../contracts/relationships.md`](../contracts/relationships.md)

## Context

People name records by short codes: W-074 in the planner, CAP-1.2.3 in the Capability Atlas.
To the host such a code is ordinary text. Nothing keeps two records from carrying the same one,
and nothing hands out the next one.

- **Every client allocates by scanning.** `docs/dogfooding.md` tells an agent to acquire the
  lease, page through every record of the type, take the highest code, add one and check it is
  free. It costs a full read of the type per session, and it is still wrong in practice: the
  planner holds duplicate finding codes F-070, F-071, F-072, F-081 and F-132, ten records in
  all, each written by a client that followed the procedure or thought it had.
- **Nothing can refuse a duplicate.** Studio, an import, an automatic action, a custom view and
  an agent all write text the same way, and none of them can see the others' drafts.
- **What the storage already has.** Each record type is a table with a column per field. A
  configured reference already gets an index of its own, outside the protected namespace and
  created with the operation that needs it (ADR-0003 note, 2026-09-09), so an index per field is
  a known shape. Every write reaches the store through one coordinator and one transaction at a
  time, so the host can allocate a number inside the write that uses it. Per-field metadata
  lives in protected tables, one rung of the layout ladder each (the tone and the rating scale
  did this; ADR-0019's hierarchy did it last).
- **Codes derived from position.** ADR-0019 left a path code (1.2.3) derived from a record's
  place in a declared hierarchy to this decision, and gave it the sibling order to build on.

## Decision drivers

1. One rule for every client: the Engine refuses a duplicate, as it refuses a loop.
2. A code a person can say in conversation is stable: it does not change when the record moves.
3. Nothing is repaired silently. Existing duplicates are the person's to resolve.
4. The planner can drop its manual ledger without losing a code anyone has written down.
5. A file that declares none of this is byte-for-byte what it was.

## Options considered

### Option A — declared uniqueness and sequences on stored fields; paths as calculations

A field can be declared unique; a unique Text field can also be given a sequence the host fills
in on create; a path code is a calculated value, not stored. Uniqueness is enforced by the
store on every write, backed by an index. Costs: one protected table, one index per unique
field, and a named refusal wherever a write can land.

### Option B — a generated "reference" field kind

A new storage kind that is always unique and always generated. Simpler to describe, but it
cannot adopt an existing field: the planner's Reference fields are Text with values in them,
and changing a field's kind is not an operation Nendo has.

### Option C — client conventions and a helper

Keep the ledger and give agents an MCP helper that returns the next code. It still cannot stop
Studio, an import or a second agent, which is how the duplicates happened.

### Do nothing

Every client keeps paying a full scan per code, and duplicates keep arriving.

## Decision

**Option A.**

1. **Unique.** `schema.setFieldUnique { entityId, fieldId, unique }` on an active stored field
   that is single-line Text (not a single choice, not long text) or Integer. Two values collide
   when they are equal; Text compares case-insensitively for ASCII letters (so `w-074` collides
   with `W-074`) and exactly otherwise. An empty value never collides, so an optional unique
   field may be left empty. Definition lane; `Reversible` (setting `unique: false` is its
   inverse and leaves every value as it is).
2. **Declaring checks the data.** The proposal clone looks for collisions. If there are any,
   validation fails with `field-values-not-unique`, listing each colliding value and the records
   that hold it (the first 20 values). Nothing is renumbered automatically; the person resolves
   the duplicates through ordinary writes first.
3. **The rule.** After declaration every write that sets the field — create, set field, set
   fields, import, command step, automatic action, custom view — is refused with
   `value-not-unique` when another record already holds the value, naming the field, the value
   and that record. The store checks before it writes, and a unique partial index on the column
   (`nendo_unique_<table>_<column>`, outside the protected namespace, as reference indexes are)
   makes the rule hold even for a path that forgot to check.
4. **Sequences.** `schema.setFieldSequence { entityId, fieldId, prefix, width }` on a unique
   Text field: `prefix` is 1 to 16 characters, `width` 1 to 9 digits (zero-padded, never
   truncated). On a create that leaves the field empty, the host writes `prefix` followed by the
   next number, inside the same transaction, so two clients cannot take the same code. The next
   number is one past the highest ever seen: the protected table keeps a high-water mark,
   initialised on declaration from the largest existing value of that shape and raised by any
   value of that shape a client writes explicitly. A number is never reused, even after its
   record is deleted. A client may still supply a code (an import carrying its own codes); it is
   only held to uniqueness. A generated field may be required: the host fills it before the
   required check. `Reversible`: removing the sequence leaves every value and the uniqueness.
5. **Paths are calculated, not stored.** ADR-0008 gains a `HierarchyPath` calculation binding
   on a record type with a declared hierarchy: the record's 1-based position among its siblings,
   and each ancestor's, joined with dots (`1.2.3`), with an optional literal prefix
   (`CAP-1.2.3`). It changes when a record moves, which is why it is never stored and never
   unique-enforced: it is unique by construction and wrong as an identity. A code people must
   be able to repeat next week is a sequence.
6. **Storage.** One protected table, `__nendo_field_rule` (entity, field, unique, sequence
   prefix, width and high-water mark), the next rung of the layout ladder; a file that declares
   neither keeps its layout and minimum host version. The minimum host version is the next rung
   at delivery, by the `minimum_host_version` rule.
7. **Where it shows.** The schema read (and so MCP describe and the view API's
   `schema.describe`) carries `unique` and `sequence { prefix, width }` per field. Studio's
   Structure shows both and offers them as reviewed changes; a form leaves a generated field
   empty on a new record and says *Assigned when saved*. MCP's create tools accept a create
   without the code and return the one assigned.
8. **The planner adopts it.** The duplicate finding codes are renumbered to free codes first,
   each record keeping its old code in its context text, so a commit message or document naming
   the old code can still be traced. Then Reference on each planner record type is declared
   unique with a sequence (`W-` 3, `F-` 3, `C-` 3, and so on), and `docs/dogfooding.md` drops the
   ledger procedure.

**Delivery order.** (1) Unique: the operation, the declaration check, the rule on every write,
the index, the schema read, MCP. (2) Sequences. (3) `HierarchyPath`. (4) Studio and forms.
(5) The planner adopts it. The contracts, `../architecture.md` and the MCP vocabulary change
with each stage as it lands.

## Evidence and validation obligations

- **Every write path.** A test per path — create, set field, set fields, import, command step,
  automatic action, custom-view write, agent — that a duplicate is refused naming the other
  record, and that the file is unchanged. Each guard seen to fail with the check removed.
- **Declaration.** Refused over duplicates with every colliding value named; accepted after
  they are resolved; compensation of both directions.
- **Sequences.** Allocation inside the write (two creates in one change set get two codes); the
  high-water mark after a delete, after an explicit higher code and after reopening; an import
  carrying codes.
- **Layout.** A file that never declares a rule keeps its layout name and minimum host version;
  the rung is recognised on reopen.
- **Paths.** Positions after a move and a reorder, against a hand-built tree; the cost of a page
  of 100 with a path column at 10,000 records, measured.

## Stage 1 note — 2026-09-27: unique fields

Delivered at host **1.37.0**; ADR-0013's views anywhere, which the documents had reserved
1.37.0 for, move to the next rung. `__nendo_field_rule` is the `-rule-` rung and already carries
the sequence columns stage 2 needs, because a rung's DDL is its fingerprint and cannot grow
later. Details the code settled:

- **Two write hooks cover every path.** Creates (single, batch, import, a restored record) and
  field writes (set field, form save, command step, automatic action, custom view, agent) all
  reach the store as `data.createRecord` and `data.setField`, and the check sits in both,
  beside ADR-0019's placement rule. The partial unique index is the backstop: with the check
  removed, a duplicate is still stopped, but as a raw storage error rather than a refusal.
- **Refusals name records, never values.** The MCP rule for audited messages allows stable
  IDs, display names and counts only, so `value-not-unique` names the record holding the value
  and `field-values-not-unique` lists the colliding records group by group. Studio, whose reader
  owns the file, names the holder by its label instead (stage 4 note).
- **A field added in the same mutation** gets its index when the mutation materializes.

Evidence: `FieldUniqueTests` (7: the rung, reopen and layout; a file without it keeping its
layout; declaration refused over collisions, then accepted; every write path refused naming
the holder, with the history unchanged; Integer and the refused shapes; compensation both ways;
a field declared in the mutation that adds it) and `FieldUniqueProtocolTests` (the schema read
and the refusal an agent sees). Falsified: with the per-write check skipped, *"Expected
exception type:<NendoPreconditionException>. Actual exception type:<SqliteException>"*; without
the audited code, the agent read only *"NENDO_VALUE_NOT_UNIQUE: The semantic precondition was
not met."*

## Stage 2 note — 2026-09-27: sequences

Delivered within host 1.37.0, on the rung stage 1 laid. Details the code settled:

- **History records the code.** The create a sequence fills is rewritten with the code before it
  is recorded, so history, a replay of it and a restored record all carry the same one. A
  restore never draws a new number.
- **The counter is raised by any code of its shape**, including the one just assigned, so the
  advance and the raise are one rule seen twice: a test that removes only the advance still
  passes, and removing the raise fails it.
- **`minimumNext`** is a payload key only compensation sets, so undoing a removal cannot go below
  the number the removed sequence had reached.
- **A prefix cannot end in a digit**, or `V2` and `001` would read back as `V` and `2001`.
- **The result names the codes.** `NendoApplyResult.AssignedValues`, and `assigned` on an MCP
  write result, list each record, field and code the host wrote.

Evidence: `FieldSequenceTests` (6: the next after the highest existing, ignoring other shapes;
a batch numbered in order; a deleted number stays spent; explicit codes and case raise the
counter; the counter survives a reopen; a restore keeps its code; a required numbered field;
the refused shapes; removal and its compensation) and `FieldUniqueProtocolTests` (a create
without a code returns the assigned one over MCP). Falsified: without the raise, *"Expected
F-051"* failed.

## Stage 3 note — 2026-09-27: hierarchy paths

`HierarchyPath` is a sixth binding kind, delivered within host 1.37.0: a calculation is
evaluated on read, so the path needs no storage and no rung of its own. Details the code
settled:

- **Siblings count in the tree read's order** — the order field, a missing order last, then
  record ID — so a path and the outline agree on which record is 1.2.
- **One indexed count per level**, walking up from the record; the ancestors read are observed,
  so a reviewed action plan that used a path is valid only while the chain above is unchanged.
  A sibling's reorder is not observed: a path is for display, as the ADR says.
- **It holds the hierarchy in place**, as a subtree aggregate does: removing the hierarchy under
  one is `hierarchy-field-in-use`.
- **`prefix` is written to a stored definition only when set**, so no earlier definition's
  canonical bytes or digest change.

Cost, measured with `tools/Review-HierarchyCost.ps1` (the ADR-0019 driver, extended) on 10,000
records with the path in place of the subtree count: a page of 100 at 29.8 ms p50 / 40.9 ms p95,
the deepest record (32 levels) at 1.3 ms p50 / 1.9 ms p95, against the 150 ms read target.

Evidence: `HierarchyPathTests` (5: paths in order with missing orders last; a prefix, and a move
followed at once; ordering by record ID without an order field; refused without a hierarchy, with
a long prefix, and holding the hierarchy; the wire format and its refusals). Falsified: treating a
missing order as ordinary made *"Expected 3"* fail for the unordered top-level record.

## Stage 4 note — 2026-09-27: Studio and forms

Structure shows *Unique* and *Numbered W-001* beside a field's requirement and offers **Make
unique**, **Allow duplicates**, **Number automatically** and **Stop numbering** as reviewed
proposals; Allow duplicates is disabled on a numbered field with the reason. The numbering form
suggests a prefix from the field's initials, rejects a prefix ending in a digit, and shows the
first code as the inputs change. On a new record an empty numbered field is not required, says
*Assigned when saved* and names the next code's shape; the form's own required check skips it. A
compiled screen's field plan carries no sequence, so the form reads it from the open file's schema.

A duplicate refused on a form first read the Engine's sentence, which names the record holding
the value by its ID. Closed the same day: the refusal carries the holder's ID as its own field
(`NendoPreconditionException.RecordId`, the bridge's `error.recordId`, left out when there is
none), and the Workbench reads that record and puts its label in place of the ID, quoted. The
label is the field references to the type are shown with, or else the type's first required
single-line text; a unique field is passed over. MCP's sentence is unchanged and still carries
no stored value. Evidence: `DesktopUniqueRefusalTests` (the holder's ID on the bridge, no stored
value in the sentence, no `recordId` key on a refusal about no record), `FieldUniqueTests` (the
ID on every write path) and `write-failure.test.mjs` (the naming field and the substitution).
Falsified: without the ID, *"Assert.AreEqual failed. Expected:<t1>. Actual:<>. … The refusal does
not say which record holds the value."* and *"Expected:<a>. Actual:<>. … The refusal names its
holder for a person-facing host to label."*; without the substitution, `write-failure.test.mjs`
failed 1 of 8. The read that fetches the label inside `runMutation` has no lane of its own.

Evidence: `record-markup.test.mjs` (the numbered control on a new record and on a record with a
code; `fieldSequence`, `sequenceExample`). Falsified: without the numbered branch, *"The input did
not match /placeholder="Assigned when saved"/"*. Agent-observed in headless Edge against the
preview's `tree` fixture (not the real host): the tags and actions per field, the disabled Allow
duplicates and its reason, the dialog's example (`O-001`, then `OWN-0001`), a trailing digit
refused, and a new record's code field not required with the note; no console error.

## Stage 5 note — 2026-09-27: the planner adopts it

The five duplicated finding codes were renumbered through the data lane: F-070 → F-165,
F-071 → F-166, F-072 → F-167, F-081 → F-168, F-132 → F-169. In each pair the record that
other records link to, or that was written first, kept the code; the renumbered record
carries its old code at the head of its context text. The proposal *Number References
automatically (W-074)* declares Reference unique and numbered on Work items (`W-`),
Findings (`F-`), Checks (`C-`) and Initiatives (`I-`), three digits each, and raises the
planner's minimum host from 1.33.0 to 1.37.0. It validated with no diagnostics, which is
also the check that no other code in the four types is held twice. Dependencies has no
Reference. `docs/dogfooding.md` no longer asks a client to scan for the highest code.

The owner accepted it the same day: the planner is at definition revision 59 with minimum host
1.37.0. Agent-observed over MCP (C-241): a check created without a Reference was assigned
`C-241`, one past the highest; setting it to `C-240` was refused with *"NENDO_VALUE_NOT_UNIQUE:
That Reference is already used by nd.check.r.unique-stage4 in Checks; each record needs its
own."*

## Accepted amendment — 2026-09-29: an import names a target by a unique field (W-075)

Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24), for W-075. It
settles what ADR-0019 item 10 left open, and it changes the CSV contract's "Choice/reference
values are stable IDs" for references only.

**What was wrong.** A spreadsheet names a parent by its code. Import took only record IDs, which
only the file knows, so a capability model arrived in thirteen hand-built batches, each written
after the one before had given its parents IDs, and a child could not name a parent in the same
import at all.

**Decision.** A CSV mapping for a reference column may name a *match field*: a unique field of
the target record type, whose values the cells hold. A cell then names a row of the same import
first, then a record the file holds, compared as the uniqueness rule compares text (without
regard to case). The import refuses, by its row: a code that names nothing; a code on two rows
of the import; a code that names both a row of the import and a different record of the file; a
match field that is not unique. When the parent field of a declared hierarchy is matched this
way by a code the import itself carries, the rows are put parents first before any batch is cut,
and each keeps the line number it has in the file; parents that lead back to themselves are
refused. The person's importer offers the choice per reference column ("names its … by": Record
ID or each unique field of the target), and `nendo.data.import_records` takes `matchFieldId` on a
column mapping. Neither path changes what it commits: the resolved record IDs, through the same
`data.createRecord` operations.

**Not label matching.** A label is whatever a person typed and may repeat. A match field is one
the target type has declared unique, so a cell can name at most one record, and a cell that
names none is refused rather than guessed.

## Consequences

### Positive

- An agent creates a planner record without reading every record of the type first.
- Duplicates stop at the Engine, whoever writes them.
- CAP-1.2.3 style display codes come from the tree instead of being maintained by hand.

### Negative

- A new refusal on every write path, which every client has to show in words.
- A path code is not an identity, and people will be tempted to use it as one; the docs and the
  Structure page have to say so.
- One index per unique field, and a protected table rung.

## Rejected alternatives

- **A reference field kind (B).** It cannot adopt the planner's existing Text fields, and a kind
  change is not an operation Nendo has.
- **Client conventions (C).** The duplicates in the planner are the evidence that conventions
  are not enough.
- **Stored path codes.** Every move would rewrite a subtree of codes, and a code that changes is
  not a reference.
- **Unicode case folding.** SQLite's `NOCASE` folds ASCII only; full folding would need a
  collation the file cannot carry. ASCII covers every code in use.

## Revisit triggers

- A code format a prefix and a number cannot express (a year, a per-parent sequence).
- Uniqueness across two fields, or across record types.
- The index cost becomes visible on large imports.
