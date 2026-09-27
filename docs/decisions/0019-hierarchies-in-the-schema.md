# ADR-0019: Declare a self-reference as a hierarchy

- **Status:** Accepted
- **Date:** 2026-09-27
- **Delivery:** Stages 1 (the cost experiment) and 2 (declaration, cycle rule, move, MCP) done 2026-09-27; stages 3–7 not started. Proposed and accepted the same day, after the owner settled the open questions
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The code survey in Context (2026-09-27) and the Capability Atlas review (W-072, planner findings F-154 to F-162). The costs were measured after acceptance as delivery stage 1, and every target was met; see the Stage 1 note
- **Amends:** ADR-0004 (the `outlineSurface` node, the parked B6) and ADR-0008 (the `SubtreeAggregate` binding and a subtree option on `RelatedAggregate`), both on delivery
- **Depends on:** ADR-0003 relational user data and protected metadata, ADR-0005 host application services, ADR-0006 revisions and compensation, ADR-0008 bounded calculations, ADR-0013 custom views, ADR-0015 Studio
- **Related design:** [`../design/surfaces-and-charts-plan.md`](../design/surfaces-and-charts-plan.md) (the parked B6 Outline), [`../contracts/relationships.md`](../contracts/relationships.md)

## Context

Many applications people build are trees: a business capability model, an
organisation chart, a work breakdown, a taxonomy, the planner's own initiatives.
Nendo stores them today as an ordinary self-reference: a Reference field whose
target is its own record type. The platform allows that, and it says nothing more
about it.

What the code does today (surveyed 2026-09-27):

- **A reference may target its own entity.** `schema.configureReference` never
  compares the target with the source (`ReferenceOperations.cs`), and
  `RecordDeletionTests` binds `source.self → source` with a record pointing at
  itself.
- **Nothing refuses a cycle.** `ValidateReferenceValueAsync`
  (`SqliteNendoStore.References.cs`) checks that the target exists at the expected
  version. The only cycle checks in the Engine are over UI nodes and behaviour
  dependencies. [relationships.md](../contracts/relationships.md) asks that cycles
  be repaired through a reviewed change, but nothing detects one.
- **There is no sibling order.** The only stored position is on UI nodes. Apps
  invent an integer field (`cap.order` in BCM.nendo).
- **Rollups are one level deep.** ADR-0008's `RelatedAggregate` (Count,
  FilteredCount, Sum) and the record page's `summaryTile` fold the records that
  point at *this* record. No data query in the Engine is recursive.
- **Studio shows a tree as a flat table.** The reference column shows the parent's
  label and is edited in the record sheet. AG Grid Community, the substrate that
  ADR-0015 chose, has no tree-data feature.
- **Import resolves references only by record ID**, so a child cannot name a parent
  in the same import, and nothing orders an import parents first.

The Capability Atlas (W-072) shows the cost. Its `model.js` rebuilds the tree,
cuts cycles deterministically for display, and refuses a parent under the
record's own descendants, but only in its own editor. Studio, an agent or an
import can still close a loop, and every other consumer of the same data would
have to repeat the repair. Thirteen hand-built batches were needed to import 575
capabilities parent-first. The design plan parked a native outline (B6) for
exactly these reasons: bounded windows over a recursive shape, and cycles.

## Decision drivers

1. **One authority.** An invariant that holds only in one client's code does not
   hold. Acyclicity must be refused where every write passes: the Engine's typed
   services (ADR-0005).
2. **Data before presentation.** A tree must stay ordinary relational data that
   the Studio table shows, CSV exports and a broken view cannot lose. No hidden
   structure that only one surface understands.
3. **Bounded work.** Every read and check has a stated bound, as ADR-0008's
   aggregates do. A deep or wide tree is refused by name, not answered slowly.
4. **Explicit reversibility.** A move is an operation with a declared class and a
   compensation (ADR-0006).
5. **Existing files keep working.** Nothing changes for a self-reference until
   someone declares it, and a file with cycles is never repaired silently.
6. **Small surface.** One concept that BCM, the planner and future apps share,
   rather than tree logic in each package.

## Options considered

### Option A — declare an existing self-reference as a hierarchy

A typed schema operation marks one self-reference field of an entity as that
entity's hierarchy, optionally naming an Integer field as the sibling order. The
parent and order stay ordinary columns. The Engine then refuses any write that
would close a loop. It gains a typed move operation, bounded tree reads and
subtree aggregates. Studio, the view API and MCP learn the declaration.

Benefits: data stays where it is and stays readable; the invariant lives in one
place; adoption is one reviewed operation on an existing file. Cost: a protected
metadata table (a new ladder rung), recursive checks on parent writes, and work
in Studio, the view API, MCP, calculations and import. Failure mode: very deep
or very wide trees make checks and rollups expensive, which the bounds address.

