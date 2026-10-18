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
  figure rows, page breaks and page numbers. It reads what is on the page, saved or not. The book
  is drawn block by block, so a paragraph is never split across sheets as Word may split it. The
  paper is set as TeX sets the reference (0.20.0 and 0.21.0, W-293): each paragraph broken into
  lines by Knuth and Plass's algorithm as tex.web has it (TeX's integer badness, its fitness
  classes, its tie rule and pruning, an emergency pass) with the AASTeX reference's parameters, its
  words measured in TeX Gyre Termes as XeTeX sets them (kerned, with ligatures, a hyphenated word
  in pieces) and hyphenated with plain TeX's patterns, the ones LaTeX's English loads; then drawn
  in Times with each space ending where TeX starts the next word. The references are set ragged,
  French-spaced and unhyphenated, as AASTeX sets its bibliography. A paragraph runs on line by line
  from the foot of a column to the head of the next, never one line alone on either side; a
  heading keeps two lines with it, a figure its caption and a table its caption; the room above a
  picture or a table grows with how far the line above it reaches below its baseline; the columns
  above the references and those of the last page are balanced as revtex balances them. The line
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
  AASTeX 6.3.1 two-column style, measured from a LaTeX render of the same plan (`ARTICLE` in
  `export.mjs`, 0.20.0): Letter, 7.1 inches of text in two 241.35-point columns 28.5 apart, Times
  at TeX's 10 points on lines exactly 12.45 points apart, each column's first baseline at 74.6
  points; the draft line at the top of the first page, a centred title block from the paragraphs
  before the first heading (title in bold, authors in small capitals, the rest smaller and
  italic), the abstract across the page and narrower, then the body justified and hyphenated,
  every paragraph indented 9 points, the first after a heading too, as the class indents it;
  headings centred and numbered ("1. INTRODUCTION", "2.1. Documents as applications"; a
  heading's own number is kept), a part such as the Abstract or References in capitals, numbered
  lists with their numbers set right, pictures at the column's width and side by side 18 points
  apart, a paragraph after a picture that starts "Figure n." set as its caption, tables with
  AASTeX's rules (double above, one under the header row, one below) and columns sized as Word
  and a browser size them, the References heading across the page under balanced columns and
  the references in two columns, ragged and never hyphenated, and page numbers on the outer
  side. Cuttings, notes and links stay out. A picture that cannot go in stands as
  its description and the view names it. *Word document, paper as typeset* (0.21.0) is the paper
  line for line as the preview sets it: every line ends in a break and its spaces are widened by
  character spacing, so Word draws TeX's lines; the references start a page where the preview's
  do, their second column where revtex starts it. Its lines do not reflow when edited in Word.
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
- A footnote (0.17.0) is a block of kind Footnote under the paragraph or cell that cites it, its
  text inline Markdown; the citing text holds `[^its ID]`. The sheet draws the number (a CSS
  counter, in reading order) and keeps the words beside it: Footnote on the bar or Ctrl+Alt+F
  cites one at the caret, a click on the number opens it, and deleting the number deletes it with
  its notes and links. A copy of a cited passage cites a footnote of its own, its words copied.
  Word export writes Word's own footnotes; Markdown export writes `[^n]` and the notes at the end;
  the preview sets them after the text. Kind needs Footnote among its choices: a file made before
  0.17.0 gets it from the package proposal (`footnoteKindOperations`).
  Without a selection (0.12.0, canvas design A), a plus and a grip appear faintly in the margin
  beside the block under the pointer: the plus adds a paragraph, a list item, a table or a heading
  below it, the grip opens the block's menu (turn into, align, the table's own actions, link,
  note, cut, copy for the agent). A Format menu in Nendo's toolbar names every tool that applies at the caret:
  marks, lists and roles as checks, alignment and style as radios, the rest as items. The menu
  declares no keys, since the editor runs them and a declared key would run the tool twice.
  The margin counts each paragraph's notes and links. Outline, Notes, Related, Cuttings, Find
  and the appearance (typeface, size, line length, kept per device) are in Nendo's toolbar.
- The Outline moves a heading's section, the heading and what it holds, past its neighbour of
  the same level: by its arrows, Alt+Shift+Up or Down on its row, or dragged onto another
  heading, another chapter included (0.16.0). The blocks keep their IDs; parents and order
  follow where they stand.
