# Garden

W-174 builds a garden of notes as a Nendo app: what Obsidian does (Markdown notes,
`[[wikilinks]]`, backlinks, tags, daily notes, a graph), reimagined on Nendo and for
agents. The owner asked for it on 2026-10-06. It stays within ADR-0013 (a custom view
carries its code in the file), ADR-0019 (a declared hierarchy), ADR-0020 (unique fields),
ADR-0022 (a new file of the application keeps its seed notes) and ADR-0024 (the file
carries its own agent skill). No host change is required.

## What is different from a vault of files

- **Links, tags and tasks are records.** A `[[wikilink]]` in a note's body becomes a
  `gd.link` row (from, to, kind, the sentence as context), a `#tag` a `gd.tag` and a
  `gd.noteTag` row, and a `- [ ]` line a `gd.task` row, when the note is saved in the Garden
  view. Every native screen, calculation, the graph and an agent's query read them; nobody
  parses text to learn who links where. Rows a person or an agent writes by hand carry the
  source *Manual* and a kind the body cannot say (Supports, Contradicts, See also, Part of);
  a save never touches them.
- **Notes nest.** `gd.note.parent` and `gd.note.order` are the type's declared hierarchy, so
  the Tree screen is the outline and `gd.note.path` and `gd.note.beneath` are calculations.
  There are no folders.
- **A note has a stage**: Seed, Growing, Evergreen. A wikilink to a note that is not there
  yet plants a Seed in the same batch, so `gd.link.to` stays required and the Overview
  counts what waits to grow. `gd.note.isOrphan` is a calculation over the link counts.
- **Daily notes** carry a date and the kind Daily; they sit on a calendar, and Today in the
  view plants one from the Template note.
- **Agents** read the file's own skill, `dev.nendo.garden`, address a note by its unique slug,
  read `gd.note.summary` instead of a body, and ask the file for backlinks and counts.

## Reading first, and a living graph

The owner asked on 2026-10-06 for the page to be for reading, with a switch to edit, and for
the graph to be dynamic and interactive, drawn with a common library as Obsidian's is.

- **Two modes, View and Edit.** A note opens in View: the title is the page heading and the
  editor is out of sight. Edit (Ctrl E toggles; both are one segmented control in Nendo's row)
  swaps the page for its Markdown with the preview beside it, filling the whole view. The
  divider between them drags, moves five points with the arrow keys, folds the preview away at
  the right edge (End) and shares the width evenly on a double-click. New note and Today open
  in Edit.
- **Width in three levels**: Narrow (760 px), Medium (1,120 px) and Full, three icon toggles
  in Nendo's row (`widthNarrow`, `widthMedium`, `widthFull`, added to Nendo's icon set for
  this; on an older Nendo, which refuses them, a choice of words), applied to the page in both
  modes. Where the divider and the width sit is this
  person's, so it stays in this browser rather than in the file.
- **The tree folds, and its edge drags** (owner, 2026-10-06, as gardens grow). A note with notes
  under it carries an arrow; a click on the arrow folds the branch away and opens nothing, and
  Right and Left unfold, step in, step up and fold. A folded branch is not drawn, so the keys and
  the rows only meet what shows. Find shows every branch holding a match, folded or not, and searches what the notes say
  through the file's search index (ADR-0028, Garden 0.9.0): a found note is in bold in the tree, and
  in the open note the words are highlighted, in the reading view and preview with the CSS Custom
  Highlight API and in the editor on a layer behind the textarea laid out as the textarea lays out
  its text (Garden 0.9.1); opening a found note starts the page at the first of them. Until the index answers, and in a file without
  one, the view matches titles, slugs and bodies itself; going to
  a note unfolds the branches above it, but reading the same note again (a change elsewhere)
  leaves the tree alone. Expand all and Collapse all are in the menu. The line between the tree
  and the page drags (160 px to 60% of the window, at most 720), moves 16 px with the arrow keys
  and resets to 250 px on a double-click. It lies over the sidebar's border, out of the grid, so
  nothing on the page measures it. The folds and the width are this person's and stay in this
  browser.
- **Help pages in Nendo's Help** (owner, 2026-10-06: the help meant was Nendo's own Help page,
  and *About this app* should come first). The package carries `help/01-welcome.md` to
  `help/08-working-with-an-agent.md`, which Help lists first under *About this app*, itself
  first in the index, and opens on (ADR-0027). They say what the in-view guide says at more
  length, with tables of what Markdown becomes, the screens, the graph's controls, the keys and
  things to ask an agent. The in-view guide points at them.
