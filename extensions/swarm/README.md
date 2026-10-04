# Swarm

An offline Nendo application: edit creature behaviours with bpmn-js, watch a
habitat, and capture experiments that replay their original rules and events.
The app opens paused. Choose Murmuration, Fireflies or Skittish, press Play, and
click the habitat to startle a group. Alt+P toggles playback.

## Behaviour

Select a box to choose Wander, Gather, Align, Flee or Rest and its duration in
fixed steps (60 per simulated second). A decision asks Nearby, Disturbed or
Crowded and needs a Yes path and a No path. The node's ↗ control starts a
connection; × removes it. Add Action and Add Decision create nodes. bpmn-js's
local diagram undo/redo applies to diagram gestures; inspector parameters are
part of the draft but do not claim that undo. Save behaviour (Ctrl+S) commits the
net draft as one version-checked batch. Reload saved discards the local draft.

Play after an edit starts from the seed with the edited graph. An existing run
always keeps the rules it began with. Save experiment captures that run, its
seed, step count and disturbances. Replay reconstructs the captured end state;
Play can continue from there. Reload saved returns to the live species.

## Records and limits

Five record types keep Species, Behaviour nodes, Transitions, Habitats and
Experiments accessible in Studio and over MCP. Connection bendpoints are JSON
text on each Transition; experiment snapshots are versioned JSON text on each
Experiment. No XML blob is the authoritative behaviour, no creature position is
stored each frame, and there is no host code or background job.

One selected species runs in one habitat: the first habitat is used, and its
size can be edited in Studio. Bounds: 1–500 creatures, 32 nodes, 64 transitions,
18,000 steps (five simulated minutes), 256 disturbances. Conditions use current
neighbours; Nearby means at least one, Crowded means eight or more, and Disturbed
means within 200 habitat units of a disturbance less than 150 steps old.
Habitat edges wrap. The simulation is an illustrative playground, not a
biological or scientific prediction.

The graph supports start events, tasks, exclusive gateways and end events.
Parallel tokens, arbitrary expressions and general BPMN execution are outside
this app. Simulation stops with its view; the file has no automatic actions.
Unsaved drafts last in the open view only. Save before switching Nendo tabs or
closing the file. Refused saves keep the draft and show the reason.

## Build

The optional **Lantern Colony** species has 300 creatures, 19 nodes, eight
decisions and 27 transitions. It scouts, gathers, avoids crowds, travels and
rests together, and repeats its escape until the disturbance passes. Add it
to an existing Swarm file with Edit data enabled:

```powershell
node tools/Add-SwarmSpecies.mjs --dry-run
node tools/Add-SwarmSpecies.mjs --endpoint http://127.0.0.1:PORT/mcp
```

The recipe is `tools/swarm/lantern-colony.mjs`. Its routing avoids unrelated
nodes; the builder checks a seeded run and exact replay before creating 47
ordinary records, then reads the saved graph back. It preserves existing
species and refuses to overwrite a conflicting Lantern Colony recipe.

From the repository root:

```powershell
npm.cmd ci --prefix tools/swarm --ignore-scripts --no-audit --no-fund
node tools/swarm/bundle.mjs
node tools/Build-Swarm.mjs --dry-run
node tools/Build-Swarm.mjs --endpoint http://127.0.0.1:PORT/mcp
pwsh ./tools/Review-Swarm.ps1
```

Make an empty `Swarm.nendo` through Nendo's New file route, open it and enable
Shape app. The builder refuses planners and nonempty files. It validates one
proposal containing the schema, presets, screens and package, releases the
lease, and leaves acceptance to the owner. The title is:
**Swarm: living habitat, editable behaviours and replayable experiments**.

Minimum host 1.42.0 (a custom view that opens the file). The package carries
bpmn-js 18.19.0 from its npm distribution; `tools/swarm/package-lock.json` pins
the rebuild. The bpmn.io watermark and its link remain visible as required by
`vendor/bpmn-js.LICENSE.txt`. No remote script or font is loaded.

The measurement lane uses the real view API and Nendo toolbar rules in a
cross-origin browser fixture. It checks geometry, drafts, typed writes, stale
refusals, captured replay, reopen, Light/Dark and narrow layout. It is included
in Test-Production. Native host acceptance/runtime is a separate owner gate.
