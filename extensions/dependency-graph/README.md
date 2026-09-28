# Dependency graph

A custom view that draws one record type as nodes and a link record type as directed
edges between them. Cycles, self-links and parallel links are all drawn. It has pointer
pan, wheel and button zoom, keyboard traversal, visible focus, a text view that lists
each record's incoming and outgoing links, and both themes. Labels are set as text, so
a label that looks like markup stays text.

Selecting a record, with the pointer, Enter or the text view, highlights its links and
asks Nendo to open it.

## In Nendo's toolbar

On a Nendo that offers it, this view draws no controls and no title of its own. The zoom
(Ctrl − and Ctrl + zoom, Ctrl 0 fits) and Text view are in Nendo's toolbar above the graph,
in Ctrl K under the view's title, and on their keys. A right-click on a record opens
Nendo's menu, with Open record. The summary line is Nendo's row's text, and the hint is
behind About, shown over the graph until Escape; the graph starts at the top of the frame.
A problem reading the file stays in the frame, whole. On an older Nendo the view shows its
own controls and lines, as it always has.

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

In Studio → Surfaces → Custom views, choose **Import** and pick this folder's
`nendo-package.json`. The package arrives as a proposal to review, and once it is
accepted the file carries the code. An agent does the same over MCP with
`extension.setPackage` and one `extension.putFile` for each file.

Show it with an `extensionGraphSurface` whose `packageId` is
`org.nendo.dependency-graph`. The definition binds the node type, its label and status
fields, the link type and the link's two reference fields. See
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-NendoGraph.ps1` serves this folder on one origin and a fixture
broker on another, and runs the real `api.js` between them in Playwright (msedge). It
measures the node, edge and parallel-edge geometry, that nodes open inside the canvas,
status names read from the schema, markup-shaped labels, exactly one `ui.openRecord`
per selection from the pointer, the keyboard and the text view, zoom, non-selectable
chrome, a re-read only after a `changes` event that keeps the selection, one read for a
burst of changes, a measured colour change on a dark `theme` event, a canvas and a
surface token changing the measured colours, 480×320 and 512×384 windows, exact summary
counts, the empty state and a refused read shown as text. Then it measures the view again
on a broker that offers Nendo's toolbar: no controls or title of its own, the toolbar it
declares, which the broker reads by the Workbench's own rules, each command, and Open from
the record menu. It runs inside `Test-Production.ps1`.