- **The Garden guide** (owner, 2026-10-06: more elaborate and more exciting) replaces the one
  paragraph About. It is a sheet at the right, beside the page rather than over it, opened by an
  info toggle in Nendo's row (or the view's own Guide button, or from the empty page), and closed
  by Esc or its close button, which hand focus back. It opens on a drawing that is the chart of
  this garden (owner, 2026-10-07: the first guide was simplistic and childish, but the animation
  good; direction C of six, W-177): a seed, a sprout and an evergreen joined by a link grow as it
  opens, in the stage tones, each with its count of notes under it, and a stage with no notes is
  a dashed outline. Under it one ruled row of notes, links, tags and unlinked notes, then the two
  ways in, the seed most linked to and a note with no links, each name opening its note, beside
  Graph and New note. Then how the garden works, as topics that open in place one at a time: four
  first moves; a table of what Markdown becomes on save; the life of a note; finding your way
  (folding, both dividers, width, previews, Find); the keys; and agents. The drawing stands still
  under reduced motion.
- **Flush with Nendo.** The view is drawn on Nendo's own surface colour from edge to edge, with
  no paper-coloured margin, and in Edit the title, editor and preview are unboxed and meet the
  view's edges, divided by lines. The sheet is 100% wide and capped, never sized by its
  content: an auto-margined box in a flex column shrinks to fit, which is how a wide window
  once showed the editor in a column with blank margins.
  Ticking a task while reading writes the tick into the body and saves at once, as one batch.
  Hovering a wikilink previews the note it names: its summary, or the start of its body.
- **The graph is d3.** `vendor/d3.min.js` is d3 7.9.0, pinned in `tools/garden/package.json`
  and copied with its licences by `tools/garden/bundle.mjs` (ISC; the notices of every module
  it was built from are in `vendor/THIRD-PARTY-NOTICES.txt`). A force simulation lays the
  notes out (links, many-body repulsion, a pull to the centre, and collision that leaves room
  for a label). The wheel and a drag on the background zoom and pan, a drag on a note moves it
  and the rest follow, hovering a note lights it and its neighbours and dims the rest, labels
  fade in as you zoom, and a click opens the note. Nodes grow with the square root of their
  links and take their stage's tone, their kind's, or their branch's: the note just under a
  top-level note on their way up, so each section of the garden has a tone of its own (owner,
  2026-10-07: a garden of Evergreen notes was one green). The tones go round in the order the
  tree shows the branches; a top-level note is grey.
- **Two places draw it.** The Graph screen (`gd.note.graph`, an `extensionGraphSurface` that
  now runs the Garden package) shows the whole garden, with Find, colour by stage, kind or branch,
  tag dots, orphans, arrows, spread and fit in Nendo's row, the tags to highlight by beside it; a right-click shows a note's
  neighbourhood. The **local graph** under a note while reading shows it and every note one
  link away, coloured by branch with a legend of the branches it shows. It is stretched to its box, each
  axis on its own, rather than zoomed, so a wide box is used across its width while the dots
  (smaller here, 4 to 9 px) and names keep the page's size; it frames itself again when the
  layout settles, until the person zooms or drags. It is seen almost settled (owner, 2026-10-07:
  it took long to settle and then snapped to the centre): d3's own `simulation.tick` runs the
  layout out of sight down to alpha 0.15 and it is framed there, and it counts as settled at
  alpha 0.02 (`alphaMin`) rather than 0.001. The lane measured a note travelling 391 px from
  the first frame and still moving after two seconds before, 21 px and still after. The Graph
  screen settles the same way (owner, 2026-10-07): framed when it is first seen and again when it
  settles, unless the person has zoomed, panned or dragged; 136 px and still moving before, 26 px
  and still after. It is
  folded away until opened (owner, 2026-10-07: in a dense garden the graph needs more room, and
  the rows of links in and out said again what the page and the graph say), and opened it takes
  the page's width and 360 to 680 px of height. A folded graph is not drawn; whether it is open
  is this person's and stays in this browser. Under it are only the tags written by hand (the
  body's tags are pills in the text, so a second list of them was the same thing twice) and the
  tasks, each card only when the note has some. The Dependency graph package the Graph screen ran before is taken out of the file.
- **A dense garden on the Graph screen** (owner, 2026-10-07: a hundred notes were big dots under a
  mesh of names and lines). Dots are 4 to 11 px in radius rather than 5 to 18; the layout is
  shaped to the window, its axes stretched against each other by at most 2.25 to 1 so a wide
  window draws a wide garden, and framed at most 1.5 times; the most linked tenth of the notes
  (at least five) keep their names at any zoom, the rest fade in from 1.1; a garden of more than
  150 links draws them light. It opens coloured by branch when the garden has a tree, with a
  legend of what the colours mean in its lower left corner. The lane draws 102 notes and 576
  links and measures the drawing centred, wider than tall, inside the screen, its dots and its
  named notes.
