# Work dependencies

A custom view for the Nendo Development planner: work items as nodes, and what blocks
what as links. An arrow points **from the item that blocks to the item it blocks**, so
reading left to right is reading the order the work has to happen in.

It is a separately versioned, unsigned package with no dependencies, downloads or write
operations, implementing protocol 1. It reads only the bounded projection Nendo approves
— a label and one status per item, plus the link endpoints. Opening a record and editing
it stay with the host.

What it shows that a list cannot:

- **Order.** Longest-path layering puts each item one column right of the last thing
  blocking it.
- **Cycles, named exactly.** Strongly connected components are marked `cycle`, and an
  item merely standing *behind* a cycle is not marked — the distinction a
  "whatever did not settle" pass gets wrong.
- **What is free to start.** The summary counts the items nothing blocks.
- **What one item is connected to.** Select an item and press Focus: everything not
  upstream or downstream of it dims.
- **A text alternative** listing each item's blockers and blocked, for a dense graph or
  a screen reader.

Statuses are drawn in the planner's own tones (Inbox, Ready, Doing, Blocked, Review,
Done, Dropped); any other status is drawn neutral rather than guessed at.

## Building and pinning

```powershell
pwsh ./tools/Build-NendoWorkDependenciesPackage.ps1
```

The output is `artifacts/extensions/org.nendo.work-dependencies-0.1.0.nendoview` and the
command prints its exact SHA-256, which is what a file pins. Entry timestamps, entry
order and manifest key order are fixed, so unchanged source produces the same digest;
rebuilding after any edit produces a different package, which must be installed and
allowed again. Nendo's installer does not ship it.

Its `extensionGraphSurface` binds the node type to Work items and the edge type to a
dependency record type whose two Reference fields both point at Work items. Writing
one is described in [authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-WorkDependencies.ps1` runs the pinned Playwright CLI against a
task-owned local server with a fixture carrying a chain, an isolated item, a three-item
cycle, an item behind that cycle, a duplicate link and a markup-shaped label. It measures
the layering, exact cycle membership and cycle edges, the summary counts, selection and
its message, Focus dimming, keyboard traversal, the text alternative, non-selectable
chrome, generation replacement, the empty state, both themes and a 512×384 compact
window. It runs inside `Test-Production.ps1`.

It is a package presentation check. It does not establish AppContainer containment,
native composition or the install/consent journey; those belong to the host and are
measured separately in the custom-view contract.
