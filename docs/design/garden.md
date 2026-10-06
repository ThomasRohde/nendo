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

## The file

`workspace/Garden.nendo`, built by `tools/Build-Garden.mjs` from `tools/garden/definition.mjs`,
one change set per stage: `schema`, `colour`, `behaviour`, `notes`, `others`, `front`, `graph`
(the Dependency graph package over `gd.link`), `garden` (the Garden package, the
`extensionView` the file opens on, and the Backlinks `extensionRecordPanel`), `skill`, `seed`
and `keep`. The builder finds the file by name in the host's discovery folder, refuses a
development planner and a non-empty file, keeps every stage under 128 operations and every
mutation under 16, and accepts its own proposal only at Unattended. `compare` reads the file
back: every stage applied, the three packages present, the seeds kept for a new garden, and a
backlink count alive.

The seed notes (Start here, How links work, Daily notes, Tags and tasks, For agents, Daily note
template) are kept in new files, so *File → New garden…* opens with the guide. Their links,
tags and tasks are derived by the same `parse.mjs` and `sync.mjs` the view uses, so the seed
cannot disagree with the parser.

## Choices

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
- **Own Markdown renderer.** The Workbench's `markdown.ts` cannot be loaded by a package and
  knows no wikilinks. Tables, footnotes, embeds and images are out of scope.
- **The in-host check is owner-reported.** `tools/Review-FileView.mjs` needs the C# journey's
  isolated profile and probe packages; the lane measures the view against the fixture broker.

## Acceptance

- `node --test tools/garden/*.test.mjs tools/view-kit/kit.test.mjs`: the parser skips code,
  tags and tasks keep their keys, the renderer never passes markup, sync plants stubs, keeps
  Manual rows, diffs tasks by key, carries target versions only for existing targets and
  refuses a body over 32 KiB or a save over 200 writes; every field a screen names exists,
  one view opens the file, the seeds say what their bodies say, the kit copy is the kit.
- `pwsh ./tools/Review-Garden.ps1` (in `Test-Production.ps1`): mount with Nendo's toolbar
  accepted by the Workbench's own rules, wikilink navigation with places, `[[` autocomplete,
  one-batch save deriving a stub, a link with context, a tag and a task, link removal keeping
  Manual rows, checkbox done by key, undo, a refused save keeping the draft, an external change
  blocking a save, a 32 KiB body refused, Light and Dark measured, the Backlinks panel opening
  its source once, and the narrow layout.
- `node tools/Build-Garden.mjs` then `compare` against `workspace/Garden.nendo`;
  `Test-Repository.ps1` and `Test-Production.ps1 -SkipRestore`.
- Owner-reported: the file opens on the Garden view in the installed host.

## Build and handoff

Source: `extensions/garden/` (the package) and `tools/garden-skill/` (the skill);
definition, builder and lane: `tools/garden/`, `tools/Build-Garden.mjs`,
`tools/Review-Garden.ps1`, `tools/Gate-Garden.mjs`. Exact commands, outcomes and remaining
owner actions are on W-174 and its Checks. Screenshots under `artifacts/garden/` are scratch.
