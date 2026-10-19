# Nendo Station

Nendo Station is a fictional orbital habitat run as a small operations room. It is the
fourth reference application, built from an empty file through the MCP interface
alone, with one custom view of its own. It is an operations room (condition, capacity,
incidents, readings, work), not a simulator, and every screen answers a question an
operator would ask; a capability with no honest question in this world is left out.

## The file

`workspace/Nendo Station.nendo`. Nine record types (Modules, Systems, Components,
Feeds, Readings, Incidents, Maintenance, Experiments, Crew), about 500 records, and
every kind of Nendo screen this host compiles except the outline (`outlineSurface`),
which needs a declared hierarchy the station does not have. Its one custom view is the
Systems Lens graph.

**The file is an output.** `tools/Build-NendoStation.mjs` is the source, with the
dataset in `tools/station-data.mjs`. It authors the whole application over local MCP in
stages. Each schema, behaviour and screen stage is one change set validated into a
proposal; the script prints the proposal's exact title and stops, and the owner accepts
it. The script never accepts a proposal. The data stages write records directly through
the data lane. Each stage builds on the definition revision the last left, so the next
refuses until the previous proposal is accepted.

```bash
node tools/Build-NendoStation.mjs --list     # the stages, in order
node tools/Build-NendoStation.mjs            # the first one not yet applied
node tools/Build-NendoStation.mjs schema-a   # one named stage
```

The stages are `schema-a`, `schema-b`, `schema-c`, `behaviour`, `data-a`, `data-b`,
`data-c`, `readings-csv`, `surfaces-a` to `surfaces-d`, `pin`, `lens-fields`,
`lens-in-file` and `workarounds`.

The script refuses to author into a file whose application ID is a development
planner's, says so, and does not guess which open Nendo was meant. To falsify that guard
without writing, point `NENDO_STATION_PLANNER_ID` at an ID nothing has and run with
`--dry-run`, which stops before the lease is taken.

To rebuild from empty:

1. In Nendo, select File → New.
2. Run the stages in order, and accept each proposal a stage makes.
3. When the CSV stage tells you to, import `artifacts/station/readings.csv` into
   Readings. Readings are the station's CSV import path.
4. The `lens-in-file` stage puts the Systems Lens code into the file from
   `extensions/systems-lens/`. Run again after an edit to that folder, it proposes only
   the files that changed.

**Dates move with the build.** The ranges of a trend chart and an activity grid are
closed words resolved against today on every read, so the build generates the dataset
relative to the day of the build. The station's *now* is the day of the build.

**A new surface kind adds its screen to `tools/Build-NendoStation.mjs`** in the change
that delivers it, and the station is rebuilt. The outline is the exception: the script
declares no hierarchy and adds no `outlineSurface`.

## How the design follows the host

Each of these host rules shaped the schema:

- A formula reads Integer, Decimal, Boolean, Text or Date. A single choice is stored as
  Text, so a formula can compare an option string, but that is brittle under a rename;
  the station keeps a stored Boolean beside a choice wherever a formula decides, and
  leaves option comparison to `filterClause`.
- A formula has no clock. Due dates are stored Date fields, compared in filters with the
  `today` value kind.
- A ranked, grouped or matrix number is a stored field.
- A related calculation reads at most 256 members; readings per system stay under it.
- There are no images. Cards, headers and the schematic are typography, tone and number.

The behaviour stage adds a reusable function, `fn.percentOf`, called by a system's load
and an experiment's share of capacity; a `Refuse` guard where a system records no design
capacity; a nullable days-to-resolve; and one trigger/action pair,
`station.flagSystemForReview`. The action follows an incident's required system
reference and sets that system's review flag. **It never sets the condition**: a
condition is an operator's judgement. A person lowers the flag with *Clear review flag*.

## Systems Lens

`extensions/systems-lens/` is the schematic of what feeds what: a custom view, carried
in the file as the package `org.nendo.systems-lens`, which runs as a screen of Components
in Use. Its [README](../extensions/systems-lens/README.md) describes what it draws, the
take-out what-if, the line between structural exposure and a prediction of failure, and
what `tools/Review-SystemsLens.ps1` measures.

