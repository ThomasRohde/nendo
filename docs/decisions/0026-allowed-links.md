# ADR-0026: Allowed links

- **Status:** Accepted
- **Date:** 2026-10-06
- **Delivery:** All four stages done 2026-10-06, at host 1.45.0 (W-105). Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24, "I pre-accept any ADR change - this is still an experimental project"), with the recommended option taken at every open point
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** D-003 in the planner (2026-09-29); the measure of ArchiMate's relationship table in Context; the delivery note below
- **Depends on:** ADR-0003 relational user data and protected metadata, ADR-0005 host application services, ADR-0006 revisions and compensation, ADR-0007 proposal validation, ADR-0012 minimum host version, ADR-0020 unique fields (the pattern this follows), ADR-0022 new files
- **Related design:** [`../design/archi-in-nendo.md`](../design/archi-in-nendo.md), [`../contracts/relationships.md`](../contracts/relationships.md)

## Context

Some record types are links: a record whose job is to join two others, with a kind that says
how. An ArchiMate relationship in `Archi.nendo` is a Concept with a Source, a Target and a
Type. ArchiMate allows only some kinds between some endpoints: an Assignment may run from a
Business Actor to a Business Role, but not from a Goal to a Node.

- **Only the view knows.** D-003 (2026-09-29) chose to keep the rule in the Archi view: its
  palette and magic connector offer only valid types, and its validator reports invalid
  relationships written any other way. A form, a CSV import, an automatic action and an agent can
  each still write one. Archi itself accepts an invalid relationship on import and flags it.
- **The formula language cannot say it.** A trigger that refuses would need to look up a row in
  another record type by three values; ADR-0008's calculations follow one reference hop.
- **The table is data.** Archi's `relationships.xml`, as archi-online carries it, has 3,844
  (source type, target type) pairs holding 11,569 allowed (source, target, relationship)
  triples. A relationship whose source or target is itself a relationship looks up the pseudo-type
  *Relationship*; spelled out for each of the eleven relationship types, the table is 12,829 rows.
  Allowing an empty cell as "any" was measured too: it brings the triples down to 7,605, not
  enough to be worth a second meaning for an empty value.
- **What the store already has.** Every write reaches the store through one coordinator, one
  transaction and one mutation at a time (ADR-0005), and ADR-0020 put a uniqueness check on every
  write path in two hooks. A record type's rules live in protected tables, one rung of the layout
  ladder each.

## Decision drivers

1. One rule for every client: the Engine refuses a link the table does not allow, as it refuses
   a duplicate code or a loop.
2. Generic, not ArchiMate's: any file with a link type and a table of allowed kinds can declare it.
3. The table is ordinary records the person can read, filter, import and correct.
4. A batch may pass through a state that is not allowed on its way to one that is.
5. A file that declares none of this is byte-for-byte what it was.

## Options considered

### Option A — a declared link rule checked at the end of each mutation

A link record type names its source and target references, its kind field, the kind field of
each endpoint, and a record type whose records are the allowed (source kind, target kind, link
kind) combinations. The store checks the links a mutation touched once its operations and
automatic actions have run, before the revision is recorded. Costs: one protected table, one index
on the table's three fields, and a refusal on every write path.

### Option B — checked inside each write

As ADR-0020's uniqueness is. Simpler to place, but a form that changes a relationship's Type and
then its Target, or a view that retypes a concept and its relationships in one batch, would be
refused half way through for a state nobody asked to keep.

### Option C — a trigger with `Refuse()` (D-003's B)

Needs a three-key lookup the formula language does not have, and each device's consent for the
trigger. A rule that holds only where consent was given does not hold on every path.

### Do nothing