- **Highlight by tag** (owner, 2026-10-07: click the tags to highlight their notes; what if a note
  has several?). A highlight is membership, not colour, so a note with several tags is never in
  doubt: it is picked out when what is chosen asks for one of its tags, and keeps its branch's
  colour. A panel beside the Graph screen lists every tag with the notes that carry it, the most
  carried first, an order that stays put while the person clicks. Two tags or more ask for all of
  them, so each click narrows, with **Any of them** a click away; while narrowing, each other tag
  counts the highlighted notes that carry it and a tag that would leave nothing is greyed, so a
  dead end is seen before it is clicked, and an empty result says so and offers Any. A colour in
  the legend is a button too and narrows the same way (a colour and tags: the notes that are
  both), and Find narrows it as well. The camera does not move: picking out is a question asked of
  the layout the person already knows. The picked notes keep their names and the links among them,
  the rest fade; hovering a note shows its own neighbourhood over the highlight. A click on a tag
  dot picks its tag (opening it moved to the right-click menu), Esc and **Clear the highlight**
  end it, and the panel hides behind a **Tags** button, kept per browser and closed by default
  under 900 px. The toggle that draws tags as dots is called **Tag dots**, so it is not taken for
  the panel.
- **Why SVG and not a canvas.** The node count of a personal garden stays in the hundreds,
  where SVG keeps up; SVG lets the theme colour every mark through CSS, lets the keyboard
  traverse the nodes with the view kit, and lets the lane measure what it draws.

## The file

`workspace/Garden.nendo`, built by `tools/Build-Garden.mjs` from `tools/garden/definition.mjs`,
one change set per stage: `schema`, `colour`, `behaviour`, `notes`, `others`, `garden`
(the Garden package, the Overview `extensionView` the file opens on, the Garden view, and the
Backlinks `extensionRecordPanel`), `graph` (the Graph screen over `gd.link`, run by the same package),
`skill`, `seed` and `keep`. The builder finds the file by name in the host's discovery folder, refuses a
development planner and a non-empty file, keeps every stage under 128 operations and every
mutation under 16, and accepts its own proposal only at Unattended. `compare` reads the file
back: every stage applied, the Garden package identical to the folder and the skill present,
the retired Dependency graph absent, the seeds kept for a new garden, and a backlink count
alive. `upgrade` brings a built file up to the folder in one change set: only the package files
that differ, each naming the content it replaces, and, for a file built before the d3 graph,
the Graph screen moved onto the Garden package and the Dependency graph package removed.

The seed notes (Start here, How links work, Daily notes, Tags and tasks, For agents, Daily note
template) are kept in new files, so *File → New garden…* opens with the guide. Their links,
tags and tasks are derived by the same `parse.mjs` and `sync.mjs` the view uses, so the seed
cannot disagree with the parser.

## Choices

- **The Overview is a view, led by the graph** (W-179, 0.16.0). The native front page of tiles
  and lists said the garden in rows of text; the owner asked for a page that draws people in, and
  chose the graph-first direction from six. A native overview cannot draw the graph, so the
  Overview is a view of the file in the Garden package (`gd.home`), listed before the Garden view
  and opening the file; `upgrade` removes the native `gd.front` and moves `opensFile` from the
  Garden view to it. Its graph is coloured by stage, as the buttons beside it that pick a stage
  out. A note picked there opens in the Garden view rather than on its record page: a view cannot
  set another view's place, so the request goes through the package's own storage, which both
  frames share because they share the package's origin, taken once and only within 15 seconds.
  Use lists the views of the file, then the record types; a test refuses two entries with one
  name.

- **No triggers.** Calculations give every count. A trigger would put the file behind device
  behaviour consent and refuse an agent's writes until approved.
- **A body is at most 32 KiB.** The MCP adapter bounds one value there; the view refuses a
  longer body so every note stays rewritable by an agent.
- **Derived rows have random IDs; tags and seeds readable ones.** A deleted record ID stays
  reserved (ADR-0023), so a link removed and written again cannot reuse an ID; sync matches
  links by (from, to), note tags by (note, tag) and tasks by the key of their text. Tags are
  never deleted by a save.
- **Required `slug`, `pinned` and `done`.** A `FilteredCount` errors on a null member, and the
  Overview and the Garden view read `pinned` as true or false; the view, the seeds and the skill always write
  them. Nendo's own Add form asks for a slug; the view and agents generate one.