When `extensions/systems-lens/` holds a newer version than the tracked file, import it
in **Studio › Screens › Custom views › Import package…**, or run the `lens-in-file`
stage, and accept the proposal. Do it in a Duplicate to keep the tracked file as it is.

## The demonstration

The demonstration takes about four minutes.

**Before you start:** steps 7 to 9 ask an agent for a change, and **the file in
`workspace/` already has it**. Either rebuild from empty as far as `lens-in-file`, the
stage before `workarounds`, or ask the agent for a distinction of your own: what waits
on a part that has not arrived, which experiments a rotation ran, or which incidents
have no written summary. The step is what the demonstration shows, not the field.

1. **Open the file.** Use opens on **Station status**: nine systems, twelve crew, a
   Nominal ring, systems by condition, incidents by severity, the *Hungriest
   experiments* list, the latest incidents, and a year of days of readings.

2. **Open Thermal Control.** The condition sets the tone of the record page header. The
   page has four tabs: Capacity, Components, Incidents, Telemetry. The review note is
   not on the page, because nothing has flagged the system.

3. **Show Systems Lens**, a screen of Components in Use, and press Fit. Coolant pump A is
   green. The loop isolation valve, Radiator 2 and the lab heat exchanger carry the mark
   `loop`, because a coolant circuit is a cycle. Both pumps feed the manifold.

4. **Take Coolant pump A offline**, with its *Take offline* command or the State field.
   The lens reads again and turns the pump red. **Nothing else changes colour**, because
   the lens does not claim to know the effect.

5. **Select the pump and press Take out.** **Cold plate chiller** and **Lab cold plate**
   read `no path`: they lose every declared feed path. The manifold, Radiator 1, the
   isolation valve, Radiator 2 and the heat exchanger read `still fed`, because pump B
   feeds them. The banner states what the answer is and is not. Escape puts the pump
   back; nothing was written.

6. **Raise an incident** against Thermal Control, naming the pump. The write's
   `alsoChanged` names `system.thermal`. Its flag and `Under review` turn true, and the
   review note field appears on the page. `Incidents` reads 1. **Condition is still
   Nominal.**

7. **Ask the agent**, in your own words:

   > We need to distinguish temporary workarounds from permanent repairs. Add
   > that distinction and a focused incident view.

8. **The agent authors one proposal**, *Nendo Station: tell a workaround from a
   repair*, of 2 mutations and 20 operations:
   - a `Resolution` choice with three toned options;
   - a **Standing workarounds** list, filtered to workarounds that are not stood down;
   - a breakdown on the ops board of how incidents were closed;
   - a count on the front page;
   - the field bound into the incident page and form.

   The field is optional: a guess about which past incidents were workarounds would
   invent the answer the field exists to record.

9. **Read the semantic diff and accept.** The screen exists. There is no build, no
   regeneration and no migration, and the records do not change.

Step 9 performs the vision's falsification criterion for an observer: an agent built a
shape nobody anticipated, and a person understood it before accepting it.

### Putting it back

The demonstration leaves the pump offline, an incident open and Thermal Control
flagged. To run it again:

1. Run *Return to service* on the pump.
2. Delete the demo incident.
3. Run *Clear review flag* on the system.

## What it does not claim

- **It is fiction.** The numbers are plausible, and none is validated.
- **Nothing here models pressure, heat, flow or margin.** No screen predicts a failure.
  Condition is what an operator recorded.
- **Systems Lens reads declared feeds**, not physics. *No path* means every declared
  path from a source passed through the component taken out. A component already
  Offline is drawn as it is, not treated as removed.
- **The trigger flags; it does not diagnose.** It writes one Boolean on the system an
  incident names, never the condition.
- **No lane rebuilds the station from empty.** The build is agent-run and
  owner-accepted; an incompatible vocabulary change is found at the next rebuild.
