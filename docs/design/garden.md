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
  yet plants a Seed in the same batch, so `gd.link.to` stays required and the front page
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
  the rows only meet what shows. Find shows every branch holding a match, folded or not; going to
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
  by Esc or its close button, which hand focus back. It opens on this garden in numbers (notes,
  links, tags, seeds, lonely notes, a bar by stage) and two ways in: the seed most linked to and a
  note with no links. Then four first moves, two with buttons that do them; a table of what
  Markdown becomes on save; the life of a note; finding your way (folding, both dividers, width,
  previews, Find); the keys; and agents. A small drawing of a seed, a sprout and an evergreen
  joined by a link grows as it opens, in the stage tones, and stands still under reduced motion.
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
  links and take their stage's tone, or their kind's.
- **Two places draw it.** The Graph screen (`gd.note.graph`, an `extensionGraphSurface` that
  now runs the Garden package) shows the whole garden, with Find, colour by stage or kind,
  tags as nodes, orphans, arrows, spread and fit in Nendo's row; a right-click shows a note's
  neighbourhood. The **local graph** under a note while reading shows it and every note one
  link away. The Dependency graph package the Graph screen ran before is taken out of the file.
- **Why SVG and not a canvas.** The node count of a personal garden stays in the hundreds,
  where SVG keeps up; SVG lets the theme colour every mark through CSS, lets the keyboard
  traverse the nodes with the view kit, and lets the lane measure what it draws.

## The file

`workspace/Garden.nendo`, built by `tools/Build-Garden.mjs` from `tools/garden/definition.mjs`,
one change set per stage: `schema`, `colour`, `behaviour`, `notes`, `others`, `front`, `garden`
(the Garden package, the `extensionView` the file opens on, and the Backlinks
`extensionRecordPanel`), `graph` (the Graph screen over `gd.link`, run by the same package),
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

- **The front page is Overview.** Use lists the front page, then the views of the file, then
  the record types, so the front page cannot share the Garden view's name; a test refuses any
  two entries with one name.

- **No triggers.** Calculations give every count. A trigger would put the file behind device
  behaviour consent and refuse an agent's writes until approved.
- **A body is at most 32 KiB.** The MCP adapter bounds one value there; the view refuses a
  longer body so every note stays rewritable by an agent.
- **Derived rows have random IDs; tags and seeds readable ones.** A deleted record ID stays
  reserved (ADR-0023), so a link removed and written again cannot reuse an ID; sync matches
  links by (from, to), note tags by (note, tag) and tasks by the key of their text. Tags are
  never deleted by a save.
- **Required `slug`, `pinned` and `done`.** A `FilteredCount` errors on a null member and a
  front-page tile filters `pinned eq true`; the view, the seeds and the skill always write
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
  local graph drawing the note and its neighbours; a hover previewing a linked note; a tick
  while reading saved as one batch; wikilink navigation with places, Edit swapping in the
  Markdown, `[[` autocomplete,
  one-batch save deriving a stub, a link with context, a tag and a task, link removal keeping
  Manual rows, checkbox done by key, undo, a refused save keeping the draft, an external change
  blocking a save, typing during a slow save kept as a draft, a double Save writing once, the
  last note opened winning, an unanswered save kept once, two drafts surviving a restart, a 32 KiB body refused, Light and Dark measured,
  the tree folding under a real pointer and the keys, kept, and unfolded by going to a note inside it;
  the tree's edge dragged 150 px with a real pointer to 400 px, moved by the keys and reset by a
  double-click; the guide opening from Nendo's row with focus on it, counting the garden, scrolling to
  Keys from its contents, drawn in the theme's tokens in Light and Dark, closing on Esc and planting
  a note from its first move; the Backlinks panel opening
  its source once; on the Graph screen, with a real pointer, every note and one edge per linked
  pair, a spread layout, hover dimming all but the neighbours, a drag that moves a note and
  opens nothing, the wheel zooming, a click opening a note once, Find, tags as nodes and the
  stage tones in both themes; and the narrow layout.
- `node tools/Build-Garden.mjs` then `compare` against `workspace/Garden.nendo`;
  `Test-Repository.ps1` and `Test-Production.ps1 -SkipRestore`.
- Owner-reported: the file opens on the Garden view in the installed host.

## Build and handoff

Source: `extensions/garden/` (the package; `vendor/` from `tools/garden/bundle.mjs`) and `tools/garden-skill/` (the skill);
definition, builder and lane: `tools/garden/`, `tools/Build-Garden.mjs`,
`tools/Review-Garden.ps1`, `tools/Gate-Garden.mjs`. Exact commands, outcomes and remaining
owner actions are on W-174 and its Checks. Screenshots under `artifacts/garden/` are scratch.
