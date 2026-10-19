# Dependency graph

A custom view that draws one record type as nodes and a link record type as directed
edges between them. Cycles, self-links and parallel links are all drawn, and every link
ends outside the record it points at, so its arrowhead shows whichever way it runs. A link
between two records in one column runs beside the column, down its right side or up its
left, bowed further for each parallel link, so a cycle or a pair reads as two lines and no
link passes through a record it does not join. It has
pointer pan, wheel and button zoom, keyboard traversal, visible focus, a text view that
lists each record's incoming and outgoing links, and both themes. Labels are set as text,
so a label that looks like markup stays text.

The records are one tab stop, and the arrow keys go to the nearest record in that direction
on the drawing; on the canvas itself they pan. That is the view kit
(`kit/nendo-view-kit.js`, copied from `tools/view-kit`). The graph is fitted when it opens,
on Fit and on Ctrl 0. Once the person zooms or pans, a re-read keeps their zoom, and keeps the
selected record, or else the focused one, at the same point on screen even when records added
or taken away move it on the grid; a graph in which none of the records they saw is left is
fitted again. The keyboard stays on the record it was on.
A link to a record this view does not show is not drawn, and the summary counts it as a
connection outside this view.

Selecting a record, with the pointer, Enter or the text view, highlights its links and
asks Nendo to open it.

## In Nendo's toolbar

On a Nendo that offers it, this view draws no controls and no title of its own. The zoom
(Ctrl − and Ctrl + zoom, Ctrl 0 fits) and Text view are in Nendo's toolbar above the graph,
in Ctrl K under the view's title, and on their keys. A right-click on a record opens
Nendo's menu, with Open record. The summary line is Nendo's row's text, and the hint is
behind About, shown over the graph until Escape; the graph starts at the top of the frame.
A problem reading the file stays in the frame, whole. On a Nendo without the toolbar the view
shows its own controls and lines.

## What it reads

Everything arrives through `window.nendo`, which `<script src="/_nendo/api.js">`
installs:

- `nendo.view.loadGraph()`: the view's records as nodes, labelled by the definition's
  label field, and its link records as edges;
- `nendo.schema.describe()`: to show a status by its choice's name rather than its
  stored ID;
- `nendo.ui.theme` and the `theme` event. The palette is Nendo's own: `api.js` sets the
  Workbench's colour tokens on the page as `--nendo-*`, and `graph.css` draws with them.
  The values after each token in `graph.css` are used only when the page runs without
  them;
- the `changes` event: the graph reads again a quarter of a second after the file
  changes, and keeps the selected record selected while it is still there;
- `nendo.ui.openRecord(entityId, recordId)`: opening the selected record;
- where the host offers them, `nendo.ui.setToolbar`, `nendo.ui.showMenu` and the `command`
  event, for the controls and the menu above.

It writes nothing. A read that Nendo refuses is shown in the summary line.

## Putting it into a file

In Studio → Screens → Custom views, choose **Import** and pick this folder's
`nendo-package.json`. The package arrives as a proposal to review, and once it is
accepted the file carries the code. An agent does the same over MCP with
`extension.setPackage` and one `extension.putFile` for each file.

Show it with an `extensionGraphSurface` whose `packageId` is
`org.nendo.dependency-graph`. The definition binds the node type, its label and status
fields, the link type and the link's two reference fields. See
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-NendoGraph.ps1`, inside `Test-Production.ps1`, serves this folder on one
origin and a fixture broker on another, and runs the real `api.js` between them in Playwright
(msedge). It measures the node, edge and parallel-edge geometry, nodes opening inside the
canvas, status names from the schema, markup-shaped labels, one `ui.openRecord` per selection
from the pointer, the keyboard and the text view, zoom, non-selectable chrome, re-reads after
`changes` (one for a burst) that keep the selection, the zoom and pan, the selected record's
place and the one tab stop, the dark theme and the canvas and surface tokens, 480×320 and
512×384 windows, exact summary counts, the empty state, a refused read, a connection outside
the view counted in the summary, every arrowhead outside the record it points at, a
same-column cycle and parallel pair drawn as separate lines, no link through a record it does
not join on grids of five and thirteen, and each arrow key reaching the nearest record. Then,
on a broker that offers Nendo's toolbar: no controls or title of its own, each declared
command, and Open from the record menu.
