# Manuscript: the plan

- **Status:** Proposed, 17 October 2026. Rewritten the same day after an independent review,
  for a greenfield project: no manuscripts exist outside this repository, so there are no
  users to migrate, no old formats to keep and no release to qualify.
- **Baseline:** main at `f494461`, Manuscript **0.12.1**. Where this plan and the code
  disagree, the code is current.
- **Standing:** The owner's decisions in [`manuscript.md`](manuscript.md) section 2 stay in
  force. Nothing here is an accepted ADR or permission for a `src/` change. The planner was
  down when this was written: add the stages as Work items when it is back.

## 1. Goal

A place to write, restructure and revise a long manuscript that never loses a word, keeps
every paragraph's identity, and does one thing other writing tools do not: **a link between
two passages that tells you when one end changed**, so a setup and its payoff, or a claim and
its evidence, stay in step through revision.

Keep what is built: an application in a `.nendo` file, the Quiet sheet over Tiptap
(ADR-0013), readable `mn.block` records, typed Engine writes and Studio always reachable. A
different editor or storage model would add risk without fixing anything found here.

## 2. What is there

A continuous Tiptap 3 sheet over `mn.block` records; block IDs kept by the package's own
`BlockIds` extension; several manuscripts per file; notes, named links and Cuttings; the
selection toolbar (W-279) and the margin grip and plus (W-282); roles, lists and tables
(W-281); Book and Paper previews; Markdown and Word export; its own help page (ADR-0027).
`tools/Review-Manus.ps1` runs the unit tests in `tools/manus/` and the Edge lane
`tools/Gate-Manus.mjs` against the fixture broker, and is a step of `Test-Production.ps1`.

The view API already offers what most of this plan needs, with no host change:
`records.search` (ADR-0028), `records.tree` without the old 10,000 bound (ADR-0019 as
amended), `records.undo`/`records.redo` (ADR-0023), `media.put` (ADR-0031) and the file's
own skill (ADR-0024).

## 3. What is wrong

From reading the code at `f494461`. The first three were also reproduced in an isolated Node
harness, which is not in the repository; the Markdown loss with the real export module.

| # | Problem | Where |
| --- | --- | --- |
| 1 | **Recovery overwrites newer work without asking.** When the blocks a draft touched are unchanged, `offerDraft` restores the whole old document and saves it. A block changed elsewhere goes back to its old text; a block added elsewhere is deleted. | `view.mjs` `offerDraft` |
| 2 | **Deleting a paragraph can count as nothing to save.** `pending()` only asks whether a surviving block changed, so the draft is dropped and an outside change reloads over the delete. | `view.mjs` `pending`, `keepDraft`, `changed` |
| 3 | **Draft protection silently stops** above 2,000,000 characters or on a storage error. | `view.mjs` `keepDraft` |
| 4 | **Markdown export drops Scene break text**, and a heading with that role passes it to every paragraph under it, so all their text goes. | `export.mjs` `toMarkdown` |
| 5 | **A save rewrites structure nobody touched.** A misplaced row, cell or nested block is read as a paragraph and written back as one. | `model.mjs` `readManuscript`, `planWrites` |
| 6 | **Notes and links follow a guess.** On merge or paste, `survivorOf` picks the first block containing the removed one's first 40 characters. Cut and paste, and undo after a save, make new IDs. | `model.mjs` `survivorOf` |
| 7 | **A table cell is one joined value**, so a paragraph inside a cell has no identity. | `editor.mjs` `cellInline` |
| 8 | **A large save is several batches**, so a refusal part way leaves half of it written. The README says one batch. | `model.mjs` `chunkWrites` |
| 9 | **Export reads `state.root` after an `await`**, so switching manuscript during export may export the other one. Not reproduced. | `view.mjs` `exportAs` |
| 10 | **Speed at 150,000 words is unmeasured.** The view reads every record in the file on open and on every change, and rescans the whole document for list markers and word counts. | `view.mjs`, `editor.mjs` |

## 4. Stages

Each stage is a few app-only changes (section 6). The owner writes with each one as it lands;
that use, recorded as owner-reported, is the main evidence.

### Stage 1 — Never lose a word

Fixes problems 1 to 5 and 9. **Built 2026-10-17 as Manuscript 0.13.0.** One change from the
list below: the batch is not persisted with its `writeKey`. Recovery instead drops a write the
file already shows, so a save that committed before the view stopped is not repeated, and a
later edit to the same passage is held for the person rather than guessed.

- **One pending state.** Track pending edits as a set of semantic changes: text, metadata,
  deletes, moves, parent and order. The same set drives the draft, saving, and whether an
  outside change may reload the sheet. A save clears only what the host acknowledged; typing
  during a save stays pending.
