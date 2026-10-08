# Garden review

Review started 2026-10-08. Scope: Garden's custom views, writing and reading workflows,
derived links/tags/tasks, navigation, search, accessibility, responsive layout, themes,
failure handling, and the adequacy of its existing checks. This is a review, not a fix pass.

## Running tally

| Priority | Open | Meaning |
| --- | ---: | --- |
| P1 | 5 | Data loss, incorrect writes, or a core workflow blocked |
| P2 | 8 | Material behavior, accessibility, or usability defect |
| P3 | 2 | Smaller clarity, polish, or maintainability issue |

**15 open findings. Suggested triage order:**

| Order | Findings | First outcome to secure |
| --- | --- | --- |
| 1 | G-002, G-003 | Ordinary navigation never discards unsaved writing |
| 2 | G-010, G-008 | Failed reads and lost replies cannot create duplicate data |
| 3 | G-001 | Draft persistence reports and handles retention failures |
| 4 | G-004, G-011, G-013 | Valid tags and task edits preserve distinct records and metadata |
| 5 | G-009, G-012 | Busy Undo and read failures have safe recovery |
| 6 | G-006, G-007 | Agenda preserves task sequence and keyboard position |
| 7 | G-015, G-014, G-005 | Readable graph labels and honest navigation/empty states |

## Scope and evidence

- Repository initially clean; Garden source is `extensions/garden/`, with definition
  and tests in `tools/garden/` and browser measurements in `tools/Gate-Garden.mjs`.
- Registered MCP serves Planner.nendo; Garden is not among the running instances.
  No owner file will be used as a mutation fixture. Browser work uses disposable data
  in the repository's fixture broker; it does not establish installed-host behavior.
- Planner has no open Work items. Existing W-174, Build Garden.nendo, an agent-friendly
  digital garden (`nd.work.r.garden`), is Done, Within accepted scope.
- Reviewed source: HEAD `5d183e81db11ef61d412b9eddf50e0fa18345d00`, Garden 0.20.0.
  The tally records reproducible defects and explicitly labeled usability judgments.

## Findings

### G-001 — P1 — Draft retention silently drops unsaved work

**Confirmed from source and existing executable tests.** `drafts.mjs:51-65` keeps at most
20 drafts and 512 KiB of serialized characters. Older drafts, and any individual draft
that exceeds the budget, are omitted. A storage failure returns null. The caller in
`workspace.js:256-263` ignores the return value. No warning tells the person that an
unsaved draft will not survive leaving this view, despite the guide's retention promise.

Reproduce: leave 21 notes dirty, then restart the view; the oldest draft is gone.
Alternatively make storage refuse a write. `tools/garden/drafts.test.mjs` already
demonstrates eviction and swallowed quota errors; these are intentional mechanics
without an adequate user-facing recovery contract.

**Suggested acceptance:** force both limits and a quota refusal, then prove no unsaved
work disappears without a visible actionable warning and a way to save or export it.

### G-002 — P1 — Clicking the current note discards its unsaved text

**Browser reproduced.** Edit Start here, type a replacement body, then click Start here
in the tree. The saved body returns, `dirty` becomes false, and the stored draft is
removed. No discard question or recovery action appears. `workspace.js:280-296` only
calls `keepDraft()` when moving to a different record; opening the current record
overwrites the in-memory draft. The same opening path is used by self-links and some
commands. Reproduction body: `UNSAVED same note click`; afterward the body was the
original `# Welcome to your garden...`, with `dirty:false`.

**Suggested acceptance:** type, activate the current tree row, and assert both text
and dirty state survive; also cover a self-link and a stage command with a dirty editor.

### G-003 — P1 — New note twice erases an unsaved new note

**Browser reproduced.** New note, title `Unsaved new`, body `UNSAVED NEW BODY`, then
New note again: both controls become empty. `workspace.js:301-310` only preserves a
draft when `state.note !== null`; an unsaved new note has null identity, and its current
draft has already been removed from the draft map. Today also calls this path.

**Suggested acceptance:** repeat New note and switch New note / Today with unsaved text;
either resume the draft or preserve distinct recoverable drafts without overwriting one.

### G-004 — P2 — Distinct Unicode tags can prevent a whole note from saving

