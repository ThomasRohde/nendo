# Manuscript

A manuscript written as one quiet continuous page and kept paragraph by paragraph (W-276,
design A of the [manuscript workbench](../../docs/design/manuscript.md)). It is built into
`workspace/Manus.nendo`, and `workspace/Manuscript.nendo` is a clean new file of it (ADR-0022)
holding a draft paper.

## Records

Every part, chapter, section and paragraph is a **Block** (`mn.block`): its text as Markdown
of one paragraph's inline content, its kind, and its place in one declared hierarchy (parent
and order). The root block is the manuscript and its text is the title; a **Cuttings** block
under it holds what was kept out of the manuscript. A block may carry a **Role**, what it is for
apart from its kind: front matter (Subtitle, Author, Dedication, Epigraph, Foreword, Preface,
Acknowledgements, Abstract, Keywords), body (Quotation, Verse, Scene break, Caption, Aside) or back
matter (Appendix, Afterword, Glossary, References, About the author, Colophon); a role on a heading
applies to everything under it. **Notes** (`mn.note`) and named **Links**
(`mn.link`) point at blocks. Studio, the **Outline** screen and an agent over MCP reach the
same records; the view keeps no copy of the manuscript in the file.

## The view

- A file may hold several manuscripts, each a top-level block of kind Manuscript with its own
  chapters and Cuttings. The picker in Nendo's toolbar opens another or starts a *New
  manuscript*; each switch is a step in Nendo's Back and Forward, and unsaved text is kept per
  manuscript.
- One Tiptap editor shows the blocks under the root, Cuttings left out. A heading's level is its
  kind: Part, Chapter, Section. A heading holds the paragraphs after it until the next heading
  at its level or above.
- A pause in typing saves what changed in version-checked `records.batch` writes: only the
  blocks whose text, kind, parent or order changed, and deleted ones. A save of more than 200
  writes or 250,000 characters goes as several batches, each committed on its own. A block out
  of place (a row outside a table) is shown where it would go and left as stored until the
  person changes it (0.13.0).
- A block keeps its ID through what the editor does to it, and where a block goes is read from
  the editor's own transactions, never from matching text (0.14.0). Splitting a paragraph keeps
  its ID on the first part; joining keeps the first, and the second's notes and links go to it,
  links marked *Needs review*. Deleted from one paragraph's start into the next, what is left is
  the second paragraph. Move up and Move down (Alt+Shift+↑ and ↓, or the block menu) move the
  blocks the selection touches. A block cut whole goes to the Cuttings with its notes and links,
  and pasted back into its manuscript it is the same block, moved. A copy is a new block. Any
  other removed block takes its notes and links with it.
- A refused write keeps the text on the page and says why; Reload takes the saved version.
  Somebody else's change reloads the page when nothing is waiting to be saved.
- What is not yet saved is kept in the view's own storage as the writes the next save would
  make, each at the version it started from, never as a copy of the whole manuscript (0.13.0).
  When the view starts again, a write whose record is unchanged since is saved; one whose record
  changed or went is held, and the person chooses *Put mine back* or *Discard mine*. Nothing
  else is written. If the device refuses to keep it, the status line says so.
- A block whose whole text is one picture, `![alt](media:…)` or a web address, is drawn as
  that picture, from the open file's media origin, and selected or deleted whole; one that does
  not load says *Picture not found* with its description. While writing it is a 168 by 112
  thumbnail with its description beside it; *Full width* under Appearance is the device's choice.
- **Write / Book / Paper** in Nendo's toolbar switches between writing and a preview: the page as
  the Word layout sets it, on sheets of its paper (6 by 9 inches, or Letter), with its fonts, roles,
  figure rows, page breaks and page numbers. It reads what is on the page, saved or not, and draws
  it block by block, so a paragraph is never split across sheets as Word may split it. The line
  length under Appearance scales the sheets, so the page's text runs as wide as it does while
  writing, and Full fits a whole sheet to the window; Small and Large scale them again, as they
  scale the writing sheet's type. No sheet is drawn wider than the window.
