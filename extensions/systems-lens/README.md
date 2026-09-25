# Systems Lens

A custom view for [Nendo Station](../../docs/design/nendo-station-plan.md): components as
nodes, the feeds between them as links. An arrow points **from the component that supplies
to the one it supplies**, so reading left to right is reading the direction of supply.

What it shows that a list cannot:

- **Direction of supply.** Longest-path layering over the condensed graph puts each
  component to the right of everything that feeds it.
- **Circuits, named exactly.** A coolant loop *is* a cycle, and so is a water loop that
  returns to the tank it draws from. Strongly connected components are marked `loop`; a
  component merely standing in front of one is not.
- **What is connected to one component.** Select it and press Focus: everything not
  upstream or downstream dims.
- **What would lose every path.** See below.
- **A text alternative** listing each component's feeds in and out, and, in take-out mode,
  every verdict by name.

Selecting a component asks Nendo to open it.

## Take out, and the line it does not cross

Select a component and press **Take out**. The lens recomputes what the declared sources
still reach without it, and answers in three:

| Verdict | Meaning |
| --- | --- |
| **no path** | It was reachable before, and without that component nothing reaches it |
| **still fed** | It is downstream of the removed component and keeps a declared path anyway |
| *(unmarked)* | Not downstream of it at all |

The difference between the first two is the whole point. A radiator fed by two pumps does
not go dark when one is taken out, and a view that painted everything downstream would say
it did. A banner states, while the mode is on and not dismissibly:

> Structural what-if over declared feeds. It says which components lose every declared
> path — not what will fail.

Three refusals hold that line:

- **Nothing is written.** Take-out is page state, cleared by Escape and by every re-read of
  the file, and the view asks Nendo for reads and for opening a record, nothing else.
- **Stored state does not propagate.** A component already Offline is outlined so it can
  be seen, and is *not* treated as removed. Colour is what the file says; take-out is what
  somebody asked. Merging the two would make the lens assert a failure model it has not got.
- **No timing, capacity or physics.** The graph knows what is declared to feed what. It
  knows nothing about pressure, heat, flow or margin.

The **sources** are the components nothing declares a feed into (a tank, an array, a
sensor), and they are read once from the whole graph. Recomputing them without the removed
component would turn a component fed only by it into a source of its own, and the one thing
this view exists to say would be exactly the thing it got wrong.

## What it reads

Everything arrives through `window.nendo`, which `<script src="/_nendo/api.js">` installs:

- `nendo.view.loadGraph()`: components as nodes and feeds as links. **The first field the
  view binds on the component's own record type is the system the schematic bands by**;
  for Nendo Station that is `componentSystem`, a reference, shown by the name of the
  system it points at. Where the schematic says something about a component it reads
  `THERM · Coolant pump A`. A component without a system is simply unbanded.
- `nendo.schema.describe()`: to show the State by its choice's name. The state tones are
  the station's own (Online, Standby, Offline, Removed); any other value is drawn neutral.
- `nendo.ui.theme` and the `theme` event. The palette is Nendo's own: `api.js` sets the
  Workbench's colour tokens on the page as `--nendo-*`, and `lens.css` draws with them, so
  the schematic sits with the app rather than beside it. The values after each token in
  `lens.css` are used only when the page runs without them.
- The `changes` event: the lens reads again a quarter of a second after the file changes,
  ends any take-out, and keeps the selected component selected while it is still there.
- `nendo.ui.openRecord(entityId, recordId)`: opening the selected component.

A read that Nendo refuses is shown in the summary line.

## Putting it into a file

In Studio → Surfaces → Custom views, choose **Import** and pick this folder's
`nendo-package.json`. The package arrives as a proposal to review, and once it is accepted
the file carries the code. An agent does the same over MCP with `extension.setPackage` and
one `extension.putFile` for each file.

Show it with an `extensionGraphSurface` whose `packageId` is `org.nendo.systems-lens`. It
binds the node type to Components, the edge type to Feeds, whose two Reference fields both
point at Components, and `componentSystem` as its first field. See
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-SystemsLens.ps1` serves this folder on one origin and a fixture broker
on another, and runs the real `api.js` between them in Playwright (msedge). Its fixture
carries a reservoir feeding two pumps onto one manifold, a cold plate hanging off one pump
alone, a three-component coolant circuit, an isolated sensor, a component stored Offline, a
parallel feed and a markup-shaped label. It measures the layering, exact circuit membership
and circuit legs, the band read from the System reference's name, state names read from the
schema, the summary counts, exactly one `ui.openRecord` per selection, **both take-out
verdicts by name**, the text alternative, that the view asks only for reads and for opening
a record, Focus dimming, keyboard traversal, non-selectable chrome, a re-read only after a
`changes` event that ends a take-out and keeps the selection, one read for a burst of
changes, a dark `theme` event and a canvas token changing the measured colour, the empty
state, 500 components and 999 feeds read in pages, a refused read shown as text and a
512×384 window. It runs inside `Test-Production.ps1`.

When the verdict assertion was written it was falsified: with every component downstream of
the removed one counted as exposed, the lane reported seven exposed and none still fed,
where the answer is two and five.