**Pure module and browser reproduced.** Save a note containing `#café #cafe` when neither
tag exists. Both creates use `gd.tag.cafe`, and the batch refuses:
`writes[3] writes gd.tag.cafe again; put a record's changes in one write.`
`sync.mjs:103-113` allocates against the pre-save tags only, while `parse.mjs:57-60`
reduces both names to the same ASCII slug. Other examples include distinct non-Latin
tags reduced to `note`. The draft stays, but otherwise valid writing cannot be saved.

**Suggested acceptance:** distinct normalized-slug collisions in the same batch and
across batches produce distinct tag IDs; exercise deleted-and-recreated tags too,
because deleted IDs remain reserved by the host.

### G-005 — P3 — A search with no matches leaves an unexplained empty tree

**Browser reproduced.** Find `NO_NOTE_HAS_THIS_TEXT_123`: zero tree rows, no empty-state
message. `workspace.js:183-184` hides `#tree-empty` based on the total index rather than
visible results. Its only message is "No notes yet. Plant one with New note."

**Suggested acceptance:** zero search results says "No matching notes" and offers to
clear Find, while a genuinely empty garden keeps its separate onboarding message.

### G-006 — P2 — Agenda alphabetizes away the order of a note's instructions

**Real-content browser observation and source confirmed.** All 20 tasks in the live
snapshot are undated. Within each source note, `agenda.mjs:61` sorts by task text.
For Tutorial: your first file, the Agenda puts "Add an optional field..." before
"Create an empty file...". Try Nendo Station puts "Put the station back as it was"
before "Take Coolant pump A offline...". These are executable tutorial steps, and
their body order carries meaning that the Agenda discards.

**Suggested acceptance:** retain source-line order for equally due tasks from one
note, with a deliberate ordering policy for Manual tasks. Measure the tutorial order,
not just the group names and counts.

### G-007 — P2 — Following a wikilink loses keyboard focus

**Browser reproduced.** Activate a wikilink in the reading body. The new note opens,
but `document.activeElement` becomes BODY, with no focus on the new heading, reading
region or a retained navigation control. `workspace.js:267-298` redraws the old link
away and scrolls the tree's current row without placing focus. Keyboard users lose
their position; screen-reader users lack a deliberate reading destination.

**Suggested acceptance:** follow a link by Enter and assert focus reaches a labeled
destination on the opened note, with Back restoring the prior navigation position.
The current reproduction confirms DOM focus only, not a screen-reader session.

The same loss was reproduced after focusing an Agenda checkbox and pressing Space:
the refreshed list leaves BODY focused (`agenda.js:45-54`). Include focus retention
on the same task, or an explicitly selected next task, in the acceptance check.

### G-008 — P1 — A lost new-note save reply duplicates the note after a restart

**Browser reproduced with the fixture broker's commit-then-drop-reply injection.**
Create `Unanswered new`, have the batch commit but answer `host-timeout`, restart the
view, resume the restored draft with New note, then Save. Two records now exist, with
slugs `unanswered-new` and `unanswered-new-2`. Before restart the UI promised the same
save would be kept once. `workspace.js:688-710` retains the original writes and writeKey
only in `state.unanswered`; `drafts.mjs` persists text but neither that request nor its
identity. The post-restart save gets a new ID and key.

**Suggested acceptance:** commit a new-note batch, lose the reply, recreate the view,
retry, and assert exactly one note and one derived set of rows. Also cover a lost
reply for an existing note, so it does not become a permanently stale draft.

### G-009 — P2 — Undo during a write silently consumes the previous Undo entry

**Executed against the actual `createWriter` module in the browser with a controlled
delayed writer.** Complete First; start Second but hold its reply; invoke Undo.
`screen.js:77-80` pops First before checking `busy`, then returns. After Second completes,
the stack contains only Second. First was never undone and cannot be reached by this
view's Undo. The UI does not disable its prior Undo link while a new write is in flight;
Ctrl Z enters the same function. Both Agenda and Tend share this writer.

**Suggested acceptance:** defer a batch, invoke Undo, finish it, and assert the prior
entry remains reachable. Busy/refusal checks must not consume history.

### G-010 — P1 — A failed related-record read lets Save duplicate derived data

