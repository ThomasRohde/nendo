# Work dependencies

A custom view for the Nendo Development planner: work items as nodes, and what blocks
what as links. An arrow points **from the item that blocks to the item it blocks**, so
reading left to right is reading the order the work has to happen in.

What it shows that a list cannot:

- **Order, laid out properly.** The Eclipse Layout Kernel's layered algorithm puts each
  item to the right of what blocks it and routes every link at right angles around the
  items. It runs in a Web Worker, so a large plan never stalls the view. If it cannot
  run, a simpler layering is drawn and the summary says so.
- **Groups.** Group by any reference or choice field of the work items, such as an
  initiative, a horizon or a status. Each group becomes a box, and links cross between
  boxes.
- **What is linked, and what is not.** Items linked to nothing wait on a shelf below the
  drawing, grouped the same way, instead of stretching it. **Linked only** hides the
  shelf.
- **Cycles, named exactly.** Strongly connected components are marked `cycle`, and an
  item merely standing *behind* a cycle is not marked, which is the distinction a
  "whatever did not settle" pass gets wrong.
- **The longest chain.** **Longest chain** marks the longest run of work that has to
  happen one item after another, with each cycle's own links set aside, and names it
  below the drawing.
- **What is free to start.** The summary counts the items nothing blocks.
- **What one item is connected to.** Select an item and press **Focus**: everything not
  upstream or downstream of it dims.
- **Filter and find.** **Filter** hides statuses, such as Done and Dropped. **Find**
  dims everything whose title does not match, and Enter opens the first match.
- **A text alternative** listing each item's blockers and what it blocks, for a dense
  graph or a screen reader.

The grouping, the hidden statuses and **Linked only** are remembered on this device for
this file. The view's configuration can set their first-time defaults:

```json
{ "groupBy": "nd.work.initiative", "hideStatuses": ["Done", "Dropped"], "linkedOnly": false }
```

Statuses are drawn in their choices' own tones, falling back to the planner's names for
Inbox, Ready, Doing, Blocked, Review, Done and Dropped; any other status is drawn neutral
rather than guessed at. Selecting an item asks Nendo to open it.

**Acting where you are.** A selected item offers its record type's own commands below
the drawing, the ones its record page offers: in the planner, Plan now, Start work, Send
to review, Complete and Reopen. Pressing one runs it on that item at the version the view
read. The graph follows the change, and the line below says what was done. If somebody
changed the item since the view read it, nothing happens, the view says so and reads it
again, and the next press uses the item as it now is. A command the item already has
what it sets, such as Complete on a Done item, is greyed out, as the record page greys
it. Nendo asks nothing first: the change
is in History under this package's name, where you can undo it. A file open read-only
offers nothing to press.

## What it reads

Everything arrives through `window.nendo`, which `<script src="/_nendo/api.js">`
installs:

- `nendo.view.loadGraph()`: work items as nodes and dependency records as links, each
  with its whole record, which is where a group's value comes from;
- `nendo.schema.describe()`: the Status by its choice's name and tone, and the fields
  that can group;
- `nendo.ui.theme` and the `theme` event: the Workbench's colours, as `--nendo-*`;
- the `changes` event: the view reads again a quarter of a second after the file
  changes, and keeps the selected item selected while it is still there;
- `nendo.ui.openRecord(entityId, recordId)`: opening the selected item;
- `nendo.commands.run(commandId, record)`: running a record command on the selected item
  (ADR-0013 Phase 3), since 2.1.0.

It changes records only through the file's own record commands. A read that Nendo refuses
is shown in the summary line, and a refused command in the line below the drawing.

## Third-party code

`vendor/elkjs/` holds elkjs 0.12.0, unchanged, under the Eclipse Public License 2.0. Its
`README.md` records the source, the licence and each file's SHA-256. The rest of this
package is under `LICENSE.txt`.

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
behind that cycle, a duplicate link, a markup-shaped label and an initiative to group
by. It measures that ELK laid the drawing out; that every link runs at right angles from
the blocker's edge to the blocked item's edge and no two items overlap, ungrouped and
grouped; that the item linked to nothing is on the shelf; that each group's box holds
exactly its items; that Filter, Linked only, Longest chain and Find do what they say;
that the grouping survives a reload; and the layering, exact cycle membership and cycle
edges, the summary counts, status names and
tones read from the schema, exactly one `ui.openRecord` per selection, Focus dimming,
keyboard traversal, the text alternative, non-selectable chrome, a re-read only after a
`changes` event that keeps the selection, one read for a burst of changes, a measured
colour change on a dark `theme` event, the empty state, a refused read shown as text
and a 512×384 window. It runs inside `Test-Production.ps1`.