- **The view never asks with a dialog.** A draft left behind when the person moves to
  another note is kept in the view and marked in the tree, because a modal blocks the
  measurement lane and a dialog is the wrong answer to "I clicked the wrong note".
  Drafts are also kept in the view's own storage (`drafts.mjs`), because Nendo ends a view
  when the person goes to another screen: they come back when the view starts again
  (review R-001). One save at a time, with what it sends fixed when it starts, so typing
  during a save stays a draft (R-005); an unanswered save goes again under its `writeKey`
  (R-011).
- **Own Markdown renderer.** The Workbench's `markdown.ts` cannot be loaded by a package and
  knows no wikilinks. Tables, footnotes, embeds and images are out of scope.
- **The in-host check is owner-reported.** `tools/Review-FileView.mjs` needs the C# journey's
  isolated profile and probe packages; the lane measures the view against the fixture broker.

## Acceptance

- `node --test tools/garden/*.test.mjs tools/view-kit/kit.test.mjs`: the parser skips code,
  tags and tasks keep their keys, the renderer never passes markup, sync plants stubs, keeps
  Manual rows, diffs tasks by key, carries target versions only for existing targets and
  refuses a body over 32 KiB or a save over 200 writes; an excerpt is cut between words; the
  graph keeps one edge per direction and no self-links and walks a focus either way along a
  link; every field a screen names exists, one view opens the file, the graph screen runs the
  Garden package, the seeds say what their bodies say, the kit copy is the kit.
- `pwsh ./tools/Review-Garden.ps1` (in `Test-Production.ps1`): mount with Nendo's toolbar
  accepted by the Workbench's own rules; a note opening for reading in a readable column; the
  local graph folded and undrawn until opened, then drawing the note and its neighbours across the page's width and kept open; no link rows and no second list of the body's tags under the note; a hover previewing a linked note; a tick
  while reading saved as one batch; wikilink navigation with places, Edit swapping in the
  Markdown, `[[` autocomplete,
  one-batch save deriving a stub, a link with context, a tag and a task, link removal keeping
  Manual rows, checkbox done by key, undo, a refused save keeping the draft, an external change
  blocking a save, typing during a slow save kept as a draft, a double Save writing once, the
  last note opened winning, an unanswered save kept once, two drafts surviving a restart, a 32 KiB body refused, Light and Dark measured,
  the tree folding under a real pointer and the keys, kept, and unfolded by going to a note inside it;
  the tree's edge dragged 150 px with a real pointer to 400 px, moved by the keys and reset by a
  double-click; the guide opening from Nendo's row with focus on it, counting the garden, each stage's
  count under its plant and an empty stage drawn as an outline, the other numbers one row, Keys opening
  in place under a real pointer and closing Start, drawn in the theme's tokens in Light and Dark,
  closing on Esc and planting a note from New note; the Backlinks panel opening
  its source once; on the Graph screen, with a real pointer, every note and one edge per linked
  pair, a spread layout, hover dimming all but the neighbours, a drag that moves a note and
  opens nothing, the wheel zooming, a click opening a note once, Find, tags as nodes and the
  stage tones in both themes; the narrow layout; and Find on a fixture broker that offers
  `records.search`: a word only one body holds marks that note alone in the tree, opened it is highlighted in
  the reading view, in the preview and behind the editor (with the layer's font, padding and width
  measured against the textarea's), an empty Find clears every mark, and
  with the search refused for want of an index the view still finds it in the bodies.
- `node tools/Build-Garden.mjs` then `compare` against `workspace/Garden.nendo`;
  `Test-Repository.ps1` and `Test-Production.ps1 -SkipRestore`.
- The Overview, on the fixture broker with `ui.openScreen` offered: the graph at the top, the
  largest thing on the page, at least 55% of its width and 380 px tall, every note and linked
  pair inside it and each dot its stage's colour; the counts beside it; no table; Evergreen
  picks out exactly its notes under a real pointer and Esc lets them go; the cards carry a title
  and a line; Find lists How links work first and offers a new note only for a title no note
  has; a card hands its note to the Garden view, opens that screen and not the record page, and
  the Garden view started next opens that note and clears the request; the theme's tokens in
  Light and Dark; at 700 px the side stacks over a full-width graph with no sideways scroll.
- Owner-reported: the file opens on the Overview in the installed host.

## Build and handoff

Source: `extensions/garden/` (the package; `vendor/` from `tools/garden/bundle.mjs`) and `tools/garden-skill/` (the skill);
definition, builder and lane: `tools/garden/`, `tools/Build-Garden.mjs`,
`tools/Review-Garden.ps1`, `tools/Gate-Garden.mjs`. Exact commands, outcomes and remaining
owner actions are on W-174 and its Checks. Screenshots under `artifacts/garden/` are scratch.
