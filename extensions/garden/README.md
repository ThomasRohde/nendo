# Garden

A custom view for a garden of notes: the notes as a tree on the left, one note's Markdown
and its preview in the middle, and what links to it below. It is the screen
`workspace/Garden.nendo` opens on (`extensionView` with `opensFile`), and the same package
is the **Backlinks** panel on a note's record page (`extensionRecordPanel`).

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

## In Nendo's toolbar

Where Nendo offers its toolbar the view draws no controls of its own: Find (Ctrl Shift F),
New note (also Nendo's Add), Today, Preview, Save (Ctrl S), Undo and Redo, and a menu with
Open record page, Graph, Mark evergreen and About. Following a wikilink declares a place, so
Back and Forward move between notes. On an older Nendo the view shows its own controls.

## What it reads

Everything arrives through `window.nendo`: `records.queryAll` for the notes (without their
bodies) and the tags, `records.get` for one note, `records.query` with `eq` filters for a
note's links, tags and tasks, `records.batch`, `records.undo` and `records.redo`,
`commands.run` for Mark evergreen, `ui.openRecord`, `ui.openScreen`, `ui.setToolbar`,
`ui.setPlace`, `ui.setHeight` on a record page, and the `changes`, `context`, `command` and
`place` events. Every method beyond the reads is used only where `nendo.has` says it exists.
Colours are the theme's tokens.

## Files

`index.html`, `garden.js` (picks the mode), `workspace.js`, `panel.js`, `related.mjs` (the
rows under a note), `parse.mjs` (links, tags, tasks, slugs, keys), `render.mjs` (Markdown to
escaped HTML), `sync.mjs` (a save's writes), `garden.css`, `kit/nendo-view-kit.js` (a copy of
`tools/view-kit/`). Not in scope: vault import, transclusion, tables and footnotes, a rich
editor, attachments, dragging in the tree (the Tree screen reorders).

## What measures it

`node --test tools/garden/*.test.mjs` for the pure modules and the file's definition, and
`pwsh ./tools/Review-Garden.ps1`, which serves this folder on one origin and the fixture
broker on another with the real `api.js` between them, inside `Test-Production.ps1`. The
design is in `docs/design/garden.md`.
