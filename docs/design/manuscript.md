# Nendo Manuscript Workbench

## Working product requirements and domain model

- **Version:** 0.3
- **Date:** 16 October 2026
- **Status:** Discovery draft, with a first slice built (W-276, below). The owner-confirmed
  decisions in section 2 are requirements. Everything else is a working model, open to
  refinement. Nothing in this document is an accepted ADR or permission to change `src/`.
- **Platform:** Nendo (this repository), with Tiptap as the editing framework.
- **Build file:** `workspace/Manus.nendo`, created empty by the owner on 2026-10-16, where the
  application was built through the host, as Garden was built in `Garden.nendo`. The owner then
  started a clean file of the application from it, `workspace/Manuscript.nendo` (ADR-0022's New:
  no history, no blocks), which now holds a draft paper on malleable software.
- **Deliverable scope:** a reusable manuscript foundation and a focused authoring application
  built on it. This document does not authorise repository changes or purchases.

### Built so far

The owner chose design A, the **Quiet sheet**, from a canvas of six directions on 2026-10-16
(<https://claude.ai/artifact/L7dAk6ufJFuBr9APFLrFxx>, private to the owner) and asked for it
to be built. It is built as section 3.1 recommends: an application in `workspace/Manus.nendo`
and a custom view, `extensions/manuscript/`, with no host change (W-276). That answers Q-04 with
its recommendation; Q-05 was taken as recommended, Markdown per block, and stays open to the
owner. Markdown and Word export (C-11) followed the same day, with the open-source docx and JSZip packages, which keeps Q-03's recommendation; a Word export of the sample book opened in Microsoft Word with its nine pictures. What the slice does and does not do is in the package's README; the measured lane is
`tools/Review-Manus.ps1`, part of Test-Production. Building it found one more host bound, a
hierarchy's 10,000 descendants (sections 10 and 13). That bound turned out to be the hierarchy
walk's, which re-reads the whole subtree for every page, so the view now reads blocks flat and
builds the tree itself; a file may also hold several manuscripts (Manuscript 0.6.0).

### Revision 0.2: what the repository review changed

Version 0.1 was written by an outside agent from the public repository and the Tiptap
documentation. Its claims about custom views, the agent bridge and file bounds were checked
against the repository and hold. It was revised because it treated Nendo as a blank storage
layer, not as the platform it is:

| Change | Why |
| --- | --- |
| New section 3, *Fit with Nendo as built* | Most of the model maps onto shipped mechanisms: a declared hierarchy, link record types, per-record versions, compensation, a view's own undo, full-text search, media and Tiptap. Version 0.1 mentioned none of them. |
| Build the first release as an application in a `.nendo` file with a custom view, not as new Engine storage | This is how Garden was built, with no host change (`docs/design/garden.md`). The vision prefers it: an application is clay in the file. Host work comes only where a measured gap needs it (section 13). |
| New section 10, *Budgets*, led by the history-row bound | Every record write adds one row to `__nendo_operation`, and a file stops accepting writes near 100,000 rows. Folding is started by the person. For a writing tool that is the binding limit, not bytes. Version 0.1 quoted only the byte bound. |
| "Checkpoint" renamed **Milestone** | *Checkpoint* already names the revision a history fold leaves (ADR-0021). |
| Relationship state `endpoint_deleted` replaced | Nendo refuses to delete a record that is still referenced, with no cascade. A link cannot outlive its endpoint. |
| Atomicity requirement narrowed to what the view API can do | `records.batch` takes up to 200 writes as one revision but cannot carry `records.move`. |
| AI section aligned with access levels and scope | *Inspect*, *Edit data*, *Shape app* and *Unattended* already separate "what AI may commit". Background agents are out of scope (vision). |
| New open decisions Q-04 to Q-06 | The architecture path, inline text storage and the history budget all need the owner's answer. |
| References point at repository paths | The document lives in the repository, and pinned GitHub blob hashes go stale. |

## 1. Product intent

Make long-form writing feel like a continuous document while making every paragraph
independently identifiable, stored, related and recoverable.

The application is for authors generally, not only novelists. A novelist, researcher,
essayist, technical author and report writer should use the same foundational model, with
optional vocabularies and views appropriate to their work.

The distinctive capability is not a collection of boxes around text. It is the ability to
ask and act on questions about specific passages, their relationships, their history and the
work still needed, without interrupting normal writing. In Nendo this has a concrete meaning:
an agent, a list, a board, a calculation or Studio can query paragraphs as records, so nobody
parses prose to learn what links to what.

## 2. Owner-confirmed decisions

| ID | Requirement |
| --- | --- |
| C-01 | Each paragraph has one place in the manuscript. No shared editable paragraph appears in more than one position. |
| C-02 | Named relationships between paragraphs are desirable. |
| C-03 | Build reusable foundations, with a deliberately focused authoring experience. |
| C-04 | Address authors generally and any kind of manuscript, not a novel-only product. |
| C-05 | Provide a quiet continuous writing surface, with optional structural views. |
| C-06 | Allow extensive font and layout choices. |
| C-07 | Choose a suitable general manuscript ontology instead of requiring the owner to list genre-specific features. |
| C-08 | Support the full range from no AI involvement to fully AI-generated manuscripts. |
| C-09 | Use 150,000 words as the normal manuscript target and 500,000 words as the stress target. These are requirements, not measured capabilities. |
| C-10 | An external editor workflow is not required. |
| C-11 | Export to Markdown and Microsoft Word (.docx). |

Not yet decided: import, paid dependencies, the exact scope of publication layout, full
branching, and whether AI may revise accepted text by default.

## 3. Fit with Nendo as built

### 3.1 Recommended path

Build the first release the way Garden was built: **a `.nendo` application** (record types,
a declared hierarchy, link types, screens and the file's own agent skill) **plus a custom
view** that carries Tiptap and draws the continuous writing surface (ADR-0013). The view is
one more client of the same typed services, so every invariant in section 5 is enforced by
the Engine for the view, Studio and agents alike, and Studio stays the route to the data when
the view fails.

"Reusable foundation" (C-03) then means a reusable *application*: the schema, the view
package and the skill, shipped as a file that keeps its seed records in every new copy
(ADR-0022). It does not need a new Engine storage kind. A host-owned document capability is a
later, evidence-led step, taken only for the gaps in section 13. Whether to accept this path
is Q-04.

### 3.2 Concept to mechanism

| PRD concept | Existing Nendo mechanism | Gap or caution |
| --- | --- | --- |
| Composition tree (one owner, ordered siblings, no cycles) | A declared hierarchy on one record type: a parent reference to the same type plus an Integer order field; `hierarchy-cycle` refuses loops; at most 32 levels (ADR-0019) | A hierarchy lives within **one** record type, so sections and blocks share one type, told apart by a kind field (section 4.2). |
| Move | `records.move` / `data.moveRecord`: places a record before a sibling or last, renumbering only the smallest run of siblings around the insertion point (ADR-0019, W-162) | Cannot be part of a `records.batch`. |
| Stable identity | Record IDs, unique within a type; deleted IDs stay reserved as tombstones | None. |
| Optimistic concurrency | Every record write is conditional on its version; a stale write is refused | None. |
| Named relationships | A link record type with source and target references and a kind field; ADR-0026 declares the allowed combinations; links can carry their own fields (`docs/contracts/relationships.md`) | No symmetric-link primitive: model a symmetric kind as one row with a documented reading. |
| Deleting a linked paragraph | Delete is refused while a record is referenced, with no cascade | The application deletes or re-targets the links in the same batch. History keeps them; compensation restores them. |
| Restore | Compensation re-creates a deleted record under its own ID when it is still deleted, its schema still fits and its references are valid (ADR-0006) | There is no universal undo, so it must say when a restore is refused. |
| Interactive undo | A view undoes and redoes only its own batches, version-checked (ADR-0023) | An agent edit made in between makes the view's undo refuse, not overwrite. That is the behaviour AC-08 wants. |
| Proposed change | A change set can carry `data.*` operations, validated on a clone and promoted by replay (ADR-0007) | Records are normally written directly at *Edit data*. Whether manuscript proposals go through change sets or through draft records is part of Q-02. |
| Milestone (named historical state) | Nothing. Backup (ADR-0010) copies the whole file; a history fold leaves a *Checkpoint* revision (ADR-0021) | Milestones are application data (section 4.3). Their retention must respect the history budget. |
| Search | FTS5 over every active Text field, Markdown included (ADR-0028) | The index exists only after `application.buildSearchIndex`; the application must build it or say why search is off. |
| Pictures | Media fields and `![alt](address)` in Markdown (ADR-0031, W-271) | 64 MiB per item, 2 GiB per file, outside the 256 MiB bound. |
| Tiptap | The Workbench's Markdown field editor uses Tiptap 3.31.4 and `@tiptap/markdown` (ADR-0017 amendment, W-275, in progress 2026-10-16) | A custom view cannot reach the Workbench's bundle. It carries its own copy, within a package's 4 MiB per file and 16 MiB in all. |
| Seeing other writers' changes | The `changes` event: the file's change sequence, at most every 250 ms, as a nudge (`docs/contracts/custom-views.md`) | The view learns that the file changed, not which paragraphs did. See section 13. |
| Export | CSV, with pictures (`docs/contracts/csv.md`); a view may download a file it generates | No Markdown or .docx export exists. No product lane measures downloads from a view (`docs/roadmap.md`, Not qualified). |
| Agent | The person's own agent, launched over ACP, editing through MCP (ADR-0030, ADR-0014) | A view cannot call `agentSession.*` (`docs/contracts/launched-agents.md`). |

## 4. Selected working ontology

### 4.1 Principle: one composition tree, many semantic relationships

The composition tree answers **where content belongs and in what order it is read**. Named
relationships answer **how passages and supporting material relate**.

Do not infer ownership from a relationship. Do not infer manuscript structure from font size.
Do not store the same editable paragraph in two structural positions.

A paragraph can be shown in a preview, search result or comparison without acquiring another
manuscript location. Earlier versions are history, not additional live placements.

### 4.2 Reusable document foundation

**Document** is the root. A manuscript uses a Document; a substantial research note or source
commentary may use another. Short labels and scalar metadata do not need to become paragraphs.

**Block** is the content unit and the one record type that carries the hierarchy. A block's
kind says what it is: section, heading, paragraph, list, list item, quotation, figure, table,
row, cell, note, equation. Sections may contain sections and blocks in a single ordered
sequence. A document need not have any sections before writing starts.

Every editable paragraph, including one inside a list item, table cell, quotation or note, is
its own block record. Composite structures own child blocks; they never hide paragraphs in a
nested document blob that is authoritative on its own.

An explicit grammar says which kinds may own which children: a row may sit only under a table,
and a table row is not a section. The Engine enforces the hierarchy's shape; the grammar on
top of it is enforced by the application, which has to be honest about that: Studio and an
agent can write a block in a place the grammar forbids. Making the grammar an Engine rule
would need host support (section 13).

Section titles and visible heading text are not kept as competing copies. A section's visible
heading is a heading block; a private outline label may exist separately and is never exported.

### 4.3 Authoring application concepts

**Project.** The working context: purpose, intended audience, language, authoring brief,
preferred vocabulary and supporting material. A simple project begins with one manuscript.
The model can later hold several related manuscripts without putting series management into
the first release.

**Manuscript.** An ordered written work tied to a Document, with its status, style definitions
and output settings. It has a current working state, not a set of co-equal live branches.

**Subject.** Something the manuscript is about: a person, place, organisation, concept, theme,
term or another kind the author defines. Subject records carry descriptions, aliases and links
to passages. They do not claim that every mention has been found.

**Source.** External material that informs the work: bibliographic information, a URL or a
retained media item, an excerpt where appropriate, and citation locators such as page or
section. A citation is a typed link from a passage to a source and locator. A bare source link
is not evidence that a claim has been checked.

**Annotation.** An observation anchored to a paragraph, a range of text, a section or
supporting material. Kinds include comment, question, intention, constraint, inconsistency and
revision issue. An annotation never becomes manuscript prose unless it is explicitly inserted.

**Task and revision pass.** A Task is work to do, with a target, status and optional priority.
A revision pass groups work under an objective such as clarity, continuity, terminology or
evidence. It can be done by hand, with AI help or by an authorised agent. A critique cites its
target as a record, not only in a chat that disappears.

**Relationship and relationship type.** A stored, typed connection between identified records.
Paragraph to paragraph is essential; links to sections, subjects and sources are supported too.
Examples: elaborates, supports, contradicts, foreshadows, resolves, defines, exemplifies. These
are meanings the author gives, not claims of truth.

**Milestone, proposed change and generation run.** A Milestone names a coherent manuscript
state: a change sequence plus a label. Going back to it is a restore through compensation, or
opening the Backup taken with it, never a rewrite of history. A Proposed change names a
candidate modification and the versions it was based on. A Generation run records a brief,
scope, progress and the changes it produced. None of these needs a collaborative editing
product.

### 4.4 Vocabulary presets, not separate engines

A preset can offer section roles, subject kinds, relationship names, metadata fields, styles
and work views. It does not change the ownership and identity rules.

- Fiction: chapter and scene; character and location; foreshadows and resolves.
- Research or argument: section and subsection; concept and claim; supports and challenges.
- Technical manuscript: procedure and reference section; component and term; requires and defines.
- General prose: sections, notes, sources and revision tasks, with no special vocabulary.

These are examples, not a promise that every publishing convention ships in the first release.
Authors rename or extend the vocabulary through Nendo's own mechanisms: choice options and
allowed links are schema, changed through a reviewed proposal. Start from a preset or a blank
page, not an ontology wizard.

## 5. Logical data contract

The following is a logical sketch, **not an existing Nendo schema or API**. Under the path in
section 3.1 each type below is an ordinary record type; the system columns (ID, version) are
the Engine's own and are not fields the application defines.

```yaml
document:
  id: record_id
  version: record_version            # Engine-owned
  schema_version: document_contract_version
  title: text

block:                               # the one hierarchical type
  id: record_id
  version: record_version            # Engine-owned
  document: reference_to_document
  parent: reference_to_block         # the hierarchy's parent field
  order: integer                     # the hierarchy's order field
  kind: choice                       # grammar-controlled
  role: optional_author_defined_role
  text: inline_content               # format is Q-05
  style: optional_reference_to_style
  formatting_overrides: declared_fields_only

relationship_type:                   # or a choice field plus ADR-0026 allowed links
  id: record_id
  name: author_visible_name
  direction: directed_or_symmetric
  inverse_label: optional_display_label

relationship:
  id: record_id
  type: reference_or_choice
  source: reference
  target: reference
  note: optional_explanation
  review_state: current_or_needs_review
  origin: manual_or_recorded_agent_run

text_anchor:
  block: reference_to_block
  base_version: block_version_at_creation
  start_offset: optional
  end_offset: optional
  affinity: boundary_behaviour
  quote_context: optional_reanchoring_evidence
  state: exact_or_rebased_or_needs_review_or_orphaned
```

Core integrity requirements:

1. Every active paragraph has exactly one owning container and one position; the ownership
   tree has no cycles. *(Engine: the declared hierarchy.)*
2. Blocks have a permitted parent for their kind. Cross-document moves are explicit operations,
   not casual field edits. *(Application, until host support exists.)*
3. Identity is never a text hash, array index or character offset. Editing or moving content
   keeps its ID. *(Engine.)*
4. Relationships confer no ownership and copy no content. A symmetric kind has one stored row;
   inverse labels need no second row.
5. Paragraph text is authoritative in one place, its block. Full-document JSON, HTML, Markdown,
   search text and statistics are projections.
6. One logical edit commits as one batch with its anchor and lineage changes, up to 200 record
   writes and 250,000 characters. A move is its own write today (section 13).
7. Every writer, including Studio, custom views and agents, meets the same Engine-enforced
   rules. Rules the application enforces are listed as such, not presented as guarantees.
8. A rejected or stale write never silently overwrites a newer version. *(Engine.)*

## 6. Paragraph lifecycle

Proposed default rules, to be checked with editing prototypes.

**Edit:** keep the ID. The write produces a new record version. Map text anchors through the
actual edit where possible; keep explicit uncertainty where mapping is not reliable.

**Move:** keep the ID, history and relationships. Change parent and order through
`records.move`. A cut and paste the editor recognises as a move follows this rule.

**Copy:** create a new block for every copied node. Do not clone relationships or review state
silently. An optional origin field can name the source without sharing content.

**Split:** keep the original ID for the leading paragraph and create a block for the rest, in
one batch: the update, the create with its parent and order, and the anchor changes. Whole-paragraph
relationships are not duplicated; links whose target becomes ambiguous are marked
*needs review*.

**Merge:** keep the first paragraph's ID, delete the second and record the merge. Rebase range
anchors when exact mapping is possible. Links to the second paragraph are re-targeted to the
first and marked *needs review*, or deleted in the same batch, because the Engine will not
delete a referenced record. Do not redirect a link silently to content whose meaning may have
changed.

**Remove:** delete the block and, in the same batch, its links and anchors. History keeps all
of them, and compensation restores them together while the IDs are still deleted. Removing
text is not permission to erase its history.

**Keep as a cutting:** move the block under the project's Cuttings section, a non-publishing
branch of the same hierarchy. It stays one owned block with its links intact, not a duplicate.
This is distinct from deletion.

**Restore:** restore a coherent state or a selected passage through a new, attributed
operation. Check for changes made since; a refused compensation is reported, not forced.
History is never rewritten.

**Reformat or reflow:** keep IDs. A changed font, wrap point or page count never splits, merges
or renumbers paragraphs.

## 7. Writing and layout

### 7.1 Continuous authoring

The default view is continuous prose. Record boundaries and relationship controls stay out of
sight until text is selected or a command is invoked. The application is not a stack of
paragraph widgets, each focused on its own.

Optional views include an outline, a section or card arrangement, related passages,
supporting material and a revision or task view. Several of them can be Nendo's own screens
over the same records (an outline, a board, a list), which keeps them working when the custom
view does not. Every view refers to the same content; opening one never creates a second
editable document.

The writing surface must handle keyboard navigation, selection across paragraph and section
boundaries, copy, cut and paste, undo and redo, find and replace, accessibility and input-method
composition. These are foundation requirements, not polish.

### 7.2 Three kinds of appearance

**Personal writing appearance:** zoom, reading width and display-only font and contrast
preferences. These never change exported formatting. They are per-device or per-view state,
not manuscript data.

**Document formatting:** named paragraph and character styles and explicit local overrides:
font family and size, emphasis, colour, alignment, spacing and indentation. Authors keep direct
formatting; styles give consistency without forcing a styles-only workflow. How inline formatting
is stored is Q-05.

**Publication layout:** paper size, margins, section and page breaks, headers, footers,
numbering and keep-together rules, with a separate preview of the chosen output profile.

The recommendation is rich document layout, not a free desktop-publishing canvas. Multiple
columns, floating text boxes, text wrapped around shapes and objects at exact page positions
are an explicit scope decision (Q-01).

Pagination is a rendering result, never a change to paragraph ownership. A 500,000-word
manuscript stays editable without whole-book pagination after each keystroke.

### 7.3 General manuscript content

The baseline covers headings, paragraphs, lists, quotations, links, pictures with captions and
alternative text, tables, and note and citation references. The model keeps valid structures
for footnotes, endnotes and equations.

The first release's coverage of complex equations, automatic citation styles, screenplay
conventions, indexes and other specialist features belongs in a later feature matrix; "any
manuscript" does not imply it. No unsupported node may be silently dropped by editing, saving
or exporting.

## 8. AI: independence, assistance and delegated authorship

### 8.1 Two separate settings

**How much AI contributes** and **what AI may commit** are separate decisions. An author may
generate a whole manuscript and still review it; another may delegate a limited revision
without reviewing each change.

The product supports:

- Manual work with no agent and no AI-dependent analysis. (Vision: local and offline use never
  depends on an agent.)
- Read-only assistance, such as questions, critique and finding passages. Nendo's *Inspect*
  level.
- Proposed changes with explicit review: draft blocks or a change set the person accepts.
- Delegated generation or revision within an authorised scope, up to a complete manuscript:
  *Edit data* for direct writes, *Unattended* for an agent that accepts its own proposals.

These use Nendo's access levels; they do not replace them. Any narrower scope inside a level
(one chapter, one revision pass) is an application convention: a prompt telling an agent to
stay in scope is not enforcement. An enforceable content scope, lock or expiring permission
would need Engine and MCP support and tests.

### 8.2 Fit the existing host

The host launches the person's own agent over ACP, in a tab of the Agent page, and the agent
edits the open file through MCP. The host is not a model client and embeds none (ADR-0014,
ADR-0030). A custom view cannot call `agentSession.*`, so in-view authoring controls either
send the person to the Agent page or need a host route designed for them, not an invented
`window.nendo` method.

The file carries its own agent skill (ADR-0024). The manuscript application's skill tells any
agent how passages, links, anchors, runs and the history budget work, so an agent that has
never seen this document can write correctly.

### 8.3 Long generation is a managed run, not one huge insertion

A generation run records the brief, audience, structure, required sources or constraints,
scope, base versions and a bounded plan. Work proceeds section by section, with milestones,
visible progress, cancellation and recovery from interruption. The run is driven by the
person's launched agent while it is open: background agents are outside Nendo's scope.

For complete generation, prefer a separate draft until promotion is authorised. Whether a run
may revise accepted text by default is Q-02.

Record the agent and, when supplied, the model, the instruction and context manifest, and the
resulting writes. Nendo already attributes every revision to its actor; the run record adds
the brief. Distinguish generated, human-edited and manually written text without claiming to
detect authorship from prose. A person's later edit does not erase the recorded AI origin.

Generated factual content is not verified because it contains source-shaped text. Citations
need retained evidence and checks; unresolved ones become annotations or tasks.

Show a cost or token budget only when the agent exposes enforceable accounting. Otherwise say
that exact spending control is unavailable; stopping a run by time or write count is not a
monetary cap.

### 8.4 Privacy and recovery

Editing, navigation, search, history and export run locally. Sending material to an agent is a
deliberate action with a visible scope. The file carries no credentials and cannot grant
itself device permissions.

Committed progress survives a cancelled run. A run cannot silently overwrite a person's edits
made meanwhile: the version check refuses it. Going back to a pre-run milestone keeps newer
work or explains the conflict.

## 9. Persistence and integration

The Engine is the persistence and validation authority, reached through typed services. The
view's browser storage is never the manuscript store. Studio and safe mode stay routes to the
data when the view fails. Nendo's file compatibility promise (ADR-0012) binds the application
like any other.

Tiptap supports JSON documents and node IDs, but that is not a paragraph database, an
identity lifecycle or Nendo history. Its document is a projection assembled from block
records and translated back into block writes; no Tiptap state is stored as a blob.

The editing path:

1. Read a window of blocks with `records.query` or `records.tree` (200 per request; `queryAll`
   reads up to 10,000 by default).
2. Build the editor document, keeping each block's ID and version on its node.
3. Turn editor transactions into changed-block writes.
4. Commit them with `records.batch`, each write conditional on its version.
5. Apply the answer, and on a `changes` nudge re-read what may have changed without replacing
   a focused editor.

The editor never serialises and rewrites the whole manuscript per keystroke. Autosave groups a
burst of edits per paragraph and shows truthful states: Saving, Saved, Save failed. "Saved"
means the host acknowledged the commit, not that a timer ran. Grouping also sets the history
cost (section 10).

Interactive undo and durable recovery are different things. Undo groups typing and structural
changes into sensible actions over the view's own batches (ADR-0023); recovery uses
compensation and milestones. Test how undo meets an agent's change and an autosave.

A bulk job runs as many batches. Do not present a multi-batch 500,000-word replacement as
atomic because each batch is.

## 10. Budgets

The manuscript must fit Nendo's bounds with its working history, not only its text.

| Bound | Value | Source |
| --- | --- | --- |
| File open bound / byte write ceiling | 256 MiB / 224 MiB, media excluded | ADR-0012 |
| Text on disk | about 2.7 times the text's bytes; about 75,500 records of 1,306 bytes reach the bound | `docs/architecture.md` |
| Rows per audit table | 100,000; writes refused 1,000 rows below | `docs/architecture.md`, ADR-0012 |
| Batch | 1 to 200 writes, at most 250,000 characters, no move | `docs/contracts/custom-views.md` |
| Request parameters | 256 KiB | `docs/contracts/custom-views.md` |
| Agent request body | 256 KiB | `docs/contracts/mcp-interface.md` |
| Media | 64 MiB per item, 2 GiB per file | ADR-0031 |
| Descendants of one hierarchy | None since 2026-10-16 (was 10,000); depth 32; a subtree aggregate folds at most 10,000 | `nendo://application/vocabulary`, `limits.hierarchy` |

**Bytes are not the problem.** 500,000 words is about 3 MB of text, about 8 MB on disk, and
somewhere between 5,000 and 15,000 blocks depending on paragraph length.

**History rows are.** Each record write adds one row to `__nendo_operation`, however small. At
100,000 rows the file stops taking writes until the person folds old history (ADR-0021), which
is started by the person, never by an agent, a view or an action, and takes a Backup first.
ADR-0021 notes that a modelling file reaches the bound after about 100 active hours. A rough
illustration for writing, to be replaced by measurement: drafting 1,000 words an hour as 12
paragraphs, each saved 15 times as it grows, is about 180 rows an hour, so about 500 hours
before a fold. Generating 500,000 words and revising it twice is roughly 30,000 to 45,000 rows.

So the application must:

- Save per paragraph on a pause, not per keystroke, and measure rows per hour of typing.
- Show the history budget and say when a fold is due, sending the person to the host's fold.
- Treat milestones as labels over history: a fold removes the revisions a milestone named,
  so a milestone that must outlive folds is a Backup.

Whether this is acceptable or the host should change is Q-06.

## 11. Performance and durability qualification

Normal fixture: 150,000 words. Stress fixture: 500,000 words. Include many short paragraphs as
well as very long ones; word count alone does not describe an editor workload.

Build deterministic fixtures with deep sections, lists, tables, pictures, many relationships,
annotations, long histories and one long uninterrupted section. Measure the installed
Windows/WebView2 host, not only a development browser.

Proposed targets, to be calibrated on a recorded reference machine:

- Input-to-paint p95 at most 50 ms on the normal fixture and 100 ms on the stress fixture
  during representative typing.
- No lost input, broken composition, selection jumps or wrong edits across editor-window
  boundaries.
- Navigation to a known paragraph p95 at most 250 ms in the open normal fixture.
- Whole-manuscript operations report progress and can be cancelled where that is safe.
- Saved content, order and accepted relationships survive a forced kill and reopen.
- Opening the stress fixture's file: report it. Installed startup on large files is an
  accepted measured exception today, not a pass (`docs/roadmap.md`).

These are proposals, not measurements. Report host version, hardware, block counts, content
size, repeated-run distributions and cold or warm conditions.

Benchmark one editor document first, then windowed rendering if needed. Do not commit to one
editor per paragraph. Any windowing keeps selection across boundaries, keyboard movement, find
and replace, paste and undo. The lazy-data-views work measured bounded reads at 100,000 records
and found deep sorting of large tables not qualified (`docs/design/lazy-data-views.md`): read
blocks in hierarchy order, never by sorting a whole table.

## 12. Export contracts

### 12.1 Shared rules

Export a coherent manuscript state read from the file, including content outside the editor's
window. Report the change sequence or milestone exported and any warnings. Leave out private
notes, relationship metadata and AI origin by default; offer them as explicit options later.

Export never changes the manuscript. Unsupported content is reported with a location the
author can open. Missing pictures, notes or text never disappear under a success message.

A view can generate the file and download it to the person's Downloads folder. No product lane
measures downloads from a view yet, so the export journey needs its own check.

### 12.2 Markdown

Markdown is a portable export, not the canonical store.

Keep headings, paragraph order, emphasis, lists, links, quotations and code. Choose and
document one Markdown profile; tables, footnotes and equations need explicit extension or
fallback rules. Write pictures beside the Markdown, as CSV export already does with its Media
folder.

Fonts, page geometry and running headers are not representable in ordinary Markdown. Say what
is lost before exporting. Named relationships do not become published links.

`@tiptap/markdown` is open source and already pinned in the Workbench (W-275); custom nodes
still need tested mappings. No paid service is needed to produce a Markdown string.

### 12.3 Word

Produce an editable .docx with real paragraphs, styles, headings, lists and other supported
structures, never page images. Map named styles and supported local formatting explicitly.

The goal is faithful structure and formatting, not identical line breaks in every Word
installation. Qualification opens representative exports in Microsoft Word and inspects the
document structure; a valid ZIP is not enough.

Tiptap's DOCX export extension converts locally but is a commercial, private-registry
component. Its optional font embedding can call an external service, and external picture URLs
may be fetched, so local export needs controlled assets and network off. An open-source
generator such as the `docx` npm package, writing from block records rather than from the
editor, is the alternative if Q-03 rules out commercial components. Either runs in the view;
the host gains no export code.

Export does not imply Word import or round-trip.

## 13. Gaps that may need host work

Each is a candidate, to be confirmed by the foundation proof before any ADR is written.

| Gap | Effect | Possible host answer |
| --- | --- | --- |
| A batch cannot carry a move | A cut-and-paste move plus its anchor changes is two revisions | Allow `records.move` in a batch, or let a batch set parent and order with renumbering |
| `changes` names no records | After an agent writes, the view must work out which blocks changed | Record-level change events for views (the 2026-10-05 outside review asked the same for MCP) |
| History rows per write | Long writing hits 100,000 rows; folding is manual | A larger bound, coalescing of one actor's rapid edits to one record, or a fold prompt |
| Grammar is application-enforced | Studio and agents can place a block where the grammar forbids | A declared parent-kind rule on the hierarchy |
| `queryAll` default of 10,000 | A large manuscript's blocks may pass it | Done: the view asks for up to 1,000,000; windowed editing is still to come |
| No milestone that survives a fold | Named states are lost to folding | A host-kept label exempt from folding, or Backup as the answer |
| A hierarchy walk reads at most 10,000 records under a root | Each page of a tree read re-walked and re-sorted the whole subtree, so reading N blocks cost about N squared; the bound kept that in check | Done: the view reads blocks flat by cursor and builds the tree (0.6.0), and since 2026-10-16 the host's tree read pages by key and has no bound (ADR-0019 amendment, W-278), so the Outline screen and `descendantOf` read any size too |

## 14. Acceptance scenarios

- **AC-01 Continuous prose.** Write, select and replace text across several paragraphs and
  sections without touching database controls.
- **AC-02 Durable identity.** Edit, restyle and move a paragraph; its ID and its links stay.
- **AC-03 Copy isolation.** Copy a linked passage, edit the copy; the original text and links
  are unchanged.
- **AC-04 Split and merge.** Split and merge text with range anchors and named links. Exact
  anchors stay right; uncertain ones are marked, not reassigned.
- **AC-05 Nested paragraphs.** Identify, edit, recover and export a paragraph inside a list, a
  table cell and a note.
- **AC-06 Coherent recovery.** Kill the host during a save and reopen: an acknowledged state or
  explicitly recovered pending work, never a half-applied structure change.
- **AC-07 Multi-view consistency.** Reorder a section in a structural view; writing view,
  search and export show the new order.
- **AC-08 Conflict safety.** An agent writes a paragraph a person has since edited. The stale
  write is refused or explicitly reconciled; the view's undo refuses rather than overwrites.
- **AC-09 AI-free operation.** With no agent and the network off, create, edit, search, restore
  and export a manuscript.
- **AC-10 Full generation.** Run a bounded full-manuscript generation, interrupt it, resume it
  deliberately, and check milestones, scope and origin.
- **AC-11 Honest exports.** Export the whole stress manuscript, not the visible window; check
  counts, order, formatting and warnings.
- **AC-12 Formatting separation.** Personal appearance leaves publication settings alone; a
  style change restyles the intended passages without changing IDs.
- **AC-13 Genre neutrality.** One schema serves fiction, an argument and a technical
  manuscript, with different vocabularies.
- **AC-14 Host boundaries.** View, Studio and agent writes cannot bypass Engine rules or widen
  their authority through stored data; rules the application enforces are listed as such.
- **AC-15 Budgets.** Exercise the byte and row ceilings with history and pictures included.
  Refusals keep saved content and say what to do.
- **AC-16 Studio fallback.** With the custom view off, the manuscript's blocks, order and links
  are readable and editable in Studio and Nendo's own screens.
- **AC-17 History cost.** Measure rows written per hour of representative typing and per
  generated chapter; the budget display matches the file's real count.

## 15. Recommended order for later planning

**Foundation proof.** In `workspace/Manus.nendo`: a Block type with its hierarchy, a link
type, and a view carrying Tiptap that loads, edits and saves blocks. Measure split, merge,
move, nested text, autosave rows, a forced kill and the large fixtures. The 150,000- and
500,000-word fixtures and the forced kill run against task-owned copies under `artifacts/`,
never against `Manus.nendo` itself, which is a workspace file and never a failure fixture.
Prove a Markdown and a .docx export. Confirm or close each gap in section 13.

**Reusable application.** The schema, presets, view package and agent skill as a file that
keeps its seed records (ADR-0022). Host ADRs only for the gaps the proof confirmed.

**Focused authoring.** Continuous writing, outline and reordering, styles and layout, named
relationships, sources, notes and tasks, and both exports. Keep optional views out of the
typing path.

**Workflows and AI.** Revision passes, passage-centred critique, milestones and resumable
scoped generation through the launched agent. Include whole-manuscript generation in
qualification, not only single-paragraph completion.

This is an order for reducing risk, not a milestone plan or an estimate. Work enters the
Nendo Development planner as work items when the owner asks for it.

## 16. Open decisions

**Q-01 Layout boundary.** Rich document layout (styles, fonts, margins, headers and footers,
tables, figures, breaks), or also desktop publishing (columns, floating boxes, exact page
positions)? Recommendation: rich document layout, with room to extend, and no claim of
desktop-publishing parity.

**Q-02 Delegated AI edits.** May an authorised run change accepted text without approving each
change, or does it work in a new draft unless existing text is explicitly included?
Recommendation: a draft by default; changing existing text needs a clearly scoped delegation.

**Q-03 Dependencies.** Must every shipped editor and export component be open source and free
of a subscription, or may a paid Tiptap component be chosen after licence, redistribution and
cost review? Recommendation: open source first and offline; no paid component chosen merely
because the editor is Tiptap.

**Q-04 Architecture path.** *Answered 2026-10-16 by building design A as a view in Manus.nendo (W-276).* First release as an application in a `.nendo` file with a custom
view (section 3.1), or as a host-owned document capability from the start? Recommendation: the
file application; host work only for gaps the proof confirms.

**Q-05 Inline text storage.** How does a block store its text? (a) Markdown with a declared
inline subset: readable in Studio, searched by FTS, exported by CSV, but no inline colour or
font runs without an extension syntax. (b) Tiptap/ProseMirror JSON in a text field: any formatting,
but opaque in Studio and search. Recommendation: (a), with paragraph-level style and overrides
as fields, so "data is usable before specialised presentation" holds; revisit if C-06 needs
inline runs.

**Q-06 History budget.** Is a manual fold every few hundred writing hours acceptable, or should
the host coalesce rapid edits or raise the row bound before the first release? Recommendation:
measure in the foundation proof (AC-17), then decide.

Still to follow: the content-feature matrix, lifecycle edge cases, milestone retention, import
if requested, the schema and any host ADRs, and measured budgets. The confirmed audience,
ownership, AI range, manuscript sizes, external-editor exclusion and export formats are not
reopened.

## 17. Evidence

Version 0.1 drew on the public repository and the Tiptap documentation on 16 October 2026.
Version 0.2 was checked against this repository at `d28cbc5` and its working tree the same day,
including the uncommitted ADR-0017 amendment for W-275. No implementation, benchmark,
licence purchase or export check has been done. Where a document and the code disagree, the
code is current.

Repository:

- `docs/vision.md`: product axioms and scope (background agents and collaboration out).
- `docs/architecture.md`: the size bound, the per-record cost and the audit-row bound.
- `docs/roadmap.md`: Not qualified, lazy data views, agent value bounds.
- `docs/contracts/custom-views.md`: the view API, batches, `changes`, state, downloads,
  package bounds.
- `docs/contracts/launched-agents.md`: `agentSession.*` refused to a view's actor.
- `docs/contracts/mcp-interface.md`: access levels, Unattended acceptance, data in change sets.
- `docs/contracts/relationships.md`: references, link types, delete refusal, restore.
- `docs/contracts/csv.md`: CSV export with pictures.
- `docs/design/garden.md`: an application with links as records and a hierarchy, built with
  no host change.
- `docs/design/lazy-data-views.md`: bounded reads measured at 100,000 records.
- ADR-0006 (revisions and compensation), ADR-0007 (proposals), ADR-0010 (backup), ADR-0012
  (bounds and compatibility), ADR-0013 (custom views), ADR-0017 and its 2026-10-16 amendment
  (Tiptap), ADR-0019 (hierarchies), ADR-0021 (folding), ADR-0022 (seed records), ADR-0023 (a
  view's own undo), ADR-0024 (the file's skill), ADR-0026 (allowed links), ADR-0028 (search),
  ADR-0030 (launched agents), ADR-0031 (media).

Tiptap:

- [Persistence](https://tiptap.dev/docs/editor/core-concepts/persistence) and the
  [UniqueID extension](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid).
- [Markdown basic usage](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage)
  and [Markdown export limitations](https://tiptap.dev/docs/conversion/export/markdown/rest-api).
- [DOCX export extension](https://tiptap.dev/docs/conversion/export/docx/editor-extension):
  local conversion, commercial distribution, fidelity limits, optional network paths.
- [TextStyleKit](https://tiptap.dev/docs/editor/extensions/functionality/text-style-kit) and
  [Pages](https://tiptap.dev/docs/pages/guides/zero-to-print-ready): useful capabilities, not a
  commitment to the commercial Pages stack.
