# Nendo Development

Nendo Development is the primary planner for the development of Nendo. It lives in
the owner's `workspace/Planner.nendo`, which is git-ignored owner data
([design](design/planner.md)). It holds real work and is not a test fixture. It is
authored through MCP and used through the installed host's Use and Studio routes.

## Live planner and next work

Read the current lanes from the live Work records (`/next` does this). A Blocked item
in Now or Next is a fact about the plan; a Later item needing a decision or ADR is
retained work, not a scheduled commitment.

**Planning order is the order among siblings.** Work can be *Part of* other work
(`nd.work.parent`, the type's hierarchy), and its page lists its parts in that order.
Nothing needs renumbering when work closes.

**Every open item says what happens next and who has it.** *Next action*
(`nd.work.next`) is one line, kept true whenever an item is left open; the Now board and
the front page show it. *Held by* (`nd.work.heldBy`: Owner, Claude Code, Codex) says who
has the item, so a client sets it when it starts and does not take an item someone else
holds without a handoff. The handoff goes into the item's *Handoff log*
(`nd.work.handoff`), never over the brief.

**Closed work has no horizon.** *Complete* and *Drop* clear it, and *Reopen* sets it
to Next. Work that waits on an owner's choice points at a Decision
(`nd.work.decision`, `D-` codes), which says the question, the options, the
recommendation and what was decided. **Decision standing on a closed item is its
standing when it closed**, not a waiver granted afterwards.

Intentional product constraints remain Findings; they are not promises to remove the
constraints. Unknown ratings and dates stay empty.

### What Dropped means here

**Dropped keeps a record but takes it out of active work.** The record, its Reference
and its Checks stay, and the description carries the reason and the reopen trigger.
Reopen restores it in one command. Do not delete a planner record to tidy up.

**A superseded acceptance check keeps its Not run outcome.** When delivered work met a
check's criteria through evidence recorded elsewhere, the check's `actual` names the
records that answered it and its outcome stays *Not run*. Converting a never-executed
check into a pass is the relabelling this planner exists to prevent.

### The front page

Use opens on the front page, in four sections:

- **Now**: doing, in review, blocked, ready in Now, and the Now list in planning order
  with each item's next action.
- **Waiting for the owner**: work in review, and open decisions.
- **Findings**: how many are untriaged, and the newest.
- **Delivered**: by month, and lately.

The record types are one step away, in the breadcrumb's record-type picker. The file
is teal with the letter P.

## Connect and identify the file

### Codex and Claude Code

| Client | Instruction entry point | Repository MCP registration |
| --- | --- | --- |
| Codex | `AGENTS.md` | `.codex/config.toml`, `mcp_servers.nendo` |
| Claude Code | `CLAUDE.md` imports `AGENTS.md` | `.mcp.json`, `mcpServers.nendo` |

Start the client from this checkout and use its registered `nendo` tools and resources
directly. Claude Code may ask the person to trust a project's MCP registration; that
client permission is separate from Nendo's proposal acceptance and device behaviour
consent.

Claude Code also loads `.claude/skills/nendo-planner`, a read-only mod, as
`nendo-planner@skills-dir` (`claude plugin list`) when a session starts; start a new
session to run an edited mod. Its status line names the workspace files Nendo holds open
and the lease holder. A band above the prompt shows the open Now items, or the first
Next item when Now is empty, and `/planner` prints both lanes. While
`tools/Test-Production.ps1` runs, the band draws its progress from
`artifacts/gate-progress.json`, and `/gate` prints it. It reads the planner over the
endpoint in `%LOCALAPPDATA%\Nendo\Mcp\active`, so it keeps working after the session's
`nendo` tools drop. It never writes and takes no lease.

To check registration, run `codex mcp get nendo` or `claude mcp get nendo` from the
repository root. If Claude reports **Pending approval**, start `claude` here and approve
the project server. A registration check does not prove that a session loaded the
instructions; in Claude, `/context` lists the loaded memory files, which should include
`CLAUDE.md` and the imported `AGENTS.md`.

Both registrations name port 41787. Each file keeps its own agent port on a device, and
41787 is the one Planner.nendo keeps on the owner's machine. If Agent → Connect in the
planner shows another port, set it back to 41787 there; the refusal names the file that
has it. On another device, open the intended planner in Nendo and confirm the
application identity first. A Git checkout does not supply the planner; if it is absent,
do not create an empty replacement. The connected application identity, not a worktree
path, decides which file an agent edits.

### The planner's own skill

The planner carries its working rules as a skill package, `dev.nendo.planner`
([ADR-0024](decisions/0024-a-file-carries-its-own-agent-skill.md)), at
`skill://dev.nendo.planner/planner/SKILL.md`; any client can read that resource. It
covers the record types, finding a record by its Reference, leaving Reference empty on a
create, decision standing, the lanes, the `pl.cmd.*` commands, the evidence rules, the
lease and what a handoff writes. **Read it there rather than here**: this document keeps
what only the repository knows.

Its source is [`tools/planner-skill/`](../tools/planner-skill/SKILL.md). To change it,
edit the source and propose it with
`node tools/Put-NendoPackage.mjs tools/planner-skill --endpoint http://127.0.0.1:41787/mcp`;
only what differs is sent, and the owner accepts it like any proposal. Agents read the
package in the file, so a source edit never accepted changes nothing.

What the repository adds to a handoff: name the branch or worktree when one is used, and
stage explicit paths, because concurrent sessions share the checkout.

### Reference codes are numbered by Nendo

The Reference field of Work items, Findings, Checks, Decisions and Initiatives is unique
and numbered ([ADR-0020](decisions/0020-unique-and-generated-fields.md)). The number
carries on after the highest code of that shape and is never given out twice, even after
its record is deleted; a duplicate is refused with `value-not-unique`. A CSV import may
leave the Reference column out or its cells empty, and every row receives the next code.
Native relationship pickers search the configured title field, so a code typed there is
not a promised lookup path.

### Reading the file without paying for it twice

- `nendo://application/describe` is large and answers reconnaissance in one call. Read it
  **once**; the client saves a large result to a file, so query that file afterwards. For
  one record type, read `manifest` and `entity/{entityId}` (schema, record count and the
  type's screens), or `describe?include=manifest,entities` for the types without screens.
- For one narrow question, prefer the narrow resource: `manifest` for revisions and
  minimum host, `entity/{entityId}/schema` for fields, choice options and the record
  count, `vocabulary` for node kinds and limits, `surfaces` for what compiled, and
  `proposals` for what is waiting.
- **Do not page a record type to find a record or a value.** The records read takes
  `recordId` for one record, and `filter`, `sort` and `desc` for a page that holds only
  what matches: for example `entity/nd.work/records?filter=` followed by the
  percent-encoded `[{"fieldId":"nd.work.ref","op":"eq","value":"W-001"}]`. A count, a sum
  or a grouped count is one read of `entity/{entityId}/aggregate`, for example
  `aggregate?aggregate=count&groupBy=nd.work.status`. The filter operators are the
  vocabulary's (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `isNotNull`) plus
  `contains` and `descendantOf`.
- A client that speaks the Skills extension can load `skill://nendo-authoring/SKILL.md`,
  the host's own index of which read answers which question.
- `view-api` is for writing a custom view's code. Development work in this repository
  reads `docs/contracts/custom-views.md` instead.
- **Command IDs** are at `surfaces.applications[].surfaces[]`, on any node whose `kind`
  is `recordCommand`. `nendo.data.execute_command` takes that node's `commandId`, never a
  button label.
- **Record versions**: a command advances the record once *per step*. Every write
  returns the `recordVersion` it produced (a delete and an idempotent replay return
  null). Carry that value into the next write rather than computing one, or the write
  is refused as stale.
- The front page is not one of the applications. It is `surfaces.overview`, and each
  tile under it names the record type it reads.

In a file with automatic actions, a schema change can require native behaviour approval
again. If a write returns `NENDO_BEHAVIOUR_NOT_APPROVED`, leave it pending and ask the
person to review the behaviour in Nendo; proposal acceptance does not bypass that
interlock. Planner.nendo has none.

### Endpoint and identity

The registered MCP server is `nendo`, at `http://127.0.0.1:41787/mcp`. Before you
author, read `nendo://application/describe`, the live vocabulary and the pending
proposals. The planner's application ID is
`application-d0b7c0e877744c1c81cf0fdd013cae2e`; a different identity must be explained
before writes. Instance IDs and edit handles are not durable identity.

Acquire editing authority only when you need it. Then:

- Keep the application handle and receipt context private.
- Respect record versions and the published call limits.
- Keep a write's idempotency key stable across its retries. The key for
  `nendo.lease.acquire` is a fresh random value for each acquire, never a fixed word
  another agent could also send.
- Release the lease at handoff.

Before you retry an uncertain write, recover it through its receipt. Native acceptance
remains the person's action, also after a reconnect.

## Record types and daily use

The skill has the record types, the lanes and the evidence rules. Record identity is
the record type plus record ID; the planner uses distinct prefixed IDs across its types,
such as `nd.work.r.<slug>`. Choose a descriptive unique ID, and never reuse an import key
for a different record. There is no dependency type: planning order and *Part of* say
what comes first, and a Blocked item's *Blocker* says what it waits for.

On a work page, the related Findings and Checks carry **Add Check** and **Add Finding**
beside their headings. Add opens the record's own page as a create form with the work
item already selected; Save returns to the work page. Opening a row moves to that
record's page and offers one step back to the work item.

If Use still shows an older version after an MCP edit, leave it for Agent or Studio and
return. Over MCP, a 2026-07-28 protocol client can open `subscriptions/listen` for
`nendo://application/proposals`, `manifest` and `health` and be told when the person
accepts, when anything commits and when the file closes; a client that cannot hold a
stream polls. Before you retry a write, confirm the stored record version.

Checks start Not run. An owner's report and an accepted exception are never converted
into fresh passes. Do not add invented projects, placeholder work, fake estimates or test
records. Exercise artificial or failure scenarios on a disposable copy.

The skill lists the seven `pl.cmd.*` commands and what each sets. *Complete* also clears
Held by and Next action.

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

If the endpoint is unavailable or read-only, or this setup is not active, report that
specific condition. Continue already-authorized independent work from the repository's
contracts and task instructions, keep a concise handoff of changes and exact outcomes,
and reconcile into the original file when it is available. Never create a replacement
planner, never read its SQLite file directly, and never mark missing evidence as passed.

Keep the live file at its owner-selected location. Use Nendo's file lifecycle for
backup, duplicate, restore and reopen. Stale writes, compensation failure cases, CSV
round trips and destructive checks belong in a person-approved disposable copy. At
handoff, restore the original file and release editing authority.
