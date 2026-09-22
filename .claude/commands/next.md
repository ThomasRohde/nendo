---
description: Read the Nendo Development planner, triage the next work item and plan it
allowed-tools: Bash, Read, Grep, Glob, ReadMcpResourceTool, mcp__nendo__nendo_lease_status
argument-hint: (no arguments)
---

Triage what is next on the development agenda, from the live planner rather than
from memory or an old export, and plan it. Triage alone is half the command: an
item named and handed back costs the next session the same reading again.

## Which item is next

Horizon says when an item was meant to happen; status says what can happen to it
now. Status decides first.

1. **Doing** is the answer, whatever lane it sits in. Report it and stop. A
   second item started while the first is open is how two half-finished changes
   reach the same file. If several are Doing, name them all and say so.
2. **Ready**, sorted by horizon (Now, then Next, then Later) and then by
   `nd.work.order`. This is the ordinary path.
3. **Inbox**, same sort — and say that it was reached from Inbox, because that
   means the lane has not been triaged.

**Never return a Blocked item.** Its blocker names something the agent cannot
supply, so returning one hands back a task that cannot be started. Skip it. If a
skipped item was in Now or Next, name it and quote its blocker: a blocked item in
a near lane is a fact about the plan, not a detail.

An item in **Review** is waiting on the owner rather than on work. Name any that
exist at the top of the report — a review is the cheapest thing on the board to
move — then carry on to the item chosen above.

**Ratings never choose the work.** Value, effort and Value per effort are set on
every open item and are worth reporting, because they inform whether the plan is
right. They are not a sort key, and an item is not next because its score is
highest. This was easy to honour while the score was blank on every record and is
easy to forget now that it renders.

## Process

1. Read `docs/dogfooding.md` — the horizons paragraph, the reference ledger and
   the reading mechanics.
2. Read `nendo://application/entity/nd.work/records` once, and choose from it by
   the rule above.
3. Read the chosen item's **Decision standing**, its description (which carries
   the next action), its acceptance criteria and its sources.
4. Read `nendo://application/entity/nd.finding/records` and
   `nendo://application/entity/nd.check/records`, and name the findings and
   acceptance checks linked to that item. The findings say what the work is for;
   the checks say what has been measured.
5. Read `nendo.lease.status` so the report says whether the planner is free to
   write.
6. Open the repository sources the item names, so the report describes the code
   as it is rather than as the planner remembers it. Read far enough to plan:
   the type carrying the defect, its callers, its tests and the lane a guard
   would run in. A plan written from the finding's description of the code
   repeats the finding; a plan written from the code says what to change.

## Output

- One line of lane context: how many items are open in Now and Next, and how many
  of those are Blocked.
- Any item in Review, by Reference and title.
- The chosen item by **Reference and title**, with horizon, status, standing,
  initiative, and its value/effort as reported context.
- **What blocks it.** If standing is *Needs decision/ADR*, say plainly that no
  `src/` change is authorised until the owner accepts an entry, and say which
  entry.
- What the work contains, from its acceptance criteria and its sources.
- Its linked findings, and its acceptance checks with their outcomes. Never
  describe a Not run check as anything else.
- Then the plan below, and whether the lease is free.

## Then plan it

The report says what the item is. The plan says what to do about it, and it is
the half that has to survive being handed to the next session. Write it for an
agent who has not read this conversation.

- **Ordered steps, each naming the file and what changes in it.** A step that
  names no path is a heading, not a step. Say what the sentence, the function or
  the assertion becomes, not that it is "improved".
- **The guard, and how it will be falsified.** Name the lane that already runs
  it — a test class, `tools/Test-Repository.ps1`, a gate script — and the
  measurement it makes. Say which line you will put the defect back into to
  watch it fail. A guard that would have passed against the old code is guarding
  the symptom; say so and write the other one.
- **What the code contradicts.** Where the acceptance criteria and the source
  disagree, quote both and say which gives way. An existing behaviour with a
  documented reason is a decision to revisit, not an oversight to delete.
- **What belongs to another item.** Near items overlap, and the same sentence
  appears in two descriptions. Name the neighbour by Reference and say where the
  boundary falls, so the work does not grow into it.
- **What is unresolved**, if anything, and what would settle it.

Plan against what the operation, the type or the payload already carries. Reading
that first is what separates a rewrite from a redesign, and it is usually the
difference between an afternoon and a week.

## Bounds

Do not acquire the lease, change any planner record, edit `src/`, or start
implementing. Planning is reading and writing the plan. The decision to start is
the owner's, and it is a separate word from this one.