**Browser reproduced.** Open Tags and tasks with one related `records.query` refused;
the page displays the read error but permits editing and saving. Append a harmless
sentence and Save: this note's note-tag rows increase from 3 to 6 and task rows from
2 to 4. `workspace.js:327-332` substitutes empty lists for failed reads, and
`save()` passes those lists to `plan()` as if the note had no derived records.
The definitions have no uniqueness constraint to prevent these duplicate joins/tasks.
This is a write-safety defect, not just an error-message problem.

**Suggested acceptance:** refuse any one prerequisite read, attempt Save, and assert
no batch is submitted until a complete, current related-record snapshot is available.
After retry, append the same sentence and assert all derived record IDs are preserved.

### G-011 — P2 — Identical checkbox lines collapse into one task and misreport completion

**Pure module and browser reproduced.** A note with two `- [ ] Repeat` lines renders
two body checkboxes but says `0 of 1 task done` in the strip. Tick the second line:
the body saves it as checked while the strip still says `0 of 1 task done`, and the
Agenda's single task follows the first line. `parse.mjs:21-34` deduplicates tasks by
a case-folded text hash. Different occurrences have no independent identity.

**Suggested acceptance:** repeated task text on different lines has explicit identity
and matching done state, or duplicates are clearly refused/explained before save.
Cover repeated instructions under different headings as well as case-only variants.

### G-012 — P2 — An initial read failure leaves a misleading, nonfunctional empty workspace

**Browser reproduced.** Refuse the first `records.query` on mount with
`Review: initial index unavailable`. The rejection reaches `pageerror`; `ready` stays
false, the alert is empty and hidden, and the screen still says "Pick a note on the
left, or plant one with New note." `workspace.js:1040-1041` awaits `loadIndex()`
without recovery, and `garden.js` has no enclosing startup catch after API readiness.

**Suggested acceptance:** initial and refresh read failures show an actionable error
and Retry; they never look like an empty garden. Retry must reach the normal view
without a host restart. Include exceptions from the bounded query-all reads.

### G-013 — P2 — Editing a checkbox's wording silently deletes its due date

**Executed against the pure save planner.** Start with task `Call Sam`, due 2026-10-09,
then change its body line to `Call Sam tomorrow`. The plan creates a new task without
`gd.task.due` and deletes the original due-dated record. The identity is a hash of the
text (`parse.mjs:33`, `sync.mjs:149-166`), so an ordinary wording edit loses metadata
set through the task's record page. The next Agenda load moves it to No date.

**Suggested acceptance:** a wording edit retains the intended task identity and its
due date, or explicitly offers a reconciliation step. A genuine deletion must remain
distinguishable from a rename. Include two similar tasks and reordered lines.

### G-014 — P3 — Overview silently hides pins and tags beyond fixed limits

**Pure module and real-content UI confirmed.** `home-data.mjs:19-20,44-53` limits
Pinned to eight alphabetically and Tags to twelve by popularity. Nine pinned records
produce eight cards. The current file has 37 tags but shows 12. Neither heading says
these are partial, and neither section offers Show all. Pinning a ninth note can appear
to do nothing; adding an alphabetically earlier pin can remove another visible card.

**Suggested acceptance:** show the total and a way to reach the omitted records, or
present these explicitly as a curated subset. Test nine pins and thirteen used tags.

### G-015 — P2 — The dense Overview graph's visible labels are too small and overlap

**Measured rendering plus usability judgment.** With the live 108-note/1,450-link
snapshot at 1440 x 900, after a three-second settle, 11 labels were visible at an
effective font size of 9.08 CSS px. Two label pairs overlapped: Calculated fields /
How screens work, and Limits / Reversibility and compensation. No labels were clipped
in that settled sample. Layout is randomized, so the exact pairs can vary.

`graph.js:218-226,261-278` scales text with the graph and always shows hub labels;
collision uses a bounded radius, not the final label rectangles. `garden.css:275`
starts at 11px before zoom. The graph-first direction itself is an accepted owner
choice. The defect is the legibility of its navigable landmarks at the real density.

**Suggested acceptance:** measure effective label size and pairwise bounding-box
overlap at Fit in both themes, across the real density and several layout seeds.
Use labels that keep a readable size and collision/selection rules that avoid
overprinting. Retain keyboard navigation and the existing text alternative.

## Live application snapshot

