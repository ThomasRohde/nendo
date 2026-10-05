---
name: planner
description: How to work the Nendo Development planner - find work by its reference code, read its decision standing before changing code, move it with the planner's commands, and record findings and checks as evidence. Use it whenever you plan, start, hand over or finish development work in this file.
---

# Working the Nendo Development planner

This file is the live backlog for developing Nendo. Every record in it is real work or
real evidence. Do not add placeholder, sample or test records to it, and do not delete a
record to tidy it: close it instead. Try anything artificial on a copy of the file.

The planner's application ID is `application-5c52097771f342d5a648fcb514318e7c`. If
`nendo://application/manifest` names another, you are connected to another file: stop
and say which one before you write anything.

## The record types

| Entity | What it holds |
| --- | --- |
| `nd.work` | A work item: brief, acceptance criteria, horizon, status, decision standing, dates. `nd.work.parent` makes it part of other work |
| `nd.initiative` | An outcome or product area that work points at |
| `nd.finding` | An observation: severity, disposition, and the guard with its falsification |
| `nd.check` | One measured outcome for one work item (`nd.check.work`, required) |
| `nd.decision` | A question, its options, the recommendation and what was decided |
| `nd.link` | One dependency: `nd.link.from` blocks `nd.link.to` |

Fields carry the same prefix, such as `nd.work.status`. Choices are their displayed words.

## Finding a record

Records are named in conversation by Reference and title, such as **W-160 — Build the
file-carried agent skill package**. The codes are `W-` work, `I-` initiatives, `F-`
findings and `C-` checks; `D-` decisions. A number identifies a record and says nothing
about priority.

Find one record with one read, never by paging a type:
`nendo://application/entity/nd.work/records?filter=` and the percent-encoded
`[{"fieldId":"nd.work.ref","op":"eq","value":"W-160"}]`. Resolve the code to its record ID
and current version before you write. A count or a grouped count is one read of
`entity/{entityId}/aggregate`.

**Leave Reference empty when you create a record.** Nendo gives it the next code for its
type when it is saved, and the write returns it under `assigned`. Do not scan for the
highest code. Never change an existing code.

## Before you change anything

Take the Now lane first, then Next. On the item you take, read **Decision standing**
before anything else:

- *Within accepted scope*: the work may proceed under the ADRs it names.
- *Needs decision/ADR*: no change to the product's source until the owner accepts a
  decision. The item's description carries the next action.

Standing never authorizes a push, a release or a publication by itself. Work already
**Doing** belongs to whoever started it; take it over only by an explicit handoff.

## Lanes

**Horizon** (Now, Next, Later) is priority, and only open work has one. **Status** (Inbox,
Ready, Doing, Blocked, Review, Done, Dropped) is execution. Order among siblings is the
planning order; Value and Effort inform a discussion and never choose work.

## Commands

| Command | Command ID | Effect |
| --- | --- | --- |
| Plan now | `pl.cmd.planNow` | Horizon Now; status Ready |
| Start | `pl.cmd.start` | Status Doing; start date today |
| Send to review | `pl.cmd.review` | Status Review |
| Complete | `pl.cmd.complete` | Status Done; completion date today; horizon cleared |
| Drop | `pl.cmd.drop` | Status Dropped; horizon cleared |
| Reopen | `pl.cmd.reopen` | Status Ready; completion date cleared; horizon Next |
| Mark reviewed | `pl.cmd.reviewed` | Initiative's last-reviewed date today |
| Decide | `pl.cmd.decide` | Decision status Decided; decided date today |

Run them with `nendo.data.execute_command`, taking the command ID from a `recordCommand`
node in `nendo://application/surfaces`, never from a button label. They are convenience
edits, not a guarded state machine: a repeated Start resets its date. A command advances
the record one version per step; carry the `recordVersion` each write returns into the
next one rather than computing it. The file has no automatic actions.

## Evidence

- Record what you observed as a **Finding**. Its disposition is Untriaged, Investigating,
  Tracked in work, Accepted limitation or Resolved. A defect's guard, and the failure text
  you saw when you put the defect back, go in *Guard and its falsification*.
- Record each measured outcome as a **Check** on its work item. Say how it was measured
  (Automated, Agent-observed or Owner-reported) separately from what came out (Not run,
  Passed, Failed, Blocked or Accepted exception). Never turn an owner's report or an
  accepted exception into a pass.
- A passed check never completes work. Send work to Review when its results can be
  assessed, and complete it only after the acceptance evidence is checked. Leave
  incomplete work open, with its next action written into its description.

## Writing and handing over

Take the single edit lease only for a bounded planner write, and release it before you
write code or run tests; never revoke someone else's. Every write carries the record's
current version and a stable idempotency key, and after a lost answer
`nendo.data.get_receipt` says what happened before you retry.

Changes to the planner's definition go as a proposal the owner accepts. Name it by its
exact title, and never call it applied before they have accepted it.

At handoff, write into the work item: its Reference, which client you are, the changed
paths, the exact commands and their outcomes, any new Findings, and the next action.
Never store a handle, a lease or a credential in the file.