- **Recovery that only replays your own edits.** The draft stores each pending change with
  the version and content it was based on, never a whole document. On reopening, a change
  whose base is still current is reapplied; one whose block changed since is shown for a
  choice. Untouched blocks are never written. Old-format drafts are simply dropped.
- **Say when protection fails.** If the draft cannot be stored, the status line says so.
- **Persist the batch before sending it**, with its `writeKey`, so a view stopped mid-save
  finishes the same write on restart. (`send` already retries once under the same key.)
- **Save only what was edited.** A block the person did not touch is not rewritten, however
  it is shaped. Odd structure is shown, not repaired.
- **Export:** Scene break keeps its text in Markdown; capture the manuscript at export start;
  a unit test checks that every exported format carries the same text as `exportPlan`.

*Done when:* each of these has a guard in `Review-Manus.ps1` that was seen failing against
the old code, with the failure text quoted in the commit or Finding.

### Stage 2 — A paragraph keeps its identity

Fixes problems 6, 8 and 10. **Built 2026-10-17 as Manuscript 0.14.0**, with three changes from
the list below:

- *Paragraphs in cells* moved to Stage 3, beside footnotes: both are the same container work,
  and a note on a paragraph inside a cell is worth little until footnotes need it.
- *Big edits* are not refused. Pasting a chapter is ordinary, and since Stage 1 a save that
  goes as several batches loses nothing: a refused remainder stays pending and the next save
  sends it. The cost is several History entries for one gesture, which the README states.
- *Speed*: reading only the active manuscript was not needed. Measured: 19 ms per key at p95
  and 0.7 s to open at 150,000 words; 58 ms and 2.5 s at 500,000. The work that mattered was
  per keystroke: word counts and block signatures cached per node, one drawing per frame, the
  margin drawn for the screen only, and list markers kept as an attribute rather than a
  decoration on each item, which ProseMirror weighed against every block on every key.

- **Lineage from transactions, not text.** Extend `BlockIds` so split, merge, cut and paste
  within a manuscript, and the new **Move** command, say which IDs survive. Notes and links
  follow that, never a text match. Delete `survivorOf`.
- **Undo after a save** goes through `records.undo` for this view's own batches, and is
  refused when another writer has changed the record since.
- **Paragraphs in cells.** A cell owns paragraph blocks, like the rest of the manuscript.
  Change the format outright: the owner's two files are converted once by the package and no
  compatibility code is kept.
- **Big edits.** An edit over one batch (200 writes, 250,000 characters) is refused before
  anything is written, with the limit named and the work kept. Fix the README.
- **Measure, then speed up.** Generate a 150,000-word and a 500,000-word manuscript in
  `tools/manus/` and time typing, opening, going to a paragraph and saving in the Edge lane.
  Then fix what is slow, cheapest first: read only the active manuscript with `records.tree`,
  keep per-block word counts, and recompute only the list runs a change touched. Window the
  editor only if the numbers still need it; one editor, never one per paragraph.

*Done when:* split, merge, move, cut and paste, undo and redo each have a test of which IDs
survive and where notes and links go; repeated identical paragraphs cannot misdirect a note;
typing stays under 50 ms per keystroke at 150,000 words in the Edge lane. (Since 2026-10-18 the
lane asserts the view's thread time per key instead, and reports key to frame: painting varies
with the machine, three times over between two mornings on the same code.)

### Stage 3 — Ordinary writing without leaving Manuscript

**First part built 2026-10-18 as Manuscript 0.15.0:** find and replace, go to a block, web
links and pictures. Building it found three defects: Nendo's view API sent a picture's bytes as
JSON, where they arrive as `{}`, so no view could ever add one (a host fix: the API now sends
base64 parts); Ctrl+Z after a reload could take the page back to before it was read; and a
picture that could not be shown pushed text past the edge of a preview page. Still to do:
reordering in the Outline drawer, the Cuttings drawer, notes edited in the view, and footnotes
and paragraphs in cells.

- Find and replace across the whole manuscript, with a choice to include Cuttings.
- Go to a paragraph or heading.
- Insert and edit hyperlinks (today they cannot be edited).
- Insert a picture with `media.put`, with alt text and caption.
- Reorder sections in the view's Outline drawer, by pointer and keyboard, using Move.
- A Cuttings drawer: browse, see where a cutting came from, put it back with its ID.
- Edit a note and mark it done in the view.
- Paragraphs in cells: a cell owns paragraph blocks, like the rest of the manuscript (from
  Stage 2).
- Footnotes: a footnote owns its paragraphs, as a cell does; insert, edit and jump to them;
  native footnotes in Word, a declared fallback in Markdown.

