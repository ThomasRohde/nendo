---
name: garden
description: How to work a Garden of notes - find a note by its slug or title, write Markdown whose [[wikilinks]], #tags and - [ ] tasks the Garden view turns into Link, Note tag and Task records, write such rows by hand as Manual rows, and read backlinks, tags and counts from the file. Use it whenever you read, write, link or summarise notes in this file.
---

# Working a Garden file

This file is a garden of notes. Every note is Markdown, and the file keeps what the notes say
about each other as records of their own, so you ask the file who links where rather than
parsing text. Its application ID is `__APPLICATION_ID__`; if `nendo://application/manifest`
names another, you are connected to another file.

## The record types

| Entity | What it holds |
| --- | --- |
| `gd.note` | A note: `gd.note.title`, `gd.note.slug` (unique, required), `gd.note.body` (Markdown), `gd.note.summary` (a paragraph for you), `gd.note.kind` (Note, Daily, Map, Source, Template), `gd.note.stage` (Seed, Growing, Evergreen), `gd.note.date` (daily notes), `gd.note.touched` (last tended), `gd.note.pinned` (required Boolean), `gd.note.parent` and `gd.note.order` (the tree) |
| `gd.link` | `gd.link.from` mentions `gd.link.to`, with `gd.link.kind` (Mentions, Supports, Contradicts, See also, Part of), `gd.link.context` (the line the link is on) and `gd.link.source` (Body or Manual) |
| `gd.tag` | A tag by `gd.tag.name` (unique, lower-case, no `#`) |
| `gd.noteTag` | `gd.noteTag.note` carries `gd.noteTag.tag`, with a `gd.noteTag.source` |
| `gd.task` | `gd.task.title`, its `gd.task.note`, `gd.task.done` (required Boolean), `gd.task.due`, `gd.task.source` (Checkbox or Manual) and `gd.task.key` |

Calculated on a note: `gd.note.linksOut`, `gd.note.linksIn` (backlinks), `gd.note.isOrphan`,
`gd.note.taskCount`, `gd.note.doneTasks`, `gd.note.openTasks`, `gd.note.tagCount`,
`gd.note.bodyLength`, `gd.note.beneath`, `gd.note.path` and `gd.note.isDaily`; on a tag,
`gd.tag.noteCount`. Read them; never write them.

## Finding a note

One read, never a page through the type:
`nendo://application/entity/gd.note/records?filter=` and the percent-encoded
`[{"fieldId":"gd.note.slug","op":"eq","value":"start-here"}]`. By title use `gd.note.title`
with `eq`. To find notes by what they say, read
`nendo://application/search?q=compost%20worms&entity=gd.note`: every word must be in the note,
in any field, best match first, each hit with the line that matched; a file without a search
index refuses with `NENDO_SEARCH_INDEX_MISSING`, and then `contains` on the title or the body
still works. A note's backlinks are
`gd.link` records where `gd.link.to` `eq` its record ID; its tags are `gd.noteTag` where
`gd.noteTag.note` `eq` it; its tasks `gd.task` where `gd.task.note` `eq` it. A count or a
grouped count is one read of `entity/{entityId}/aggregate`. Prefer `gd.note.summary` to the
body when you only need to know what a note is about, and fill the summary in when you write
a note.

## Writing a note

- Write Markdown in `gd.note.body`. Name another note as `[[its-slug]]` (or `[[Its title]]`,
  or `[[its-slug|other words]]`), a tag as `#word`, and a task as a line `- [ ] what to do`
  (`- [x]` when done).
- Draw a diagram as a fence whose language is `mermaid` (flowchart, sequenceDiagram,
  classDiagram, stateDiagram-v2, erDiagram, timeline and the rest of Mermaid). The Garden view
  draws it in the theme's colours; leave colours and `%%{init}%%` themes out of it.
- Give every new note a `gd.note.title`, a `gd.note.slug` (lower-case letters, digits and
  hyphens, unique in the file), `gd.note.pinned` false, a `gd.note.stage` (Seed for a stub,
  Growing for work in progress, Evergreen when it says what it means) and `gd.note.touched`
  today. `gd.note.kind` is Note unless it is a Daily note (set `gd.note.date`), a Map, a Source
  or a Template. Put a note under another with `gd.note.parent`, or move it with
  `nendo.data.move_record`.
- A body is at most 32 KiB, the bound on one value over MCP. Split a longer note.

## The rows a body makes

A save in the Garden view derives rows from the body and deletes the Body and Checkbox rows it
no longer says. When you write a body, write its rows exactly as the view would, in the same
batch, or the next save there rewrites them. The reference is the view's own code: read
`nendo://application/extension/org.nendo.garden/file?path=parse.mjs`, and `path=sync.mjs`.

