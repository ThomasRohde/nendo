# Swarm

An offline Nendo application: edit creature behaviours with bpmn-js, watch a habitat, and capture
experiments that replay their rules and events. The design is in `docs/design/swarm.md`. The view
opens paused: choose Murmuration, Fireflies or Skittish, press Play, and click the habitat to
startle a group. Alt+P toggles playback.

## Behaviour

Select a box to choose Wander, Gather, Align, Flee or Rest and its duration in fixed steps (60 per
simulated second). A decision asks Nearby, Disturbed or Crowded and needs a Yes and a No path. A
node's ↗ starts a connection; × removes it. Add Action and Add Decision create nodes. bpmn-js's
undo and redo cover diagram gestures, not inspector parameters. Save behaviour (Ctrl+S) commits
the net draft as one version-checked batch.

Play after an edit starts from the seed with the edited graph; a running simulation keeps the
rules it began with. Save experiment captures the run, its seed, step count and disturbances.
Replay reconstructs the captured end state, and Play continues from there. Reload saved returns to
the live species and discards the draft.

## Records and limits

Five record types hold Species, Behaviour nodes, Transitions, Habitats and Experiments, so all are
reachable in Studio and over MCP. Connection bendpoints are JSON text on each Transition;
experiment snapshots are versioned JSON text on each Experiment. No XML blob is authoritative, no
position is stored per frame, and there is no host code, background job or automatic action.

- One selected species runs in the first habitat, whose size is edited in Studio. Edges wrap.
- Bounds: 1–500 creatures, 32 nodes, 64 transitions, 18,000 steps (five simulated minutes), 256
  disturbances.
- Nearby means at least one neighbour, Crowded eight or more, Disturbed within 200 habitat units
  of a disturbance under 150 steps old.
- The graph supports start events, tasks, exclusive gateways and end events. Parallel tokens,
  expressions and general BPMN execution are out of scope. The simulation is illustrative, not a
  scientific prediction.
- An unsaved behaviour is a draft in this device's browser storage for this file, never in the
  file, and is found again on return. Reload saved or a save drops it. A refused save keeps the
  draft and shows the reason; a change made during a save stays a draft. The save's own change
  notice is never taken for somebody else's.
- Saved experiments are listed newest first. Nendo's toolbar cuts a species name past 80
  characters and offers at most 64 species, the selected one always included.
- A transition whose From or To belongs to another species is left out of the diagram; one whose
  Route does not read is drawn on a route of its own. The view names each, and a save leaves the
  first as it is.

## Build and test

From the repository root:

```powershell
npm.cmd ci --prefix tools/swarm --ignore-scripts --no-audit --no-fund
node tools/swarm/bundle.mjs
node tools/Build-Swarm.mjs --dry-run
node tools/Build-Swarm.mjs --endpoint http://127.0.0.1:PORT/mcp
pwsh ./tools/Review-Swarm.ps1
```

Make an empty `Swarm.nendo` through Nendo's New file route, open it and set agent access to Shape
app. The builder refuses planners and nonempty files, validates one proposal holding the schema,
presets, screens and package, releases the lease and leaves acceptance to the person. The
proposal's title is **Swarm: living habitat, editable behaviours and replayable experiments**.
`README.md` is not packed.

Minimum host 1.42.0 (a custom view that opens the file). The package carries bpmn-js 18.19.0 from
npm; `tools/swarm/package-lock.json` pins the rebuild. The bpmn.io watermark and link stay visible,
as `vendor/bpmn-js.LICENSE.txt` requires. No remote script or font is loaded.

`Review-Swarm.ps1` runs the real view API and Nendo's toolbar rules in a cross-origin browser
fixture: geometry, drafts, typed writes, stale refusals, replay, reopen, Light and Dark, and narrow
layout. `Test-Production.ps1` runs it. The native host is not covered by this lane.

### Lantern Colony

An optional species: 300 creatures, 19 nodes, eight decisions and 27 transitions. It scouts,
gathers, avoids crowds, travels, rests, and repeats its escape until a disturbance passes. Add it
to an existing Swarm file with Edit data access:

```powershell
node tools/Add-SwarmSpecies.mjs --dry-run
node tools/Add-SwarmSpecies.mjs --endpoint http://127.0.0.1:PORT/mcp
```

The recipe is `tools/swarm/lantern-colony.mjs`. The builder checks a seeded run and exact replay
before creating 47 records, then reads the saved graph back. It keeps existing species and refuses
to overwrite a conflicting Lantern Colony.
