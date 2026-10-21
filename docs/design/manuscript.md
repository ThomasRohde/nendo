# Manuscript

A manuscript written as one quiet continuous page and kept paragraph by paragraph, built as a
Nendo application: a `.nendo` file with record types, a declared hierarchy, link records, screens
and a custom view, `extensions/manuscript/`, that carries Tiptap (ADR-0013). It needs no host
change. `tools/Build-Manus.mjs` builds it into an empty file; `workspace/Manuscript.nendo` holds
the owner's paper and `workspace/Milo.nendo` a picture book. What the view does, key by key, is in the
package's [README](../../extensions/manuscript/README.md).

The aim: long-form writing that feels like one continuous document while every paragraph is
independently identifiable, stored, related and recoverable. An agent, a list, a board, a
calculation or Studio can query paragraphs as records, so nobody parses prose to learn what links
to what.

## Owner-confirmed requirements

1. Each paragraph has one place in the manuscript. No shared editable paragraph appears in more
   than one position.
2. Named relationships between paragraphs are wanted.
3. Build reusable foundations, with a deliberately focused authoring experience.
4. Address authors generally and any kind of manuscript (novel, research, essay, technical, report),
   not a novel-only product.
5. A quiet continuous writing surface, with optional structural views.
6. Extensive font and layout choices.
7. A general manuscript ontology, not genre-specific features listed by the owner.
8. The full range from no AI involvement to fully AI-generated manuscripts.
9. 150,000 words is the normal manuscript target and 500,000 words the stress target.
10. No external editor workflow.
11. Export to Markdown and Microsoft Word (.docx).

Shipped editor and export components are open source and work offline; a paid component is not
chosen merely because the editor is Tiptap.

## Principle: one composition tree, many relationships

The composition tree answers **where content belongs and in what order it is read**. Named
relationships answer **how passages relate**. Ownership is never inferred from a relationship,
structure never from font size, and one editable paragraph never has two structural positions. A
paragraph shown in a preview, search result or comparison gains no second location; earlier
versions are history, not live placements.

## Records and screens

