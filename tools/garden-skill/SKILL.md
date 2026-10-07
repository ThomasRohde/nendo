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
| `gd.link` | `gd.link.from` mentions `gd.link.to`, with `gd.link.kind` (Mentions, Supports, Contradicts, See also, Part of), `gd.link.context` (the sentence) and `gd.link.source` (Body or Manual) |
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
  (`- [x]` when done). Inside a code fence or inline code they mean nothing.
- Give every new note a `gd.note.title`, a `gd.note.slug` (lower-case letters, digits and
  hyphens, unique in the file), `gd.note.pinned` false, a `gd.note.stage` (Seed for a stub,
  Growing for work in progress, Evergreen when it says what it means) and `gd.note.touched`
  today. `gd.note.kind` is Note unless it is a Daily note (set `gd.note.date`), a Map, a Source
  or a Template. Put a note under another with `gd.note.parent`, or move it with
  `nendo.data.move_record`.
- A body is at most 32 KiB, the bound on one value over MCP. Split a longer note.
- **The Garden view derives rows from the body when a person saves there**: one `gd.link` per
  `[[link]]` (kind Mentions, source Body, with the sentence as context), a `gd.tag` and a
  `gd.noteTag` per `#tag`, and a `gd.task` per checkbox (source Checkbox, `gd.task.key` the
  key of its text). Rows with source Body or Checkbox belong to the body: a save deletes the
  ones the body no longer says. When you write a body over MCP, write its Body rows yourself
  the same way, or leave them and the next save in the view will make them.
- **Rows you write by hand are yours**: give a `gd.link`, `gd.noteTag` or `gd.task` the source
  `Manual`, and a save never touches it. A Manual link may carry a kind the body cannot say:
  Supports, Contradicts, See also, Part of.
- A reference write carries its target's current version in `expectedTargetVersions`, or
  names the target by `gd.note.slug` or `gd.tag.name` under `references`, which are unique.
- Tags are never deleted by a save. A tag's `gd.tag.name` is lower-case without `#`.

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

Use opens on the **Overview**, led by the garden's graph, with the pinned and lately tended
notes, the tasks due next and the tags; notes are written in the **Garden** view. Notes have a Tree, All notes, Orphans,
By stage, a Daily calendar, Maps and a Graph (`gd.note.graph`); tasks have Open, By source, a
Due calendar and All tasks. A note's page shows its links out, backlinks, tags and tasks, and
the Backlinks panel with each backlink's sentence.

## Handing over

Take the single edit lease only for a bounded write and release it when you are done. Changes
to the application itself go as a proposal the person accepts. Say which notes you wrote or
changed, by slug.
