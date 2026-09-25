---
title: Concepts
description: The words Nendo uses for files, data, screens, changes and agents, each defined once.
group: Start
order: 20
---

Each term below names one thing. The other guides use these terms without
explaining them again. For the idea behind Nendo, see
[the concept page](/nendo/concept).

## The file and its data

### Application file

A `.nendo` file is one SQLite database in a local folder. It holds the whole
application: record types, fields, records, screens, calculations, automatic
actions, settings and the full change history. An empty file is a valid
application. You can open it and enter data before any screen exists. See
[Files and data](/nendo/docs/files-and-data) for copies, backups and limits.

A file can also carry a sentence that says what it is for. Nendo shows it under
the file name in About this file, in the File menu, and an agent reads it first.

### Record type

A record type is one kind of thing that the file tracks, for example *Task* or
*Client*. Nendo stores each record type as an ordinary table. Some internal
names say *entity*; that means record type.

### Field

A field is one named value on a record type. Each field has a storage kind, and
some storage kinds also have a presentation that controls how the value is shown
and edited. These are the choices in Studio's **Add field** dialog:

| Add field option | Storage kind | Presentation | Notes |
| --- | --- | --- | --- |
| Short text | Text | Single line | |
| Long text | Text | Long text | |
| Choice | Text | Single choice | 1 to 32 options, each at most 120 characters. One value per record. |
| Whole number | Integer | none | Large values keep every digit. |
| Rating on a scale | Integer | Rating | Drawn as dots. The scale has a minimum and a maximum and at most ten values. |
| Decimal | Decimal | none | Exact. Nendo does not round it. |
| Yes / No | Boolean | none | |
| Date | Date | Date | A calendar day with no time. |
| Date and time with timezone | DateTime | none | |
| UUID | Uuid | none | |
| Reference to another record | Reference | none | See [Reference](#reference). |

A field holds one value. There is no multi-choice field and no file, image or
binary field. A choice option can carry one of eight named colours (red, orange,
amber, green, teal, blue, violet, grey). The presentation and a rating's scale
are set when the field is made and do not change later.

A field can be **required** or **optional**. When you make a field required,
Nendo first checks every record and asks you for the missing values. It fills in
nothing by itself.

You can **retire** a field or a record type instead of deleting it. Retiring
keeps the stored values and stops new writes. Structure can reactivate it.

### Record

A record is one row of a record type. It has a stable record ID and a record
version. The version goes up by one on each change. A save states the version it
was made against, and Nendo refuses a save against an old version, so two edits
never overwrite each other silently.

### Stable ID

Every record type, field, choice option, record and screen part has a stable ID.
Screens, references and calculations use the ID. The name you see is a label on
top of it, so a rename breaks nothing.

### Reference

A reference field links a record to one record of another record type (or of the
same type). It stores the target record's ID and shows one text field of the
target as its label. A record page can show the other direction as a
**related list**: all records whose reference points at this record.

Nendo refuses to delete a record that another record still references. Clear or
reassign the references first. Nothing cascades.

## Screens

### Screen

A screen is a stored description of how to show and edit records: a list, a
board, a gallery, a calendar, a timeline, a matrix, a record page, a form, a
command or the front page. Internal names call a screen a *surface*. The file
stores only the description, never HTML, scripts or SQL. Nendo compiles the
description and draws it. See [Screens](/nendo/docs/screens) for every kind. The
one screen that runs code is a custom view, whose code the file carries as a
package: see [Custom views](/nendo/docs/custom-views).

### Node tree

Each screen is a tree of nodes. The root node is the screen itself, for example a
list. Its children are the parts: field bindings, filter clauses, sections, tabs,
tiles, charts, related lists and commands. Each node has a stable ID. A change
to a screen adds, sets, moves or removes a node.

### Use and Studio

Nendo has two views of a file.

- **Use** shows the screens that the file defines. It is the application as its
  author built it.
- **Studio** is part of Nendo itself, not of the file. It has five areas:
  **Data** (a table of every stored field of every record), **Structure** (record
  types and fields), **Surfaces** (the compiled screens and any compile errors),
  **History** and **Health**. No file content and no agent can remove Studio or
  hide the route to it.

If a screen definition does not compile, Nendo turns off every custom screen and
Studio keeps working.

### Command

A command is a button on a record page that sets one or more fields of that
record in one step, for example *Mark done*. Each step sets one field to a fixed
value, today's date, the current time or empty. A command is part of the
screens, not of the automatic rules below: it runs only when a person presses it
or an agent runs it.

## Rules

### Calculation

A calculated field is computed from other fields of the record when it is read.
Nobody types into it. The formula language is small and closed: arithmetic,
comparisons, a fixed set of functions, today's date and the current time. A
**function** is a named, reusable formula that calculations call. See
[Calculations and actions](/nendo/docs/calculations-and-actions).

### Automatic action and trigger

An **action** is a list of steps that set a field, create a record or delete a
record. A **trigger** runs an action when a record of a given type is created,
updated or deleted. The triggering save and everything the action changes are
stored together, or nothing is stored.

A file with a trigger cannot be edited until you approve its actions on this
computer. The approval is stored on the computer, not in the file.

## Changes and history

### Data lane and application lane

A record edit, a paste or an import writes straight to the file. That is the
**data lane**. A change to record types, fields, screens or rules goes through a
proposal. That is the **application lane**.

### Change set and proposal

A **change set** is an ordered list of typed operations with one description,
for example *add a field*, *add a node*, *set a property*. An agent builds a
change set and asks Nendo to validate it. Nendo applies it to a private copy of
the file and checks the result.

A validated change set is a **proposal**. It waits under **Pending changes**
until you open **Review changes**, read what it does, and accept or reject it.
When you accept, Nendo replays the same operations on your real file. The private
copy never replaces your file. Rejecting leaves the file unchanged. Studio's own
structure edits use the same path, which is why they say **Preview changes**.

A proposal records the revision it was built on. When you accept one proposal,
other waiting proposals become stale and must be rebuilt.

### Revision and history

Every accepted change creates a revision. Changes to the app's shape advance the
**definition revision**. Changes to records advance the **data revision**. Both
share one change sequence, so History lists all changes in order and shows who
made each one: you, an agent or a trigger.

### Reversibility

Every operation declares one of three reversibility classes. The review shows
the class before you accept, and History shows it again:

| Label in the app | Meaning |
| --- | --- |
| Reversible | Nendo can produce the exact inverse. |
| Compensatable with retained state | Nendo kept the old state and can restore it while the current state allows. |
| Not compensatable | There is no inverse, for example a new record type or field. |

To reverse a change, History applies the inverse as a new revision
(**Compensate**). History is never rewritten. There is no universal undo.

## Agents

### Access level

An agent connects to the open file through the Model Context Protocol (MCP). You
choose how much it can do on the **Agent access** page:

| Level | The agent can |
| --- | --- |
| Off | Nothing. No agent can connect. |
| Inspect | Read the file: structure, records, screens, history, health and waiting proposals. |
| Edit data | Also create, edit and delete records and run commands. |
| Shape app | Also build change sets and submit them as proposals for you to review. |
| Unattended | Also accept its own proposals. Use it only while an agent builds a new file. |

### Lease

A lease is the right to write. One agent holds it at a time. It has no expiry
unless you turn expiry on. You can revoke it at any time with **Revoke edit
access**. Setting access to Off, closing the file or switching files ends it. See
[Agents](/nendo/docs/agents).

## Safety

### Safe mode

Nendo inspects a file before it grants any capability. If the file fails an
integrity check or was changed by another program, Nendo opens it in safe mode:
a restricted Studio. The status pill reads **Recovery required**. Custom screens, commands and agent editing are off,
and you can still read the data and its history. Health says what Nendo found
and how to recover. Nendo never guesses a repair. A file that needs a newer
version of Nendo does not open at all.
