# Nendo Development

Nendo Development is the primary planner for the development of Nendo. It lives
in the owner's `workspace/Planner.nendo`. That file is git-ignored owner data, and
this repository does not keep versions of it. The file contains real work. It is
not a reusable test fixture. The application is authored through MCP and is used
through the installed host's Use and Studio routes.

**Planner.nendo replaced `workspace/Nendo.nendo` on 2026-09-29.** The old file grew
by adding each host feature as a test of it; the new one does the same job, designed
from the feature set ([design](design/planner.md), W-099). Every record crossed with
its record ID and Reference code, so W-, F-, C- and I- codes mean what they meant.
History, receipts and record versions did not cross: they stay in `Nendo.nendo`,
which is kept as the archive. Read it for that history; never plan in it. Where a
section below describes the old file, it says so.

## Live planner and next work

The completed source import on 2026-09-15 contained **six initiatives, 32 real
work items, 28 findings and 41 checks** (31 future acceptance criteria and ten
setup checks). Later dogfooding adds real findings and evidence. For current
totals, read the live records. Every imported work item has source references
and acceptance criteria. The linked checks have concrete procedures. Relevant
work descriptions name prerequisites and the next design decision.

The planning horizons are intentional. Read the current lanes from the live
Work records (`/next` does this); a Blocked item in Now or Next is a fact about
the plan, and a Later item needing a decision or ADR is retained work, not a
scheduled commitment.

