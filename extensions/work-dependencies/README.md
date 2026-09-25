# Work dependencies

A custom view for the Nendo Development planner: work items as nodes, and what blocks
what as links. An arrow points **from the item that blocks to the item it blocks**, so
reading left to right is reading the order the work has to happen in.

What it shows that a list cannot:

- **Order.** Longest-path layering puts each item one column right of the last thing
  blocking it.
- **Cycles, named exactly.** Strongly connected components are marked `cycle`, and an
  item merely standing *behind* a cycle is not marked, which is the distinction a
  "whatever did not settle" pass gets wrong.
- **What is free to start.** The summary counts the items nothing blocks.
- **What one item is connected to.** Select an item and press Focus: everything not
  upstream or downstream of it dims.
- **A text alternative** listing each item's blockers and what it blocks, for a dense
  graph or a screen reader.

Statuses are drawn in the planner's own tones (Inbox, Ready, Doing, Blocked, Review,
Done, Dropped); any other status is drawn neutral rather than guessed at. Selecting an
item asks Nendo to open it.

## What it reads

Everything arrives through `window.nendo`, which `<script src="/_nendo/api.js">`
installs:

- `nendo.view.loadGraph()`: work items as nodes and dependency records as links;
- `nendo.schema.describe()`: to show the Status by its choice's name, which also picks
  its tone;
- `nendo.ui.theme` and the `theme` event: light or dark;
- the `changes` event: the view reads again a quarter of a second after the file
  changes, and keeps the selected item selected while it is still there;
- `nendo.ui.openRecord(entityId, recordId)`: opening the selected item.

It writes nothing. A read that Nendo refuses is shown in the summary line.

## Putting it into a file

In Studio → Surfaces → Custom views, choose **Import** and pick this folder's
`nendo-package.json`. The package arrives as a proposal to review, and once it is
accepted the file carries the code. An agent does the same over MCP with
`extension.setPackage` and one `extension.putFile` for each file.

Show it with an `extensionGraphSurface` whose `packageId` is
`org.nendo.work-dependencies`. It binds the node type to Work items and the edge type
to a dependency record type whose two Reference fields both point at Work items. See
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-WorkDependencies.ps1` serves this folder on one origin and a
fixture broker on another, and runs the real `api.js` between them in Playwright
(msedge). Its fixture carries a chain, an isolated item, a three-item cycle, an item
behind that cycle, a duplicate link and a markup-shaped label. It measures the
layering, exact cycle membership and cycle edges, the summary counts, status names and
tones read from the schema, exactly one `ui.openRecord` per selection, Focus dimming,
keyboard traversal, the text alternative, non-selectable chrome, a re-read only after a
`changes` event that keeps the selection, one read for a burst of changes, a measured
colour change on a dark `theme` event, the empty state, a refused read shown as text
and a 512×384 window. It runs inside `Test-Production.ps1`.