*Done when:* the owner can write, restructure and export a chapter without opening Studio.

### Stage 4 — Linked passages

The feature that sets Manuscript apart. Build it as soon as Stage 2 is in; it needs nothing
from Stage 3.

- Link two passages with a name (setup → payoff, claim → evidence, term → definition).
- When one end changes, the link is marked *Needs review*, with the text before and after.
- A review list of stale links, in manuscript order; acknowledging a link records the
  versions reviewed.
- **Threads:** pick a link name, character or idea and read its passages in order, with
  context around each and the gaps shown. Navigation first; editing through a thread only
  once it uses the same command path as the sheet.

*Done when:* link a setup and payoff, move the setup, change it, see the payoff flagged,
review it, acknowledge it; the IDs and the link survive all of it.

### Stage 5 — Output and appearance

- Writing appearance stays per device and never changes output (it already is).
- Named document styles (body, heading, quotation, verse, caption) that travel with the
  manuscript and map to real Word styles. Changing a style keeps IDs.
- Book and Paper become editable output profiles (page size, margins, headers, numbering),
  plus a plain manuscript profile.
- Preview shows a block taller than a page instead of hiding the overflow.
- Offer a good set of fonts by name; preflight warns about substitution.

*Done when:* a Word export opens in Word with the manuscript's styles, headings, lists,
tables and footnotes as native structures; checked by the owner in Word.

### Later, when the owner wants them

- **Sources and subjects:** typed records linked to passages, with a simple locator; presets
  for fiction (characters, locations) and argument (claims, sources). No bibliography engine.
- **Revision passes:** a named pass gathers issues and proposed changes, and compares against
  a named earlier state.
- **AI drafting:** a manuscript skill in the file (ADR-0024) and a richer *Copy for the agent*
  with target IDs, base versions and scope. A generation run writes section by section into a
  separate draft root, records what it finished, and resumes without duplicates. The agent is
  the person's own (ADR-0030); there is no model client in Nendo.

## 5. Limits to design around

- A file refuses writes from 99,000 operation rows until history is folded (ADR-0021), and
  holds about 98,000 records. Every save adds rows. A 500,000-word manuscript is 20,000 to
  25,000 blocks before notes, links and edits, so the stress fixture has to fit; measure rows
  per writing hour in Stage 2.
- A view hears only *that* the file changed, not which records.
- `records.undo` covers this view's batches in this session only.
- A view cannot list installed fonts, read history use, make Backups or open the Agent page.

Each of these would be a host change with its own ADR and the full gate. None is needed for
Stages 1 to 5; do not start one unless a stage proves it is.

## 6. How each change is made

- An app-only change touches `extensions/manuscript/`, `tools/manus/`, `tools/Gate-Manus.mjs`,
  `tools/Review-Manus.ps1` or `tools/Build-Manus.mjs`. It needs `Review-Manus.ps1`, every new
  guard seen failing, and `Test-Repository.ps1`. Then commit and push; the package reaches a
  file as a proposal the owner accepts.
- Changing the fixture broker (`tools/Graph-FixtureBroker.html`) is a shared-tool change and
  needs the full gate. It already supports `drop`, `hold`, `fail`, `remount`, `pushChanges`,
  `writeKey` replay and `records.undo`, which Stage 1 needs.
- Bump the package version and update its README and help with each change.
- Fixtures are generated into `artifacts/`; never use a `workspace/` file as a failure
  fixture.

## 7. Not doing

Real-time collaboration, cloud sync, other platforms, a mobile app, a new database, a
background agent, a model client inside Nendo, a desktop-publishing canvas, import from other
tools, external pilot authors, and release qualification. Each is either outside Nendo's
boundaries ([vision](../vision.md)) or a question for when someone other than the owner uses
it.

## 8. Start here

Stage 1, in this order: the Markdown Scene break fix (smallest, separate file), then the
pending state, then recovery. Read first: [`view.mjs`](../../extensions/manuscript/view.mjs)
(`pending`, `keepDraft`, `offerDraft`, `save`, `send`, `changed`, `exportAs`),
[`model.mjs`](../../extensions/manuscript/model.mjs) (`planWrites`, `chunkWrites`,
`survivorOf`), [`editor.mjs`](../../extensions/manuscript/editor.mjs) (`BlockIds`, `read`),
[`export.mjs`](../../extensions/manuscript/export.mjs) (`exportPlan`, `toMarkdown`),
[`Gate-Manus.mjs`](../../tools/Gate-Manus.mjs) and the
[custom views contract](../contracts/custom-views.md) (Writes, Undo and redo, Drafts).
