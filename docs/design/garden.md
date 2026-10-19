# Garden

A garden of notes as a Nendo app: Markdown notes, `[[wikilinks]]`, backlinks, tags, daily notes
and a graph, built on Nendo and for agents. `workspace/Garden.nendo` carries the app and
`extensions/garden/` is its view. It stays within ADR-0013 (a custom view carries its code in the
file), ADR-0019 (a declared hierarchy), ADR-0020 (unique fields), ADR-0022 (a new file keeps its
seed notes) and ADR-0024 (the file carries its own agent skill). It needs no host change.

## What is different from a vault of files

- **Links, tags and tasks are records.** When the Garden view saves a note, a `[[wikilink]]` in its
  body becomes a `gd.link` row (from, to, kind, the line it is on as context), a `#tag` a `gd.tag`
  and a `gd.noteTag` row, and a `- [ ]` line a `gd.task` row. Screens, calculations, the graph and
  agents read them; nobody parses text to learn who links where. Rows written by hand carry the
  source *Manual* and a kind the body cannot say (Supports, Contradicts, See also, Part of); a save
  never touches them.
- **Notes nest.** `gd.note.parent` and `gd.note.order` are the type's declared hierarchy, so the
  Tree screen is the outline and `gd.note.path` and `gd.note.beneath` are calculations. There are
  no folders.
- **A note has a stage**: Seed, Growing, Evergreen. A wikilink to a note that does not exist plants
  a Seed in the same batch, so `gd.link.to` stays required. `gd.note.isOrphan` is a calculation
  over the link counts.
- **Daily notes** carry a date and the kind Daily; they sit on a calendar, and Today in the view
  plants one from the Template note.
- **Agents** read the file's own skill, `dev.nendo.garden`, address a note by its unique slug, read
  `gd.note.summary` instead of a body, and ask the file for backlinks and counts.

## Screens

Use lists the views of the file, then the record types: Overview, Garden, Notes and Tasks. Links,
Note tags and Tags have no screen (their record pages stay), so the host keeps them out of the
navigation (semantic-surfaces.md). A test refuses two Use entries with one name. The Garden view's
icon is a sprout and the Overview's a house.

- **Overview** (`gd.home`), a view of the package and the screen the file opens on. The graph leads,
  coloured by stage, with buttons that pick a stage out; beside it the counts, the tags under the
  stages, and the pinned notes as the only cards. A note picked there opens in the Garden view: a
  view cannot set another view's place, so the request goes through the package's own storage,
  which both frames share, taken once and only within 15 seconds.
- **Garden**, the note view described below.
- **Agenda** groups tasks by when they are due and ticks a body task in its note as well as on its
  record, since a tick on the record alone would be undone by the next save.
- **Tend** lists the notes that want a gardener.
- **Graph** (`gd.note.graph`, an `extensionGraphSurface` over `gd.link` run by the Garden package).
- **Backlinks**, an `extensionRecordPanel` on a note's record page.

The Overview, Agenda and Tend are views rather than native screens, because a native screen cannot
draw the graph, group by a date relative to today, write a note's line with its task, or open a
note in the Garden view.

## The Garden view

