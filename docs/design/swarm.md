# Swarm

W-133 builds an offline creature-behaviour playground as a Nendo app. The owner
requested it on 2026-10-04. It stays within ADR-0013: a custom view carries its
code in the file and uses typed application services. No host change or
background simulation is required.

The main screen pairs a habitat with a bpmn-js behaviour editor. The habitat is
the visual focus; controls and the inspector use Nendo's theme tokens and leave
the Mica shell and Studio route intact. At narrow widths the editor sits below
the habitat. Colour identifies creature states, with names and counts beside it.
The simulation starts paused so the owner chooses when motion begins.

Species, behaviour nodes, transitions, habitats and experiments are ordinary
records. bpmn-js is a projection of the node/link records, not the authoritative
XML document. Diagram gestures stay in a local draft until Save behaviour commits
the net difference as one version-checked batch. Refused saves retain the draft.

Supported behaviour is one start, actions (Wander, Gather, Align, Flee, Rest),
exclusive decisions (Nearby, Disturbed, Crowded), and optional ends. Decisions
have Yes/No paths. No parallel tokens, general expressions or workflow execution
are claimed. A bounded interpreter drives each creature independently. Spatial
buckets bound neighbour searches; a seeded generator and fixed steps make runs
repeatable. Pointer disturbances are simulation events, not database writes.

An experiment stores the captured model, seed, step count and disturbances in
a text snapshot, with a name and summary as separate fields. Replay uses that
captured model, even after the live behaviour changes. Creature positions are
derived, never written on animation frames. Runs stop at their documented bound.

## Acceptance

- Editing a connected graph changes measured creature trajectories.
- Presets produce distinct motion; invalid graphs fail with useful diagnostics.
- Play, Pause, Reset and pointer disturbance work; population and steps are bounded.
- Saving behaviour uses one typed batch, including target versions for references.
- Save refusal preserves the draft; changes elsewhere are reported and cannot be overwritten.
- Experiments replay the same captured run after reopening, independently of current rules.
- Light/Dark, narrow layout, geometry and readable state counts are measured.
- The complete app is authored through MCP into a new task-owned file and validated
  as a proposal. Acceptance remains the owner's action.

## Build and handoff

Source: `extensions/swarm/`; dependency recipe and measurements: `tools/swarm/`;
MCP authoring: `tools/Build-Swarm.mjs`; intended file: `workspace/Swarm.nendo`.
The build refuses the development planner and any nonempty target. It takes a
short lease and releases it after validating the proposal.

Exact commands, outcomes and remaining owner actions are recorded on W-133 and
its linked Checks. Build logs and screenshots under `artifacts/swarm/` are scratch.
