# Garden

A custom view for a garden of notes, in four places:

- **The Overview**, the screen `workspace/Garden.nendo` opens on (`gd.home`, an `extensionView`
  with `opensFile`): the garden's graph leads it, coloured by stage, beside the number of notes
  and links, a box that finds a note or names a new one, the stages, the unlinked notes and the
  tags, each a button that picks its notes out on the graph. Under it, the pinned notes as cards
  with their first line. Past eight pinned notes or twelve tags, the heading counts them all and
  Show all lists the rest. A note picked there opens in the Garden view: the Overview hands it over through the
  package's storage (`handover.mjs`) and opens that screen. It replaced a native front page of
  tiles and lists (0.16.0).
- **The Garden view** (`gd.garden`, an `extensionView`): the notes as a tree on the left and one note in the middle, in View or Edit.
  View is the page; Edit (Ctrl E toggles) is its Markdown with the preview beside it, filling
  the view. Drag the divider between them, or move it with the arrow keys; at the right edge it
  folds the preview away. Narrow, Medium or Full sets the page's width. A note with notes under
  it has an arrow that folds its branch away (Left and Right do the same), and the line between
  the tree and the page drags too.
- **The Garden guide**, a sheet beside the page: a drawing of the garden by stage with its counts,
  the other numbers in one row, a seed to grow next and a note to link up, and topics that open in
  place: four first moves, what Markdown becomes, the life of a note, finding your way, the keys,
  and agents.
- **The Graph screen** (`extensionGraphSurface` over `gd.link`): the whole garden as a living
  d3 graph.
- **The Agenda** (`gd.task.agenda`, an `extensionRecordsSurface` that leads the tasks' screens):
  every open task by when it is due, Overdue, Today, This week (to Sunday), Later and No date, each
  with its box and its note (`agenda.mjs`, `agenda.js`). A tick on a task a note's body says writes
  `- [x]` into that line and the task in one `records.batch`, so the next save keeps it; a task
  added by hand ticks its record alone. The line under the heading says what was done, with Undo
  (`records.undo`, and Ctrl Z). A ticked task stays, ticked, until the screen starts again. The
  note's name opens it in the Garden view, as the Overview does.
- **Tend** (`gd.note.tend`, an `extensionRecordsSurface` after the Tree): seeds and growing notes
  not tended within 1 week, 2 weeks (the start), 1 month or 3 months, the longest waiting first,
  and notes not written yet (`tend.mjs`, `tend.js`). Daily and evergreen notes are never asked for.
  Tended today, Mark growing and Mark evergreen write what the commands of those names write, as
  one batch Undo takes back. The span is kept in this browser (`garden.tend.span.v1`).
- **The Backlinks panel** on a note's record page (`extensionRecordPanel`).
- **Help pages**: `help/*.md`, eight Markdown pages that Nendo's Help shows first under
  *About this app* ([ADR-0027](../../docs/decisions/0027-a-file-carries-its-own-help.md)):
  welcome, writing, growing, finding your way, the graph, daily notes and tasks, keys, and
  working with an agent. Nothing in them runs.

## Reading

The title is the page heading and the body is set in a readable column, its tags pills in the
text. Between the title and the text, a note with tasks has a grey strip (`#task-strip`,
`tasks.mjs`): a ring and "2 of 5 tasks done", the next open task with its box, and Show all for
every task, each with its due date and a way to its record. A body task ticks its line; a task
added by hand ticks its record, as one batch Undo takes back. Under the text is the note's local graph (the note and every note one link away), folded until
opened and then the page's width, then any tags written by hand, when the note has some. The links in are on the Backlinks panel and the Graph screen. A wikilink opens its note in place; hovering one previews
the note it names. Ticking a task saves the tick at once, as one batch.

## Diagrams

A fence whose language is `mermaid` is a diagram. `render.mjs` leaves it as a `figure.diagram`
holding its source as code, and `diagrams.js` draws it with Mermaid in the page, the Edit
preview and the hover preview. Mermaid (`vendor/mermaid.min.js`, about 3.5 MB) loads the first
time a page has a diagram, never with the view. It runs at its strict security level, so its
output passes through its own sanitizer and a diagram binds no clicks or scripts. Its colours
are the theme's tokens resolved to colours, since Mermaid computes shades from them, and a
theme change draws every diagram again. Drawings are cached by theme and source, so typing
elsewhere in a note does not draw a diagram twice; a diagram being typed is drawn when the
typing pauses. One that does not parse keeps its source with Mermaid's reason under it. An
unclosed fence, as at the end of a hover preview, stays code.

## What a save does

The body is the source. When you save, the view derives records from it and writes them
with the note as one `records.batch`, which Undo takes back as one step:

- `[[slug]]`, `[[Title]]` or `[[slug|other words]]` becomes a **Link** (`gd.link`, kind
  Mentions, source Body, the sentence as its context). A target that is not a note yet is
  planted as a Seed note in the same batch. Removing the link deletes the row; the seed stays.
- `#tag` becomes a **Tag** (`gd.tag`, made once for the file) and a **Note tag**.
- `- [ ] text` becomes a **Task** (`gd.task`, source Checkbox) keyed by its text, so ticking
  the box updates the same row. A second line with the same text is a second task (its key ends
  `-2`). A line whose words change keeps its row and due date, matched by its place in the body
  or by its words; a task a save deletes is named in the status line.
- Rows with the source **Manual**, written by hand or by an agent, are never touched.
- Inside a code fence or inline code nothing is derived.
- A body over 32 KiB is refused in the frame, so an agent can always rewrite the note over
  MCP, where one value is bounded there.

A draft left behind when you move to another note is kept and marked in the tree, and it
survives going to another screen of Nendo or reopening the view: drafts wait in the view's own
storage on this device, never in the file, until saved. Typing that arrives while a save is on
its way stays a draft; Save is off until the save is answered, and a save Nendo never answered
is finished, not repeated, by pressing Save again. A note changed elsewhere while a draft is
dirty blocks Save until the person chooses Keep mine or Discard mine; a change that leaves the
title and body alone moves the draft onto the new version. Reading the open note again (its row,
a link to itself, a command) never replaces its draft. A new note not saved yet waits at the top
of the tree, so New note and Today never write over it. Drafts this device cannot keep (past 50,
or 2 MiB, or when storage refuses) are named above the note, each a link to it. A save never
answered is kept in storage too, so Save after a restart sends the same batch; one the file
already holds is recognised as saved. Save reads the note's links, tags and tasks afresh, and
writes nothing when they or the garden cannot be read. Today is your own calendar day. `[[` in the editor
opens a list of notes to link.

## The graph

d3's force simulation lays the notes out. The wheel and a drag on the background zoom and
pan; a drag on a note moves it and its neighbours follow; hovering a note lights it and its
neighbours and dims the rest; labels fade in as you zoom, never smaller than 12 px on the
screen and never over another (the less linked one waits); a click opens the note, and a
right-click offers its neighbourhood. A note's size follows the square root of its links and
its colour is its stage's tone, its kind's, or its branch's (the section of the garden it grows
in: the note just under a top-level note on its way up). Manual links are dashed, tag links dotted.
The local graph under a note is coloured by branch, with a legend of the branches it shows, and
is stretched to its box rather than zoomed, so its dots and names keep the page's size.
The keyboard moves between notes with the arrows and opens one with Enter, and a screen reader
reads every note with its neighbours as a list.

