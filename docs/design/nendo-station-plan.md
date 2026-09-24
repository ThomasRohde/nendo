# Nendo Station — the showcase application

A fictional orbital habitat, run as a small operations room. It is the fourth
reference application: built from an empty file through the MCP interface alone,
carrying one custom view of its own, and kept current as each new surface slice
lands.

It replaces the **Reading Log** proposed in
[surfaces-and-charts-plan.md](surfaces-and-charts-plan.md#a-fourth-reference-application--delivered-2026-09-22).
A reading log would have proved the charts. A station proves the charts, the
relationships, the calculations, the action and the custom-view boundary in one
world, and it has somewhere to put the next five slices.

## What it is, and what it is not

- It is an **operations room**: condition, capacity, incidents, readings, work.
- It is **not a simulator**. No physics, no thermal model, no propagation of
  failure. Numbers are plausible, not validated, and the documents say so.
- It is **not the planner**. Nendo Development stays entirely about developing
  Nendo. The station's records live in its own file; only the *work* of building
  it is a planner item.
- It is **not a museum of features**. Every surface answers a question an
  operator would actually ask. Where a capability has no honest question in this
  world, it is left out rather than staged.

## The world

**Nendo Station** — a seven-module habitat in low orbit, crew of twelve on
six-month rotations, flying for about five years. It is old enough to have a
maintenance history and small enough that one person can hold it in their head.

| Module | What it is |
| --- | --- |
| Hab A, Hab B | Crew quarters, galley, medical |
| Laboratory | Experiment racks |
| Node 1 | The junction: power distribution, comms |
| Airlock | EVA prep |
| Truss | Unpressurised: arrays, radiators |
| Cupola | Observation, attitude reference |

Nine systems run across them: O₂ Generation, CO₂ Scrubbing, Water Reclamation,
Thermal Control, Primary Power, Battery Storage, Power Distribution, Comms,
Attitude Control. Each is built from components — pumps, valves, filters,
sensors, radiators, cells, controllers, tanks — and components **feed** one
another: power, coolant, air, water, data. That feed network is the graph the
custom view draws.

The tone is an approachable ops room: calm nouns, exact numbers, no drama. A
degraded scrubber is a number and a date, not a klaxon.

## The constraints that shape the design

These are host rules, not preferences. Each one changed the design, so each is
written down before the schema rather than discovered during it.

1. **Five scalars in a formula.** A calculation or action expression reads
   Integer, Decimal, Boolean, Text or Date (`NendoBehaviourScalar`). A **single
   choice is stored as Text** with a `singleChoice` presentation, so a formula
   does read one, comparing it against an exact option string — the planner's own
   `nd.work.isBlocked` is `status == Blocked`. A **Reference** and a **DateTime**
   are what a formula cannot reach. Comparing an option string inside a formula
   is brittle under a rename, so this file keeps a stored Boolean beside the
   choice wherever a formula must decide, and leaves option comparison to
   `filterClause`, where the definition names the field and is refused at
   validation rather than going quietly false.
2. **No clock in a formula.** The catalogue is total: no `Today()`. So "days
   since service" is not computable. Due dates are **stored** Date fields, and
   screens compare them with the `today` value kind in a filter.
3. **A calculation never filters, orders, groups or totals.** It can drive
   `visibleWhen` and it can be read on a page. It cannot be a `rankByFieldId`,
   a `groupByFieldId` or a matrix axis. Every ranked, grouped or filtered number
   in the station is therefore a **stored** field.
4. **The projection discloses two fields.** A custom view receives a label and
   one status per node — nothing else. Systems Lens therefore needs the system
   name inside the label, which is a stored Text field the file maintains
   (`componentSchematicLabel`, "THERM · Coolant pump A"). That is a convention between the
   definition and the package, not a host feature, and the README says so.
5. **The published authoring limits**, read off `nendo://application/vocabulary`
   rather than remembered: 16 operations and 8 mutations per *call*, 32 mutations
   and **512 canonical operations** per change set, 128 operations per change set
   on the older authoring lane. So the batching in the build script is driven by
   the per-call limit, and the split into separate proposals is driven by what a
   person can review in one sitting — not by a ceiling. A stage that creates
   record types must also be accepted before the next stage can name them, since
   a draft validates against the active file's clone.
6. **No images.** Cards, headers and the schematic are typography, tone and
   number. This is the product's strength, not a workaround.
7. **A related calculation reads at most 256 members.** Readings per system stay
   under that by construction — see the dataset.

## Coverage

Every contract version 3 node kind, and where it earns its place. This table is
the check that the application shows the product rather than a sample of it.

| Kind | Where | The question it answers |
| --- | --- | --- |
| `overviewSurface` | Station status | How is the station, right now |
| `section`, `tabGroup` | Overview, system page | — |
| `summaryTile` | Overview, system page | Crew aboard; open incidents |
| `progressTile` | Overview | Systems nominal, out of nine |
| `breakdownChart` | Overview, system list | Systems by condition |
| `rangeTile` | Overview | Coldest and warmest reading on file |
| `trendChart` | Overview | Incidents raised per month, last twelve |
| `activityGrid` | Overview | Readings taken, a year of days |
| `recentList` | Overview | The last five incidents |
| `rankedList` | Overview | Experiments by power draw |
| `recordList` | Systems, components, readings, incidents | — |
| `gallerySurface` | System cards | The nine systems at a glance, toned |
| `boardSurface` (choice) | Incidents by status | The ops board |
| `boardSurface` (reference) | Systems by module | What is where |
| `matrixSurface` | Condition × criticality | Which degradations matter |
| `calendarSurface` | Maintenance by due date | What is due this month |
| `timelineSurface` (spans) | Incidents raised → resolved | How long things stayed broken |
| `timelineSurface` (spans) | Experiments, crew rotations | — |
| `detailSurface` | System, component, incident | The record page, with a toned header |
| `relatedList` | System → components, incidents, readings | — |
| `fieldBinding` + `visibleWhen` | System page | The review note appears only when flagged |
| `filterClause` | Throughout, including `today` | — |
| `recordForm` | System, incident, maintenance | — |
| `recordCommand` + `commandStep` | Five commands | Stand down; take offline; complete |
| `extensionGraphSurface` | Systems Lens | What feeds what |

Plus, from [ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md):
all six binding shapes, a reusable function, a `Refuse` guard, a nullable result,
and one trigger/action pair.

## Schema

Semantic IDs are camelCase and stable. Nine record types.

### module

`moduleName` Text req · `designation` Text · `pressurised` Boolean ·
`volume` Decimal · `commissioned` Date

Seven records. Small on purpose: it is the reference a board groups by, and the
S7 column ceiling is 24.

### system

`systemName` Text req · `systemCode` Text · `criticality` choice
(Vital red, Major amber, Minor blue) · `condition` choice (Nominal green,
Degraded amber, Offline red, Maintenance violet) · `module` Reference → module ·
`commissioned` Date · `designCapacity` Decimal req · `currentLoad` Decimal req ·
`capacityUnit` Text · `reviewFlag` Boolean · `reviewNote` Text

Calculations:

| Field | Shape | Formula |
| --- | --- | --- |
| `headroom` Decimal | SameRecordField ×2 | `designCapacity - currentLoad` |
| `loadPercent` Decimal | SameRecordField ×2, function call | `designCapacity = 0 ? Refuse('This system records no design capacity, so a load percentage would be invented.') : PercentOf(currentLoad, designCapacity)` |
| `openIncidents` Integer | RelatedAggregate Count | incidents via `incidentSystem` |
| `outOfLimitReadings` Integer | RelatedAggregate FilteredCount | readings via `readingSystem`, predicate `outOfLimits` |
| `underReview` Boolean | SameRecordField + SameRecordCalculation | `reviewFlag or openIncidents > 0` |

`underReview` drives `visibleWhen` on `reviewNote`. `loadPercent` is the
`Refuse` demonstration: a system with no recorded capacity declines to invent a
percentage, in the author's own sentence, rather than borrowing a division error.

### component

`componentName` Text req · `schematicLabel` Text req · `system` Reference →
system req · `componentKind` choice (Pump, Valve, Filter, Sensor, Radiator,
Cell, Controller, Tank) · `state` choice (Online green, Standby blue,
Offline red, Removed grey) · `installed` Date · `serviceIntervalDays` Integer ·
`lastServiced` Date · `nextServiceDue` Date · `serial` Text

Calculations: `serviceWindowDays` Integer = `DaysBetween(lastServiced,
nextServiceDue)`; `plannedHours` Decimal = RelatedAggregate Sum of maintenance
`hours` via `taskComponent` (which is why `hours` is required).

`state` is the lens status. `schematicLabel` is the lens label.

### feed

The edge type. `feedFrom` Reference → component req · `feedTo` Reference →
component req · `feedKind` choice (Power, Coolant, Air, Water, Data) ·
`redundantPath` Boolean · `feedNote` Text

Two distinct Reference fields onto the same record type is exactly what
`extensionGraphSurface` binds.

### reading

`readingSystem` Reference → system req · `taken` Date req · `metric` choice
(Pressure, Temperature, Oxygen, Carbon dioxide, Power draw, Water) ·
`readingValue` Decimal req · `unit` Text · `outOfLimits` Boolean req

`outOfLimits` is stored rather than derived because `FilteredCount` counts a
Boolean that is true, and because a limit is an operator's judgement.

### incident

`incidentTitle` Text req · `incidentSystem` Reference → system **req** ·
`incidentComponent` Reference → component · `raised` Date req · `resolved` Date ·
`severity` choice (Routine blue, Elevated amber, Critical red) ·
`incidentStatus` choice (Open red, Contained amber, Resolved green, Stood down
grey) · `summary` Text

`daysToResolve` Integer = `DaysBetween(raised, resolved)`, declared
`resultNullable: true`, so an unresolved incident reads *Not set* rather than
`calculation-missing-input`.

`incidentSystem` is required deliberately: the action follows it, and an empty
reference would write nothing and commit anyway. The contract states that; this
file avoids relying on it.

### maintenance

`taskTitle` Text req · `taskComponent` Reference → component req · `taskKind`
choice (Inspection, Replace, Calibrate, Clean) · `opened` Date · `due` Date ·
`completed` Date · `taskStatus` choice (Scheduled, In progress, Done, Deferred) ·
`hours` Decimal req

### experiment

`experimentTitle` Text req · `lead` Reference → crew · `experimentModule`
Reference → module · `experimentSystem` Reference → system · `startsOn` Date ·
`endsOn` Date · `experimentStatus` choice (Proposed, Running, Complete, Halted) ·
`powerDraw` Decimal req · `priority` Integer with `rating` presentation, 1–5

`powerSharePercent` Decimal = `PercentOf(powerDraw, capacity)` where `capacity`
is a **ReferenceTraversal** through `experimentSystem` to `designCapacity` — the
sixth binding shape, and the second caller of the shared function.

### crew

`crewName` Text req · `role` choice (Commander, Flight engineer, Scientist,
Medical officer) · `rotationStart` Date · `rotationEnd` Date · `callsign` Text

### The function

`PercentOf(part, whole)` → Decimal, `part / whole * 100`. Called by
`system.loadPercent` and `experiment.powerSharePercent`. Division answers in the
decimal domain, which is the point of putting a percentage in a reusable function
rather than writing it twice.

### The trigger and action

**Trigger** `incidentChanged`: incident *created* and *updated*, update narrowed
to `severity` and `incidentStatus`.

**Action** `flagSystemForReview`: one `SetField` step, target the record reached
by following `incidentSystem`, assignment `reviewFlag` ← the literal `true`.

It flags. It does not set `condition`, and the host would allow it to: a choice
stores as Text, and Text is one of the five scalars an expression writes. This is
a product decision, not a host refusal, which is the honest way to record it. A
condition is an operator's judgement, and an application that quietly downgraded
a system because a ticket changed would be making that judgement for them.

The flag is lowered by a person, through the **Clear review flag** command. The
machine raises, the person lowers; that asymmetry is the design, not a gap.

### The commands

| On | Command | Steps |
| --- | --- | --- |
| system | Clear review flag | `reviewFlag` ← literal false; `reviewNote` ← null |
| component | Take offline | `state` ← Offline |
| component | Return to service | `state` ← Online |
| incident | Stand down | `incidentStatus` ← Stood down; `resolved` ← `today` |
| maintenance | Complete | `taskStatus` ← Done; `completed` ← `today` |

## The dataset

Small enough to read, large enough for the charts to mean something.

| Type | Records | Shape |
| --- | ---: | --- |
| module | 7 | — |
| system | 9 | Seven Nominal, one Degraded, one Maintenance |
| component | ~40 | Across the nine systems |
| feed | ~60 | Includes two genuine coolant loops and one redundant pump pair |
| reading | ~340 | Four months of daily samples, at most ~40 per system |
| incident | 14 | Three open, two contained, spans from one day to six weeks |
| maintenance | 20 | Six due inside the next month |
| experiment | 8 | Two running, priorities 1–5 |
| crew | 12 | Two overlapping rotations |

Readings per system stay well under the 256-member related-calculation ceiling by
construction. The feed network stays far under the 500-node / 1,000-edge
projection bound, which the lens must still handle at the bound — see its gate.

Readings arrive by **CSV import**, which is the one shipped capability the other
reference applications do not exercise end to end. Everything else is authored
over MCP.

## Systems Lens

`extensions/systems-lens/`, package `org.nendo.systems-lens`, protocol 1,
unsigned, no dependencies, no network, no writes.

It draws the feed network as a schematic: components as nodes, feeds as directed
edges, each node toned by its stored `state`, banded by the system prefix in its
label.

### What it does that a list cannot

- **Direction of supply.** Longest-path layering over the condensed graph puts
  each component to the right of everything that feeds it.
- **Loops, named exactly.** A coolant circuit *is* a cycle. Strongly connected
  components are condensed, marked `loop`, and drawn as a ring; a component
  merely standing behind a loop is not marked — the distinction a
  "something did not settle" pass gets wrong.
- **Connection.** Select a component, press Focus, and everything not upstream or
  downstream of it dims.
- **Take this out.** The session-only what-if below.
- **A text alternative** listing each component's feeds in and out, and, in
  take-out mode, the exposed and reduced sets by name.

### Take-out mode, and the line it must not cross

Press **Take out** on a selected component. The lens recomputes reachability from
the source set — components with no incoming feed: tanks, arrays, generators —
and classifies every other component:

| Verdict | Meaning | Words on screen |
| --- | --- | --- |
| **Exposed** | Reachable before, unreachable without it | *loses every declared feed path* |
| **Reduced** | Still reachable, but some declared path is gone | *keeps a declared feed path* |
| **Unaffected** | Not downstream of it at all | — |

The distinction between exposed and reduced is the whole point. A radiator fed by
two pumps does not go dark when one is taken out, and a lens that painted
everything downstream red would say it did. A banner states, permanently and not
dismissibly:

> Structural what-if over declared feeds. It says which components lose every
> declared path — not what will fail.

Three refusals hold that line:

- **Nothing is written.** Take-out mode is renderer memory, cleared by Escape and
  by any `replaceProjection`, and the package has no write capability to lose.
- **Stored state does not propagate.** A component already Offline is outlined so
  the operator can see it, and is *not* treated as removed. Colour is fact from
  the file; take-out is a question the operator asked. Merging the two would make
  the lens quietly assert a failure model it does not have.
- **No timing, capacity or physics.** The graph knows what is declared to feed
  what. It does not know pressure, heat, flow or margin, and the README says so
  in those words.

### The rest of what it owes

Deterministic layout, pointer pan and wheel zoom, keyboard traversal with a
visible focus ring, both themes from the `setTheme` message, an empty state, a
compact 512×384 window, labels rendered as text including markup-shaped ones, and
`selectRecord` only for a node in the current generation. Open record, Refresh,
Studio, Disable and Close stay on the host's toolbar, outside the renderer.

Build: `tools/Build-NendoSystemsLensPackage.ps1`, a one-line wrapper over
`Build-NendoViewPackage.ps1`, printing the exact SHA-256 that the file pins.

## The showcase moment

The demonstration, in the order it is performed. It takes about four minutes.

1. **Open the file.** The overview says nine systems, seven nominal, three open
   incidents, a year of readings as toned squares.
2. **Open Thermal Control.** The record page header is toned by condition. The
   related lists show its components, its incidents, its readings. The review
   note is not on screen, because nothing has flagged it.
3. **Open Systems Lens** beside the components. Coolant pump A is green, the
   radiator loop is drawn as a ring, and the redundant pump pair is visible as
   two paths into the same radiator.
4. **Set Coolant pump A to Offline** in its own record — a typed native write, or
   the *Take offline* command. Within half a second the lens receives
   `replaceProjection` and the pump turns red. Nothing else changes colour,
   because the lens does not pretend to know what that costs.
5. **Press Take out** on the pump. Two components are marked *exposed* — they
   lose every declared path — and the radiator is marked *reduced*, because the
   backup pump still feeds it. The text alternative names all three.
6. **Back in the native app**, raise an incident against Thermal Control. The
   trigger flags the system, `underReview` turns true, and the review note field
   appears on the page that did not have it a moment ago. The matrix moves a
   count from Nominal × Vital to Degraded × Vital. The incident board gains a
   card; the timeline gains an open-ended span.
7. **Ask the agent**, in the person's own words:

   > We need to distinguish temporary workarounds from permanent repairs. Add
   > that distinction and a focused incident view.

8. **The agent authors one proposal** over MCP: a `resolution` choice field
   (Workaround amber, Permanent repair green, Not applicable grey), a
   `recordList` *Standing workarounds* filtered to `resolution eq Workaround` and
   `incidentStatus ne Stood down`, a `breakdownChart` by resolution on the
   incident list, a `summaryTile` on the overview, and the field bound into the
   incident form and page. Roughly twenty operations, one change set.
9. **The owner reads the semantic diff** — *Add a choice field Resolution with
   three options*, *Add a list of the records this record type holds*, *Keep only
   records whose Resolution is Workaround* — and accepts. The screen exists. No
   build, no regeneration, no migration, and the 400 records are untouched.

Step 9 is the vision's falsification criterion performed in front of someone: an
agent built a shape nobody anticipated, and a person understood it before
accepting it.

## How it is built, and how it stays current

**The file is an output; the script is the source.**
`tools/Build-NendoStation.mjs` authors the whole application from an empty file
over local MCP — schema, calculations, function, behaviour, every surface, then
the records — in a sequence of change sets, each validated into a proposal the
owner accepts. It prints each proposal's exact title so the owner can find it,
and polls until the definition revision moves before it continues.

That costs about ten accept clicks to build a station from nothing, and those ten
clicks *are* the review path working. It is an agent-run tool, not a CI lane: it
needs a running host and a person's acceptance, and neither is scriptable
honestly.

The benefit is that the station does not rot. When S8 lands, its screen is added
to the script, the file is rebuilt, and the diff shows exactly what the new slice
bought. The rule to write into the surface plan: **a new surface slice adds its
screen to Nendo Station in the same change that delivers it.**

### Where things live

| Path | What |
| --- | --- |
| `workspace/Nendo Station.nendo` | The built file, tracked, covered by `Test-BinaryAssets.ps1` |
| `extensions/systems-lens/` | Package source: `index.html`, `lens.css`, `lens.js`, `LICENSE.txt`, `README.md` |
| `tools/Build-NendoSystemsLensPackage.ps1` | Reproducible package build, prints the pin |
| `tools/Build-NendoStation.mjs` | Authors the application over MCP |
| `tools/Gate-SystemsLens.mjs`, `tools/Review-SystemsLens.ps1` | The presentation gate, inside `Test-Production.ps1` |
| `docs/design/nendo-station-plan.md` | This plan |
| `docs/reviews/blackbox-prompt.md` | A phase that reaches the station |

## Evidence

### What the gate measures

`Review-SystemsLens.ps1` runs the pinned Playwright CLI against a task-owned
local fixture server, reusing `Graph-FixtureServer.mjs`, and measures:

1. A chain lays out 0, 1, 2.
2. **A redundant pair: take out one pump and the radiator is *reduced*, not
   exposed.**
3. A single path: take out the pump and the radiator is *exposed*.
4. A three-component coolant loop is marked `loop`, with exact membership.
5. A component behind that loop is not marked.
6. An isolated component is drawn and is exposed by no take-out.
7. A label with no `·` separator gets no band and is still drawn.
8. A markup-shaped label is drawn as text.
9. Parallel feeds are preserved and do not change the verdicts.
10. 500 nodes and 1,000 edges render and report `ready` inside the budget.
11. An empty projection shows the empty state.
12. `replaceProjection` clears take-out mode, bumps the generation, and a
    `selectRecord` echoing the old generation is refused.
13. Both themes, from the `setTheme` message rather than `prefers-color-scheme`.
14. A 512×384 window.
15. Keyboard traversal, focus ring, and the text alternative naming the exposed
    and reduced sets.

### The falsification

Case 2 is the guard that matters, because it measures the exact claim this view
must not overstate. Before it is trusted:

1. Replace the reachability computation with *everything downstream of the
   removed component is exposed*.
2. Run the gate. Case 2 must fail, and its failure text goes into the record
   verbatim.
3. Restore the computation, re-run, and file a Finding carrying that text.

A guard nobody has watched fail is a guess. A guard that would have passed
against the naive implementation is guarding the drawing, not the claim.

### The build script's own guard, falsified 2026-09-22

`Build-NendoStation.mjs` picks the Nendo it talks to, so the worst thing it could
do is author nine record types into the development planner. It refuses any file
whose application ID is the planner's. Run against the planner it says:

```text
The only Nendo answering has the development planner open.
This script will not author a station into it.
```

Falsifying it cannot mean letting it write, so `NENDO_STATION_PLANNER_ID`
overrides the ID it refuses and `--dry-run` stops before the lease is taken. With
the guard pointed at an ID nothing has, the same command selects the planner and
reports what it would have sent:

```text
File            application-7efd926c073f4be9974be19bbc39ff41
Stage           schema-a
Dry run: 8 mutations, 56 operations would be sent. No lease was taken.
```

Agent-observed against the live planner, not a lane.

### What is not measured

- The install / allow / open journey and native composition belong to the host
  and are measured by the custom-view contract's own lanes, not here.
- `Build-NendoStation.mjs` is agent-run and owner-accepted. There is no automated
  assertion that the station rebuilds from empty; if the vocabulary changes
  incompatibly, the next rebuild is where it is found.
- Nothing here says the station is *usable* beyond the owner's own reading of it.

## Milestones

Each is one proposal set, its own acceptance criteria, and a checkpoint.

**M0 — Planner entry. Done 2026-09-22:** **W-056 — Build Nendo Station as the
fourth reference application**, `nd.work.r.station`, under I-006 *Richer views of
the same data*, Now / Ready / Within accepted scope, planning order 15, carrying
the acceptance criteria below. No `src/` change; ADR-0013 and ADR-0008 already
carry the authority, and no new host capability is needed. If a surface turns out
to need one, the item becomes *Needs decision/ADR* and stops there.

**M1 — World and schema. Written 2026-09-22, not yet run.** All five open
questions are settled below. `tools/Build-NendoStation.mjs` carries the whole of
M1 as four stages, each one change set validated into a proposal: `schema-a` the
station and what it is made of, `schema-b` what happens on it, `schema-c` crew
and experiments, `behaviour` the function, the seven calculations and the
trigger/action pair. It refuses to author into any file whose application ID is
the planner's, prints the proposal title and stops — it never accepts one.

Nothing has been authored, because **the station file does not exist yet**. The
local MCP endpoint serves whichever file Nendo has open, and only the planner is
open; a client cannot move itself to another endpoint. Creating the file is the
owner's act: File, New in Nendo, saved as `workspace/Nendo Station.nendo`. Then
`node tools/Build-NendoStation.mjs` runs stage by stage.

**M2 — Data.** Seed modules, systems, components, feeds, incidents, maintenance,
experiments and crew over MCP. Import readings from CSV. Check the exact numbers
the charts will state before any chart exists.

**M3 — Surfaces, part one.** Overview, system list, gallery, board by module,
board by condition, the condition × criticality matrix, and the system record
page with its tabs, related lists, charts and `visibleWhen`. Proposals 5–7.

**M4 — Surfaces, part two.** Incident board, incident timeline with spans,
maintenance calendar, experiment timeline and gallery, crew rotations, reading
list with its trend, activity grid and range tile, the five commands, and the
forms. Proposals 8–10.

**M5 — Systems Lens. Delivered 2026-09-22.** `extensions/systems-lens/`, package
`org.nendo.systems-lens` 0.1.0, pinned by the `pin` stage which reads the digest
off the built archive rather than carrying a copy. Since 2026-09-24 (W-060) it is
0.2.0 at protocol 2: the `pin` stage binds the component's name as the label and
discloses `componentSystem` as a field, and the `lens-fields` stage moves a file
pinned earlier to that shape in one proposal. `Review-SystemsLens.ps1` runs
inside `Test-Production.ps1`, and the exposed-versus-reduced guard was falsified
before it was trusted — see below. The palette was rebuilt on Nendo's own tokens
after the first version opened in a warm grey of its own beside the app's chrome;
[authoring a custom view](../custom-view-authoring.md) now says a view sits with
the app rather than offering it as a choice.

**M6 — The demonstration. Delivered 2026-09-22.**
[docs/nendo-station.md](../nendo-station.md) carries the walkthrough with what
each step actually showed, performed on the live file: the *Take offline* command
moved the pump from version 3 to 4; raising an incident returned `alsoChanged`
naming `system.thermal` at version 2, and its flag, `Under review` and the review
note on the page followed, while its condition stayed Nominal. The agent change
was authored as the `workarounds` stage — 2 mutations, 20 operations — and
accepted. Blackbox phase 9 reaches the file cold; the vision, roadmap, surface
plan and `workspace/README.md` name the fourth reference application.

### Acceptance criteria

- The station file opens, and Studio reaches every record type.
- Every kind in the coverage table is present on a compiled surface.
- The trigger flags a system on an incident change, and only on the changes it
  declares.
- Systems Lens opens under consent, draws the loop, and distinguishes exposed
  from reduced on the redundant-pair fixture.
- The falsification text is recorded in a Finding.
- The agent change in step 7 is authored, reviewed as a diff and accepted, and
  the resulting screen works — recorded with the proposal's exact title.
- `pwsh ./tools/Test-Production.ps1` passes with the new lane in it.

## Open questions

All five are settled, against the live vocabulary and the live planner.

1. ~~Can a `commandStep` literal name a choice option?~~ **Answered 2026-09-22:
   yes** — `valueKind: literal` with the option's exact text. The planner's own
   *Plan now* and *Complete* commands do it, and the published action example
   writes a choice the same way, as `'Active'`.
2. ~~Can an action assignment write a choice?~~ **Answered 2026-09-22: yes** — a
   choice stores as Text, and Text is one of the five behaviour scalars.
   `flagSystemForReview` still writes the Boolean, for the design reason above.
3. ~~Does a choice field bind into a formula as Text?~~ **Answered 2026-09-22:
   yes.** `nd.work.isBlocked` in the planner reads `status == Blocked`.
   `underReview` keeps its stored Boolean anyway, so renaming an option cannot
   quietly change what it means.
4. ~~Exact operation counts for a field with N choice options.~~ **Answered
   2026-09-22:** a `singleChoice` field carries its `options` inline on
   `schema.addField`, so the field is **one** operation however many options it
   has, and each option that wants a colour costs one `schema.setChoiceMetadata`.
   A four-option toned choice is five operations. Measured on the real stage:
   `schema-a` is 8 mutations and 56 operations, well inside 512.
5. ~~Whether `rating` presentation and `accentFieldId` interact on a gallery
   card.~~ **Answered 2026-09-22: they do not.** `accentFieldId` is a
   single-choice field that tones the card edge; `rating` is a schema-level
   presentation on an Integer field, drawn as dots wherever that field appears.
   They are independent, so the experiment gallery shows both.

The answers came from reading the live file and the published vocabulary rather
than the source: the `nd.work` schema read reports `storageKind: text` with
`presentation: singleChoice` and carries the derived field's own expression, and
`nendo://application/examples` supplies the action, trigger and reference forms
as they stand.

## Out of scope

Named so the plan is not read as promising them: telemetry overlays richer than
one status per node (a protocol 2 question, not a package question), images,
live data of any kind, alarm or threshold evaluation, a second custom view, and
any claim that this file models a spacecraft.
