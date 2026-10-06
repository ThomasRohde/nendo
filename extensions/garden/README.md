# Garden

A custom view for a garden of notes, in three places:

- **The Garden view**, the screen `workspace/Garden.nendo` opens on (`extensionView` with
  `opensFile`): the notes as a tree on the left and one note in the middle, in View or Edit.
  View is the page; Edit (Ctrl E toggles) is its Markdown with the preview beside it, filling
  the view. Drag the divider between them, or move it with the arrow keys; at the right edge it
  folds the preview away. Narrow, Medium or Full sets the page's width.
- **The Graph screen** (`extensionGraphSurface` over `gd.link`): the whole garden as a living
  d3 graph.
- **The Backlinks panel** on a note's record page (`extensionRecordPanel`).

## Reading

The title is the page heading and the body is set in a readable column. Under it are the
note's backlinks with the sentence that links, its local graph (the note and every note one
link away), its tags and its tasks. A wikilink opens its note in place; hovering one previews
the note it names. Ticking a task saves the tick at once, as one batch.

## What a save does

The body is the source. When you save, the view derives records from it and writes them
with the note as one `records.batch`, which Undo takes back as one step:

- `[[slug]]`, `[[Title]]` or `[[slug|other words]]` becomes a **Link** (`gd.link`, kind
  Mentions, source Body, the sentence as its context). A target that is not a note yet is
  planted as a Seed note in the same batch. Removing the link deletes the row; the seed stays.
- `#tag` becomes a **Tag** (`gd.tag`, made once for the file) and a **Note tag**.
- `- [ ] text` becomes a **Task** (`gd.task`, source Checkbox) keyed by its text, so ticking
  the box updates the same row.
- Rows with the source **Manual**, written by hand or by an agent, are never touched.
- Inside a code fence or inline code nothing is derived.
- A body over 32 KiB is refused in the frame, so an agent can always rewrite the note over
  MCP, where one value is bounded there.

A draft left behind when you move to another note is kept and marked in the tree; a note
changed elsewhere while a draft is dirty blocks Save until it is reloaded. `[[` in the editor
opens a list of notes to link.

## The graph

d3's force simulation lays the notes out. The wheel and a drag on the background zoom and
pan; a drag on a note moves it and its neighbours follow; hovering a note lights it and its
neighbours and dims the rest; labels fade in as you zoom; a click opens the note, and a
right-click offers its neighbourhood. A note's size follows the square root of its links and
its colour is its stage's tone, or its kind's. Manual links are dashed, tag links dotted.
The keyboard moves between notes with the arrows and opens one with Enter, and a screen reader
reads every note with its neighbours as a list.

## In Nendo's toolbar

Where Nendo offers its toolbar the view draws no controls of its own. The Garden view declares
Find (Ctrl Shift F), New note (also Nendo's Add), Today, View or Edit, the width as three icons
(Narrow, Medium, Full; words on a Nendo without those icons),
Save (Ctrl S), Undo and Redo, and a menu with Open record page, Graph of the garden,
Mark evergreen and About. Following a wikilink declares a place, so Back and Forward move
between notes. The Graph screen declares Find, Colour by stage or kind, Tags, Orphans,
Arrows, Spread, zoom and Fit (Ctrl 0), and About. On an older Nendo the views show their own
controls.

## What it reads

Everything arrives through `window.nendo`: `records.queryAll` for the notes, the links and the
tags, `records.get` for one note, `records.query` with `eq` filters for a note's links, tags
and tasks, `records.batch`, `records.undo` and `records.redo`, `commands.run` for Mark
evergreen, `schema.describe` for the choices' tones, `ui.openRecord`, `ui.openScreen`,
`ui.setToolbar`, `ui.showMenu`, `ui.setPlace`, `ui.setHeight` on a record page, and the
`changes`, `context`, `command` and `place` events. Every method beyond the reads is used only
where `nendo.has` says it exists. Colours are the theme's tokens.

## Files

`index.html`, `garden.js` (picks the place), `workspace.js`, `graphscreen.js`, `panel.js`,
`graph.js` (the d3 drawing), `graph-data.mjs` (records to nodes and edges), `related.mjs` (the
rows under a note), `parse.mjs` (links, tags, tasks, slugs, keys), `render.mjs` (Markdown to
escaped HTML), `sync.mjs` (a save's writes), `garden.css`, `kit/nendo-view-kit.js` (a copy of
`tools/view-kit/`), and `vendor/`: d3 7.9.0 (`d3.min.js`, ISC, `d3.LICENSE.txt`) with the
notices of the modules it is built from. Refresh it with:

```bash
npm.cmd ci --prefix tools/garden
node tools/garden/bundle.mjs
```

Not in scope: vault import, transclusion, tables and footnotes, a rich editor, attachments,
dragging in the tree (the Tree screen reorders).

## What measures it

`node --test tools/garden/*.test.mjs` for the pure modules and the file's definition, and
`pwsh ./tools/Review-Garden.ps1`, which serves this folder on one origin and the fixture
broker on another with the real `api.js` between them, and drives the graph with a real
pointer, inside `Test-Production.ps1`. The design is in `docs/design/garden.md`.