- **Role** in Nendo's toolbar sets the role of the block the caret is in; the sheet names it above
  the block and indents a quotation, a verse or an epigraph as a layout would. A file built before
  0.5.0 has no Role field and shows no control until the field is added.
- **Export** in Nendo's toolbar saves what is on the page, reads the manuscript as the file holds
  it, and downloads it: *Markdown* as a `.md`, or a `.zip` with the `.md` and a `media/` folder
  when it has pictures; *Word document* as a `.docx` with a Title, Heading 1 to 3, bold, italic,
  underlined, strikethrough, highlighted and code runs, each block's own alignment over its
  layout's, and pictures with their descriptions as alternative text, in one
  of two layouts, each setting blocks by their role. A block without one is set by what its
  heading says (Abstract, References, Appendix …), and a paragraph after a picture that starts
  "Figure n." is its caption. The *book layout* is a 6 by 9 inch page in Georgia with a title page and each
  part or chapter on a new page. The *paper layout* is an article as arXiv carries one in the
  AASTeX two-column style, on Letter paper in Times at 10 points: the draft line at the top of
  the first page, a centred title block from the paragraphs before the first heading (authors
  in small capitals), the abstract across the page and narrower, then the body in two
  justified columns, indented after the first paragraph, with headings centred and numbered
  ("1. INTRODUCTION", "2.1. Documents as applications"; a heading's own number is kept), a
  part such as the Abstract or References in capitals, pictures at the column's width and side
  by side within it, a paragraph after a picture that starts "Figure n." set as its caption, a
  References section with hanging indents, and page numbers at the top right. Cuttings, notes and links stay out. A picture that cannot go in stands as
  its description and the view names it.
- Selecting words in a paragraph shows a bar of icons in groups (text, alignment, paragraph,
  manuscript), each named with its keys in a tooltip: bold, italic, underline, strikethrough,
  inline code, highlight and clear formatting; align left, centre, right and justify; paragraph
  or Part, Chapter and Section heading; Quotation; Link to a passage, Add a note, Keep as cutting
  and Copy for the agent. Ten are on the bar to start with; More holds the rest, where a pin puts
  one on the bar and a right-click on the bar puts it back (kept per device, `manuscript.bar`).
  Underline and highlight are kept in a block's Markdown as `<u>` and `<mark>`, outside the
  emphasis delimiters; alignment is the block's `mn.block.align` choice (Left, Centre, Right,
  Justify; none takes the layout's setting), offered only in a file that has the field.
- Lists (0.10.0): a list item is a paragraph block with `mn.block.list` (Bulleted, Numbered) and
  `mn.block.level` (none for the outermost, 1 to 4 deeper); consecutive items make a list, as
  Word keeps a list as paragraph properties. "- ", "* " and "1. " start one, Tab and Shift+Tab
  change the level, Enter on an empty item steps out and then ends the list, a pasted HTML list
  arrives as items. The sheet numbers items with CSS counters per level; the exports use the same
  rule (`numberLists`), Word with its own numbering, one instance per list so each starts at 1.
- Tables (0.10.0): a Table block owns Row blocks, each owning Cell blocks whose text is inline
  Markdown, as section 4.2 of the design describes; the first row is the header. The sheet uses
  Tiptap's table nodes with each table, row and cell carrying its block ID; the bar offers add and
  delete row or column and delete table. Word export writes a table with a repeated header row,
  Markdown a pipe table, the preview an HTML table. Kind needs Table, Row and Cell among its
  choices: a file made before 0.10.0 gets them with `schema.addChoice` (Nendo with W-280); until
  then the view offers no tables there.
  Without a selection (0.12.0, canvas design A), a plus and a grip appear faintly in the margin
  beside the block under the pointer: the plus adds a paragraph, a list item, a table or a heading
  below it, the grip opens the block's menu (turn into, align, the table's own actions, link,
  note, cut, copy for the agent). A Format menu in Nendo's toolbar names every tool that applies at the caret:
  marks, lists and roles as checks, alignment and style as radios, the rest as items. The menu
  declares no keys, since the editor runs them and a declared key would run the tool twice.
  The margin counts each paragraph's notes and links. Outline, Notes, Related and the
  appearance (typeface, size, line length, kept per device) are in Nendo's toolbar.

