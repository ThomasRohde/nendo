# Nendo Development

Nendo Development is the primary planner for the development of Nendo. It lives
in the owner's `workspace/Nendo.nendo`. That file is git-ignored owner data, and
this repository does not keep versions of it. The file contains real work. It is
not a reusable test fixture. The application is authored through MCP and is used
through the installed host's Use and Studio routes.

## Live planner and next work

The completed source import on 2026-09-15 contained **six initiatives, 32 real
work items, 28 findings and 41 checks** (31 future acceptance criteria and ten
setup checks). Later dogfooding adds real findings and evidence. For current
totals, read the live records. Every imported work item has source references
and acceptance criteria. The linked checks have concrete procedures. Relevant
work descriptions name prerequisites and the next design decision.

The planning horizons are intentional. The list below shows them as of the
second 2026-09-20 triage. Claude Code did that triage after the owner marked
W-052 and W-054 Done and dropped W-028 as not valuable for this prototype.

- **Now:** one. W-053 (remember which sections a person folded, across reopening
  the file). The owner asked for it. It is within accepted scope, with effort 1.
  W-032 (quiet empty results for optional calculations) was the other item. The
  owner accepted its ADR-0008 amendment, and W-032 was delivered and marked Done
  the same day.
- **Next:** three. Each one can start when the owner says so. W-026 (the
  duplicate startup inspection) is pure waste with no design question. It stays
  here because nobody opens a large file in this prototype. W-008 (how proposal
  review explains behaviour consent) is a small decision on the agent-authoring
  path. W-010 (independent authoring diagnostics together) returns from Later,
  because this product is now built by agent authoring in bulk. The owner moved
  it out on 2026-09-17 and decides when it comes back in.
- **Later:** six. W-045, W-011, W-017 and W-007 each need a decision or an ADR,
  and none of them shapes the next month. Two are Blocked on something that does
  not exist yet: a person's billing evidence (W-020) and a machine that can be
  cut from power (W-030). These are retained future work and decisions. They are
  not silently scheduled commitments.

10 items are open, 30 are Done and 13 are Dropped. **Planning order is unique
across the file**, so a board sorted by it has one answer. Open work holds 1-14,
delivered work holds 101-131 and dropped work holds 201-213. This keeps All work
in open-first order. When you add an item, keep the order unique, and do not
reuse a number. **Move a completed item's order into the delivered range when it
closes**.

**Horizon on a closed item says nothing.** The field is required and has no
empty value, so delivered and dropped work stays at Later. The completion date
of that work is its history, and every board except All work filters it out.
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

**Dropped is this file's way of keeping something without carrying it.** The
record, its Reference and its Checks stay. Reopen restores it in one command.
The code is never reused. A drop is not a decision that something is wrong. Read
the description to find which reason applied. Do not delete a planner record to
tidy up.

**An initiative's last review was an agent's, and the record cannot say so.**
All six initiatives were cleared on 2026-09-17. Before each clear, every work
item under the initiative was read, and its outcome statement was confirmed to
still hold. `nd.initiative.reviewed` carries the date, and there is no reviewer
field. This document therefore records the fact: Claude Code did that pass, not
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

The front page was accepted on 2026-09-15, at definition revision 30 and minimum
host **1.23.0**. Use opens on it. It shows:

- a title;
- a description that says what the file is for;
- work count;
- a Delivered ring;
- breakdowns by status and horizon;
- a Date range over the completion dates;
- an Evidence section (checks by outcome and **by method**, findings by
  disposition);
- a Lately section with the last five delivered items and the last five
  observations.

The record types are one step away, in the same **Showing** picker.

The Delivered ring counts over every work item, Dropped included. A ring's
denominator is its scope, and it cannot be narrowed independently (F-010). The
separate *Delivery progress* list keeps the non-dropped denominator.

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

C-044 stays an Owner-reported Accepted exception, which preserves the original
agent observation, and it must not be converted into a pass. It states what was
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

