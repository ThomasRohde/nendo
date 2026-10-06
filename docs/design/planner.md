# Planner.nendo: the planner, designed

`workspace/Nendo.nendo` grew by adding each new host feature as a test of it. It
works, but it carries the history of how it was built: twelve work screens that
overlap, a Horizon that is required so that closed work is left at *Later*, planning
orders numbered by hand into open, delivered and dropped ranges, a Score calculation
and an action whose flag was always on.

`workspace/Planner.nendo` does the same job, designed from the feature set as it is
now. It uses a feature only where it answers a question the planner has. It holds
every record of the old planner under its own record ID and Reference code.

**Planner.nendo is the primary planner since 2026-09-29**, when the owner switched.
[Dogfooding](../dogfooding.md), `AGENTS.md` and the MCP registrations point at it, and
`Nendo.nendo` is kept as the archive. W-099 built it.

## How it is built

`tools/Build-Planner.mjs` builds the file from an empty one over MCP alone.
`tools/planner-definition.mjs` holds the shape. The script is the source and the file is
the output, as it is for Nendo Station.

```text
node tools/Build-Planner.mjs --list       the stages
node tools/Build-Planner.mjs              every stage not yet applied, in order
node tools/Build-Planner.mjs migrate      copy every record from Nendo.nendo
node tools/Build-Planner.mjs compare      measure the copy against Nendo.nendo
node tools/Build-Planner.mjs catch-up     bring a filled copy up to Nendo.nendo
```

- **Finding the files.** The script finds `Planner.nendo` among the running Nendo
  windows by its name. It finds the old planner by its application ID. It refuses a
  target that answers with the old planner's ID before it takes a lease. It only ever
  reads the old planner: `migrate` and `compare` take no lease there.
- **Proposals.** Each stage is one change set, validated into a proposal. At
  Unattended the script accepts its own proposal. Below Unattended it stops and names
  the proposal for the person to accept.
- **Migration.** `migrate` writes by JSON import, keeping record IDs and typed
  Reference codes. It works in reference order: initiatives, work, dependencies,
  findings, checks. Its idempotency keys are derived from content, so an interrupted
  run replays rather than duplicates.
- **Compare.** `compare` checks each field. Every source record must exist under its ID,
  every carried field must be equal after the transform declared in `CARRY`, and the
  copy must hold nothing extra. Every Reference must be unique.

**Rebuilding for the switch.** The switch rebuilds the file, so it carries the data of
that day:

1. Create an empty `Planner.nendo`.
2. Set its Agent access to Unattended.
3. Run the script, then `migrate`, then `compare`.

## The model

Entity and field IDs keep the `nd.*` prefix where the meaning is unchanged. Every reader
of the old file therefore reads the new one: the `/next` skill, `docs/dogfooding.md`, and
anyone who knows `nd.work.status`.

| Type | What changed, and why |
| --- | --- |
| **Work** (`W-`) | **Horizon is optional.** *Complete* and *Drop* clear it, because a horizon on closed work said nothing and the old file could not say so. **Part of** is a self-reference declared as the type's hierarchy ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)), with Planning order as the sibling order: the *Breakdown* outline drags work into place and splits a bundle into parts, replacing the hand-kept 1/100/200 ranges. **Waits on decision** points at a Decision. Value and effort stay (60 items are rated); the Score that divided them is gone, because no screen used it. |
| **Initiative** (`I-`) | **Status** (Active, Paused, Closed) added; migrated initiatives are Active. The *Review needed* flag and the action that raised it are gone: the action set it on nearly every work edit, so it was always on and said nothing ([dogfooding](../dogfooding.md) records the clear it needed). *Last reviewed* and the *Mark reviewed* command stay. |
| **Finding** (`F-`) | Disposition *Linked to work* is now *Tracked in work*, because the Work item field already says which work. **Guard and its falsification** is new: the reported-broken loop in `AGENTS.md` ends by recording exactly this, and until now it went into the context text. |
| **Check** (`C-`) | Unchanged but for colour. |
| **Dependency** | Unchanged. It is the edge type of the [Work dependencies](../../extensions/work-dependencies/README.md) graph, whose code the file now carries. |
| **Decision** (`D-`, new) | Question, options, recommendation, what was decided, when, and the ADR. The owner-picks-a-direction canvases and *Needs decision/ADR* standing now have a record to point at. It starts empty: no decision in the old file has a record to copy. |