### Option B — a host-maintained derived structure (closure table or nested sets)

The host keeps an ancestor table (or intervals) beside the entity and answers
subtree questions from it. Benefits: subtree reads and rollups are single indexed
queries. Costs: every move rewrites many derived rows; the derived table can
drift from the parent column and needs its own repair path; the file gains
structure a person cannot read in the table. It solves a performance problem that
has not been measured yet.

### Option C — a general acyclic constraint on any reference graph

Allow acyclicity to be declared over any set of references, across entities.
Benefits: covers dependency graphs (the planner's `nd.link`) too. Costs: no
natural sibling order, no single parent, and no clear outline or rollup meaning;
the cases people hit first are single-parent trees.

### Do nothing / defer

Trees stay app conventions. Each package repeats cycle repair and parent checks,
Studio and agents can still create loops, imports of real hierarchies stay
manual, and rollups across levels remain impossible. The B6 outline stays parked.

## Decision

**Option A**, with Option B kept as a possible internal index behind the same
contract if measurement ever calls for it.

1. **Declaration.** `schema.declareHierarchy { entityId, parentFieldId,
   orderFieldId? }`. The parent field must be a Reference configured to the same
   entity; the order field, if named, an Integer field of that entity. One
   hierarchy per entity. Stored in a new protected table `__nendo_hierarchy`
   (a new rung at the end of the layout ladder, with the minimum host version
   raised, per ADR-0003). `schema.removeHierarchy { entityId }` returns the field
   to an ordinary self-reference and leaves every value as it is. Both are
   Definition-lane operations; declaring is `Reversible` (removal is its inverse).
2. **Declaring validates the data.** The proposal clone walks the stored parents.
   A cycle or a self-parent fails validation with `hierarchy-cycle-present`,
   naming every record on each loop, and so does a tree deeper than the depth
   bound. The person repairs the data through ordinary reviewed writes first.
   Nothing is repaired automatically.
3. **The cycle rule.** After declaration, every write that sets the parent field
   — create, set field, update, import, command step, automatic action, custom
   view — is refused with `hierarchy-cycle` when the new parent is the record or
   one of its descendants, naming the loop. The check walks up from the new
   parent over the existing covering index on the reference column, so its cost
   is the depth, not the tree size. Depth is bounded at **32 levels**, and a
   write past it is refused with `hierarchy-too-deep`.
4. **Order.** If an order field is declared, siblings sort by it, then by record
   ID; otherwise by record ID alone. The order stays an ordinary field that a
   person can see and edit.
5. **Move.** `data.moveRecord { entityId, recordId, expectedRecordVersion,
   parentRecordId?, expectedParentVersion?, beforeRecordId? }` sets the parent
   and, with an order field, places the record before a sibling or last. When the
   neighbours leave no integer gap, the siblings are renumbered in the same
   revision, each against its version. Class: `Reversible`; compensation restores
   every touched record's previous parent and order. The subtree moves with its
   root because children point at it.
6. **Reads.** A bounded tree read returns a window: a root (or the top level),
   a depth limit, and per node its parent, depth, sibling position and child
   count, paged like other reads. It backs Studio, the view API
   (`records.tree`) and an MCP resource. `records.query` gains a
   `descendantOf` filter over the same bound.
7. **Subtree aggregates.** ADR-0008 gains a `SubtreeAggregate` binding (Count,
   FilteredCount, Sum). It folds the record's **descendants only** by default
   ("12 capabilities inside"); `includeSelf: true` adds the record itself, for a
   total of a node and everything under it. `RelatedAggregate` gains an option to
   fold the records related to any node of the subtree (for example, the
   applications supporting a capability or anything under it). Both are bounded
   at **10,000 descendants** and refuse past it by name, like `RelatedRows`.
8. **Studio.** A declared hierarchy shows as an outline in the data view: an
   indented, expandable label column with move up, move down, indent and outdent,
   built on AG Grid Community with the tree read and a custom cell renderer (no
   Enterprise tree data). The flat table stays available.
9. **The outline surface (B6).** ADR-0004 gains `outlineSurface`, a root of its
   own that an author or an agent places in an application, as a list is placed.
   - Properties: `definitionVersion`; `entityId` (required, and the entity must
     declare a hierarchy, else refused at authoring); `title`; `titleFieldId`
     (an active stored Text field that is not a single choice, defaulting to the
     parent reference's label field); `accentFieldId` (an active single-choice
     field); `expandDepth` (1 to 4, default 2: the levels open when the surface
     first shows); `reorder` (Boolean, default false).
   - Children: ordered `fieldBinding`, shown as columns beside the title. A
     calculated field bound there may be a subtree aggregate (point 7), which is
     how an outline shows rollups. `filterClause` is refused: a filtered tree
     hides the ancestors that give a match its meaning. The surface has a find
     box instead, which runs one bounded query and opens the matches' ancestor
     paths.
   - Reads: the top level, then each expanded node's children, as pages of at
     most 100 in sibling order, each node with its child count, so a collapsed
     row says how many it holds and a long sibling list offers the next page.
   - Behaviour: selecting a row opens its record page. With `reorder: true`, a
     person moves records by drag and by keyboard (up, down, indent, outdent)
     through `data.moveRecord`; a refused move puts the row back and says why.
     A person's expanded rows are kept on this device, keyed by application ID
     and node ID, as section folds are (ADR-0004, 2026-09-24); the file is
     unchanged by them.
   - A file that contains one needs the host version that delivers it, by the
     `minimum_host_version` rule. Diagnostic codes are allocated at delivery.
10. **Import.** Rows of a declared hierarchy are ordered parents first within an
    import. Resolving a parent by a code rather than a record ID is W-075 and
    depends on unique fields (W-074); it is not decided here.
11. **Deletion is unchanged.** A record with children stays `record-referenced`.
    Deleting a subtree is not decided here.
12. **Codes are not part of this decision.** A generated path code (1.2.3) derived
    from a record's position belongs with unique and generated fields (W-074),
    which may build on the sibling order this decision provides.

**Delivery order.** (1) The cost experiment below, before any product code.
(2) Declaration, the cycle rule and the move operation in the Engine, with MCP.
(3) Tree reads, `descendantOf` and the view API. (4) Subtree aggregates.
(5) The Studio outline. (6) The outline surface. (7) The Capability Atlas moves
onto the declaration. The contracts, `../architecture.md` and the MCP vocabulary
change with each stage as it lands, not before.

## Evidence and validation obligations

- **Cost, first.** An experiment on the production table shape at 10,000 records
  and depth 32 measures the cycle check on a parent write, a tree-read window, an
  outline page of 100 children and a subtree Count and Sum, against the existing
  read targets (R06). A result that misses them lowers the bounds in a note on
  this ADR, or reopens Option B as an internal index, before stage 2 starts.
- **One rule for every client.** Engine tests refuse a cycle-closing write from
  set field, create, update, import, a command step, an automatic action, MCP and
  a custom view, each naming the loop. A guard is falsified by removing the
  check and quoting the failure.
- **Declaring on dirty data.** A file with a cycle, a self-parent and a
  too-deep branch fails `schema.declareHierarchy` validation with every record
  named, and the active file is untouched.
- **Move.** Moving a subtree, reordering with and without a gap, and a stale
  version each behave as stated; compensation restores the previous state.
- **Upgrade and recovery.** A file without the new rung opens unchanged; the
  first declaration adds it; an older host refuses writable open by the
  `minimum_host_version` rule (ADR-0012), and a file that never declares one keeps
  its current minimum.
- **Studio and the outline surface.** Measured, not screenshotted: indentation
  by depth, expand and collapse counts, child counts on collapsed rows, the page
  of 100 and the next page, find opening ancestor paths, a move by keyboard and
  by pointer with `reorder` on and none with it off, both themes. Authoring
  refuses an `outlineSurface` on an entity without a hierarchy and a
  `filterClause` under one.
- **The motivating case.** The Capability Atlas drops its own cycle repair and
  parent check and uses the declaration, and `tools/Review-BcmAtlas.ps1` passes.

## Stage 1 note — 2026-09-27: the costs, measured

`tools/Review-HierarchyCost.ps1` builds a file through the Engine's canonical operations:
10,000 records of one entity with a configured self-reference (so the production table
shape and its covering index), 5,000 link records pointing into the tree, one root holding
9,948 of the records, a spine to depth 32, a node with 1,006 children and the rest spread
over the first seven levels. It times the candidate SQL for each read on a read-only
connection, and the writes through the coordinator. Thirty samples after three warm-ups;
two runs on the development machine (Windows x64). The targets were set before the run.

| Measure | p50 | p95 (run 1 / run 2) | Target |
| --- | ---: | ---: | ---: |
| Cycle check, walk from depth 32 | 0.15–0.18 ms | 0.58 / 0.32 ms | 2 ms |
| Cycle check, walk from depth 3 | 0.11–0.12 ms | 0.24 / 0.20 ms | 2 ms |
| Children page of 100 with child counts, first page of 1,006 | 0.37–0.44 ms | 0.67 / 0.76 ms | 150 ms |
| The same, last page | 1.5–1.8 ms | 2.95 / 2.37 ms | 150 ms |
| `descendantOf` page of 100 under the root (9,948) | 28–30 ms | 43.8 / 45.8 ms | 150 ms |
| Subtree Count, Sum and FilteredCount at the root (9,948) | 27–32 ms | 66.3 / 56.7 ms | 150 ms |
| The same at a middle node (462) | 0.8–2.1 ms | 1.5 / 2.7 ms | 150 ms |
| Links related to any node of the root's subtree (4,968) | 37 ms | 56.2 / 58.8 ms | 150 ms |
| Declaration scan of all 10,000 for loops and depth | 15–16 ms | 21.5 / 17.3 ms | 1 s |
| A save that changes one parent (baseline, no check yet) | 17 ms | 22.5 / 24.3 ms | 150 ms |
| One revision renumbering 1,005 siblings | 326–358 ms | 392 / 438 ms | 1 s |

Every answer matched the tree the driver built in memory: the root's 9,948 descendants,
the middle node's 462, depth 32, no unreachable record, and the loop found when the
proposed parent is below the record.

**Conclusions.** The bounds of 32 levels and 10,000 descendants stand. The cycle check
costs at most about 0.6 ms against a save of about 17 ms, so it can run inside every
parent write. No read needs Option B's derived structure; the costs that grow with the
tree (a whole-subtree page, aggregate or related fold) stay under half the read target
at the bound. Renumbering is the one cost that grows with a sibling list; ordering by gaps
of 1,024 makes it rare, and at 1,005 siblings it still stays under half a second. These are
Engine numbers on one machine, without MCP or Workbench, and not a guarantee.

## Stage 2 note — 2026-09-27: declaration, the rule and the move

Delivered at host 1.35.0, as decided, with three refinements that the code taught:

- **A move is a convenience, not a stored operation type.** The architecture requires
  whole-document conveniences to expand into typed operations before history, so
  `data.moveRecord` became `NendoApplicationService.MoveRecordAsync` and the MCP tool
  `nendo.data.move_record`, which write `data.setField` operations in one revision. The
  store's placement rule is what refuses a loop, whoever writes the parent.
- **Reversibility.** Declare and remove are `ReversibleWithRetainedState`, the class of
  their neighbours, and each compensates the other. A move's operations each keep their
  prior value; the one-click compensation covers single-operation revisions, so a move
  that also sets order is undone operation by operation. Point 5's "compensation restores
  every touched record" holds for the operations, not as one click.
- **Declaring requires an optional parent**, and while declared the parent cannot be made
  required and neither field nor the record type can be retired. A required parent would
  leave a tree with no top level.

Evidence: `HierarchyTests` (12 Engine tests: the rung, reopen and host version; the
parent and order rules; refusal over loops and too-deep branches with the file unchanged;
the rule on a field write, a form save and a raw mutation; the depth bound on create and
move; retirement and requirement; compensation both ways; moves into a gap, last, with
renumbering in one revision, and the refusals). Removing the placement call from the field
write and the scan from the declaration made five of them fail ("no exception was
thrown"). `HierarchyProtocolTests` shows the refusal reaching an MCP client with the loop;
without the audited code it read only `NENDO_HIERARCHY_CYCLE: The semantic precondition was
not met.` The output-schema contract exercises the move tool and the schema read's
`hierarchy`.

## Consequences

### Positive

- A tree is valid for everyone who writes to it, not only for the view that drew it.
- Apps stop re-implementing tree logic; a package can rely on the declaration.
- Rollups across levels become possible without scripting.
- Studio can show and restructure a tree, so the data is usable before any custom
  view (vision: data before presentation).
- The planner's initiatives, and any future outline, can use the same shape.

### Negative

- A new protected table and ladder rung, and a raised minimum host version for
  files that declare one.
- Recursive checks and reads in the Engine, with bounds to tune and defend.
- More surface to document and test: an operation pair, a move operation, a tree
  read, a filter, two aggregate forms, a Studio mode and a surface node.
- One hierarchy per entity: a record type that needs two trees (for example,
  reporting and location) must choose one or use a second entity.

## Rejected alternatives

- **Option B as the contract.** Rejected for now: it adds derived structure that
  can drift and that a person cannot read, to solve a cost nobody has measured.
  The obligations above measure it; it can return as an internal index.
- **Option C.** Rejected for now: the need in evidence is single-parent trees with
  order and rollups, which a general acyclic constraint does not give. Dependency
  graphs remain served by link records and custom views.
- **A hidden system position column.** Rejected: the order would be invisible in
  the table and CSV, against the data-before-presentation axiom. The order is a
  declared ordinary field instead.
- **Repairing cycles on declaration.** Rejected: silent repair changes data the
  person has not reviewed. Validation names the records instead.

## Revisit triggers

- The cost experiment misses its targets at 10,000 records or depth 32.
- A real application needs two hierarchies on one entity, or several parents.
- Unique generated codes (W-074) need something this decision does not provide.
- Authors need a filtered outline, or an outline across two record types.
