# Manuscript

A manuscript written as one quiet continuous page and kept paragraph by paragraph (W-276,
design A of the [manuscript workbench](../../docs/design/manuscript.md)). It is built into
`workspace/Manus.nendo`.

## Records

Every part, chapter, section and paragraph is a **Block** (`mn.block`): its text as Markdown
of one paragraph's inline content, its kind, and its place in one declared hierarchy (parent
and order). The root block is the manuscript and its text is the title; a **Cuttings** block
under it holds what was kept out of the manuscript. **Notes** (`mn.note`) and named **Links**
(`mn.link`) point at blocks. Studio, the **Outline** screen and an agent over MCP reach the
same records; the view keeps no copy of the manuscript in the file.

## The view

- One Tiptap editor shows the blocks under the root, Cuttings left out. A heading's level is its
  kind: Part, Chapter, Section. A heading holds the paragraphs after it until the next heading
  at its level or above.
- A pause in typing saves what changed as one version-checked `records.batch`: only the blocks
  whose text, kind, parent or order changed. Splitting a paragraph keeps its ID on the first
  part; joining keeps the first. A removed paragraph takes its notes and links with it, unless
  its text now sits in another block (a merge), which takes them over marked *Needs review*.
- A refused write keeps the text on the page and says why; Reload takes the saved version.
  Somebody else's change reloads the page when nothing is waiting to be saved.
- Text not yet saved is kept in the view's own storage until it is, and put back when the view
  starts again if nothing it touched has changed since.
- A block whose whole text is one picture, `![alt](media:…)` or a web address, is drawn as
  that picture, from the open file's media origin, and selected or deleted whole; one that does
  not load says *Picture not found* with its description. While writing it is a 168 by 112
  thumbnail with its description beside it; *Full width* under Appearance is the device's choice.
- **Export** in Nendo's toolbar saves what is on the page, reads the manuscript as the file holds
  it, and downloads it: *Markdown* as a `.md`, or a `.zip` with the `.md` and a `media/` folder
  when it has pictures; *Word document* as a `.docx` with a Title, Heading 1 to 3, bold, italic,
  strikethrough and code runs, and each picture at the text's width with its description as
  alternative text. Cuttings, notes and links stay out. A picture that cannot go in stands as
  its description and the view names it.
- Selecting words in a paragraph shows a bar: Link, Note, Keep as cutting, Copy for the agent.
  The margin counts each paragraph's notes and links. Outline, Notes, Related and the
  appearance (typeface, size, line length, kept per device) are in Nendo's toolbar.

## Limits

- A declared hierarchy holds at most 10,000 descendants, so a manuscript holds at most about
  10,000 blocks, near the 500,000-word stress size of the design.
- Every save writes one History row per block it changes; the file stops taking writes near
  100,000 rows until the person folds old history.
- Lists, quotations, tables and inline links are not editable here yet, and a picture can be
  added only by writing its block elsewhere (Studio, an agent); a block that holds them keeps
  their characters.
- A cut and paste is a delete and a new paragraph, not a move. Undo after a save brings a
  deleted paragraph back under a new ID.

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
