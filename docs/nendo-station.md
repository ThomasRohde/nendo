# Nendo Station

Nendo Station is a fictional orbital habitat that operates as a small operations
room. It is the fourth reference application. It was built from an empty file
through the MCP interface alone, and it has one custom view of its own.

The design, the coverage table and the milestones are in
[nendo-station-plan.md](design/nendo-station-plan.md). This page tells you how to
open the file, describes the demonstration, and lists what the station does not
claim.

## The file

`workspace/Nendo Station.nendo`. It has nine record types (Modules, Systems,
Components, Feeds, Readings, Incidents, Maintenance, Experiments, Crew), about
600 records, and every kind of screen this host compiles.

**The file is an output.** `tools/Build-NendoStation.mjs` is the source. It
authors the whole application over local MCP in stages. Each stage is a change
set that the script validates into a proposal, and the owner accepts the
proposal. The script never accepts a proposal.

```bash
node tools/Build-NendoStation.mjs --list     # the stages, in order
node tools/Build-NendoStation.mjs            # the first one not yet applied
```

The script refuses to author into a file whose application ID is the application
ID of the development planner. The refusal states this reason, and the script
does not guess which open Nendo was intended.

To rebuild from empty:

1. In Nendo, select File → New.
2. Run the stages in order, and accept each proposal.
3. When the CSV stage tells you to, import `artifacts/station/readings.csv` into
   Readings.
4. Before the pin, build and allow the Systems Lens package.

**Dates move with the build.** The range of a trend chart and the range of an
activity grid are closed words. The host resolves them against today every time
it reads. Thus the build generates the dataset relative to the day of the build,
and does not record fixed dates. A rebuild moves the history of the station
forward. The *now* of the station is the day of the build.

## Systems Lens

`extensions/systems-lens/` is the schematic of what feeds what. It is the one
thing in this file that is not a Nendo screen. Its
[README](../extensions/systems-lens/README.md) describes what it draws, the
take-out what-if, and the line that separates structural exposure from a
prediction of failure.

## The demonstration

The demonstration takes about four minutes. It was performed on 2026-09-22, and
the result of each step is recorded beside that step.

**Before you start:** steps 7 to 9 ask an agent for a change, and **the file in
`workspace/` already has that change**. The owner accepted it on 2026-09-22, and
that acceptance shows that the step works. Thus, do one of these two things:

- Rebuild from empty as far as the `pin` stage.
- Ask the agent for a distinction of your own. For example: what waits on a part
  that has not arrived, which experiments a rotation ran, or which incidents have
  no written summary.

The step is what the demonstration shows. The specific field is not important.

1. **Open the file.** Use opens on **Station status**. It shows nine systems,
   twelve crew, a Nominal ring, systems by condition, incidents by severity, the
   five experiments with the highest power draw (the *Hungriest experiments*
   list), the latest incidents, and a year of days of
   readings.

2. **Open Thermal Control.** The condition sets the tone of the record page
   header. The page has four tabs: Capacity, Components, Incidents, Telemetry.
   *Observed: 4.8 kW headroom, 65.71% load, 0 incidents, 14 readings outside
   limits. The review note is not on the page, because nothing has flagged the
   system.*

3. **Open Systems Lens** beside the components, and press Fit. Coolant pump A is
   green. The loop isolation valve, Radiator 2 and the lab heat exchanger have
   the mark `loop`, because a coolant circuit is a cycle. Both pumps feed into the
   manifold.

4. **Take Coolant pump A offline.** Use its *Take offline* command or the State
   field. *Observed: the command moved the record from version 3 to version 4.*
   Within half a second, the lens receives a new projection and the pump turns
   red. **Nothing else changes colour**, because the lens does not claim to know
   the effect of that change.

5. **Select the pump and press Take out.** *Expected result, which the gate also
   measures on the same shape: **Cold plate chiller** and **Lab cold plate** read
   `no path`, because they lose every declared feed path. The manifold, Radiator
   1, the isolation valve, Radiator 2 and the heat exchanger read `still fed`,
   because pump B feeds them.* The banner states what the answer is and what it is
   not. Press Escape to put the pump back. Nothing was written.

6. **Raise an incident** against Thermal Control, and name the pump in it.
   *Observed: the write returned `alsoChanged` with `system.thermal`, updated,
   version 2. The flag is true, `Under review` is true, and the review note field
   is now on the page. The page did not have that field before the write.
   `Incidents` reads 1. **Condition is still Nominal**: the action raised a flag,
   and it did not make a judgement in place of an operator.*

7. **Ask the agent**, in your own words:

   > We need to distinguish temporary workarounds from permanent repairs. Add
   > that distinction and a focused incident view.

8. **The agent authors one proposal**, *Nendo Station: tell a workaround from a
   repair*. The proposal has 2 mutations and 20 operations:
   - a `Resolution` choice with three toned options;
   - a **Standing workarounds** list, filtered to workarounds that are not stood
     down;
   - a breakdown on the ops board of how incidents were closed;
   - a count on the front page;
   - the field bound into the incident page and form.

   The field is optional. Every incident already in the file was closed before
   anybody made this distinction. A guess about which incidents were workarounds
   would invent the answer that the field exists to record.

9. **Read the semantic diff and accept.** The screen exists. There is no build, no
   regeneration and no migration, and the 600 records do not change.

Step 9 performs the falsification criterion of the vision for an observer. An
agent built a shape that nobody anticipated, and a person understood it before
accepting it.

### Putting it back

The demonstration leaves the pump offline, an incident open and Thermal Control
flagged. To run the demonstration again:

1. Run *Return to service* on the pump.
2. Delete the demo incident.
3. Run *Clear review flag* on the system.

A person lowers the flag. That is the other half of what the trigger states.

## What it does not claim

- **It is fiction.** The numbers are plausible, and none of them is validated.
- **Nothing here models pressure, heat, flow or margin.** No screen predicts a
  failure. Condition is what an operator recorded.
- **Systems Lens reads declared feeds**, not physics. *No path* means that every
  declared path from a source passed through the component that was taken out.
  The lens draws a component that is already Offline as it is, and does not treat
  it as removed.
- **The trigger flags; it does not diagnose.** It writes one Boolean on the
  system that an incident names. It never writes the condition.

## Keeping it current

A new surface slice adds its screen to `tools/Build-NendoStation.mjs` in the same
change that delivers the slice, and the station is rebuilt. This rule keeps this
file current. Without it, the file would show only the vocabulary as it was in
September.