- Cuttings lists what was kept out of the manuscript. Put back sets a cutting after the
  paragraph the caret is in, the same block with its notes and links; Delete, pressed twice,
  deletes it and its notes and links for good. Where a cutting came from is not kept.
- A note's words and kind are edited in Notes, where the note is.
- Word export sets each role in a paragraph style of Word's own (0.19.0): Body Text, Body Text
  First, Quotation, Verse, Epigraph, Aside, Scene Break, Caption, Dedication, Subtitle, Author,
  Abstract, Keywords, References, Glossary, Colophon and Front Matter, beside Title and Heading 1
  to 3. The formatting is in the style, so changing a style in Word changes every paragraph of it;
  a block's own alignment stays on the paragraph. Three layouts: book, paper and manuscript (for a
  submission: Times at 12 points, double-spaced, on Letter with one-inch margins).
- Page setup keeps an output profile per layout and manuscript in the file (`mn.profile`): page
  size, margins in millimetres, a typeface by name, its size (headings and the smaller roles
  scaled with it), line spacing and page numbers, each over the layout's own when set. The Word
  export and the preview use it; *Use the layout's own* removes it. A typeface this computer does
  not have is named, since the preview and Word set it in a stand-in. The writing appearance
  stays per device. A file made before 0.19.0 gets the type from the package proposal
  (`profileEntityOperations`).
- A block longer than a page is shown whole in the preview, its sheet grown and marked, where it
  was cut off at the sheet's foot.
- A link keeps each end's words as they were when it was made or last reviewed (`mn.link.fromSeen`,
  `mn.link.toSeen`, 0.18.0). When a save changes the words at either end, the link is marked
  *Needs review* in the same batch; a link that kept no words yet keeps the ones from before the
  save. Related and the Links panel show what changed, word by word, and Reviewed makes the link
  current again with the words as they are now. A move is not a change of words. The Links panel
  also follows a thread: every passage at an end of one kind of link, or connected to the
  paragraph the caret is in, in reading order, with its chapter, the gap since the one before and
  its neighbours on request. Reading only: a thread's passages are edited on the page. The two
  fields reach a file made before 0.18.0 from the package proposal (`linkSeenFieldOperations`).

## Limits

- The paper's reference is `tools/manus/latex.mjs`, the plan as AASTeX 6.3.1 sets it, and
  `tools/Compare-ManusPaper.ps1` sets a manuscript four ways (the reference with Tectonic, both
  Word exports in Word, the preview in Edge), measures each block's page, column and baseline
  against the reference, and scores each page's ink against the reference's, pixel by pixel. It
  needs Tectonic, Word, and Python with PyMuPDF and Pillow, so it runs by hand, outside the gate.
  Measured on the draft paper on 2026-10-18: the preview and the paper as typeset put all 122
  blocks on the reference's page and column and within a point of its baseline (largest 0.8 and
  1.0 points), their ink scoring 0.983 and 0.984 against the reference's on average (1 would be
  identical; the type is Times, not Termes). Of the reference's 737 lines as a PDF reader takes
  them out, 718 read the same in the preview and 720 in the paper as typeset; most of the rest
  are lines the reader splits in two, and two paragraphs TeX breaks a line differently. The paper layout itself, which Word sets, is a line or two off on median, as Word
  breaks lines one at a time. Of 240 generated paragraphs XeTeX sets, the breaker matches 224 line
  for line, and all 240 as bibliography entries (`tools/manus/typeset-fixture.json` keeps nine).
- The reference departs from the class in what the exports cannot do: pictures and tables stand
  where the text has them rather than float; the room around headings, lists and figures does
  not shrink or stretch to fill a column, and no break is preferred before a section or around a
  list; a column starts before a heading the class's grid would leave at its foot; the class's
  credit under the draft line and its affiliation marks are left out.

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
`tools/manus/package-lock.json` pins the rebuild. `hyphenation.mjs` is plain TeX's `hyphen.tex`,
converted by `tools/manus/plain-hyphen.mjs` and carrying that file's terms. No remote script or font is loaded.

`Review-Manus.ps1` runs the unit tests (`tools/manus/*.test.mjs`) and the browser lane
(`tools/Gate-Manus.mjs`) against the fixture broker; it is part of Test-Production. The view
in the installed Nendo is the owner's check.