Garden opened during this review. Read-only MCP reports package 0.20.0, definition
revision 64, data revision 2266, change sequence 2330: 108 notes, 1,450 links, 495 note-tag
rows, 37 tags and 20 tasks. This is the current Garden app, not the older Idea Garden
example. All 40 package-file SHA-256 values match `extensions/garden/`. Owner records
remain untouched. A read-only export is used to render the real content in the fixture
broker; all mutation probes use the separate synthetic seed fixture.

## Checks so far

- `pwsh -NoProfile -File ./tools/Review-Garden.ps1`: 69 module tests passed; browser
  lane passed all named checks, Browser exceptions: 0. Sandbox launch initially
  stalled; the same command completed with browser-launch access.
- Additional Playwright probes reproduced G-002 through G-005 despite that baseline.
  Scratch: `artifacts/garden-review-probe.js` and `garden-review-probe-results.txt`.
- `garden-review-edge.js`: reproduced G-008, G-009 and Agenda focus loss; the new-note
  retry created two distinct records in the synthetic fixture. No owner record was used.
- `garden-review-failure.js`: reproduced G-010 through G-012; injected read failures
  doubled note-tag and task rows in the synthetic fixture, repeated checkboxes counted
  as one, and initial read rejection had no visible error. The intentional rejection
  produced one page exception; the baseline lane's zero-error result remains separate.
- `pwsh -NoProfile -File ./tools/Test-Repository.ps1` reached Binary assets and stopped
  at the owner-file interlock: `workspace/Garden.nendo is open in Nendo`. This is not a
  corruption result or a repository pass. Garden was left open as the owner requested.
- Native window enumeration found Garden running with its window hidden and Planner
  visible. No window was activated, moved or edited. Screenshots in this report are
  browser renders, not native-window captures; the shared Mica shell is not exercised.

## UX/UI assessment and coverage

The reading-first workspace, flush editor, adjustable width, foldable tree and local
graph form a coherent writing environment. The baseline exercised both themes, real
pointer dragging, keyboard resizing, search highlights, diagrams, task strips,
backlinks, Overview handoff, Agenda and Tend. The current-content reading page and
Agenda are substantially easier to scan than the dense Overview graph.

- **Main weakness:** the promise that writing is safely kept is broken by everyday
  navigation and by recovery edge cases. Address the P1s before visual polish.
- **Accessibility:** keyboard focus loss is measured in G-007; graph tab navigation
  retains one entry tab stop. No screen reader or forced-colors session was run.
- **Responsive:** the real-content Overview at 700px measured scrollWidth = innerWidth
  = 700. Its graph started at y=569.88, below the stacked controls; this is a layout
  tradeoff, not evidence of a desktop/mobile host promise. The Guide becomes an overlay
  at that width. Actual Windows 200% scaling and native shell behavior were not exercised.
- **Visual:** inspected Light/Dark Overview, reading, Agenda, Graph, Tend, and narrow
  Guide captures; the existing lane also measures theme tokens and narrow layouts.
  A screenshot alone was not used to classify G-015: text size and overlaps were measured.
- **Data/security boundary:** inspected parse/render escaping, atomic save planning,
  manual-row preservation, per-record versions, and Mermaid's strict mode. No new
  markup-execution defect was established; this is not a security qualification.
- **Intentional boundaries, not findings:** no attachments, tables, footnotes, vault
  import or background derivation. Native/agent edits must keep derived rows in sync
  as the file's skill describes. Full production, build, installer and restore lanes
  were not run for this report-only change. No product files were edited or rebuilt.

## Checkpoint

Review complete across the scope above; 15 findings remain open. Changed tracked-scope
path: `GARDEN.md` only (new). No product implementation, commit or publish occurred.
Next action: owner triages findings; implementation should add each proposed guard to
the existing Garden lane, see it fail on the original defect, then fix and rerun it.
No guards were added or claimed falsified in this review-only pass.

## Planner handoff

The proposal **Garden review 2026-10-08: 15 prioritized findings and evidence**
validated as `previewable`, `isValid: true`, with zero diagnostics and 20 operations:
one Work item, fifteen Findings, and four Checks. It is **not accepted or applied**.
The edit lease was released. Proposal ID: `proposal-053be7db0ca86eecdc0dd8bcaf44350b`.
Proposed work ID: `nd.work.r.garden-review-20261008`; generated W/F/C references are
left to Nendo rather than guessed. The Work item remains Review with the owner's
triage as its next action. The checks preserve Passed, Failed, Blocked and Not run
as distinct outcomes.

