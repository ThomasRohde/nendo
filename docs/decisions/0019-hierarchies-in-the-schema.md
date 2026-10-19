# ADR-0019: Declare a self-reference as a hierarchy

- **Status:** Accepted
- **Date:** 2026-09-27
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `HierarchyTests`, `HierarchyTreePagingTests`, `HierarchyProtocolTests` and `OutlineSurfaceTests`; `tools/Review-HierarchyCost.ps1` measures the bounds
- **Amends:** ADR-0004 (the `outlineSurface` node) and ADR-0008 (the `SubtreeAggregate` binding and `acrossSubtree` on `RelatedAggregate`)
- **Depends on:** ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0013, ADR-0015
- **Contract:** [relationships](../contracts/relationships.md#a-declared-hierarchy), [queries](../contracts/queries.md), [the outline](../contracts/semantic-surfaces.md#the-outline)

## Context

Many applications are trees: a capability model, an organisation chart, a work breakdown, a
taxonomy. A self-reference (a Reference field whose target is its own record type) stores one,
but on its own it refuses no cycle, has no sibling order, and rolls up only one level. An
invariant that holds only in one view's code does not hold: Studio, an import or an agent can
still close a loop. So the rule belongs in the Engine, where every write passes (ADR-0005), and
the tree stays ordinary relational data that the table and CSV show.

## Decision

A record type may declare one self-reference as its hierarchy. The parent and the order stay
ordinary columns.

1. **Declaration.** `schema.declareHierarchy { entityId, parentFieldId, orderFieldId? }`. The
   parent field is an optional Reference configured to the same record type; the order field, if
   named, an Integer field of it. One hierarchy per record type. Stored in `__nendo_hierarchy`,
   the layout ladder's `-hierarchy-` rung (host 1.35.0). `schema.removeHierarchy { entityId }`
   returns the field to an ordinary self-reference and keeps every value. Both are definition-lane
   operations, `ReversibleWithRetainedState`, each compensating the other.
2. **Declaring validates the data.** A loop or a self-parent fails validation as
   `hierarchy-cycle-present`, naming every record on each loop; a branch deeper than 32 levels as
   `hierarchy-too-deep`. Nothing is repaired; the person fixes the data through ordinary writes.
3. **The cycle rule.** Once declared, every write that sets the parent (create, set field, form
   save, import, command step, automatic action, custom view, agent) is refused as
   `hierarchy-cycle` when the new parent is the record or one of its descendants, naming the
   loop. The store's placement check walks up from the new parent, so it costs the depth.
   Depth is bounded at **32 levels** (`hierarchy-too-deep`).
4. **While declared**, the parent cannot be made required (`hierarchy-parent-required`), and
   neither field nor the record type can be retired. Removing the hierarchy is
   `hierarchy-field-in-use` while an outline surface, a subtree aggregate or a `HierarchyPath`
   (ADR-0020) reads it.
5. **Order.** Siblings sort by the order field (negative, then positive, then records without an
   order), then by record ID; without an order field, by record ID. Declaring with an order field
   creates `nendo_tree_{table}` on (parent, order, record ID), outside the protected namespace;
   removing drops it. Without one, the reference index serves.
6. **Move.** `MoveRecordAsync` (MCP `nendo.data.move_record`, Studio and the outline, the view
   API's `records.move { entityId, recordId, version, parentRecordId, parentVersion,
   beforeRecordId }`) sets the parent and, with an order field, places the record before a
   sibling or last. It is a convenience, not a stored operation type: it writes `data.setField`
   operations in one revision, compensated as a record revision (ADR-0023). When the neighbours
   leave no integer gap, the smallest run of siblings around the insertion point that fits is
   renumbered in the same revision; a sibling without an order joins the run. The result's
   `recordIds` names every record written. A custom view's actor may call it; its revision's
   origin is `extension:‹package›`.
7. **Reads.** The tree read (`NendoTreeQuery`, the view API's `records.tree` and `treeAll`, MCP
   `nendo://application/entity/{entityId}/tree`) walks depth-first from a root or the top level,
   1 to 32 levels deep, giving each node its parent, depth and child count. It pages by key: the
   signed cursor names the record the last page ended on and is bound to the change sequence, so a
   page costs its own records and the levels above it. `descendantOf` is a filter operator on the
   parent field, honoured by pages, counts and aggregates; it walks the subtree once per
   statement, so the tree read is the read for a whole large subtree. Neither has a size bound;
   the file is the bound. A read-only file walks its snapshot the same way.
8. **Subtree aggregates.** ADR-0008's `SubtreeAggregate` (Count, FilteredCount, Sum) folds a
   record's descendants; `includeSelf: true` adds the record. `acrossSubtree` on a
   `RelatedAggregate` folds the related records pointing anywhere into the subtree. A counted or
   summed field must be required; a member without a value is an error, never zero. Both stop at
   `limits.hierarchy.maximumAggregatedDescendants` (**10,000**) and are an error past it, never a
   partial total, because a calculation runs for every record a read returns. `includeSelf` and
   `acrossSubtree` enter the canonical body only when true.
9. **Studio.** Data opens a record type with a hierarchy as an outline, with a Table switch: a
   pinned, indented first column in the same AG Grid Community table, read one level at a time
   (`data.treeRecords`, pages of 200, a *Show more* row). Buttons and **Alt+Shift+arrow** move the
   focused record; Enter or Space opens or closes it.
10. **The outline surface.** ADR-0004's `outlineSurface` (host 1.36.0) shows a declared hierarchy
    in an application: `entityId` (`NUI430` without a hierarchy), `title`, `titleFieldId`
    (`NUI431`), `accentFieldId` (`NUI432`), `expandDepth` 1 to 4, default 2 (`NUI433`), `reorder`
    (`NUI434`, default false), and ordered `fieldBinding` columns, which may be subtree
    aggregates. `filterClause` is refused: a filtered tree hides the ancestors that give a match
    its meaning. A find box opens the matches' ancestor paths instead. The full behaviour is in
    the [semantic-surfaces contract](../contracts/semantic-surfaces.md#the-outline).
11. **Import** orders the rows of a declared hierarchy parents first. A reference column may name
    its target by a unique field (ADR-0020).
12. **Deletion is unchanged.** A record with children is `record-referenced`.

## Consequences

- A tree is valid for every writer, and packages rely on the declaration instead of repeating
  cycle repair and parent checks.
- Rollups across levels need no script, and Studio can show and restructure a tree before any
  custom view exists.
- A protected table, a ladder rung and a raised minimum host for files that declare one.
- One hierarchy per record type: a type that needs two trees chooses one or uses a second type.

## Rejected alternatives

- **A derived closure table or nested sets as the contract:** derived structure that can drift and
  a person cannot read, for a cost the measurements do not show.
- **A general acyclic constraint over any references:** gives no single parent, order or rollup;
  dependency graphs stay link records.
- **A hidden position column:** the order would vanish from the table and CSV.
- **Repairing cycles on declaration:** changes data the person has not reviewed.

## Revisit triggers

- A whole tree read stops growing in line with what it returns.
- The file's row bound moves (ADR-0012), so a tree can pass 98,000 records.
- An application needs two hierarchies on one record type, or several parents.
- Authors need a filtered outline, or an outline across two record types.
