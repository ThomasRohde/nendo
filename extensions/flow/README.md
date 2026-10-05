# Flow

An offline Nendo application for repeatable procedures. Draw a flow with xyflow
(React Flow): Steps joined by Edges, each edge named by the outcome that takes it.
An agent walks a flow one step at a time over MCP, and Nendo holds where each run
is. The file ships with *Fix a reported defect*, the repository's own loop for
something reported broken.

## Drawing

**Add step** (Alt+N) and **Add end** put a step in the middle of the view. Drag
from the bottom of a step to another step to add an edge; the new edge takes the
first of `next`, `yes`, `no` that its siblings do not use. Select a step or an
edge to name it and write its instructions, its *Done when* or its *Choose when*.
Delete removes the selection, with a step's edges. **Save** (Ctrl+S) writes the
net draft as one version-checked batch; **Reload saved** drops the draft. A
refused save keeps the draft.

A step's key and kind stay as drawn: edges and runs name a step by its key, and
Nendo refuses a changed one. The **Walkable** panel lists what stops a flow from
being walked the same way every time: no Start or End, a Start with other than one
edge out, two edges from one step with the same outcome, a step with no way out,
one that cannot be reached and one from which no End can be reached. Choose a
line to go to the step.

## Runs

A Run is one walk. It begins on the edge that leaves the Start, and from then on
moves only when `fl.run.choice` is set to an edge that leaves the step it is on.
Nendo's own actions write `fl.run.currentKey`, `fl.run.path` and
`fl.run.status`; a run's step written by hand is refused, even beside an edge,
and so is an edge that leaves another step or another flow. History holds every
move. **Runs** lists a flow's runs; choose one to mark its step and the edges it
took, and press an outcome to move it. **For agents** has the steps to give an
agent, with this flow's IDs.

## Records and limits

Four record types: Flows, Steps, Edges and Runs, in Studio and over MCP. Edges
carry copies of their ends' keys and kinds, kept by an action, because a formula
compares text and never a reference. The path is a convenience and is not checked;
History is the record. The agent still decides which outcome happened: Nendo
decides only where that outcome leads.

## Build

`tools/flow/` pins React 19, @xyflow/react 12 and esbuild; `npm run bundle` there
writes `vendor/xyflow.js`, `vendor/xyflow.css` and `vendor/THIRD-PARTY-NOTICES.txt`
(all MIT). `tools/Build-Flow.mjs --endpoint …` authors the app into an empty file as
one proposal; `tools/Review-Flow.ps1` is its browser lane, and `FlowAppTests` walks
the shipped actions in the Engine.
