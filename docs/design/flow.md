# Flow

W-163 builds an app for repeatable procedures that an agent walks, asked for by
the owner on 2026-10-05. A flow is drawn in xyflow; a run of it is ordinary
records, and Nendo's own actions decide where a run may go. It stays within
ADR-0013: a custom view carries its code in the file, and the routing is
ADR-0008 behaviour. No host change is needed.

## The model

| Record type | Holds |
| --- | --- |
| Flow (`fl.flow`) | Name, a unique key, purpose |
| Step (`fl.step`) | Name, a unique key, its flow, kind (Start, Step, End), instructions, *Done when*, position |
| Edge (`fl.edge`) | Outcome, *Choose when*, its flow, from and to; copies of its ends' keys and kinds and its flow's key |
| Run (`fl.run`) | Title, flow, the chosen edge; the current step's key, status and path, all written by Nendo |

xyflow is a projection of the Step and Edge records. Gestures stay in a local draft
until **Save** commits the net difference as one version-checked batch.

## Routing

The spike (`FlowRunTests`, C-480) showed the shape; `FlowAppTests` installs the
operations the build ships and walks them.

- An action on Edge copies its ends' keys and kinds as text whenever the edge is
  drawn or redrawn. A formula compares text, never a reference, and a step reaches
  only one hop, so the run reads them from the edge.
- **Begin.** A run is created with `choice` set to an edge. Its action takes the
  edge's target only when the edge leaves a Start of the run's own flow, and
  refuses otherwise.
- **Move.** Setting `choice` runs an action that takes the edge's target only
  when the edge leaves the run's current step in the same flow. Otherwise
  `Refuse()` stops the whole save, so nothing changes and no revision is written.
- **Hold.** A trigger on the current step refuses any value other than the target
  of the chosen edge. It sorts before the move, so a write that sets a step and an
  edge together meets it first: the step must be where the edge leads, and the move
  then needs the edge to leave that same step. Only a self-loop passes both, and it
  goes nowhere.
- **Keep.** A step's key and kind are refused once drawn, because edges and runs
  name it by key.

What it does not claim: the agent still decides which outcome happened, and the
path is a convenience that nothing checks. History records every write and its
origin. An agent holding the lease can still delete a run or edit a flow; this
holds procedure, not access.

## Walkable

The view lists what stops a flow from being walked the same way every time: one
Start with one edge out, at least one End, an outcome on every edge and no two
alike from one step, instructions on every step, every step reachable from the
Start and able to reach an End.

## Acceptance

W-163 holds the criteria. The lanes are `node --test tools/flow/*.test.mjs`,
`FlowAppTests` and `FlowRunTests` in the Engine suite, and `tools/Review-Flow.ps1`
in the browser against the fixture broker. A walk over MCP against the accepted
file is the agent-observed check; it needs the owner to accept the proposal and
approve the file's actions.

## Build and handoff

Source: `extensions/flow/`; the bundle recipe, schema, behaviour and tests:
`tools/flow/`; MCP authoring: `tools/Build-Flow.mjs`; intended file:
`workspace/Flow.nendo`. The build refuses the development planner and any
nonempty target, takes a short lease, validates one proposal and releases the
lease. Acceptance is the owner's action.