- **Skipped:** everything inside a fence (a line opening with three or more `` ` `` or `~`,
  indent allowed, closed by a line of the same character at least as long) and inside inline `` `code` ``.
- **Links:** `[[target]]` or `[[target|words]]`, target trimmed. One `gd.link` per note named,
  the first time (case-insensitive): kind Mentions, source Body, and `gd.link.context` the
  whole line the link is on, trimmed. Only a line over 200 characters is cut, to a window around
  the link cut between words, with `…` at each cut end. The target is the note whose slug, else
  whose title, equals it (case-insensitive), else whose slug is `slugify(target)`. A link to the
  note itself makes no row. A target that is no note plants one in the same batch: slug
  `slugify(target)` (`-2`, `-3` if taken), title the target (or the words, when they make the
  same slug), kind Note, stage Seed, pinned false, touched today.
- **slugify:** NFKD, accents dropped, lower-case, each run of anything but `a-z` and `0-9` one
  hyphen, hyphens trimmed from the ends, at most 64 characters, `note` when nothing is left.
- **Tags:** `#name` at the start of a line or after whitespace, `(`, `,` or `;`. The name runs
  over letters, digits, `_`, `-` and `/`; trailing `-` and `/` are dropped, it is lower-cased,
  and it must hold a letter. Once per note: a `gd.tag` if the file has no tag of that name, and
  a `gd.noteTag` with source Body.
- **Tasks:** a line `- [ ] text`, `* [x] text` or `+ [X] text`, at any indent. One `gd.task` per
  line: title the text trimmed, done for `x` or `X`, source Checkbox, and `gd.task.key` the
  FNV-1a hash (32-bit, over the UTF-8 bytes) of the text lower-cased, whitespace runs made one
  space, trimmed, as eight lower-case hex digits. The second line with the same key adds `-2`,
  the third `-3`. A task's line is scanned for links and tags too.
- **What a save compares:** rows are matched by what they say, never by record ID, so the IDs
  are yours: a Body link by its target, its context updated when it differs; a note tag by its
  tag; a task by its key (`matchTasks`), its title and done following the line.

### Worked example

The note `compost` with this body:

````markdown
# Compost

Worms eat scraps. Keep it damp, as [[soil-life]] says, and add [[Kitchen scraps|peelings]].

- [ ] Turn the heap
- [x] Turn the heap
- [ ] Ask whether [[Soil-Life]] covers worms

Filed under #Compost and #how-to-, not #2026.

```
[[not-a-link]] #not-a-tag
- [ ] not a task
```
````

makes these rows, in this order. The heading, `#2026`, the second `soil-life` and the fence
make none; if no note is Kitchen scraps, the batch plants the Seed `kitchen-scraps` first.

```json
{
  "links": [
    { "target": "soil-life", "context": "Worms eat scraps. Keep it damp, as [[soil-life]] says, and add [[Kitchen scraps|peelings]]." },
    { "target": "Kitchen scraps", "context": "Worms eat scraps. Keep it damp, as [[soil-life]] says, and add [[Kitchen scraps|peelings]]." }
  ],
  "tags": ["compost", "how-to"],
  "tasks": [
    { "text": "Turn the heap", "done": false, "key": "434efef9" },
    { "text": "Turn the heap", "done": true, "key": "434efef9-2" },
    { "text": "Ask whether [[Soil-Life]] covers worms", "done": false, "key": "cc838afd" }
  ]
}
```

## Writing rows

- **Rows you write by hand are yours**: give a `gd.link`, `gd.noteTag` or `gd.task` the source
  `Manual`, and a save never touches it. A Manual link may carry a kind the body cannot say:
  Supports, Contradicts, See also, Part of.
- Write a note and its rows as one `nendo.data.apply_writes`, and give it a short `label` that
  says what you did, such as `Wrote compost and its links`. The label is what History calls the
  revision, and History is where the person reviews your work; `nendo.data.undo_revision`
  takes a `label` too.
- A reference write carries its target's current version in `expectedTargetVersions`, or
  names the target by `gd.note.slug` or `gd.tag.name` under `references`, which are unique.
- A save never deletes a tag.

## Commands

| Command | Command ID | Effect |
| --- | --- | --- |
| Mark evergreen | `gd.cmd.evergreen` | Stage Evergreen; touched today |
| Mark growing | `gd.cmd.growing` | Stage Growing; touched today |
| Tended today | `gd.cmd.tend` | Touched today |
| Pin / Unpin | `gd.cmd.pin`, `gd.cmd.unpin` | Pinned true or false |
| Done / Reopen | `gd.cmd.done`, `gd.cmd.reopen` | A task's done true or false |

Run them with `nendo.data.execute_command` by command ID. A command advances the record one
version per step; carry the `recordVersion` each write returns into the next write. The file
has no automatic actions, so a schema change never asks the device for behaviour consent.

## Screens

Use opens on the **Overview**, led by the garden's graph, with the stages, the tags and the
pinned notes; notes are written in the **Garden** view. Notes have a Tree, Tend (`gd.note.tend`:
seeds and growing notes not tended lately, and notes not written yet), All notes, Orphans, By
stage, a Daily calendar, Maps and a Graph (`gd.note.graph`); tasks have the Agenda
(`gd.task.agenda`: open tasks by when they are due) and a Due calendar. Links, Tags and Note tags
have record pages and no screen, so Use does not list them; read them on a note's page or over
MCP. A note's page shows its links out, backlinks, tags and tasks, and the Backlinks panel with
the line each backlink is on.

## Handing over

Take the single edit lease only for a bounded write and release it when you are done. Changes
to the application itself go as a proposal the person accepts. Say which notes you wrote or
changed, by slug.