- **Colour.** Every choice that a board groups by, or that a page takes its accent
  from, carries a tone.
- **References.** Every Reference is unique and numbered. Decisions start at `D-001`.
  The others continue after the highest code copied.

### What it works out

- **Work.**
  - *Is blocked* shows the Blocker section only while the work is Blocked.
  - *Days from start to done* stays empty until both dates exist.
  - It counts its Checks, its Findings and its Parts.
- **Initiative.** It counts its Work.
- **Decision.** It counts the work waiting on it.

That is all it works out. A count of only the passed checks, or only the delivered work,
would need a FilteredCount. A FilteredCount reads a *stored*, required Boolean, so it
would mean adding a field that repeats the status. The initiative page lists its open
work and its delivered work as related lists, and each list states its own count.

**There are no automatic actions.** The only one in the old file was the always-on flag.
Every trigger also asks this device for consent again on each schema change.

### Screens

The twelve work screens are now six, plus the dependency graph:

| Screen | What it answers |
| --- | --- |
| Now | Board by status, horizon Now |
| Plan | Board by horizon, open work only |
| By initiative | Reference board, open work only |
| Breakdown | Outline, drag to reorder |
| All work | List, with a count and a status breakdown |
| Delivery history | Timeline from start to completion, delivered work |
| Dependencies | The graph view |

The six old screens are covered by these:

- **Review queue** is Now's Review column.
- **Delivery progress** existed only to give a completion ring a denominator without
  Dropped work. Delivery history and the front page's Delivery tab replace it.
- **Open work by target date** and **Target dates** covered only a handful of targets.
  The work page states each one.
- **Horizon against status** always showed 46 Done items in Now, which was the defect
  this design removes.

**The work page.** The header shows the title, Reference and status accent, and the
status, horizon and standing. A Blocker section appears only while the work is blocked.
Four tabs follow:

- **Brief**: what the work is, its acceptance criteria, initiative, decision and sources.
- **Plan**: parent, order, ratings and dates.
- **Evidence**: its Checks and Findings, each with Add.
- **Links**: its parts, and what it blocks or is blocked by.

**The other record types.**

| Type | Screens |
| --- | --- |
| Initiatives | Gallery; page with open and delivered work |
| Findings | Triage board and list |
| Checks | Board by outcome and list |
| Decisions | Board; page with the work waiting on each |
| Dependencies | List and page |

**The front page** is a tab group:

- **Now**: doing, in review, blocked, ready in Now, the Now list in planning order, and
  open work by horizon.
- **Delivery**: delivered, the span, by month, the days anything was delivered, and
  recently delivered.
- **Evidence**: checks by outcome and by method, findings by disposition, untriaged, and
  the latest findings.
- **Decisions**: open decisions, and open work needing one.

**Commands.** Work has *Plan now*, *Start*, *Send to review*, *Complete*, *Drop* and
*Reopen*. Initiatives have *Mark reviewed*, and decisions have *Decide*. The file is
violet with the letter P, so it is not mistaken for the amber N beside it.

## The switch, 2026-09-29

The owner switched on 2026-09-29, with Planner.nendo already open.

- **Not rebuilt; caught up.** The copy was the same day's, and the owner had already
  edited one record in it. So instead of a rebuild from empty, `catch-up` imported the
  25 Checks the copy lacked and set the 38 fields that had changed since. It leaves alone
  a record the copy has already edited (version past 1), and names it. `compare` then
  found two differences, both that edit: C-281, W-089's owner shell, set to Passed in
  the new file.
- **Port.** Planner.nendo keeps 41766 on this device. `.mcp.json` and
  `.codex/config.toml` name it, so Nendo.nendo keeps 41763 and nothing had to be
  released.
- **Documents.** `docs/dogfooding.md`, `AGENTS.md`, `workspace/README.md` and the
  `/next` command name the new file.
- **Guards.** `tools/Build-NendoStation.mjs` refuses both planners' application IDs.
  `tools/Build-Planner.mjs` keeps the old one as its source.
- **The old file.** `Nendo.nendo` was kept as the archive until the owner retired it
  on 2026-10-06.

## Known limitations

- **Deleted codes.** A code deleted in the old file can be issued again, because the new
  file's counter starts at the highest code it holds.
- **History does not move.** History, receipts and record versions stay in the old
  file; a copied record starts at version 1.
- **Screen checks.** The screens are compiled and valid, but no check measures how they
  lay out.