Report bytes were checked explicitly: UTF-8, no BOM, zero CR bytes. Final changed-file
inspection found only this new report. Scratch browser data and probe scripts are
not durable evidence; the reproductions and measurements above are the handoff.
Both review browsers were closed, the task-owned fixture server reached its bounded
lifetime, and 34 task-owned scratch files were removed, including the read-only data
exports, probe scripts/results and screenshots. Scratch filenames cited above identify
the executed probes; those files are no longer retained. The existing Garden lane's
normal outputs remain under `artifacts/garden/`. Owner Nendo instances were left alone.

## Fix pass (2026-10-08, Garden 0.21.0)

All 15 findings are fixed in commit `6634691`, and `workspace/Garden.nendo` carries
0.21.0 (`4b7807b`, applied by `Build-Garden.mjs upgrade`, definition revision 66). Each
finding has a guard in a lane that already runs: unit tests in `tools/garden/*.test.mjs`,
and section 23 of `tools/Gate-Garden.mjs`. Every guard was falsified: the defect was put
back, the guard failed with the text below, and it passed again with the fix restored.

| Finding | Fix | Failure with the defect put back |
| --- | --- | --- |
| G-001 | Drafts not kept (past 50, 2 MiB, or refused) are named above the note, each a link to it | `G-001: a draft past the count must be named, not let go in silence.`; refused storage: `G-001: storage that refuses must be said: .` |
| G-002 | Reading the open note again keeps its draft; a text change elsewhere offers Keep mine / Discard mine | `G-002: activating the open note's row must keep its unsaved text: {"title":"Start here","editor":"# Welcome to your garden…` |
| G-003 | Unsaved new notes wait in the tree; Today returns to today's | `G-003: a second New note must start empty and keep the first in the tree: {…"rows":["Untitled"]}` |
| G-004 | New tags take IDs of their own | unit `two tags whose names make one slug…` failed; `G-004: distinct tags with one slug must save` |
| G-005 | No-match Find says so, with Clear Find | `G-005: a search with no match must say so.` |
| G-006 | Agenda keeps each note's line order; Manual tasks after | `G-006: a note's tasks must keep its body's order: ["Link it to this one","Plant your first note with **New note**"]` |
| G-007 | Focus to the opened note's title; Back to the link; Agenda keeps the box | `G-007: the keyboard must land on the opened note's title: <body>…`; `G-007: Space on a box must keep the keyboard on it: <body class="list-mode">…` |
| G-008 | The unanswered save persists; a committed one is recognised after restart | `G-008: a new note kept but unanswered must be one note after a restart, its draft spent: {"notes":1,"rows":["Unanswered new"],"unanswered":null}` |
| G-009 | Undo checks busy before taking history; disabled while a write travels | `G-009: an Undo pressed while a tick travels must spend nothing: 1 steps.` |
| G-010 | Save reads related rows afresh; nothing is written over rows it could not read | `G-010: a save that could not read the note's rows must say nothing was saved, and send nothing: {"problem":null,"batches":1}` |
| G-011 | Every checkbox line is a task; repeats keyed `-2`, `-3` | `G-011: two Repeat lines must be two tasks in the strip: {"done":0,"total":1,…}` |
| G-012 | Read failures show Retry and never an empty garden; Save waits | `G-012: a garden that could not be read must say so.` |
| G-013 | A reworded task keeps its record and due date (by place, then words); removals are named | `G-013: a task reworded in place keeps its record and due date: undefined.` |
| G-014 | Overview counts every pin and tag, with Show all | `G-014: past eight pins and twelve tags, the headings must count them all and offer Show all: {…"pinnedCount":"",…}` |
| G-015 | Names at least 12 px at any zoom; measured boxes never overprint | size: `…"smallest":7.72…`; overprint: `…"overlaps":[["Calculated fields","Agent access"],…]` |

Checks run: `tools/Review-Garden.ps1` passed, 77 unit tests and 49 browser checks, 0
browser exceptions. `Test-Repository.ps1` passed in full once Garden was closed, binary
assets included (70 tracked assets read end to end, the committed Garden.nendo among them).
`Build-Garden.mjs compare` matched every package file; it still reports that a new
garden would keep 1 record rather than 33 seeds, a state of the file's own notes that
predates this pass. Not exercised: a screen reader, forced colours, and the installed host.
