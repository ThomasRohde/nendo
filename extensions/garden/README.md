# Garden

A custom view for a garden of notes. `workspace/Garden.nendo` opens on its Overview. The design
is in `docs/design/garden.md`.

## Places

- **Overview** (`gd.home`, an `extensionView` with `opensFile`): the graph coloured by stage, the
  note and link counts, a box that finds or names a note, and the stages, unlinked notes and tags
  as buttons that pick their notes out on the graph. Under it, the pinned notes as cards. Past
  eight pinned notes or twelve tags, the heading counts them all and Show all lists the rest. A
  picked note opens in the Garden view through the package's storage (`handover.mjs`).
- **Garden view** (`gd.garden`, an `extensionView`): the notes as a tree beside one note, in View
  or Edit (Ctrl E, declared in Nendo's row). Edit is the Markdown with its preview beside it; the
  divider drags or moves with the arrow keys, and at the right edge folds the preview away.
  Narrow, Medium or Full sets the page's width. A branch folds with its arrow or Left and Right;
  the tree's edge drags too.
- **Garden guide**, a sheet beside the page: the garden by stage with its counts, a seed to grow
  next, a note to link up, and topics that open in place.
- **Graph screen** (`extensionGraphSurface` over `gd.link`): the whole garden as a d3 graph.
- **Agenda** (`gd.task.agenda`, an `extensionRecordsSurface` leading the tasks' screens): open
  tasks by due date (Overdue, Today, This week to Sunday, Later, No date), each with its box and
  note (`agenda.mjs`, `agenda.js`). Ticking a body task writes `- [x]` into its line and the task
  in one `records.batch`; a task added by hand ticks its record alone. Undo (`records.undo`, Ctrl
  Z) is offered under the heading. A ticked task stays until the screen starts again.
- **Tend** (`gd.note.tend`, an `extensionRecordsSurface` after the Tree): seeds and growing notes
  not tended within 1 week, 2 weeks (default), 1 month or 3 months, longest waiting first, and
  notes not written yet (`tend.mjs`, `tend.js`). Daily and evergreen notes are never listed.
  Tended today, Mark growing and Mark evergreen write what the commands of those names write, as
  one batch. The span is kept in this browser (`garden.tend.span.v1`).
- **Backlinks panel** on a note's record page (`extensionRecordPanel`).
- **Help**: `help/*.md`, eight pages Nendo's Help shows under *About this app*
  ([ADR-0027](../../docs/decisions/0027-a-file-carries-its-own-help.md)). Nothing in them runs.

## Reading

The title is the heading and the body a readable column with its tags as pills. A note with
tasks has a strip under the title (`#task-strip`, `tasks.mjs`): a ring with "2 of 5 tasks done",
the next open task, and Show all with due dates and links to records. Ticking saves at once, as
one batch. Under the text is the local graph (the note and every note one link away), folded
until opened, then any tags written by hand. A wikilink opens its note in place; hovering one
previews it.

## Diagrams

A `mermaid` fence is a diagram. `render.mjs` leaves it as a `figure.diagram` holding its source,
and `diagrams.js` draws it in the page, the Edit preview and the hover preview. Mermaid
(`vendor/mermaid.min.js`, about 3.5 MB) loads the first time a page has a diagram, at its strict
security level, so a diagram binds no clicks or scripts. Its colours are the theme's tokens
resolved to colours; a theme change redraws. Drawings are cached by theme and source; a diagram
being typed is drawn when typing pauses. One that does not parse keeps its source with Mermaid's
reason. An unclosed fence stays code.

## What a save does

The body is the source. A save derives records from it and writes them with the note as one
`records.batch`, which Undo takes back as one step:

- `[[slug]]`, `[[Title]]` or `[[slug|other words]]` becomes a **Link** (`gd.link`, kind Mentions,
  source Body, its line as context). The target is the note of that title, else that slug, case
  not minded. A missing target is planted as a Seed note in the same batch, once however it is
  spelled. Removing the link deletes the row; the seed stays.
- A new note's slug is its title in lower case, letters of any script kept and Latin accents
  dropped (`Заметки о саде` → `заметки-о-саде`, `Café` → `cafe`). A note keeps its slug.
- `#tag` becomes a **Tag** (`gd.tag`, once per file) and a **Note tag**.
- `- [ ] text` (a bullet; `1. [ ]` stays text) becomes a **Task** (`gd.task`, source Checkbox)
  keyed by its text. A repeated line is a second task (key ending `-2`). A line whose words change
  keeps its row and due date, matched by place or words. A task a save deletes is named in the
  status line.
- Rows with source **Manual** are never touched. Nothing is derived inside code.
- A body over 32 KiB is refused in the frame, so an agent can always rewrite the note over MCP.

Drafts live in the view's storage on this device, never in the file, and survive changing
screens and reopening; the tree marks them. Typing during a save stays a draft; Save is off until
the save is answered, and pressing Save again finishes an unanswered save rather than repeating
it, also after a restart. A note changed elsewhere while its draft is dirty blocks Save until Keep
mine or Discard mine; a change that leaves title and body alone moves the draft onto the new
version. Rereading the open note never replaces its draft. An unsaved new note waits at the top
of the tree. Drafts that cannot be kept (past 50, past 2 MiB, or refused by storage) are named
above the note. Save rereads the note's links, tags and tasks and writes nothing when they cannot
be read. Today is the person's calendar day. `[[` in the editor lists notes to link.

## The graph

d3's force simulation lays the notes out. Wheel and background drag zoom and pan; dragging a note
pulls its neighbours; hovering lights its neighbourhood; labels fade in with zoom, never under 12
px and never overlapping; a click opens the note and a right-click offers its neighbourhood. Size
follows the square root of the links; colour is stage, kind or branch (the note just under a
top-level note). Manual links are dashed, tag links dotted. The local graph is coloured by branch
with a legend, stretched to its box rather than zoomed; there and on the Overview the wheel
scrolls the page and Ctrl+wheel or a pinch zooms. Arrows move between notes, Enter opens one, and
a screen reader reads every note with its neighbours as a list.

## In Nendo's toolbar

Where Nendo offers its toolbar the view draws no controls of its own; otherwise it shows them
itself. The Garden view declares Find (Ctrl Shift F), New note (also Nendo's Add), Today, View or
Edit, the width (Narrow, Medium, Full), Save (Ctrl S), Undo, Redo, the Garden guide, and a menu
with Open record page, Graph of the garden and Mark evergreen. Folding the tree to a level is the
view's own Show (1, 2, 3, All). Following a wikilink declares a place, so Back and Forward move
between notes. The Graph screen declares Find, Colour by stage, kind or branch, Tags, Orphans,
Arrows, Spread, zoom, Fit (Ctrl 0) and About.

## What it reads

Everything goes through `window.nendo`: `records.queryAll`, `records.get`, `records.query` with
`eq` filters, `records.search` for Find ([ADR-0028](../../docs/decisions/0028-full-text-search-in-the-file.md); the view matches
title, slug and body itself until it answers, and highlights hits with the CSS Custom Highlight
API), `records.batch`, `records.undo`, `records.redo`, `commands.run`, `schema.describe`,
`ui.openRecord`, `ui.openScreen`, `ui.setToolbar`, `ui.showMenu`, `ui.setPlace`, `ui.setHeight`
on a record page, and the `changes`, `context`, `command` and `place` events. Every method beyond
the reads is used only where `nendo.has` says it exists. Colours are the theme's tokens.

## Files

`nendo-package.json`, `index.html`, `garden.js` (picks the place), `garden.css`, and:

- screens: `workspace.js` (Garden view), `home.js` and `home-data.mjs` (Overview),
  `graphscreen.js` (Graph screen), `agenda.js` and `agenda.mjs` (Agenda), `tend.js` and
  `tend.mjs` (Tend), `panel.js` (Backlinks panel), `screen.js` (shared by the list screens);
- drawing: `graph.js` (d3) and `graph-data.mjs` (records to nodes and edges);
- the note: `parse.mjs` (links, tags, tasks, slugs, keys), `render.mjs` (Markdown to escaped
  HTML), `diagrams.js` (Mermaid), `sync.mjs` (a save's writes), `related.mjs` (rows under a
  note), `tasks.mjs` (task strip), `drafts.mjs` (drafts and unanswered saves), `search.mjs`
  (Find), `findmarks.mjs` (Find's highlights), `handover.mjs` (Overview to Garden view);
- `help/` (Help pages), `LICENSE.txt`, `kit/nendo-view-kit.js` (a copy of `tools/view-kit/`),
  and `vendor/`: d3 7.9.0 (`d3.min.js`, ISC) and Mermaid 11.17.2 (`mermaid.min.js`, MIT), each
  with its licence file. Mermaid is most of a change set's 4 MiB of new package content, so a new
  garden takes it in a build stage of its own (`diagrams`).

`README.md` is not packed. Refresh `vendor/` with:

```bash
npm.cmd ci --prefix tools/garden
node tools/garden/bundle.mjs
```

Not in scope: vault import, transclusion, tables, footnotes, a rich editor, attachments, dragging
in the tree (the Tree screen reorders).

## Tests

- `npm.cmd test --prefix tools/garden` (or `node --test tools/garden/*.test.mjs`): the pure
  modules and the file's definition.
- `pwsh ./tools/Review-Garden.ps1`: serves this folder and the fixture broker on separate origins
  with the real `api.js` between them and drives the graph with a real pointer. It is run by hand; `Test-Production.ps1` does not run it.
