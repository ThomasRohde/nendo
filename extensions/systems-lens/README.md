# Systems Lens

A custom view for [Nendo Station](../../docs/design/nendo-station-plan.md): components as
nodes, the feeds between them as links. An arrow points **from the component that supplies
to the one it supplies**, so reading left to right is reading the direction of supply.

It is a separately versioned, unsigned package with no dependencies, downloads or write
operations, implementing protocol 2. It reads only the bounded projection Nendo approves —
a name, one state and the system per component, plus the link endpoints. Opening a record and editing
it stay with the host.

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

- **Nothing is written.** Take-out is renderer memory, cleared by Escape and by any new
  projection, and the package has no write capability to lose.
- **Stored state does not propagate.** A component already Offline is outlined so it can
  be seen, and is *not* treated as removed. Colour is what the file says; take-out is what
  somebody asked. Merging the two would make the lens assert a failure model it has not got.
- **No timing, capacity or physics.** The graph knows what is declared to feed what. It
  knows nothing about pressure, heat, flow or margin.

The **sources** are the components nothing declares a feed into — a tank, an array, a
sensor — and they are read once from the whole graph. Recomputing them without the removed
component would turn a component fed only by it into a source of its own, and the one thing
this view exists to say would be exactly the thing it got wrong.

## The system is a disclosed field

Version 0.2.0 speaks protocol 2 (ADR-0013, 2026-09-24). The view names the component's
system as a disclosed field, and **the first node field the projection names is the system
this schematic bands by** — for Nendo Station, `componentSystem`, a reference that arrives
as the system's name. The label is the component's name alone. Where the schematic says
something about a component it reads `THERM · Coolant pump A`, composed here from the two.
A component without a system, or a view that discloses no node field, is simply unbanded.

Version 0.1.0 had no second field to read, so the file packed the system into the label
and this package split it on ` · `. That convention is gone: a label containing the
separator is now just a name, and the consent review names the system field the view
receives.

The state tones are the station's own (Online, Standby, Offline, Removed), drawn in the
same hues Nendo gives those choice tones. Any other value is drawn neutral rather than
guessed at.

## It sits with the app

The palette is Nendo's own, copied from `src/Nendo.Workbench/src/styles/02-tokens.css` into
one block at the top of `lens.css`. No colour crosses the extension boundary — the host
sends one word, light or dark — so that copy can drift if the app's tokens change, and
keeping it in step is a rebuild. The view opens in a pane beside the File menu and the
theme switch, and a palette of its own would read as a foreign window bolted into the
product. [Authoring a custom view](../../docs/custom-view-authoring.md) carries the rule.

## Building and pinning

```powershell
pwsh ./tools/Build-NendoSystemsLensPackage.ps1
```

The output is `artifacts/extensions/org.nendo.systems-lens-0.2.0.nendoview` and the command
prints its exact SHA-256, which is what a file pins. Entry timestamps, entry order and
manifest key order are fixed, so unchanged source produces the same digest; rebuilding after
any edit produces a different package, which must be installed and allowed again.
`tools/Build-NendoStation.mjs pin` reads the digest off the built archive rather than
carrying a copy, so the pin cannot go stale against the package beside it.

Its `extensionGraphSurface` binds the node type to Components and the edge type to Feeds,
whose two Reference fields both point at Components. Writing one is described in
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-SystemsLens.ps1` runs the pinned Playwright CLI against a task-owned
local server with a fixture carrying a reservoir feeding two pumps onto one manifold, a cold
plate hanging off one pump alone, a three-component coolant circuit, an isolated sensor, a
component stored Offline, a parallel feed and a markup-shaped label. It measures the
layering, exact circuit membership and circuit legs, the band read from the disclosed system field, the
summary counts, selection and its message, **both take-out verdicts by name**, the text
alternative, that the view sends nothing but a handshake and a selection, Focus dimming,
keyboard traversal, non-selectable chrome, generation replacement clearing the what-if, the
empty state, the 500-node bound, both themes and a 512×384 compact window. It runs inside
`Test-Production.ps1`.

**The guard was falsified before it was trusted.** With the verdict rewritten as *everything
downstream of the removed component is exposed*, the lane fails:

```text
Error: Taking out pump A named the wrong components as losing every path:
{"exposed":["chiller","hx","manifold","plate","rad","rad2","valve"],"reduced":[],"removed":["pumpA"]}
```

Seven exposed and none still fed, where the answer is two and five. The rule was restored
and the lane re-run to `"systems lens ok"`.

It is a package presentation check. It does not establish AppContainer containment, native
composition or the install/consent journey; those belong to the host and are measured
separately in the [custom-view contract](../../docs/contracts/custom-views.md).