- **View and Edit.** A note opens in View: the title is the page heading and the editor is out of
  sight. Edit (Ctrl E; one segmented control in Nendo's row) swaps the page for its Markdown with
  the preview beside it, filling the view. The divider drags, moves five points with the arrow
  keys, folds the preview away at the right edge (End) and shares the width evenly on a
  double-click. New note and Today open in Edit.
- **Width**: Narrow (760 px), Medium (1,120 px) and Full, three icon toggles in Nendo's row
  (`widthNarrow`, `widthMedium`, `widthFull`; a host that refuses them gets words), in both modes.
- **Flush with Nendo.** The view is drawn on Nendo's surface colour edge to edge. In Edit the
  title, editor and preview are unboxed, divided by lines. The sheet is 100% wide and capped, never
  sized by its content.
- **Reading.** Ticking a task while reading writes the tick into the body and saves at once, as
  one batch. Hovering a wikilink previews the note it names: its summary, or the start of its body.
- **Tasks strip.** A note's tasks are in a grey strip between its meta row and its text: a progress
  ring, "N of M tasks done", the next open task with its box, and Show all for every task with its
  due date and a way to its record. Hidden when the note has none. A body task ticks its line; a
  task added by hand ticks its record. The boxes are drawn from the theme's tokens.
- **Local graph** under a note: the note and every note one link away, coloured by branch with a
  legend. Folded until opened, and not drawn while folded; open, it takes the page's width and 360
  to 680 px of height. It is stretched to its box, each axis on its own, with 4 to 9 px dots and
  names at the page's size, and frames itself again when the layout settles until the person zooms
  or drags. Under it are only the tags written by hand, when the note has some.
- **Tree.** A note with notes under it carries an arrow; a click on it folds the branch and opens
  nothing. Right and Left unfold, step in, step up and fold. A folded branch is not drawn. Going to
  a note unfolds the branches above it; reading the same note again leaves the tree alone. **Show**
  above the tree folds it to a level: 1 folds every branch, All none, 2 and 3 unfold that many
  levels. A fold by hand, or an unfold by going to a note, releases the level; the last level
  picked is kept. Show is disabled while Find unfolds what it found and hidden when no note has
  notes under it. The tree's edge drags (160 px to 60% of the window, at most 720), moves 16 px
  with the arrow keys and resets to 250 px on a double-click; it lies over the sidebar's border,
  out of the grid.
- **Find** shows every branch holding a match, folded or not, and searches the notes' text
  through the file's search index (ADR-0028). A found note is bold in the tree; in the open note
  the words are highlighted, in the reading view and preview with the CSS Custom Highlight API and
  in the editor on a layer behind the textarea laid out as the textarea lays out its text. Opening
  a found note starts at the first of them. Without an index the view matches titles, slugs and
  bodies itself.
- **Kept per browser, not in the file**: the divider, the width, the folds, the tree's width,
  whether the local graph is open, and the Tags panel.
- **The Garden guide** is a sheet at the right, beside the page, opened by an info toggle in
  Nendo's row, the view's Guide button or the empty page, and closed by Esc or its close button,
  which hand focus back. It opens on a chart of this garden: a seed, a sprout and an evergreen
  joined by a link grow in the stage tones, each with its count of notes, and a stage with no notes
  is a dashed outline. Under it one ruled row of notes, links, tags and unlinked notes; the seed
  most linked to and a note with no links; Graph and New note. Then topics that open in place one
  at a time: first moves, what Markdown becomes on save, the life of a note, finding your way, the
  keys, and agents. The drawing stands still under reduced motion.
- **Help.** The package carries `help/01-welcome.md` to `help/08-working-with-an-agent.md`, which
  Nendo's Help lists first under *About this app* and opens on (ADR-0027). The guide points at them.

## The graph

- **d3.** `vendor/d3.min.js` is d3 7.9.0, pinned in `tools/garden/package.json` and copied with its
  licences by `tools/garden/bundle.mjs` (ISC; notices in `vendor/THIRD-PARTY-NOTICES.txt`). A force
  simulation lays the notes out: links, many-body repulsion, a pull to the centre, and collision
  that leaves room for a label. It is drawn in SVG: a personal garden stays in the hundreds of
  notes, and SVG lets the theme colour every mark, the keyboard traverse the nodes and the lane
  measure what it draws.
- **Interaction.** On the Graph screen the wheel and a background drag zoom and pan; inside a note
  and on the Overview only Ctrl+wheel or a pinch zooms, so the wheel scrolls the page. A drag on a
  note moves it and the rest follow; hover lights a note and its neighbours and dims the rest;
  labels fade in with zoom; a click opens the note; a right-click shows its neighbourhood.
- **Colour.** Nodes grow with the square root of their links and take their stage's tone, their
  kind's, or their branch's: the note just under a top-level note on their way up, the tones going
  round in tree order; a top-level note is grey. The Graph screen opens by branch when the garden
  has a tree, with a legend in its lower left corner.
- **Settling.** `simulation.tick` runs the layout out of sight down to alpha 0.15, where it is
  framed, and it counts as settled at alpha 0.02 (`alphaMin`). It frames again when it settles
  unless the person has zoomed, panned or dragged.
- **A dense garden.** Dots are 4 to 11 px in radius. The layout is shaped to the window, its axes
  stretched against each other by at most 2.25 to 1, and framed at most 1.5 times. The most linked
  tenth of the notes (at least five) keep their names at any zoom; the rest fade in from 1.1. Over
  150 links are drawn light.
- **Graph screen controls** in Nendo's row: Find, colour by stage, kind or branch, Tag dots,
  orphans, arrows, spread and fit.
- **Highlight by tag.** A highlight is membership, not colour: a note is picked out when the choice
  asks for one of its tags, and keeps its branch's colour. The Tags panel lists every tag with its
  notes, most carried first, in an order that stays put. Two tags or more ask for all of them, with
  **Any of them** a click away; while narrowing, each other tag counts the highlighted notes that
  carry it, a tag that would leave nothing is greyed, and an empty result says so and offers Any. A
  legend colour is a button and narrows the same way; Find narrows it as well. The camera does not
  move. Picked notes keep their names and their links, the rest fade; hover shows a note's own
  neighbourhood over the highlight. A click on a tag dot picks its tag (opening it is on the
  right-click menu); Esc and **Clear the highlight** end it. The panel hides behind a **Tags**
  button, closed by default under 900 px.

## Rules

- **No triggers.** Calculations give every count. A trigger would put the file behind device
  behaviour consent and refuse an agent's writes until approved.
- **A body is at most 32 KiB**, the MCP adapter's bound on one value; the view refuses a longer
  body so every note stays rewritable by an agent. A save is at most 200 writes.
- **Derived rows have random IDs, with a readable prefix.** A deleted record ID stays reserved
  (ADR-0023), and two names can make one slug (`#café` and `#cafe`), so tags made by a save take a
  random suffix too. Sync matches links by (from, to), note tags by (note, tag) and tasks by the
  key of their text, a second line with the same text keyed `-2`; a line whose words changed keeps
  its row by its place in the body or by its words, so its due date stays. A save never deletes a
  tag, and `gd.tag.name` is unique, so a stale list of tags is refused rather than duplicated.
- **Required `slug`, `pinned` and `done`.** A `FilteredCount` errors on a null member, and the
  Overview and the Garden view read `pinned` as true or false. Nendo's Add form asks for a slug;
  the view and agents generate one.
- **The view never asks with a dialog.** A draft left behind when the person moves to another note
  is kept and marked in the tree. Drafts are also kept in the view's own storage (`drafts.mjs`),
  because Nendo ends a view when the person leaves the screen; they come back when it starts again.
  One save at a time, with what it sends fixed when it starts, so typing during a save stays a
  draft. An unanswered save goes again under its `writeKey`, and is kept in storage so it does
  after a restart too. Reading the open note again keeps its draft, a new unsaved note waits in the
  tree, and a draft this device cannot keep is named with a way to it. A change elsewhere is the
  person's choice, Keep mine or Discard mine, never a silent reload. Save reads the note's derived
  rows afresh and writes nothing over rows it could not read.
- **Own Markdown renderer.** The Workbench's `markdown.ts` cannot be loaded by a package and knows
  no wikilinks. Tables, footnotes, embeds and images are out of scope.
- **Mermaid draws a `mermaid` fence.** Mermaid 11.17.2 is vendored whole (about 3.5 MB) and loads
  only when a page has a diagram. It runs in the view's frame under ADR-0013 at Mermaid's strict
  security level and takes its colours from the theme's tokens. Mermaid pulls in KaTeX, for which
  npm reports a low-severity prototype-pollution advisory with no fix inside Mermaid 11.

## The file

`tools/Build-Garden.mjs` builds `workspace/Garden.nendo` from `tools/garden/definition.mjs`, one
change set per stage: `schema`, `colour`, `behaviour`, `notes`, `others`, `garden` (the package,
the Overview view the file opens on, the Garden view, the Backlinks panel, and the Agenda and Tend
screens), `diagrams` (Mermaid, most of a change set's 4 MiB on its own), `graph`, `skill`, `seed`
and `keep`. The builder finds the file by name in the host's discovery folder, refuses a
development planner and a non-empty file, keeps every stage under 128 operations and every
mutation under 16, and accepts its own proposal only at Unattended.

- `compare` reads the file back: every stage applied, the Garden package identical to the folder,
  the skill present, the retired Dependency graph package and the old list screens absent, the
  seeds kept for a new garden, and a backlink count alive.
- `upgrade` brings a built file up to the folder in one change set: the package files that differ,
  each naming the content it replaces, the skill, the Overview in place of a native front page,
  the Agenda and Tend in place of the old lists, and the search index when the file has none.

The seed notes (Start here, How links work, Daily notes, Tags and tasks, For agents, Daily note
template) are kept in new files, so *File → New garden…* opens with the guide. Their links, tags
and tasks are derived by the same `parse.mjs` and `sync.mjs` the view uses.

## Checks

- `node --test tools/garden/*.test.mjs tools/view-kit/kit.test.mjs`: the parser, renderer, sync,
  excerpts and graph data, and the definition (every field a screen names exists, one view opens
  the file, the graph screen runs the Garden package, the seeds say what their bodies say, the kit
  copy is the kit).
- `pwsh ./tools/Review-Garden.ps1` (`tools/Gate-Garden.mjs`, run by hand; not in `Test-Production.ps1`) drives the
  view, the Overview, the guide, the Graph screen and Find against the fixture broker, with a real
  pointer, in Light and Dark and at a narrow width.
- `node tools/Build-Garden.mjs compare` against `workspace/Garden.nendo`.
- The in-host check is owner-reported: `tools/Review-FileView.mjs` needs the C# journey's isolated
  profile and probe packages.

Source: `extensions/garden/` (the package; `vendor/` from `tools/garden/bundle.mjs`) and
`tools/garden-skill/` (the skill); definition, builder and lane under `tools/garden/`,
`tools/Build-Garden.mjs`, `tools/Review-Garden.ps1` and `tools/Gate-Garden.mjs`.