## In Nendo's toolbar

Where Nendo offers its toolbar the view draws no controls of its own. The Garden view declares
Find (Ctrl Shift F), New note (also Nendo's Add), Today, View or Edit, the width as three icons
(Narrow, Medium, Full; words on a Nendo without those icons),
Save (Ctrl S), Undo and Redo, the Garden guide, and a menu with Open record page, Graph of the
garden and Mark evergreen. Folding the tree to a level is the view's own, in Show (1, 2, 3, All) above the tree. Following a wikilink declares a place, so Back and Forward move
between notes. The Graph screen declares Find, Colour by stage, kind or branch, Tags, Orphans,
Arrows, Spread, zoom and Fit (Ctrl 0), and About. On an older Nendo the views show their own
controls.

## What it reads

Everything arrives through `window.nendo`: `records.queryAll` for the notes, the links and the
tags, `records.search` for Find (ADR-0028; the view matches title, slug and body itself until it
answers, and wherever it cannot; the words found are highlighted in the open note with the CSS
Custom Highlight API, and in the editor on a layer behind the textarea), `records.get` for one note, `records.query` with `eq` filters for a note's links, tags
and tasks, `records.batch`, `records.undo` and `records.redo`, `commands.run` for Mark
evergreen, `schema.describe` for the choices' tones, `ui.openRecord`, `ui.openScreen`,
`ui.setToolbar`, `ui.showMenu`, `ui.setPlace`, `ui.setHeight` on a record page, and the
`changes`, `context`, `command` and `place` events. Every method beyond the reads is used only
where `nendo.has` says it exists. Colours are the theme's tokens.

## Files

`index.html`, `garden.js` (picks the place), `workspace.js`, `graphscreen.js`, `panel.js`,
`graph.js` (the d3 drawing), `graph-data.mjs` (records to nodes and edges), `related.mjs` (the
rows under a note), `tasks.mjs` (the strip of a note's tasks), `parse.mjs` (links, tags, tasks, slugs, keys), `render.mjs` (Markdown to
escaped HTML), `diagrams.js` (Mermaid fences to SVG), `sync.mjs` (a save's writes), `garden.css`,
`kit/nendo-view-kit.js` (a copy of `tools/view-kit/`), and `vendor/`: d3 7.9.0 (`d3.min.js`, ISC,
`d3.LICENSE.txt`) and Mermaid 11.17.2 (`mermaid.min.js`, MIT, `mermaid.LICENSE.txt`), with the
notices of the modules they are built from. Mermaid is most of a change set's 4 MiB of new
package content, so a new garden takes it in a build stage of its own (`diagrams`). Refresh
`vendor/` with:

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
