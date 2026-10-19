# Nendo Development

Nendo Development is the primary planner for the development of Nendo. It lives
in the owner's `workspace/Planner.nendo`. That file is git-ignored owner data, and
this repository does not keep versions of it. The file contains real work. It is
not a reusable test fixture. The application is authored through MCP and is used
through the installed host's Use and Studio routes.

This planner replaced the one of 2026-09-29 on 2026-10-19, and started empty: nothing
was migrated ([design](design/planner.md)). Its codes start again at W-001, so a W-, F-,
C-, D- or I- code in a commit or document from before 2026-10-19 names a record of the
retired planner, which the owner keeps outside this repository.

## Live planner and next work

The planning horizons are intentional. Read the current lanes from the live
Work records (`/next` does this); a Blocked item in Now or Next is a fact about
the plan, and a Later item needing a decision or ADR is retained work, not a
scheduled commitment.

**Planning order is the order among siblings.** Work can be *Part of* other work
(`nd.work.parent`, the type's hierarchy), and its page lists its parts in that order.
Nothing needs renumbering when work closes.

**Every open item says what happens next and who has it.** *Next action*
(`nd.work.next`) is one line, kept true whenever an item is left open; the Now board and
the front page show it. *Held by* (`nd.work.heldBy`: Owner, Claude Code, Codex) says who
has the item, so a client sets it when it starts and does not take an item someone else
holds without a handoff. The handoff itself goes into the item's *Handoff log*
(`nd.work.handoff`), never over the brief.

**Closed work has no horizon.** Horizon is optional: *Complete* and *Drop* clear it,
and *Reopen* sets it to Next. Work that waits on an owner's choice points at a
Decision (`nd.work.decision`, `D-` codes), which says the question, the options,
the recommendation and what was decided.
**Decision standing on a closed item is its standing at the time it closed**, not a
waiver granted afterwards.

Work that waits for a decision stays explicit. Intentional product constraints
remain Findings; they are not promises to remove the constraints. Unknown ratings
and dates stay empty.

### What Dropped means here

**Dropped keeps a record in the file but takes it out of active work.** The
record, its Reference and its Checks stay, and the description carries the reason
and the reopen trigger. Reopen restores it in one command. A drop is not a
decision that something is wrong. Do not delete a planner record to tidy up.

**A superseded acceptance check keeps its Not run outcome.** When delivered work
met a placeholder check's criteria through evidence recorded elsewhere, the
check's `actual` names the records that answered it and its outcome stays *Not
run*. Converting a never-executed check into a pass is the relabelling that this
planner exists to prevent.

### The planner has its own front page

Use opens on the front page, in four sections:

- **Now**: doing, in review, blocked, ready in Now, and the Now list in planning order
  with each item's next action.
- **Waiting for the owner**: work in review, and open decisions.
- **Findings**: how many are untriaged, and the newest of them.
- **Delivered**: by month, and lately.

The record types are one step away, in the breadcrumb's record-type picker. The file
is teal with the letter P.

## Connect and identify the file

### Codex and Claude Code

Both clients use the same live planner and shared repository instructions:

| Client | Instruction entry point | Repository MCP registration |
| --- | --- | --- |
| Codex | `AGENTS.md` | `.codex/config.toml`, `mcp_servers.nendo` |
| Claude Code | `CLAUDE.md` imports `AGENTS.md` | `.mcp.json`, `mcpServers.nendo` |

Start the client from this checkout. Use its registered `nendo` tools and
resources directly. Neither client needs to launch the other. Claude Code may
ask the person to trust a project's MCP registration. That client permission is
separate from Nendo's proposal acceptance and device behavior consent.

Claude Code also loads `.claude/skills/nendo-planner`, a read-only mod. Its
status line names the workspace files Nendo holds open and the lease holder. A
band above the prompt shows the open Now items, or the first Next item when Now
is empty, and `/planner` prints both lanes. While `tools/Test-Production.ps1` runs, the band
also draws its progress bar from `artifacts/gate-progress.json`, and `/gate` prints it.
Claude Code loads it from this folder as `nendo-planner@skills-dir` (`claude plugin list`)
when a session starts. A session the desktop app hosts did not pick up an edit to it
(2026-10-15): start a new session to run the changed mod. It reads the planner over the
endpoint in `%LOCALAPPDATA%\Nendo\Mcp\active`, so it keeps working after the
session's `nendo` tools drop. It never writes and takes no lease.

To check registration, run `codex mcp get nendo` or `claude mcp get nendo` from
the repository root. If Claude reports **Pending approval**, start `claude` here
and approve the project server through its normal prompt. A registration check
does not prove that a fresh agent session loaded the instructions or used the
planner. In Claude, `/context` lists loaded memory files. Check that the
repository `CLAUDE.md` and the imported `AGENTS.md` are present.

Both registrations name the local host at port 41787. Each file keeps its own
agent port on a device: 41787 is the one Planner.nendo claimed on this machine.
If Agent → Connect in the planner shows another
port, set it back to 41787 there; the refusal names the file that has it.
On another device, first open the intended planner in Nendo and confirm the
application identity. The
working `.nendo` file is owner data and is git-ignored, so a Git checkout alone
does not supply the planner. If the planner is absent, do not create an empty
replacement. If a Git worktree is used, its repository configuration can reach
the same host. The connected application identity decides which file an agent
would edit. The worktree-relative artifact path does not decide this.

### The planner's own skill

The planner carries the rules for working in it as a skill package, `dev.nendo.planner`
([ADR-0024](decisions/0024-a-file-carries-its-own-agent-skill.md)). A client that speaks
the Skills extension lists it beside `nendo-authoring` and reads it at
`skill://dev.nendo.planner/planner/SKILL.md`; any client can read that resource. It covers
the record types, finding a record by its Reference, leaving Reference empty on a create,
decision standing, the lanes, the `pl.cmd.*` commands, the evidence rules, the lease and
what a handoff writes. **Read it there rather than here**: this document keeps what only
the repository knows.

Its source is [`tools/planner-skill/`](../tools/planner-skill/SKILL.md). To change it,
edit the source and propose it with
`node tools/Put-NendoPackage.mjs tools/planner-skill --endpoint http://127.0.0.1:41787/mcp`;
the owner accepts it like any proposal, and only what differs is sent. The package in the
file is what agents read, so a source edit that was never accepted changes nothing.

What the repository adds to a handoff: name the branch or worktree when one is used, and
stage explicit paths, because concurrent sessions share the checkout.

### Reference codes are numbered by Nendo

The Reference field of Work items, Findings, Checks, Decisions and Initiatives is
unique and numbered ([ADR-0020](decisions/0020-unique-and-generated-fields.md)). The number carries
on after the highest code of that shape and is never given out twice, even after its
record is deleted; a duplicate is refused with `value-not-unique`, whoever writes it. A
CSV import may leave the Reference column out, or its cells empty, and every row receives
the next code. Native relationship pickers search the configured title field, so a code
typed there is not a promised lookup path.

### Reading the file without paying for it twice

- `nendo://application/describe` is large, and it answers the reconnaissance
  phase in one call. Read it **once**. The client saves large results to a
  file. After that, query that file; do not read the resource again. For one record
  type, read `manifest` and `entity/{entityId}` instead (schema, record count and the
  type's screens in one small read), or `describe?include=manifest,entities` for the
  types without the screens.
- For one narrow question, prefer the narrow resource: `manifest` for revisions
  and minimum host, `entity/{entityId}/schema` for fields, choice options and the
  record count, `vocabulary` for node kinds and limits, `surfaces` for what
  compiled, and `proposals` for what is waiting.
- **Do not page a record type to find a record or a value.** The records read
  takes `recordId` for one record, and `filter`, `sort` and `desc` for a page that
  holds only what matches: for example `entity/nd.work/records?filter=` followed by
  the percent-encoded `[{"fieldId":"nd.work.ref","op":"eq","value":"W-140"}]`. A
  count, a sum or a grouped count is one read of `entity/{entityId}/aggregate`, for
  example `aggregate?aggregate=count&groupBy=nd.work.status`. The filter operators
  are the vocabulary's (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `isNotNull`)
  plus `contains` and `descendantOf`.
- A client that speaks the Skills extension can load `skill://nendo-authoring/SKILL.md`:
  the host's own index of which read answers which question, with the vocabulary, the
  examples and the view API as its files. It says what this section says, from the
  build that serves it.
- `view-api` is for writing a custom view's code and nothing else. Development
  work in this repository reads `docs/contracts/custom-views.md` instead.
- **Command IDs** are at `surfaces.applications[].surfaces[]`, on any node whose
  `kind` is `recordCommand`. `nendo.data.execute_command` takes that node's
  `commandId`. It never takes a button label.
- **Record versions**: a command advances the record once *per step*. For
  example, *Plan now* moves v3 to v5, and *Complete* moves v9 to v11. Every write
  returns the `recordVersion` that it produced. A delete and an idempotent replay
  return null. Carry that value into the next
  write, and do not compute one. Otherwise the next write is refused as stale.
- The front page is not one of the applications. It is `surfaces.overview`, and
  each tile under it names the record type that it reads.

Planner.nendo has no automatic actions. In a file that has them, a schema change
can require native behavior approval again, even when the action's intent is
unchanged. If a write returns `NENDO_BEHAVIOUR_NOT_APPROVED`, leave it pending.
Ask the person to review the current behavior in Nendo.
Proposal acceptance alone does not allow the agent to bypass that interlock.

### Endpoint and identity

The registered MCP server is `nendo`, at `http://127.0.0.1:41787/mcp` for this
installation. Before you author, read `nendo://application/describe`, the live
vocabulary and the pending proposals. The planner's application ID is
`application-d0b7c0e877744c1c81cf0fdd013cae2e`. A different identity must be explained before
writes. Instance IDs and edit handles are not durable
identity.

Acquire editing authority only when you need it. Then:

- Keep the application handle and receipt context private.
- Respect record versions and the published call limits.
- Keep a write's idempotency key stable across its retries. The key for `nendo.lease.acquire` is a fresh random value for each acquire, never a fixed word another agent could also send.
- Release the lease at handoff.

Before you retry an uncertain write, recover it through its receipt. Native
acceptance remains the person's action, also after a reconnect.

## Record types and daily use

The skill has the record types, the lanes and the evidence rules. Record identity is the
record type plus record ID; the planner uses distinct prefixed IDs across its types, such
as `nd.work.r.s4`. Choose a descriptive unique ID, and never reuse an import key for a
different record. There is no dependency type: planning order and *Part of* say what comes
first, and a Blocked item's *Blocker* says what it waits for.

On a work page, the related Findings and Checks carry **Add Check** and **Add
Finding** beside their headings. Each row opens the record that it names. Add
opens the record's own page as a create form. In that form, the work item is
already selected, named and versioned, so you do not have to find the reference
in the picker. Save returns to the work page, with the new record in the list.
When you open a row, Nendo moves to that record's page and offers one step back
to the work item.

If Use still shows an older version after an MCP edit, leave it for Agent or
Studio, then return to Use before you repeat a write. Over MCP, a 2026-07-28 client
can open `subscriptions/listen` for `nendo://application/proposals`, `manifest` and
`health` and be told when the person accepts, when anything commits and when the
file closes; a client that cannot hold a stream polls. Before you retry a write,
confirm the stored record version.

Checks start Not run. An owner's report and an accepted exception are never
converted into fresh passes. This is the living development backlog. Do not add invented projects,
placeholder work, fake estimates or test records to make its screens look
populated. Exercise artificial/failure scenarios on a disposable copy.

### Commands

The skill lists the seven `pl.cmd.*` commands and what each sets. *Complete* also
clears Held by and Next action.

## Screens and calculations

| Screen | What it answers |
| --- | --- |
| Now | Board by status, horizon Now; its Review column is the review queue |
| Plan | Board by horizon, open work only; the empty-horizon column is the inbox |
| All work | Every item, newest first |
| Triage | Findings not yet Resolved or Accepted limitation, by disposition |
| All findings | Every finding |
| Checks | Every check |
| Decisions | Board by status |
| Initiatives | List with work counts |

A work page heads with status, horizon, standing, Held by and Next action, and carries
Brief, Evidence, Handoff and Details tabs; a Blocker section appears only while the work
is Blocked. Findings, Checks, Decisions and Initiatives each have a page; a decision's
lists the work waiting on it, and an initiative's its open and delivered work.

The calculated fields are *Is blocked* and two counts: an initiative's Work and the work
waiting on a Decision. **There are no automatic actions**, so a schema change never asks
this device for behaviour consent again. The file has a full-text index, so
`nendo://application/search` finds work by what it says.

## Unavailable planner and recovery

If the endpoint is unavailable or read-only, or if this setup is not active,
report that specific condition. Continue already-authorized independent work
with the repository's contracts and task instructions. Keep a concise handoff
of changes and exact outcomes. When the original file is available, reconcile
into it. Never create a replacement planner, never read its SQLite file
directly, and never mark missing evidence as passed.

Keep the live file at its owner-selected location. Use Nendo's file lifecycle
for backup, duplicate, restore and reopen. Stale writes, compensation failure
cases, CSV round trips and destructive checks belong in a person-approved
disposable copy. At handoff, restore the original file and release editing
authority.