The view and the validator keep the rule (D-003's A). Every other path can write an invalid link.

## Decision

**Option A.**

1. **The rule.** `schema.declareLinkRule { entityId, sourceFieldId, targetFieldId, kindFieldId,
   sourceKindFieldId, targetKindFieldId, tableEntityId, tableSourceFieldId, tableTargetFieldId,
   tableKindFieldId }` on a link record type; `schema.removeLinkRule { entityId }` takes it away.
   One rule per link record type. Definition lane; `Reversible`: each is the other's inverse, and
   removing keeps every record as it is.
2. **Its shape.** Source and target are bound references of the link type. The kind is a field of
   the link type; each endpoint kind is a field of the record type its reference points at. The
   table is another record type (not the link type, not an endpoint's), and each of its three
   fields matches the field it stands for: a reference to the same record type, or single-line
   Text to single-line Text. No two of the link type's three fields are the same field, nor are
   two of the table's. All ten are active. Anything else is `link-rule-invalid`, naming the field.
3. **What is allowed.** A link is checked when its source, target and kind are all set. It is
   allowed when a record of the table holds its source's kind, its target's kind and its own kind,
   compared exactly as stored. An endpoint whose kind is empty matches no row. A link with an empty
   source, target or kind is not checked: an ArchiMate element is a Concept with neither.
4. **Declaring checks the data.** On the proposal clone, every link is checked. If any is not
   allowed, validation fails with `links-not-allowed`, naming the first 20 and how many there are.
   Nothing is changed or deleted; the person corrects the links or the table first.
5. **When it holds.** At the end of every mutation, after automatic actions, the store checks
   each link the mutation created, restored or set the source, target or kind of; each link whose
   source or target had its kind set; and, when a table record was changed or deleted, every link.
   A link that is not allowed refuses the whole mutation with `link-not-allowed`, naming the link
   and, for reference kinds, the three kind records by ID; a text kind is named by field only,
   since a refusal carries no stored value. Every path reaches this point: create, set field, a
   form save, a CSV import batch, a command step, an automatic action, a custom view, an agent,
   History's undo and a restore.
6. **In use.** While a rule is declared, retiring either record type, retiring any of its ten
   fields, or changing one's presentation is `link-rule-field-in-use`. Renaming is allowed.
7. **New files.** A new file of the application (ADR-0022) checks every kept link against the kept
   table, and refuses with `links-not-allowed` rather than start a file that breaks its own rule.
8. **Storage.** One protected table, `__nendo_link_rule`, keyed by the link record type, the next
   rung of the layout ladder (`-linkrule-`); a file that declares none keeps its layout and minimum
   host version. Declaring creates an index on the table's three columns
   (`nendo_link_<table>`, outside the protected namespace, as unique and reference indexes are),
   so each check is one indexed lookup; removing drops it. Minimum host 1.45.0.
9. **Where it shows.** The schema read (MCP `entity/{id}/schema` and `describe`, the view API's
   `schema.describe`) carries `linkRule` on the link type, with the ten IDs. A proposal names the
   rule in words. Studio's Structure shows it on the link type. Declaring it is authored as a
   change set; Studio offers no form for it in this decision.
10. **Archi adopts it.** `Archi.nendo` gains *Allowed relationships*: three references to Concept
    types, seeded with the 12,829 rows and kept in new files, and declares the rule on Concepts
    (Source, Target, Type; Type on both ends). The validator keeps its own check, for a file that
    has not declared the rule. An `.archimate` import that holds an invalid relationship is refused,
    naming it, where Archi would import it and flag it; that is the point of the rule.

**Delivery order.** (1) The Engine: operations, rung, declaration, the rule at the mutation
boundary, in-use guards, new files, compensation, schema read. (2) MCP: vocabulary, authoring,
refusals. (3) Studio's Structure line. (4) Archi adopts it. The contracts and
`../architecture.md` change with each stage.

## Evidence and validation obligations

- **Every write path.** A test per path — create, set field, a batch that passes through an
  invalid state, import, command step, automatic action, custom-view write, agent — that an
  invalid link is refused naming it and that the file is unchanged; the endpoint-kind and
  table-row paths; each guard seen to fail with its check removed.
- **Declaration.** Refused over invalid links, naming them; accepted after they are corrected;
  compensation both ways; the shape refusals.
- **Layout.** A file that never declares a rule keeps its layout name and minimum host version;
  the rung is recognised on reopen.
- **Archi.** In `Archi.nendo`, an invalid relationship refused through a form, CSV import, MCP and
  the view with the same reason.

## Delivery note — 2026-10-06

All four stages landed together. Details the code settled:

- **One hook, two places.** Both apply paths (`ApplyAsync` for a single mutation, and
  `ApplyChangeSetAsync` per mutation of a change set, which a proposal's clone and its promotion
  both run) call the check after materializing, so every path reaches it: forms, imports,
  commands, automatic actions, views, agents, undo and restore.
- **Which links a mutation can have changed** is read from its operations: a create or restore of
  a link, a set of its source, target or kind, a set of either end's kind, and any write to the
  table, which checks every link. The named links are checked in slices of 400.
- **A declaration in the mutation that creates its record types** has no data to check, and the
  table's index is created when the mutation materializes its columns.
- **The refusal names records, never stored text**: for a reference kind, the kind records by ID
  (the MCP rule for audited messages); a text kind by its field only.

Evidence: `LinkRuleTests` (11: the rung, reopen and layout; a file without a rule keeps its
layout and host; declaration refused naming the links, then accepted; create, set kind, set
target, form, batch, source's kind, target's kind, table row edited, table row deleted and a
command step each refused naming the link with the history unchanged, and a CSV batch refused at
review; a mutation passing through a link that is not allowed; an automatic action; undoing the
row a link needs, and compensation both ways; a reference kind named by its records; a new file
that would keep a link without its row; the shape refusals; the in-use guards),
`LinkRuleProtocolTests` (the schema read, an agent's refusal with its sentence, the authoring
table and the compiler), `link-rule-markup.test.mjs` (Studio's note on the link type and the
table). Falsified, each with *"Assert.ThrowsExactlyAsync failed. Expected exception
type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown."*: the check removed
from both apply paths (4 of 10 tests failed), the source's-kind branch removed, the target's-kind
branch removed, the table branch removed, and the new-file check removed. Without the code among
MCP's audited refusals, the agent read only *"NENDO_LINK_NOT_ALLOWED: The semantic precondition
was not met."*

**Archi adopts it.** `tools/Build-Archi.mjs` adds *Allowed relationships* (stage `rules`), seeds
the 12,829 rows and declares the rule on Concepts (stage `linkRule`). Run against
`workspace/Archi.nendo` in a Debug host with a device state of its own: the declaration was
accepted, so every relationship the file already held is allowed. Agent-observed in that host,
an Assignment from a Principle to a Node was refused with the same sentence through an agent's
create, an agent's CSV import (`nendo.data.import_records`), the form's create over the Workbench
bridge, and the view's batch over the bridge as the Archi package writes it; the change sequence
stayed at 422. The person's own CSV importer, behind a native file dialog, was not driven; it
prepares the same batch proposal the Engine test refuses. Studio's note was measured in that host
in both themes. The file grew from 18.7 MB to 36 MB.

## Consequences

### Positive

- A link type can hold its own grammar, whoever writes to it.
- ArchiMate's table becomes records a person can read and filter, not 4,000 lines of package code.

### Negative

- A new refusal on every write path, and one more rung.
- An import from a tool that tolerates invalid links is refused rather than flagged.
- `Archi.nendo` carries 12,829 more records.

## Rejected alternatives

- **Checked inside each write (B).** It refuses honest batches half way through.
- **A trigger (C).** It needs a lookup the formula language lacks, and holds only where consent
  was given.
- **Wildcard cells.** Measured on ArchiMate's table: 7,605 rows instead of 11,569, for a second
  meaning of an empty value that every reader of the table would have to learn.
- **Choice-valued kinds.** A choice's options belong to their field, so a table field could not
  hold the link field's options; a reference to a kinds record type does what a choice would.

## Revisit triggers

- A link type that needs two rules, or a rule that spans more than one hop.
- A kind that is a single choice.
- Instance rules, such as ArchiMate's junction checks, which compare a link with its neighbours.