## Limits

- The view reads every block of the file flat, a cursor page at a time, and builds the tree
  itself. Since ADR-0019's amendment of 2026-10-16 only subtree aggregates keep the 10,000-record
  bound; Nendo's Outline, `records.tree` and `descendantOf` page by key.
- Every save writes one History row per block it changes; the file stops taking writes near
  100,000 rows until the person folds old history.
- A web link is written `[words](address)` and edited with Web link on the bar (0.15.0). A
  bare address, an `<address>` and a link with a title stay as the characters they were
  written with; a Word export makes each link Word's own hyperlink.
- Insert picture puts a picture from this computer in the file with `nendo.media.put` and on
  the page as a block of its own, its file name as its description; Describe picture changes
  that. Add a caption below starts a Caption paragraph.
- Find and replace (Ctrl+F, Ctrl+H, or Find in the toolbar) reaches every paragraph and table
  cell, on the page or not, and with *Cuttings too* the cuttings as saved. Replace all is one
  step that one Ctrl+Z undoes, except in the Cuttings, which are written as records. A block's
  ID, as *Copy for the agent* copies it, goes straight to the block.
- Reading the file again (a change made elsewhere) starts the undo history again, so Ctrl+Z
  never takes the page back to before it was read.
- Ctrl+Z after a save undoes the save's revision (`records.undo`), so a deleted block comes
  back under its own ID with its notes and links. That holds while the view stays open and
  nobody else has changed those records since; otherwise the block comes back as a new one.
- Speed, measured by `Review-Manus.ps1` in Edge against the fixture broker, typing at a
  person's pace in the middle of a generated manuscript. The lane holds the view's own work on
  the page's thread to 50 ms a key at 150,000 words and 75 ms at 500,000: 13 ms and 31 ms alone
  on 2026-10-18, about twice that under the full gate. From key to frame, the design's measure, it took
  19 ms and 57 ms at p95 on 2026-10-17 and 58 ms and 154 ms the next morning, the same code
  both times; painting is the machine's, so that number is reported and not asserted. Not
  measured in the installed Nendo.

## Build

```powershell
npm.cmd ci --prefix tools/manus --no-audit --no-fund
node tools/manus/bundle.mjs
node tools/Build-Manus.mjs --dry-run
node tools/Build-Manus.mjs --endpoint http://127.0.0.1:PORT/mcp [--accept]
node tools/Put-NendoPackage.mjs extensions/manuscript --endpoint http://127.0.0.1:PORT/mcp [--accept]
pwsh ./tools/Review-Manus.ps1
```

`Build-Manus.mjs` builds only into an empty, newly created file and accepts only with
`--accept` at Unattended. `Put-NendoPackage.mjs` updates the view in a file that has it. The
package carries Tiptap 3.31.4 and marked 17.0.6, bundled by esbuild 0.28.2 into
`vendor/editor.js`, and docx 9.8.1 and JSZip 3.10.2 into `vendor/export.js`, loaded only when
exporting, with every bundled package's licence in `vendor/THIRD-PARTY-NOTICES.txt`;
`tools/manus/package-lock.json` pins the rebuild. No remote script or font is loaded.

`Review-Manus.ps1` runs the unit tests (`tools/manus/*.test.mjs`) and the browser lane
(`tools/Gate-Manus.mjs`) against the fixture broker; it is part of Test-Production. The view
in the installed Nendo is the owner's check.
