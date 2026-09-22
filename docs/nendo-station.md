# Nendo Station

A fictional orbital habitat, run as a small operations room. It is the fourth
reference application, built from an empty file through the MCP interface alone,
and it carries one custom view of its own.

The design, the coverage table and the milestones are in
[nendo-station-plan.md](design/nendo-station-plan.md). This page is how to open
it, what the demonstration is, and what it does not claim.

## The file

`workspace/Nendo Station.nendo`. Nine record types — Modules, Systems,
Components, Feeds, Readings, Incidents, Maintenance, Experiments, Crew — about
600 records, and every kind of screen this host compiles.

**The file is an output.** `tools/Build-NendoStation.mjs` is the source: it
authors the whole application over local MCP in stages, each one a change set
validated into a proposal the owner accepts. It never accepts one.

```bash
node tools/Build-NendoStation.mjs --list     # the stages, in order
node tools/Build-NendoStation.mjs            # the first one not yet applied
```

It refuses to author into any file whose application ID is the development
planner's, and it says so rather than guessing which open Nendo was meant.

Rebuilding from empty is: File → New in Nendo, then run the stages in order,
accepting each proposal, importing `artifacts/station/readings.csv` into Readings
when the CSV stage says to, and building and allowing the Systems Lens package
before the pin.

**Dates move with the build.** A trend chart's range and an activity grid's range
are closed words the host resolves against today every time it reads, so the
dataset is generated relative to the day it was built rather than written down. A
rebuild moves the station's history forward; the station's *now* is the day it
was built.

## Systems Lens

`extensions/systems-lens/` — the schematic of what feeds what, and the one thing
in this file that is not a Nendo screen. Its own
[README](../extensions/systems-lens/README.md) covers what it draws, the
take-out what-if and the line that separates structural exposure from a
prediction of failure.

## The demonstration

About four minutes. Performed on 2026-09-22; what each step actually showed is
recorded beside it.

**Before you start:** steps 7 to 9 ask an agent for a change, and **the file in
`workspace/` already has that change** — it was accepted on 2026-09-22, which is
how the step is known to work. So either rebuild from empty as far as the `pin`
stage, or ask the agent for a distinction of your own: what is waiting on a part
that has not arrived, which experiments a rotation actually ran, which incidents
nobody has written a summary for. The step is the point, not the field.

1. **Open the file.** Use opens on **Station status**: nine systems, twelve crew,
   a Nominal ring, systems by condition, incidents by severity, the five
   hungriest experiments, the latest incidents, a year of days of readings.

2. **Open Thermal Control.** The record page header is toned by condition. Four
   tabs: Capacity, Components, Incidents, Telemetry. *Observed: 4.8 kW headroom,
   65.71% load, 0 incidents, 14 readings outside limits. The review note is not
   on the page, because nothing has flagged the system.*

3. **Open Systems Lens** beside the components, and press Fit. Coolant pump A is
   green; the loop isolation valve, Radiator 2 and the lab heat exchanger are
   marked `loop`, because a coolant circuit is a cycle; both pumps run into the
   manifold.

4. **Take Coolant pump A offline** — its own *Take offline* command, or the State
   field. *Observed: the command moved the record from version 3 to version 4.*
   Within half a second the lens receives a new projection and the pump turns
   red. **Nothing else changes colour**, because the lens does not pretend to know
   what that costs.

5. **Select the pump and press Take out.** *Expected, and what the gate measures
   on the same shape: **Cold plate chiller** and **Lab cold plate** read `no path`
   — they lose every declared feed path — and the manifold, Radiator 1, the
   isolation valve, Radiator 2 and the heat exchanger read `still fed`, because
   pump B carries them.* The banner says what the answer is and is not. Press
   Escape to put the pump back; nothing was written.

6. **Raise an incident** against Thermal Control naming the pump. *Observed: the
   write returned `alsoChanged` naming `system.thermal`, updated, version 2. The
   flag is true, `Under review` is true, and the review note field is now on a
   page that did not have it a moment ago. `Incidents` reads 1. **Condition is
   still Nominal** — the action raised a flag and did not make an operator's
   judgement for them.*

7. **Ask the agent**, in your own words:

   > We need to distinguish temporary workarounds from permanent repairs. Add
   > that distinction and a focused incident view.

8. **The agent authors one proposal**, *Nendo Station: tell a workaround from a
   repair* — 2 mutations, 20 operations: a `Resolution` choice with three toned
   options, a **Standing workarounds** list filtered to workarounds that are not
   stood down, a breakdown of how incidents were closed on the ops board, a count
   on the front page, and the field bound into the incident page and form. The
   field is optional, because every incident already on file was closed before
   anybody drew this distinction and guessing which were workarounds would invent
   the answer the field exists to record.

9. **Read the semantic diff and accept.** The screen exists. No build, no
   regeneration, no migration, and the 600 records are untouched.

Step 9 is the vision's falsification criterion performed in front of someone: an
agent built a shape nobody anticipated, and a person understood it before
accepting it.

### Putting it back

The demonstration leaves the pump offline, an incident open and Thermal Control
flagged. To run it again: *Return to service* on the pump, delete the demo
incident, and *Clear review flag* on the system — the flag is lowered by a
person, which is the other half of what the trigger says.

## What it does not claim

- **It is fiction.** The numbers are plausible and none of them is validated.
- **Nothing here models pressure, heat, flow or margin.** No screen predicts a
  failure. Condition is what an operator recorded.
- **Systems Lens reads declared feeds**, not physics. *No path* means every
  declared path from a source passed through the component taken out. A component
  already Offline is drawn as it is and is not treated as removed.
- **The trigger flags; it does not diagnose.** It writes one Boolean on the
  system an incident names, and never the condition.

## Keeping it current

A new surface slice adds its screen to `tools/Build-NendoStation.mjs` in the same
change that delivers it, and the station is rebuilt. That is what stops this file
becoming a museum of the vocabulary as it was in September.
