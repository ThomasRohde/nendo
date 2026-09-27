# ADR-0020: Unique and generated fields

- **Status:** Accepted
- **Date:** 2026-09-27
- **Delivery:** Not started. Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24, "I pre-accept any ADR change - this is still an experimental project"), with the recommended option taken at every open point
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