Both registrations name the local host at port 41763. On another device, first
open the intended planner in Nendo and confirm the application identity. The
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
The initial 108 records received distinct codes through an accepted proposal at
definition revision 26. That proposal added four fields, for a total of 46
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

### The reference ledger, and what it costs to read

**The ledger is the file, not this document.** There is no ordered or filtered
read resource. `nendo://application/entity/{id}/records` returns the records of
a type, fifty to a page, with a `nextCursor` that the same URI takes as
`?cursor=`. To find the highest code issued, you must therefore scan that type,
every page of it. If you read a first page as the whole type, you allocate a
code that is already taken. This happened on 2026-09-19, when findings ran to
87.

**Scan a type at most once per session.** Take the highest `.ref` from that one
read. Then allocate locally, and increment for every further record that you
create in the same session. Four separate scans of the same entity to allocate
four codes is the mistake that this paragraph exists to prevent.

By intent, this document does not record the highest code per type, and it
does not record the record counts. This section carried both until 2026-09-15.
On the day it was written, its finding code was already one behind the file. A
copied number is correct until the next record is created. A stale number is
worse than no number: it reads as an authority to allocate against, but the
codes that it gives are already taken. Dated census figures elsewhere in this
document state what was true on a date, and you read them as history. A ledger
claims to state what is true now, and only the live file can do that.

### Reading the file without paying for it twice

- `nendo://application/describe` is ~58 KB, and it answers the reconnaissance
  phase in one call. Read it **once**. The client saves large results to a
  file. After that, query that file; do not read the resource again.
- For one narrow question, prefer the narrow resource: `manifest` for revisions
  and minimum host, `entity/{entityId}/schema` for fields and choice options,
  `vocabulary` for node kinds and limits, `surfaces` for what compiled, and
  `proposals` for what is waiting.
- **Command IDs** are at `surfaces.applications[].surfaces[]`, on any node whose
  `kind` is `recordCommand`. `nendo.data.execute_command` takes that node's
  `commandId`. It never takes a button label.
- **Record versions**: a command advances the record once *per step*. For
  example, *Plan now* moves v3 to v5, and *Complete* moves v9 to v11. Every write
  returns the `recordVersion` that it produced. Carry that value into the next
  write, and do not compute one. Otherwise the next write is refused as stale.
- The front page is not one of the applications. It is `surfaces.overview`, and
  each tile under it names the record type that it reads.

For a new record, allocate the next unused number for its type, padded to at
least three digits. Enter it explicitly. Agents must do these steps:

1. Acquire the edit lease.
2. Read current codes.
3. Check that the proposed code is absent.
4. Create the record.
5. Release the lease.

When titles, priorities or relationships change, keep codes unchanged. Retain
historical planner records (use Done, Dropped or Resolved as appropriate), so
that issued codes are not reused.

This is an application convention. The host requires a nonempty Reference, but
it does not allocate codes, enforce uniqueness or prevent changes to them.
People who create records must also check existing references. Neither client
may claim automatic numbering, immutable fields or deep links. A broader host
feature needs its own design and acceptance work.

A schema change can require native behavior approval again, even when the
action's intent is unchanged. If a write returns `NENDO_BEHAVIOUR_NOT_APPROVED`,
leave it pending. Ask the person to review the current behavior in Nendo.
Proposal acceptance alone does not allow the agent to bypass that interlock.

### Endpoint and identity

The registered MCP server is `nendo`, at `http://127.0.0.1:41763/mcp` for this
installation. Before you author, read `nendo://application/describe`, the live
vocabulary and the pending proposals. The planner's application ID is
`application-7efd926c073f4be9974be19bbc39ff41`. A different identity must be
explained before writes. Instance IDs and edit handles are not durable
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
| `nd.initiative` | Outcome, product area, optional target, sources and review flag | Work points here |
| `nd.work` | Brief, acceptance criteria, horizon, execution, decision standing and dates | `nd.work.initiative` -> initiative |
| `nd.finding` | Observation, context, severity, disposition and source | Optional `nd.finding.work` -> work |
| `nd.check` | Expected/actual result, method, outcome, procedure and environment | Required `nd.check.work` -> work |

