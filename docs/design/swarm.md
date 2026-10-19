# Swarm

An offline creature-behaviour playground as a Nendo app. `workspace/Swarm.nendo` carries the app
and `extensions/swarm/` is its view. It stays within ADR-0013: a custom view carries its code in
the file and uses typed application services. It needs no host change and runs no background
simulation.

The main screen pairs a habitat with a bpmn-js behaviour editor. The habitat is the visual focus;
controls and the inspector use Nendo's theme tokens. At narrow widths the editor sits below the
habitat. Colour identifies creature states, with names and counts beside it. The simulation starts
paused, so the person chooses when motion begins.

Species, behaviour nodes, transitions, habitats and experiments are ordinary records. bpmn-js is a
projection of the node and link records, not the authoritative XML document. Diagram gestures stay
in a local draft until Save behaviour commits the net difference as one version-checked batch,
with target versions for references. A refused save keeps the draft; a change elsewhere is
reported and cannot be overwritten.

Supported behaviour is one start, actions (Wander, Gather, Align, Flee, Rest), exclusive decisions
(Nearby, Disturbed, Crowded) with Yes and No paths, and optional ends. There are no parallel
tokens, general expressions or workflow execution. A bounded interpreter drives each creature
independently. Spatial buckets bound neighbour searches; a seeded generator and fixed steps make
runs repeatable. Population and steps are bounded. Pointer disturbances are simulation events, not
database writes.

An experiment stores the captured model, seed, step count and disturbances in a text snapshot,
with a name and summary as separate fields. Replay uses that captured model, even after the live
behaviour changes. Creature positions are derived, never written on animation frames.

## Build and checks

- `tools/Build-Swarm.mjs` authors the complete app over MCP into an empty, host-created file and
  validates it as a proposal; it never accepts one. It refuses a development planner and any
  non-empty target, and releases its lease after validating.
- `tools/Add-SwarmSpecies.mjs` adds a species recipe through typed writes, with no schema change.
- `tools/swarm/` holds the definition, the dependency bundle recipe and the unit tests
  (`node --test tools/swarm/*.test.mjs`).
- `pwsh ./tools/Review-Swarm.ps1` (`tools/Gate-Swarm.mjs`) drives the view.

Between them they measure that editing a graph changes trajectories, presets differ, invalid
graphs fail with diagnostics, Play, Pause, Reset and disturbance work, a save is one batch, a
refusal keeps the draft, experiments replay after reopening, and Light, Dark, the narrow layout and
the state counts read.
