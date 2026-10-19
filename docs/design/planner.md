# Planner.nendo: the planner, designed

`workspace/Planner.nendo` is the Nendo Development planner. **The owner switched to it on
2026-10-19.** It replaced the planner of 2026-09-29, which had been designed from the
host as it was then. That planner had seven work screens, a dependency graph, ratings
that never chose work, a four-tab front page, and a handoff that had to be written into
the description. When it was retired it held 293 work items, all closed, with 736 checks
and 342 findings. The work was done serially, one item at a time, by the owner and two
agent clients, and most of that structure was never read.

This planner is the same planner rebuilt for daily work and nothing else. It was built
empty under the working name PlannerNG.nendo and renamed when the owner switched.
**Nothing was migrated**: its codes start again at W-001, F-001, C-001, D-001 and I-001.
A code in a commit or document from before 2026-10-19 names a record of the retired
planner, which the owner keeps outside this repository.

## How it is built

`node tools/Build-Planner.mjs` builds it from an empty file over MCP alone, from
`tools/planner-definition.mjs`, in seven stages: schema, colour, behaviour, work,
records, front, finish. It writes the shape only, no records. At Unattended the script
accepts its own proposal; below it, it names the proposal for the person to accept.
The file's skill is `tools/planner-skill/` ([dogfooding](../dogfooding.md) says how to
propose it).

## What it keeps, so its readers keep working

Entity, field and command IDs keep their `nd.*` and `pl.cmd.*` names wherever the
meaning is the same: `nd.work.status`, `nd.work.horizon`, `nd.work.order`,
`nd.work.isBlocked`, `pl.cmd.start` and the rest. The planner mod in
`.claude/skills/nendo-planner`, `/next` and the evidence rules read it as they read the
planner before. Status, horizon, decision standing, the evidence method and outcome, the
finding dispositions and the guard with its falsification are unchanged, because
`AGENTS.md` names them.

## What changed, and why

| Change | Why |
| --- | --- |
| **Next action** (`nd.work.next`), one line on every open item | `AGENTS.md` asks for the next action whenever an item is left open. It was buried in the description; now the Now board, the work page and the front page show it. *Complete* clears it. |
| **Held by** (`nd.work.heldBy`: Owner, Claude Code, Codex) | "Respect work already Doing" needs to know whose it is. *Complete* and *Drop* clear it. |
| **Handoff log** (`nd.work.handoff`), its own tab | The handoff (client, paths, commands, outcomes) went into the description and overwrote the brief. |
| **Markdown** for brief, acceptance criteria, sources, observations, guards, decisions and outcomes | The host shows Markdown formatted, and these fields are written as lists and code. |
| **Full-text search index** | Finding an item by what it says, not only by its code. |
| **Dependencies removed** (`nd.link` and the graph view) | In a serial project the planning order and *Part of* already say what comes first. The Blocker text says what an item waits for. |
| **Value, Effort, Target date and the lead-time calculation removed** | Ratings never chose work, and six items in 293 had a target date. |
| **Standing has two choices** | *Outside current scope* was never used. |
| **Findings merge Observation and Reproduction** | One Markdown field; sources go into it. |
| **Checks lose Evidence reference** | It said what *Actual result* says. *Environment* is now *Build / environment*. |
| **Decisions merge Question and Options** | One Markdown field; *ADR and sources* is now a one-line *ADR*. |
| **Initiatives are title, status and outcome** | Area, target, last reviewed, sources and *Mark reviewed* were not read. |
| **Teal P** | So it is not mistaken for the violet planner it replaced. |

The calculations are *Is blocked* (it shows the Blocker section, and the mod reads it),
an initiative's work count and the work waiting on a decision. Related lists state their
own counts, so the work item's check, finding and part counts are gone. **There are no
automatic actions**, so a schema change never asks this device for behaviour consent
again.

## Screens

A front page, eight screens and five record pages, down from fourteen screens and a
four-tab front page.

| Screen | What it answers |
| --- | --- |
| Front page | Now (doing, review, blocked, ready in Now, and the Now list with next actions); waiting for the owner (in review, open decisions); untriaged findings; delivered by month and lately |
| Now | Board by status, horizon Now; its Review column is the owner's queue |
| Plan | Board by horizon, open work only; the empty-horizon column is the inbox |
| All work | Every item, newest first: history and search |
| Triage | Board of findings that still need a hand (not Resolved, not Accepted limitation) |
| All findings | Every finding |
| Checks | Every check; a work item's own are on its page |
| Decisions | Board by status |
| Initiatives | List with work counts |

**The work page** heads with status, horizon, standing, Held by and Next action, shows a
Blocker section only while the work is blocked, and has four tabs: **Brief** (title,
brief, acceptance criteria, sources), **Evidence** (its checks and findings), **Handoff**
(the log) and **Details** (kind, initiative, decision, parent, order, dates, blocker, and
its parts).

**Commands**: *Plan now*, *Start*, *Send to review*, *Complete*, *Drop* and *Reopen* on
work, *Decide* on decisions. *Complete* also clears Held by and Next action; *Drop* clears
Held by.

## Known limitations

- **Old codes are not continued.** W-001 here is not W-001 of the retired planner.
- **History does not move.** The retired planner's records, history and receipts stay in
  that file.
- **Screen checks.** The screens compiled and the file is valid (`surfaces` reports no
  diagnostics), but no check measures how they lay out.
- **The Work dependencies view** (`extensions/work-dependencies`) is no longer carried by
  the planner; the package and its lane remain.