Fields carry the same prefix, for example `nd.work.title`, `nd.work.status` and
`nd.check.actual`. Record IDs are global. Initial records have names such as
`nd.work.r.s4` and similar stable slugs. Future agents should choose a
descriptive unique ID. They should not reuse an import key for a different
record. Choices are their displayed strings. Exact numeric values retain the
host's numeric envelopes.

1. Read existing work and related records before you create a duplicate.
2. Use **Now / Next / Later** for scheduling intent. Use **Inbox, Ready, Doing,
   Blocked, Review, Done, Dropped** for execution. Planning order is a stored
   number. Optional value/effort ratings inform discussion and never choose
   work.
3. Read **Decision standing** and the linked repository sources. **Within
   accepted scope** does not replace the ADR or authorize a push, release or
   publication.
4. Record observations as Findings and exact outcomes as Checks. Select
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

You still pick the Reference code. The host requires the field, but it does not
allocate a code, enforce uniqueness or prevent changes to it. Before you save,
allocate `C-0nn` or `F-0nn` by the ledger rules below. **C-044 remains an
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

| Command | Effect |
| --- | --- |
| Plan now | Horizon Now; status Ready |
| Start work — set start date to today | Status Doing; overwrite start date with today |
| Send to review | Status Review |
| Complete | Status Done; completion date today |
| Reopen | Status Ready; clear completion date |
| Initiative reviewed | Clear review-needed; last-reviewed date today |

These are explicit convenience edits. They are not a guarded state machine. A
repeated Start resets its date by design. Commands have stable IDs that you can
find in the compiled surfaces. Use the returned commandId, not a guessed button
label.

## Screens, calculations and action

The work screens are All work, Roadmap, Now, Review queue, Delivery progress,
Target dates and Delivery history, with a shared tabbed work page. Initiatives
use a gallery and related-work page. Findings have a triage list and
disposition board. Checks have a list and full evidence form. All required
create fields appear on the corresponding detail page. No unadvertised defaults
are assumed.

**Intentional layout adjustment:** All work stays unfiltered for browsing and
chart drill-through. Delivery progress excludes Dropped records and carries the
completion ring, so its denominator is all non-dropped work. In the current
vocabulary, a ring cannot change its denominator independently of its parent
query.

The calculated fields are value per effort, initiative outcome, initiative work
count, work evidence count, and Is blocked. The last one controls a blocker
section. Calculations are read-only. They are never used for query ordering,
filters, grouping or surface totals. Related calculations have a 256-member
ceiling. The host refuses a partial result, while surface totals use exact
aggregate reads.

**Optional scores are quietly empty.** The score is declared to allow an empty
result over optional ratings. Since the 2026-09-20 amendment to ADR-0008, that
declaration decides the result: an unrated item reads *Not set*, not a
missing-input error (W-032; F-015 records what it read before). The score's 1-5
guard refuses by name with `Refuse('Ratings are 1 to 5.')`. That is the proposal
that the owner accepted the same day, in place of its old `0 / 0` guard
(definition revision 39). Do not invent zero ratings, and do not fill a rating
to make a score appear.

The single installed action sets `nd.initiative.reviewNeeded` to true in these
cases:

- work is created;
- work is deleted;
- the initiative, horizon, status, acceptance criteria or target of work
  changes.

Reassignment reaches both the previous and the next initiative. An empty
reference selects no target. Unrelated edits do not flag an initiative. The
action writes a literal true with no event-record bindings, and it has no
cascading initiative trigger. Approval covers the exact behavior definition and
stays device-local.

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
| [ADR index](decisions/README.md) and [ADR-0013](decisions/0013-defer-general-extension-model.md) | One extension-design item; scheduling is not implementation authority |
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
