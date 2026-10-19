---
name: planner
description: How to work the Nendo Development planner - find work by its reference code, read its decision standing before changing code, take and hand over work with Held by and Next action, move it with the planner's commands, and record findings and checks as evidence. Use it whenever you plan, start, hand over or finish development work in this file.
---

# Working the Nendo Development planner

This file is the live backlog for developing Nendo. Every record in it is real work or
real evidence. Do not add placeholder, sample or test records to it, and do not delete a
record to tidy it: close it instead. Try anything artificial on a copy of the file.

The planner's application ID is `application-d0b7c0e877744c1c81cf0fdd013cae2e`. If
`nendo://application/manifest` names another, you are connected to another file: stop
and say which one before you write anything.

## The record types

| Entity | What it holds |
| --- | --- |
| `nd.work` | A work item: brief, acceptance criteria, next action, who holds it, horizon, status, standing, handoff log. `nd.work.parent` makes it part of other work |
| `nd.finding` | An observation: kind, severity, disposition, and the guard with its falsification |
| `nd.check` | One measured outcome for one work item (`nd.check.work`, required) |
| `nd.decision` | A question for the owner with its options, the recommendation and what was decided |
| `nd.initiative` | The outcome a run of work serves |

Fields carry the same prefix, such as `nd.work.status`. Choices are their displayed words.
Brief, acceptance criteria, sources, handoff log, observation and guard are Markdown.

## Finding a record

Records are named in conversation by Reference and title, such as **W-012 — Fold the
toolbar into the title band**. The codes are `W-` work, `F-` findings, `C-` checks, `D-`
decisions and `I-` initiatives. A number identifies a record and says nothing about
priority.

Find one record with one read, never by paging a type:
`nendo://application/entity/nd.work/records?filter=` and the percent-encoded
`[{"fieldId":"nd.work.ref","op":"eq","value":"W-012"}]`. For words rather than a code,
`nendo://application/search` answers from the file's full-text index. Resolve the code to
its record ID and current version before you write. A count or a grouped count is one
read of `entity/{entityId}/aggregate`.

**Leave Reference empty when you create a record.** Nendo gives it the next code for its
type when it is saved, and the write returns it under `assigned`. Never change a code.

## Choosing and taking work

Status decides first: an item that is **Doing** is the answer; then **Ready** by horizon
(Now, Next, Later) and planning order; then **Inbox**, saying it was untriaged. Never take
a **Blocked** item; its Blocker says what it waits for. An item in **Review** waits for
the owner.

On the item you take, read **Decision standing** before anything else:

- *Within accepted scope*: the work may proceed under the ADRs it names.
- *Needs decision/ADR*: no change to the product's source until the owner decides. The
  item points at the Decision (`nd.work.decision`); its Next action says what is asked.

Standing never authorizes a push, a release or a publication by itself.

**Held by** (Owner, Claude Code, Codex) says who has the item. Set it to yourself when you
Start, and do not take an item someone else holds without an explicit handoff.
**Next action** is one line saying what happens next. Keep it true whenever you leave an
item open: it is what the front page, the Now board and the next session read first.

## Commands

| Command | Command ID | Effect |
| --- | --- | --- |
| Plan now | `pl.cmd.planNow` | Horizon Now; status Ready |
| Start | `pl.cmd.start` | Status Doing; start date today |
| Send to review | `pl.cmd.review` | Status Review |
| Complete | `pl.cmd.complete` | Status Done; completion date today; horizon, holder and next action cleared |
| Drop | `pl.cmd.drop` | Status Dropped; horizon and holder cleared |
| Reopen | `pl.cmd.reopen` | Status Ready; completion date cleared; horizon Next |
| Decide | `pl.cmd.decide` | Decision status Decided; decided date today |

Run them with `nendo.data.execute_command`, taking the command ID from a `recordCommand`
node in `nendo://application/surfaces`, never from a button label. They are convenience
edits, not a guarded state machine: a repeated Start resets its date. A command advances
the record one version per step; carry the `recordVersion` each write returns into the
next one rather than computing it. Set Held by and Next action yourself, beside the
command. The file has no automatic actions.

## Evidence

- Record what you observed as a **Finding**: Defect, Friction, Known limitation or Idea.
  Its disposition is Untriaged, Investigating, Tracked in work, Accepted limitation or
  Resolved. A defect's guard, and the failure text you saw when you put the defect back,
  go in *Guard and its falsification*.
- Record each measured outcome as a **Check** on its work item. Say how it was measured
  (Automated, Agent-observed or Owner-reported) separately from what came out (Not run,
  Passed, Failed, Blocked or Accepted exception), and name the build it ran against.
  Never turn an owner's report or an accepted exception into a pass.
- A passed check never completes work. Send work to Review when its results can be
  assessed, and complete it only after the acceptance evidence is checked.

## Writing and handing over

Take the single edit lease only for a bounded planner write, and release it before you
write code or run tests; never revoke someone else's. Every write carries the record's
current version and a stable idempotency key, and after a lost answer
`nendo.data.get_receipt` says what happened before you retry.

At handoff, add a dated entry to the work item's **Handoff log**: which client you are,
the changed paths and commit, the exact commands and their outcomes, and any new
Findings. Then set Next action. Never store a handle, a lease or a credential in the file.

Changes to the planner's definition go as a proposal the owner accepts. Name it by its
exact title, and never call it applied before they have accepted it.