| Type | Fields | Rule |
| --- | --- | --- |
| **Blocks** (`mn.block`) | Text (Markdown of one paragraph's inline content), Kind (Manuscript, Part, Chapter, Section, Paragraph, Cuttings, Table, Row, Cell, Footnote), Inside (parent), Order, Role, Align (Left, Centre, Right, Justify), List (Bulleted, Numbered), Level | The one hierarchical type (ADR-0019). A top-level Manuscript block is one manuscript and its text the title; a file may hold several. A Cuttings block under it holds what was kept out. A heading's level is its kind. A list item is a paragraph with List and Level; consecutive items make the list. A Table owns Rows owning Cells. A Footnote sits under the block that cites it as `[^its ID]` |
| **Notes** (`mn.note`) | Note, Kind (Comment, Question, Task, Issue), On (a block), Done | An observation anchored to a block |
| **Links** (`mn.link`) | Kind (Elaborates, Supports, Contradicts, Foreshadows, Resolves, See also), From, To, Why, Review (Current, Needs review), From and To as reviewed | A named relationship between blocks. Each end's words as last reviewed are kept; a save that changes them marks the link *Needs review* in the same batch |
| **Output profiles** (`mn.profile`) | Manuscript, Layout (Book, Paper, Manuscript), Page size, Margins (mm), Typeface, Size, Line spacing, Page numbers | One layout's settings for one manuscript, over the layout's own |

Roles are front matter (Subtitle, Author, Dedication, Epigraph, Foreword, Preface,
Acknowledgements, Abstract, Keywords), body (Quotation, Verse, Scene break, Caption, Aside) and back
matter (Appendix, Afterword, Glossary, References, About the author, Colophon); a role on a heading
applies to everything under it.

Screens: the **Manuscript** view, which opens the file; **Outline** (an outline surface over
Blocks, reorderable); **Notes**; **Links**. With the view off, the blocks, their order and links
stay readable and editable in Studio and these screens.

`tools/manus/definition.mjs` holds the shape and `tools/Build-Manus.mjs` builds it into an empty,
newly created file. A field or choice a file lacks reaches it as a package proposal
(`schema.addField`, `schema.addChoice`).

**The grammar.** Which kinds may own which children (a row only under a table; a table row is not a
section) is the application's rule. The Engine enforces the hierarchy's shape, not the grammar, so
Studio and an agent can write a block where the grammar forbids it; the view shows such a block
where it would go and leaves it as stored until the person changes it.

## Nendo mechanisms it relies on

| Concept | Mechanism | Caution |
| --- | --- | --- |
| Composition tree | A declared hierarchy on one record type; `hierarchy-cycle` refuses loops; at most 32 levels (ADR-0019) | Sections and blocks share one type, told apart by Kind |
| Move | `records.move`: before a sibling or last, renumbering only the run around the insertion point | Cannot be part of a `records.batch` |
| Stable identity | Record IDs; deleted IDs stay reserved | None |
| Concurrency | Every record write is conditional on its version; a stale write is refused | None |
| Named relationships | A link record type with source, target and kind; ADR-0026 allowed links (`docs/contracts/relationships.md`) | No symmetric-link primitive: a symmetric kind is one row with a documented reading |
| Deleting a linked block | Refused while referenced, with no cascade | The application deletes or re-targets links in the same batch |
| Restore | Compensation re-creates a deleted record under its own ID when it can (ADR-0006) | No universal undo: a refused restore is said |
| Interactive undo | A view undoes and redoes its own batches, version-checked (ADR-0023) | An agent edit in between makes the view's undo refuse, not overwrite |
| Search | FTS5 over every active Text field (ADR-0028) | Exists only after `application.buildSearchIndex` |
| Pictures | Media and `![alt](media:…)` in Markdown (ADR-0031) | 64 MiB per item, 2 GiB per file |
| Tiptap | The view carries its own copy, within a package's 4 MiB per file and 16 MiB in all | A view cannot reach the Workbench's bundle |
| Others' changes | The `changes` event, at most every 250 ms, as a nudge (`docs/contracts/custom-views.md`) | It says that the file changed, not which blocks |
| Agent | The person's own agent over ACP, editing through MCP (ADR-0030, ADR-0014); the view asks it about a passage with `nendo.assistant.ask` (ADR-0033) | A view sees only its own turn's reply, never the conversation or the agent's settings |

## Integrity rules

1. Every active paragraph has exactly one owning container and one position; the tree has no
   cycles. *(Engine.)*
2. A block has a permitted parent for its kind. *(Application.)*
3. Identity is never a text hash, array index or offset; editing or moving keeps the ID. *(Engine.)*
4. Relationships confer no ownership and copy no content.
5. Paragraph text is authoritative in one place, its block. Editor documents, Markdown, search text
   and statistics are projections; no Tiptap state is stored.
6. One logical edit commits as `records.batch` writes of up to 200 writes and 250,000 characters
   each; a larger save goes as several batches, each committed on its own, never presented as
   atomic. A move is its own write.
7. Studio, custom views and agents meet the same Engine rules; rules the application enforces are
   listed as such.
8. A rejected or stale write never silently overwrites a newer version. *(Engine.)*

## Paragraph lifecycle

- **Edit** keeps the ID; the write makes a new record version.
- **Move** keeps the ID, history and relationships. Where a block goes is read from the editor's
  transactions, never from matching text. A block cut whole and pasted back into its manuscript is
  the same block, moved.
- **Copy** makes a new block for every copied node, cloning no relationships or review state.
- **Split** keeps the ID on the first part and creates a block for the rest.
- **Merge** keeps the first block's ID; the second's notes and links go to it, links marked *Needs
  review*, never silently redirected.
- **Remove** deletes the block and, in the same batch, its notes and links. History keeps them, and
  undo restores them together while the IDs are still deleted.
- **Keep as a cutting** moves the block under the Cuttings, one owned block with its links intact.
- **Reformat or reflow** keeps IDs: a changed font, wrap point or page count never splits, merges or
  renumbers paragraphs.

## Writing, appearance and layout

The default view is continuous prose in one editor. Record boundaries and relationship controls
stay out of sight until text is selected or a command is invoked. Optional views (outline, notes,
related passages, cuttings) refer to the same content; none creates a second editable document.
Keyboard navigation, selection across blocks, clipboard, undo and redo, find and replace,
accessibility and input-method composition are foundation requirements.

Three kinds of appearance stay apart:

- **Personal writing appearance**: typeface, size and line length on screen, kept per device, never
  in the manuscript and never in an export.
- **Document formatting**: Kind, Role and Align on a block, and inline Markdown marks (bold,
  italic, strikethrough, code, `<u>`, `<mark>`).
- **Publication layout**: an output profile per layout and manuscript, previewed on its sheets.

Layout is rich document layout, with no claim of desktop-publishing parity: no free columns,
floating boxes or exact page positions (whether to go further is an open decision). Pagination is a rendering result, never a change to ownership, and a 500,000-word
manuscript stays editable without whole-book pagination per keystroke. No unsupported node is
silently dropped by editing, saving or exporting.

## AI

**How much AI contributes** and **what AI may commit** are separate decisions. Manual work needs no
agent and no network. Read-only help is Nendo's *Inspect* level; direct writes *Edit data*; an
agent that accepts its own proposals *Unattended*. A narrower scope inside a level (one chapter, one
pass) is an application convention, not enforcement.

The host launches the person's own agent over ACP and the agent edits through MCP; the host embeds
no model (ADR-0014, ADR-0030). The file's own skill (ADR-0024) tells an agent how blocks, links and
the history budget work. *Ask the agent* sends a passage, each block named by its ID, with the
person's request and what the agent may do: notes only by default, so suggestions land as notes in
the margin and the text stays the writer's (ADR-0033). *Copy reference* copies a block's ID, which
an agent or Find reaches directly.

A long generation is a managed run driven by the launched agent while it is open, section by
section, never one huge insertion; background agents are out of scope. Every revision is attributed
to its actor. A run cannot overwrite a person's edits made meanwhile: the version check refuses it.
Generated factual text is not verified because it is source-shaped. A cost cap is shown only when
the agent exposes enforceable accounting.

## Persistence

The Engine is the store, reached through typed services; the view's browser storage is never the
manuscript store. The editing path:

1. Read every block flat with `records.queryAll` (up to 1,000,000) and build the tree in the view.
2. Build the editor document, keeping each block's ID and version on its node.
3. Turn editor transactions into changed-block writes on a pause in typing, never per keystroke.
4. Commit them with `records.batch`, each write conditional on its version.
5. On a `changes` nudge, re-read without replacing a focused editor that has unsaved work.

Unsaved work is kept in the view's storage as the writes the next save would make, each at the
version it started from. The status says Saving, Saved or Save failed; "Saved" means the host
acknowledged the commit. Undo covers the view's own batches (ADR-0023); recovery beyond that is
compensation.

## Budgets

| Bound | Value | Source |
| --- | --- | --- |
| File open bound / byte write ceiling | 256 MiB / 224 MiB, media excluded | ADR-0012 |
| Rows per audit table | 100,000; writes refused 1,000 rows below | `docs/architecture.md`, ADR-0012 |
| Batch | 1 to 200 writes, at most 250,000 characters, no move | `docs/contracts/custom-views.md` |
| Request parameters / agent request body | 256 KiB each | `docs/contracts/custom-views.md`, `docs/contracts/mcp-interface.md` |
| Media | 64 MiB per item, 2 GiB per file | ADR-0031 |
| Hierarchy | Depth 32; no bound on descendants; a subtree aggregate folds at most 10,000 | `limits.hierarchy` |

**Bytes are not the limit.** 500,000 words is about 3 MB of text, about 8 MB on disk, 5,000 to
15,000 blocks. **History rows are.** Each record write adds one row to `__nendo_operation`; at the
bound the file takes no writes until the person folds old history (ADR-0021), which only the person
starts. So the application saves per paragraph on a pause, should show the history budget and send
the person to the host's fold when one is due, and treats a named state that must outlive a fold as
a Backup.

## Performance

Fixtures of 150,000 and 500,000 words, with many short and very long paragraphs. Targets:
input-to-paint p95 at most 50 ms at 150,000 words and 100 ms at 500,000; no lost input, broken
composition or selection jumps; whole-manuscript operations report progress. `tools/Review-Manus.ps1`
asserts the view's own work per key (50 ms at 150,000 words, 75 ms at 500,000) and reports
key-to-frame, since painting is the machine's. Blocks are read in hierarchy order, never by sorting
a whole table.

## Export

- Export reads the manuscript as the file holds it, including what is outside the editor's window,
  and never changes it. Cuttings, notes and links stay out. What cannot go in is named with a place
  the author can open; nothing disappears under a success message.
- **Markdown** is a portable export, not the store: a `.md`, or a `.zip` with a `media/` folder when
  there are pictures. Named relationships do not become published links.
- **Word** is an editable .docx with real paragraphs, Word paragraph styles per role, headings,
  lists, tables, footnotes and pictures with alternative text, never page images, generated in the
  view from block records with the open-source `docx` and JSZip packages. The aim is faithful
  structure and formatting, not identical line breaks; qualification opens exports in Microsoft
  Word. Export does not imply Word import.

## Gaps that may need host work

| Gap | Effect | Possible host answer |
| --- | --- | --- |
| A batch cannot carry a move | A move and its related changes are two revisions | `records.move` in a batch |
| `changes` names no records | After an agent writes, the view re-reads to find what changed | Record-level change events for views |
| History rows per write | Long writing reaches the row bound; folding is manual | Coalescing one actor's rapid edits, a larger bound, or a fold prompt |
| Grammar is application-enforced | Studio and agents can place a block where the grammar forbids | A declared parent-kind rule on the hierarchy |
| No named state survives a fold | A label over history is lost to folding | A host-kept label exempt from folding, or Backup |

## Open decisions

- **Layout boundary.** Rich document layout only, or desktop publishing too? Recommendation: rich
  document layout, with room to extend.
- **Delegated AI edits.** May an authorised run change accepted text without approving each
  change? Recommendation: a new draft by default; changing existing text needs a clearly scoped
  delegation.
- **Inline text storage.** Markdown per block, with paragraph-level fields, is built as recommended;
  it keeps the data usable in Studio, search and CSV. Revisit if inline font or colour runs are
  needed.
- **History budget.** Is a manual fold every few hundred writing hours acceptable, or should the
  host coalesce edits or raise the bound? Measure rows per hour of typing first.
- Not yet decided: import, full branching, and the wider ontology below.

**The wider ontology**, a working model not yet built: a **Project** (purpose, audience, brief,
vocabulary), **Subjects** (people, places, concepts) with aliases and links to passages,
**Sources** with citations as typed links carrying a locator, **Tasks and revision passes**, and
**Milestones** (a change sequence plus a label; going back is compensation or a Backup, never a
rewrite), **Proposed changes** and **Generation runs**. Vocabulary presets (fiction, research,
technical, general prose) offer role, subject and relationship names without changing ownership or
identity rules; authors extend them through reviewed schema proposals.

## Acceptance scenarios

- Continuous prose: select and replace across paragraphs and sections without database controls.
- Identity: edit, restyle and move a paragraph; its ID and links stay. A copy of a linked passage
  leaves the original's text and links alone.
- Split and merge keep exact anchors right and mark uncertain ones.
- A paragraph inside a list, a table cell and a note is identified, edited, recovered and exported.
- A host killed during a save reopens to an acknowledged state or explicitly recovered work.
- A section reordered in the Outline shows in the writing view, search and export.
- An agent's stale write is refused or reconciled; the view's undo refuses rather than overwrites.
- With no agent and the network off: create, edit, search, restore and export.
- A bounded full-manuscript generation can be interrupted and resumed deliberately.
- Exporting the stress manuscript writes all of it, with counts, order, formatting and warnings.
- Personal appearance leaves publication settings alone; a style change keeps IDs.
- One schema serves fiction, an argument and a technical manuscript.
- View, Studio and agent writes cannot bypass Engine rules.
- Byte and row ceilings, with history and pictures, refuse while keeping saved content.
- With the view off, the manuscript is readable and editable in Studio and Nendo's screens.
- Rows per hour of typing and per generated chapter are measured.

Large fixtures and a forced kill run against task-owned copies under `artifacts/`, never against a
`workspace/` file.

## Sources

`docs/vision.md`, `docs/architecture.md`, `docs/contracts/custom-views.md`,
`docs/contracts/launched-agents.md`, `docs/contracts/mcp-interface.md`,
`docs/contracts/relationships.md`, `docs/contracts/csv.md`, [Garden](garden.md); ADR-0006, ADR-0007,
ADR-0010, ADR-0012, ADR-0013, ADR-0017, ADR-0019, ADR-0021, ADR-0022, ADR-0023, ADR-0024, ADR-0026,
ADR-0028, ADR-0030, ADR-0031.
