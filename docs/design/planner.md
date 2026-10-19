# Planner.nendo: the planner, designed

`workspace/Planner.nendo` is the Nendo Development planner, built for daily serial work by the
owner and two agent clients. Its codes run W-, F-, C-, D- and I- from 001.

## How it is built

`node tools/Build-Planner.mjs` builds it from an empty file over MCP alone, from
`tools/planner-definition.mjs`, in seven stages: schema, colour, behaviour, work, records, front,
finish. It writes the shape only, no records. At Unattended the script accepts its own proposal;
below it, it names the proposal for the person to accept. The file's skill is
`tools/planner-skill/` ([dogfooding](../dogfooding.md) says how to propose it).

## Identifiers its readers rely on

Entity, field and command IDs are `nd.*` and `pl.cmd.*`: `nd.work.status`, `nd.work.horizon`,
`nd.work.order`, `nd.work.isBlocked`, `pl.cmd.start` and the rest. The planner mod in
`.claude/skills/nendo-planner`, `/next` and the evidence rules read them. Status, horizon, decision
standing, the evidence method and outcome, the finding dispositions and the guard with its
falsification are fixed, because `AGENTS.md` names them.

## Fields

| Field | Rule |
| --- | --- |
| **Next action** (`nd.work.next`) | One line on every open item. The Now board, the work page and the front page show it. *Complete* clears it. |
| **Held by** (`nd.work.heldBy`: Owner, Claude Code, Codex) | Whose the work is. *Complete* and *Drop* clear it. |
| **Handoff log** (`nd.work.handoff`) | Its own tab: client, paths, commands, outcomes, kept apart from the brief. |
| **Markdown** | Brief, acceptance criteria, sources, observations, guards, decisions and outcomes. |
| **Blocker** | Text saying what an item waits for. There are no dependency links; planning order and *Part of* say what comes first. |
| **Standing** | Two choices. |
| **Findings** | Observation and reproduction in one Markdown field, sources in it. |
| **Checks** | *Build / environment* and *Actual result*. |
| **Decisions** | Question and options in one Markdown field; a one-line *ADR*. |
| **Initiatives** | Title, status and outcome. |

The file has a full-text search index. Its mark is a teal P. The calculations are *Is blocked* (it
shows the Blocker section, and the mod reads it), an initiative's work count and the work waiting on
a decision. Related lists state their own counts. **There are no automatic actions**, so a schema
change never asks this device for behaviour consent.

## Screens

A front page, eight screens and five record pages.

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

**The work page** heads with status, horizon, standing, Held by and Next action, shows a Blocker
section only while the work is blocked, and has four tabs: **Brief** (title, brief, acceptance
criteria, sources), **Evidence** (its checks and findings), **Handoff** (the log) and **Details**
(kind, initiative, decision, parent, order, dates, blocker, and its parts).

**Commands**: *Plan now*, *Start*, *Send to review*, *Complete*, *Drop* and *Reopen* on work,
*Decide* on decisions. *Complete* also clears Held by and Next action; *Drop* clears Held by.

## Known limitations

- **Screen checks.** The screens compile and the file is valid (`surfaces` reports no
  diagnostics), but no check measures how they lay out.
- **The Work dependencies view** (`extensions/work-dependencies`) is not carried by the planner;
  the package and its lane remain.