**Planning order is the order among siblings.** Work can be *Part of* other work
(`nd.work.parent`, the type's hierarchy), and the *Breakdown* outline drags an
item into place and splits a bundle into parts. The order is no longer numbered by
hand into open, delivered and dropped ranges; the numbers the old file gave are
kept, and nothing needs renumbering when work closes.

**Closed work has no horizon.** Horizon is optional: *Complete* and *Drop* clear it,
and *Reopen* sets it to Next. Work that waits on an owner's choice points at a
Decision (`nd.work.decision`, `D-` codes), which says the question, the options,
the recommendation and what was decided.
**Decision standing on a closed item is its standing at the time it closed**.
For example, the S4-S7 items read *Within accepted scope* because their
amendments were accepted, not because the gate was waived.

For anything after this date, read the live records. This paragraph is a
starting point. It is not the state.

### The 2026-09-17 triage, and what Dropped means here

Six work items were Dropped, not deleted. Each one carries its reason and its
reopen trigger in its own description. Two were merges (W-012 into W-011, W-029
into W-022), where the two halves were one decision or one sitting. Four were
imported roadmap paragraphs that never moved and had no live question behind
them. For three of those four, the file itself already argued against them in
their own briefs.

**Dropped keeps a record in the file but takes it out of active work.** The
record, its Reference and its Checks stay. Reopen restores it in one command.
The code is never reused. A drop is not a decision that something is wrong. Read
the description to find which reason applied. Do not delete a planner record to
tidy up.

The rest of this section records the old file. **Planner.nendo has no review flag
and no automatic action**: the flag below was always on and said nothing.

**An initiative's last review was an agent's, and the record cannot say so.**
All six initiatives were cleared on 2026-09-17. Before each clear, every work
item under the initiative was read, and its outcome statement was confirmed to
still hold. The flag is `nd.initiative.reviewNeeded` (Review needed). The
*Initiative reviewed* command clears it and sets `nd.initiative.reviewed` (Last
reviewed) to the date. There is no reviewer field. This document therefore records the fact: Claude Code did that pass, not
the owner. In this schema, method belongs to a Check, and an initiative has no
Check. Read the flag as "somebody looked", not as "the owner agreed".

If the distinction must ever be actionable, it needs a field and not a
convention.

Before that clear, the flag was true on all six initiatives since the import,
and nobody had ever cleared it. That is why the clear was necessary: a signal
that is always on gives no information. The installed action raises the flag on
any change to a work item's initiative, horizon, status, acceptance criteria or
target. A triage of this size therefore sets every flag again. Clear the flags
last, after the work edits. If you clear them earlier, the pass flags again what
it cleared.

**A superseded acceptance check keeps its Not run outcome.** Four placeholder
checks from the import (C-031, C-034, C-035, C-036) state criteria that
delivered work met later, through evidence recorded elsewhere. Their `actual`
now names the records that answered them. Their outcome stays *Not run*, because
that is the true state of these checks. To convert a never-executed placeholder
into a pass, because the criteria were met somewhere else, is the relabelling
that this planner exists to prevent. The outcome field is not the place to
record that history.

### The planner has its own front page

Use opens on the front page. It is a tab group:

- **Now**: doing, in review, blocked, ready in Now, the Now list in planning order,
  and open work by horizon.
- **Delivery**: delivered, the span, by month, the days anything was delivered, and
  recently delivered.
- **Evidence**: checks by outcome and by method, findings by disposition, untriaged,
  and the latest findings.
- **Decisions**: open decisions, and open work needing one.

The record types are one step away, in the breadcrumb's record-type picker. The file
is violet with the letter P; the archive is the amber N.

### How the first planner was set up (Nendo.nendo, 2026-09-15)

The old file's front page was accepted on 2026-09-15, at definition revision 30 and
minimum host 1.23.0. Its Delivered ring counted over every work item, Dropped
included, because a ring's denominator is its scope (F-010).

For later priority/status changes, use the live records. Work that waits for a
decision stays explicit. Intentional product constraints remain Findings; they
are not promises to remove the constraints. Unknown ratings and dates stay
empty.

The initial three proposals passed clone validation without diagnostics and
were accepted. They contained four entities, 42 stored fields, three
relationships, 21 screen/command roots, five calculations, one function, one
action and one trigger. Their definition revision was 21, and their minimum host
version is 1.22.0. The owner separately approved automatic behavior, and later
imports ran the initiative-review action successfully. Shape acceptance and
device behavior approval remain separate person-owned acts.

W-001 was completed on 2026-09-15 after implementation and runtime
qualification. Its linked evidence has **11 Passed Checks and one Accepted
exception**. All authored views were inspected in Light/Dark. These were also
exercised: keyboard tabs, draft preservation, chart drill-through,
dated/undated views, graceful reopen without an agent, actions, commands,
compensation, stale writes and faithful CSV. The final compact-list correction
is accepted and inspected in both themes.

One requested entry point was absent at closure: related Checks had no Add or
open action. The supported type-specific Add route passed. **C-044 records the
unmet setup requirement; F-031 and W-033 carried the improvement.** W-033
delivered it on 2026-09-18: a related list now adds and opens.

C-044 has the method Owner-reported and the outcome Accepted exception. The
owner accepted the workaround on 2026-09-15 and closed W-001. Its actual result
still records the original agent observation: the related Checks list had no
Add or open control. Do not convert C-044 into a pass. It states what was
true on 2026-09-15, and the delivery of the improvement does not change that.
The closing census contains 34 work items, six initiatives, 32 findings and 45
checks. For later changes, read the live records.

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

To check registration, run `codex mcp get nendo` or `claude mcp get nendo` from
the repository root. If Claude reports **Pending approval**, start `claude` here
and approve the project server through its normal prompt. A registration check
does not prove that a fresh agent session loaded the instructions or used the
planner. In Claude, `/context` lists loaded memory files. Check that the
repository `CLAUDE.md` and the imported `AGENTS.md` are present.

Both registrations name the local host at port 41766. Each file keeps its own
agent port on a device (W-089): 41766 is the one Planner.nendo claimed on this
machine, and the archive keeps 41763. If Agent → Connection in the planner shows
another port, set it back to 41766 there; the refusal names the file that has it.
On another device, first open the intended planner in Nendo and confirm the
application identity. The
working `.nendo` file is owner data and is git-ignored, so a Git checkout alone
does not supply the planner. If the planner is absent, do not create an empty
replacement. If a Git worktree is used, its repository configuration can reach
the same host. The connected application identity decides which file an agent
would edit. The worktree-relative artifact path does not decide this.

### Shared-work handoff

At task start, name the stable Work item ID in the development conversation.
Read its status, criteria, sources, Findings and Checks. Work that is already
Doing is not implicitly free to take over. For the same scope, follow an
explicit user/task handoff. If there is no such handoff, choose authorized
independent work. The planner is not a multi-agent job scheduler, and it has no
hidden ownership/claim mechanism.

Acquire the single edit lease only for bounded planner writes. Release it while
you do code work or tests. A released lease does not mean that its work item is
unclaimed. If the other client holds the lease, continue independent read/code
work, and retry after release. Never revoke the lease for convenience, and never
widen authority. After you reacquire the lease, use current record versions.
Reconcile conflicts; do not overwrite the other client's edits.

At handoff, update the work status and linked Checks. Include these items in the
task's handoff:

- the work ID;
- the client name (Codex or Claude Code);
- the branch/worktree, when relevant;
- the changed paths;
- the exact commands/outcomes;
- new Findings;
- the next action.

If technical implementation notes help the next client, put them in the work
description. Put measured results in Checks. Do not store handles, credentials
or lease tokens in either place. Release editing authority before you hand
over.

### Short references

Use **Reference + title** in conversation and handoffs, for example **W-001 —
Build and qualify Nendo Development**. The required stored Reference field uses
`W-` for work, `I-` for initiatives, `F-` for findings and `C-` for checks.
The 108 records that the file held at definition revision 26 received distinct
codes through an accepted proposal at that revision. This count is later than
the 97 records of the 2026-09-15 import (see
[Initial inventory and source reconciliation](#initial-inventory-and-source-reconciliation)),
and it includes records created after the import. That proposal added four fields, for a total of 46
stored fields. W-002 is S4 Overview, I-001 is Develop Nendo in Nendo, and F-001
tracks this reference improvement. Numbers identify records. They do not
indicate priority.

The main lists, boards, gallery and detail forms show the field. To locate a
record exactly, use Studio's Reference filter. Alternatively, read that
entity's complete MCP record pages and match its `.ref` field. Before you write,
resolve the code to its semantic record ID and current version. Native
relationship pickers still search the configured title field and show internal
IDs. A short code typed there is not a promised lookup path. Calendar/timeline
cards keep their concise fields. To see the reference, open the record.

### Reference codes are numbered by Nendo

**Leave Reference empty when you create a record.** Since 2026-09-27 the Reference field
of Work items, Findings, Checks and Initiatives is unique and numbered
([ADR-0020](decisions/0020-unique-and-generated-fields.md), W-074): Nendo gives a new record
the next code for its type (`W-`, `F-`, `C-` or `I-` and at least three digits) when it
is saved. `nendo.data.create_record` returns the code under `assigned`; a form says
*Assigned when saved*. Do not scan a type for its highest code first. The number carries
on after the highest code of that shape, and a number is never given out twice, even
after its record is deleted.

A code you type is kept if no other record of the type holds it; a duplicate is refused
with `value-not-unique`, whoever writes it. Nothing stops a code being changed later, so
when titles, priorities or relationships change, keep codes unchanged. Retain historical
records (use Done, Dropped or Resolved as appropriate) rather than deleting them.

Before numbering, the file held five finding codes twice, each written by a client that
had scanned for the highest code. On 2026-09-27 one record of each pair was renumbered:
F-070 → F-165, F-071 → F-166, F-072 → F-167, F-081 → F-168 and F-132 → F-169. Each keeps
its old code in its context text, and the record that keeps the old code is the one
the other records link to or that came first. A commit or document before that date that
names one of these five codes may mean either record.

### Reading the file without paying for it twice

- `nendo://application/describe` is ~69 KB (measured 2026-09-22), and it answers the reconnaissance
  phase in one call. Read it **once**. The client saves large results to a
  file. After that, query that file; do not read the resource again.
- For one narrow question, prefer the narrow resource: `manifest` for revisions
  and minimum host, `entity/{entityId}/schema` for fields and choice options,
  `vocabulary` for node kinds and limits, `surfaces` for what compiled, and
  `proposals` for what is waiting.
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

A schema change can require native behavior approval again, even when the
action's intent is unchanged. If a write returns `NENDO_BEHAVIOUR_NOT_APPROVED`,
leave it pending. Ask the person to review the current behavior in Nendo.
Proposal acceptance alone does not allow the agent to bypass that interlock.

### Endpoint and identity

The registered MCP server is `nendo`, at `http://127.0.0.1:41766/mcp` for this
installation. Before you author, read `nendo://application/describe`, the live
vocabulary and the pending proposals. The planner's application ID is
`application-5c52097771f342d5a648fcb514318e7c`. The archive, `Nendo.nendo`, is
`application-7efd926c073f4be9974be19bbc39ff41`; an agent that finds itself
connected to it is on the wrong file. A different identity must be explained before
writes. Instance IDs and edit handles are not durable
identity.

Acquire editing authority only when you need it. Then:

- Keep the application handle and receipt context private.
- Respect record versions and the published call limits.
- Use stable idempotency keys.
- Release the lease at handoff.

Before you retry an uncertain write, recover it through its receipt. Native
acceptance remains the person's action, also after a reconnect.

## Record types and daily use

| Entity ID | Purpose | Important relationships |
| --- | --- | --- |
| `nd.initiative` | Outcome, product area, status (Active, Paused, Closed), optional target, sources and last reviewed | Work points here |
| `nd.work` | Brief, acceptance criteria, horizon, execution, decision standing and dates | `nd.work.initiative` -> initiative; `nd.work.parent` -> work (Part of); `nd.work.decision` -> decision |
| `nd.finding` | Observation, context, severity, disposition, source, and the guard with its falsification | Optional `nd.finding.work` -> work |
| `nd.decision` | Question, options, recommendation, what was decided and when, and sources | Work that waits on it points here |
| `nd.check` | Expected/actual result, method, outcome, procedure and environment | Required `nd.check.work` -> work |
| `nd.link` | One dependency between two work items, with an optional note | Required `nd.link.from` (blocker) and `nd.link.to` (blocked item) -> work |

Fields carry the same prefix, for example `nd.work.title`, `nd.work.status` and
`nd.check.actual`. Record IDs are global. Initial records have names such as
`nd.work.r.s4` and similar stable slugs. Future agents should choose a
descriptive unique ID. They should not reuse an import key for a different
record. Choices are their displayed strings. Exact numeric values retain the
host's numeric envelopes.

1. Read existing work and related records before you create a duplicate.
2. Use **Now / Next / Later** for scheduling intent on open work; closed work has
   none. Use **Inbox, Ready, Doing, Blocked, Review, Done, Dropped** for execution. Planning order is a stored
   number. Optional value/effort ratings inform discussion and never choose
   work.
3. Read **Decision standing** and the linked repository sources. **Within
   accepted scope** does not replace the ADR or authorize a push, release or
   publication.
4. Record observations as Findings and exact outcomes as Checks. A Finding's
   disposition is **Untriaged, Investigating, Tracked in work, Accepted limitation**
   or **Resolved**; the reported-broken loop's guard and its falsification text go in
   its **Guard and its falsification** field. Select
   **Automated**, **Agent-observed** or **Owner-reported** independently of
   **Not run**, **Passed**, **Failed**, **Blocked** or **Accepted exception**.
5. When the results of work are ready to assess, send it to Review. Complete it
   only after you check the acceptance evidence. A passed check never completes
   work by itself. Incomplete and blocked lanes remain explicit.

On a work page, the related Findings and Checks carry **Add Check** and **Add
Finding** beside their headings. Each row opens the record that it names
(ADR-0004, 2026-09-18 amendment; W-033). Add opens the record's own page as a
create form. In that form, the work item is already selected, named and
versioned, so you do not have to find the reference in the picker. Save returns
to the work page, with the new record in the list. When you open a row, Nendo
moves to that record's page and offers one step back to the work item.

Leave Reference empty: Nendo gives the record its code when you save (see
[Reference codes are numbered by Nendo](#reference-codes-are-numbered-by-nendo)). **C-044 remains an
Owner-reported Accepted exception and must not be converted into a pass**: it
records what was true when W-001 closed.

If Use still shows an older version after an MCP edit, leave it for Agent or
Studio. Then return to Use before you repeat a write. During setup closure, this
refreshed W-001 from Review to its stored Done state and corrected the
completion ring. F-032/W-034 retain the refresh/draft-handling investigation.
Live updates are not assumed. Before you retry a write, confirm the stored
record version.

The setup work item is `nd.work.r.dogfood`. Its acceptance checks distinguish
schema/record reads, real UI observations, owner reports, offline use and
recovery on a disposable copy. Future checks start Not run. Historical reports
are preserved in source context, and they are never converted to fresh passes.
This is the living development backlog. Do not add invented projects,
placeholder work, fake estimates or test records to make its screens look
populated. Exercise artificial/failure scenarios on a disposable copy.

### Commands

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

These are explicit convenience edits. They are not a guarded state machine. A
repeated Start resets its date by design. The old file's IDs
(`nd.screen.work-start.root` and the rest) do not exist here. Read the IDs from the
compiled surfaces rather than from a button label.

## Screens and calculations

| Screen | What it answers |
| --- | --- |
| Now | Board by status, horizon Now; its Review column is the review queue |
| Plan | Board by horizon, open work only |
| By initiative | Board by initiative, open work only |
| Breakdown | Outline of Part of, drag to reorder |
| All work | List, with a count and a status breakdown |
| Delivery history | Timeline from start to completion, delivered work |
| Dependencies | The Work dependencies graph over `nd.link` |

A shared work page carries Brief, Plan, Evidence and Links tabs; a Blocker section
appears only while the work is Blocked. Initiatives have a gallery and a page with
open and delivered work; Findings a triage board and a list; Checks a board by
outcome and a list; Decisions a board and a page with the work waiting on each.

The calculated fields are *Is blocked*, *Days from start to done*, and counts: a
work item's Checks, Findings and Parts, an initiative's Work, and the work waiting
on a Decision. The old file's Score (value per effort) is gone; Value and Effort
stay as ratings. **There are no automatic actions**, so a schema change never asks
this device for behaviour consent again.

The old file had twelve work screens, a Score calculation and one action that raised
an initiative's review flag on nearly every work edit. They stay in `Nendo.nendo`.

## Initial inventory and source reconciliation

The import on 2026-09-15 brought in **6 initiatives, 31 work items, 27 findings
and 30 future checks** from the source inventory. One real dogfooding work
item, Finding and Check for optional-score semantics followed. Complete live
reads found all 97 records and all 73 references resolved, with no duplicate
import IDs. Dates, ratings and estimates without source evidence are empty. An
open-issue search of `ThomasRohde/nendo` returned zero issues on this date, so
there were no GitHub issues to import or update.

The source inventory has 56 entries: 31 actionable items, 18 intentional
limitations, and 7 delivered/merged source groups. Nine additional Findings link
specific documented gaps to their Work items. Future state lives in the planner.
These are dated import decisions, not a second evolving backlog.

| Source | Import decision |
| --- | --- |
| [Roadmap](roadmap.md), Not qualified | Separate distribution, signing, ARM64, startup, clean-machine, accessibility, tray and power-loss work; intentional cloud/platform/client/account limits remain Findings |
| [Surface plan](design/surfaces-and-charts-plan.md), S4-S7 | One work item per slice, carrying its component list and ADR dependency; Reading Log qualification is separate |
| Surface plan, parked ideas | Outline, advanced scheduling and images remain accepted-limit Findings, not implied commitments |
| [ADR index](decisions/README.md) and [ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md) | One extension-design item; scheduling is not implementation authority |
| Roadmap, Agent authoring ergonomics | Consent design, target validation, multiple diagnostics, proposal rebase/recovery, version targeting and handshake naming; required-only sums and path/access boundaries stay limitations |
| Roadmap, vocabulary widening | Outcome runtime, selector measurement, calendar-month aggregate investigation and tile concurrency; fixed scales, start-year placement and session-local selection stay limitations |
| Roadmap, cleanup carry-forward | Asset integrity, CI allowance investigation and clean-user NSIS-wrapper lane |
| Roadmap, standing risk | Cold-user core-loop observation and this dogfooding application |
| [2026-09-12 MCP review](reviews/2026-09-12-local-mcp-review.md) and [UI review](reviews/2026-09-12-ui-polish.md) | Explicitly closed findings remain delivered; no duplicate unfinished tasks |
| [2026-09-13 review resolutions](reviews/2026-09-13-blackbox-behaviour-review.md#resolutions) | Resolved defects remain delivered; still-open target/sum issues merge into the current roadmap inventory |
| [2026-09-14 MCP review](reviews/2026-09-14-installed-host-mcp-review.md) | Six historical findings answered by current roadmap/contracts; not reopened from the old report |
| Current catalogue and contract introductions | Existing filter/calculation boundaries retained; stale production-pending statements linked to documentation work |

The optional-score work item, Finding and future Check came from a real
calculation read during setup. They are new dogfooding observations, separate
from the 94-record initial source inventory.

S0-S3 surface work and ADR-0008 S1-S9 are delivered context, not unfinished
work. Every imported record carries source references. Source references and
outcomes in the live file are authoritative. Scratch import files and logs are
disposable, and they must not be treated as backups or a second work planner.

## Unavailable planner and recovery

### Setup checks already performed

- `pwsh ./tools/Test-Repository.ps1`: exit 0, `Repository verification passed.`
- `git diff --check`: exit 0. Changed/new guidance files were separately checked
  for zero CR bytes and no UTF-8 BOM.
- Complete live reads: all 97 expected records, source/title/acceptance content
  retained, 73 references resolved, six initiative counts and 32 evidence counts
  equal independent counts over all records. No duplicate IDs.
- All 32 imported work items have empty ratings, as their sources do. Optional
  scores return `calculation-missing-input` with no numeric value. On the copy,
  4/2 returned 2. Absent and out-of-scale effort returned no number.
- Automatic-action consent initially blocked writes with
  `NENDO_BEHAVIOUR_NOT_APPROVED`. After owner approval, import writes committed
  and the affected initiatives were flagged. The updated target versions were
  reported.
- `nendo.health.verify_integrity`: `ok`, scanned at change sequence 79. This is
  an integrity result for that point, not a guarantee about later changes.
- A captured installed Nendo 0.6.0 window shows the separate automatic-action
  approval panel and no pending proposals. This is not a Use-screen UI check.
- The initial process exposed native chrome but no WebView controls. After a
  graceful exit, the same file reopened with process-local loopback WebView
  inspection enabled. Its Agent page showed Off, no activity and no edit lease.
  Use and Studio were usable without MCP access.
- The real-window screen pass covered 11 browse views and four detail pages in
  both Light and Dark, plus Studio in each theme. It found no script errors or
  visible error alerts. Keyboard arrows/Home/End switched tabs. Enter/Escape
  operated the view picker. An unsaved description survived tab changes and was
  discarded when the inspector closed. The Doing chart selected only W-001, and
  when its filter was cleared, 32 records returned. Calendar Undated showed 32
  records. Timeline Undated showed 31, with W-001 alone on the dated 2026 spine.
- Compact record lists render the title plus two detail fields. Reference was
  added without allowance for that ceiling, so All work's status and the Checks
  list's outcome needed earlier bindings. The accepted app correction was
  inspected on five changed lists in both themes (ten cases). Reference and
  execution/evidence state are visible together. F-030 is Resolved. Broader host
  changes are separate work.
- A disposable `qualification.nendo` was created through native Duplicate with
  a new instance identity. After separate owner behavior/access approval, 15 MCP
  checks covered trigger fields, reassignment, unassignment, unrelated and no-op
  edits, deletion, ratings, six commands, repeated Start, stale-version
  rejection without mutation, and exact idempotent replay.
- Eight native UI checks covered successful compensation of a multiline value, a
  30 Dec 2025–3 Jan 2026 span on the 2025 start-year spine, target-date calendar
  placement, the conditional blocker, the creation/linking of a Finding and
  Check, visible related evidence, and Plan now → Start → Send to review. A
  passing Check left the work status unchanged. The related-list entry-point gap
  above remains explicit. The capture used the respective type's Add form.
- The requested dated/undated, completion-span and start-year scenarios passed.
  The additional end-before-start rendering scenario was not inspected, and no
  result for it is claimed. Fresh Claude instruction loading and an actual
  two-client runtime handoff also remain unchecked. Repository/configuration
  integration is covered separately.
- Native faithful CSV export/import on the copy round-tripped 33 Work items.
  Complete MCP reads compared every stored field as a multiset: 33 new record
  IDs, all values equal, and the original 33 records unchanged. Nulls,
  references, dates, ratings, multiline text, quotes, Unicode and formula-like
  text survived. Import creates records. It does not restore IDs or merge with
  existing work. This intentionally created duplicate human References, only on
  the copy.

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
