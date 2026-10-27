# Studio contract

The requirements for the permanent host-owned database editor.
Decision: [ADR-0015](../decisions/0015-host-owned-database-studio-and-ag-grid-community.md).

## 1. Axiom

Every valid `.nendo` file opens with a permanent human workspace that the host
supplies: **Nendo Studio**. It is available when:

- the database contains no user entities;
- no agent is connected;
- no custom surface exists;
- a custom definition or declarative command is invalid;
- the file opens in a restricted safe mode.

Application content cannot remove, replace or hide the route back to Studio.

Agent connection settings are bound to the file session at request admission
inside the controller gate. Switching files while a request waits refuses it. Port
and lease duration are both validated before either preference is saved or the
listener restarts; a refused combined request keeps the current connection and
edit lease.

## 2. Destinations

Records read as typed objects with understandable properties, relations,
validation and history, not anonymous rows and foreign-key values.

1. **Data**: table, record inspector, search, filters, sorts, import and export;
2. **Structure**: entities, fields, constraints, relationships and physical mapping,
   and each record type's calculated fields, read-only (see [calculated fields](#calculated-fields-in-structure));
3. **Screens**: the compiled screens of each record type, each with its health: *Healthy*,
   *Warning* with the compiler's sentence, *Missing package* for a custom view whose package
   the file lacks, or *Off* while custom views do not run. A board is renamed on its own card.
   Screens has no per-screen disable or restore: every custom screen switches off on its own
   in recovery or under a definition that does not compile, when Screens lists the compiler's
   errors instead, and a proposal that fixes the definition brings them back
   ([ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md)). Below them is the
   Custom views panel: this device's two switches for custom views, and import, export and
   removal of the file's view packages ([custom views](custom-views.md#studio));
4. **History**: revisions, attribution, semantic changes and Undo where it is supported;
5. **Health**: compatibility, integrity, drift, backup, recovery and safe mode, and
   whether custom views run.

## 3. Empty database

A new Nendo file contains only kernel metadata and a genesis revision. Studio opens
on Data and offers **Create record type**. When a known application recipe applies,
Data also offers a button that starts it. The navigation also reaches:

- **Agent**, for agent access and its Activity, Launch and Connect tabs: Connect
  carries the connection guidance for a client the person runs, and Launch starts an
  agent program installed on this computer in a conversation tab beside the file
  ([launched agents](launched-agents.md));
- **Health**, for file identity, versions and health.

File → **Import CSV** is available when the file has a record type that is not
retired. Studio never adds a sample entity, record or custom surface.

## 4. Every entity

When an entity exists, Studio supplies, as runtime projections from the semantic
schema that are not stored application content:

- a table in **Data**, headed with the record type's name (`<Type> data`);
- a generated record inspector/form;
- create, edit and delete paths;
- sorting, filtering and quick search;
- schema and record-history inspection;
- CSV import and export.

## 5. The table

The table gives typed inline editing with explicit pending, committed,
validation-failed and conflicted states; keyboard focus, navigation, edit, commit
and cancel; a persistent new-record affordance; a record inspector for long text,
relationships and metadata; deterministic row ordering and block loading; light,
dark and high-contrast presentation; accessible names, roles, errors and focus;
and stable semantic test targets based on entity, field and record IDs.

**A cell save.** A saved cell keeps the keyboard on that cell and the columns where
they were scrolled, and the message line says it saved. A refused edit puts the
stored value back in its cell beside the reason. Enter saves a cell and continues in
the same field on the next row. Escape cancels the editor; Tab outside editing
leaves the grid so it does not trap keyboard users. The filter takes values as the
grid shows them: Yes and No for a Boolean, a choice by its label, and a reference by
choosing its record in the picker a record form uses; its status names the value as
given, never a stored ID. A delete says what it deleted and offers **Open
History**, where the entry names the record and Undo brings it back.

**Leaving a record with unsaved typing.** Every move off a record page declines while
it holds unsaved typing, Health included, and says "Save or discard your changes
before …". Closing the record, by its close button, Back to Data or Escape, asks
"Discard your changes?" first.

**History names what changed.** Each operation of an entry reads in words, with the
field, the record type and the record it acts on, by the record's label even after
a delete. The action is **Undo**, offered only where Nendo can reverse the change;
the classes read "Can be undone", "Can be undone if nothing has changed it since"
and "Cannot be undone", except that a created record and a record an undo brought
back read "Undone by deleting the record; its ID stays reserved". A structure change
is offered only while it is the file's latest, and an undo of an undo is named Redo.
It is not universal undo. Undo of one record's edit acts at once. An undo that
reaches more than one record, or a definition or package change, first asks in a
dialog that names the entry and says what undoing it does (*deletes 3 records this
change added or brought back*); Cancel sends nothing. View changes opens a
revision's operations whatever the file has done since, and what is open stays open
across a redraw.

**Columns.** A column's header carries the field's name. Clicking it, or Enter on the
focused header, sorts every record of the type by that field through
`data.queryRecordWindow` — ascending, descending, then record order — never a
reorder of the loaded page; a calculated column sorts the same way, and the outline
does not sort. The filter keeps the sort and the sort keeps the filter. A width is
dragged at the column's edge, or fitted by double-clicking it. The header's pencil,
or F2, renames the field: Enter prepares `schema.renameField` as a proposal to
review, titled *Rename Owner on Task to Lead*. A rename that does not open its
review, refused or pressed while another action runs, puts the header back and says
why. Opening a record is an icon at the row's start, faint until the row is pointed
at or focused; Enter or Space on that cell opens it too. Drag headers to reorder
columns. **Columns** hides or pins fields and **Reset columns** restores the layout.
The record-open column stays visible and pinned. Width, order, visibility and
pinning are validated device preferences keyed by application ID and record type,
never in the file. **Copy cell** (or Ctrl+C outside an editor) copies one formatted
value; clipboard refusal is reported. There is no rectangular selection, bulk paste
or saved table view.

**Flat tables load while scrolling.** AG Grid Community's Infinite Row Model requests
blocks of 100 records through the typed window query, with five cached blocks and at
most two concurrent requests. Evicted blocks reload under the same signed query and
revision. The grid stays mounted as blocks arrive. No total is invented before an
end block is read; loading, empty results, Retry and Refresh have local status. A
write from elsewhere marks the table stale without moving the reader; Refresh reads
again. Edits use the same versioned typed operations and refresh the focused
record's neighbourhood by stable ID, including a record that moves under sorting.
Missing anchors are reported.

**An outline for a declared hierarchy** ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)).
A record type that declares a hierarchy opens as an outline, with a switch to the
flat table. The outline is a pinned first column: each record indented by its
depth, a toggle and a child count on a record with children, and "Show more" where a
level has more than the 200 read. Enter or Space opens or closes the focused record.
Move up, Move down, Indent and Outdent — or Alt+Shift and an arrow — move it with
`data.moveRecord`; a move that would pass siblings not yet read is not offered. The
other columns edit as in the table. When the file moves, each open level is read
again as far as Show more had read it.

Outline rows, layout choices and pending reads belong to the open file session. A
file switch clears them even when both files have the same type IDs and change
sequence; late replies from the old session cannot refill the cache. Background
reads wait to redraw while the person is interacting or holds an edited or retained
draft. A failed read offers **Try reading again**, which can retry the same
revision.

**Unique and numbered fields** ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)).
Structure shows a field's rules beside its requirement: a *Unique* tag, and
*Numbered* with an example code (`Numbered W-001`). A single-line Text or plain
Integer field offers **Make unique** or **Allow duplicates**; a unique Text field
offers **Number automatically**, a form with a prefix and a digit count whose example
follows the inputs, or **Stop numbering**. Each is a reviewed proposal. Allow
duplicates is disabled on a numbered field, saying why. On a new record a numbered
field that is empty is not required and says *Assigned when saved*, with the next
code as an example; a code typed there is kept if it is free.

**A reference's label.** A bound reference's row says which record type it points at
and the field it shows them by, and offers **Label by…**: a form listing the
target's other active Text fields, which prepares a reviewed
`schema.setReferenceLabel`. It is disabled, saying why, when the target has no other
one. History names the change *Change a reference's label* and offers Undo while it
is the latest definition change.

### Calculated fields in Structure

A record type's calculated fields ([calculations and actions](calculations-and-actions.md))
follow its stored fields in a read-only **Calculated** group: name, stable ID, result
type (and *May be empty* where the result can be), the formula as written, and the
fields it reads. The heading counts them apart: *6 stored fields · 1 calculated*. A
stored field that a calculation reads says so under its name (*Seeds per gram reads
this field, so it cannot be retired while that calculation stays*) and does not
offer **Retire**, since the host would refuse it as `retired-binding`; **Retire
record type** is withheld the same way while the type owns a calculation or one
elsewhere reads it. A calculation that reads other calculations names them among its
reads. The reads come from the record type's schema, `derivedFields[].readsFieldIds`,
`readsCalculationIds` and `readsEntityIds`, matched by ID as the host's check
matches them.

### Making a field required

**Make required** and **Reactivate** of a required field list the records that have
no value, 50 at a time, each by its label, and ask for a value for each. Nothing is
filled in for the person: a choice starts on *Choose…*, which the form refuses, and a
rating is chosen on its scale. A batch that only fills values is titled *Fill missing
Status values (first 50)*; the requirement changes with the last batch. The form is
drawn only while the person is still on the page they pressed it on. **Convert
reference** heads each record by its label too, and a record counts as mapped only
once a target is chosen or Clear is pressed in its own picker. A rating's Lowest and
Highest are required while the rating type is chosen; an empty one is refused, not
read as 0.

### Reviewing a proposal Studio prepared

A change the host refuses on its copy of the file opens no review: Studio rejects
that proposal in the host and says the host's words in the form, which keeps what
was typed. A press while another action runs says *Wait for the current action to
finish, then try again.*

Accepting a proposal that Structure, Screens or Data prepared returns to that page,
with the outcome on it (*Add Effort points field accepted.*). Only a proposal that
builds the file's first screens lands on Use, where they now are; a view the Add view
form made lands on the view. For a proposal Studio itself prepared (origin
`workbench`) the review's first button is **Discard**: it rejects the proposal
(`proposal.reject`) and says so, so no validated copy is left waiting where nothing
reaches it. Any other proposal opened there, a custom view's or an agent's, has
**Back**, which leaves it waiting for its author or for the Agent page, where Reject
asks first. Escape leaves the review without rejecting anything, and the trail's Back
returns to it. The **Preview** panel names the record types and screens the change
addresses, read from the IDs its lines carry, and the read-only preview opens on the
first of them. Each line is marked as an addition, a removal (a retired field or a
removed package, among others) or a change. Where History would not undo the
proposal as a whole, each line reads *Can be undone, but not from History*, and
History says the same beside an entry it does not offer to undo. A proposal that
removes a package names each screen and panel that will then say the package is
missing.

### What a new file keeps

Every grid has an *In new files* column (ADR-0022): *Kept* or *Left out* for a
record's own mark, *Kept (type)* or *Left out (type)* for one that follows its record
type. Choosing in the cell writes `data.setKeptInNewFiles`, which moves no version.
Above the grid a sentence says the type's default, with a button that prepares
`schema.setKeptInNewFiles` as a proposal.

## 6. Field presentations

| Semantic form | Storage/relationship | Table experience |
| --- | --- | --- |
| short text | `text` | inline text editor |
| long text | `text` + presentation hint | clipped cell and record inspector editor |
| Markdown text | `text` + `markdown` presentation (host 1.44.0) | clipped cell; the record page shows it formatted (see below) |
| integer/decimal | numeric scalar | locale-aware numeric editor |
| checkbox | `boolean` | direct toggle with nullable state where declared |
| date/datetime | canonical date value | date picker; a date and time is shown and typed in this device's time and saved as an exact timestamp with its offset (Studio's grid edits it as text) |
| single choice | scalar + allowed stable option IDs | searchable choice picker; the cell shows the tone of the option as a dot |
| rating | `integer` + a closed min/max scale of at most ten values | the cell draws dots filled to the value; the user edits it by choosing one of the numbers of the scale; a value outside the scale shows as that number with the issue stated, never as a dot count that nobody chose |
| reference | relationship/foreign key | related-record label and picker |
| UUID | `uuid` | normally read-only abbreviated value |

**Markdown text.** The record page shows it formatted: headings, nested lists,
tables, code, emphasis, quotes, hard line breaks and backslash escapes; links are not
followed, and each block takes its direction from its own text. It is written in
place in a Tiptap editor with a toolbar (bold, italic, strikethrough, code, two
heading levels, lists, quote, code block, link) and Tiptap's keys; a **Markdown**
disclosure under it holds the source, and an edit in either shows in the other. The
editor writes Markdown back only when the person changes the text, reads raw HTML as
text and writes no HTML entities. A value edited there may come back normalised as
`markdown.ts` reads it the same: table padding, `_` emphasis as `*`, escaped `_` and
brackets; an entity typed literally, such as `&amp;`, comes back as its character.
Structure offers **Show as Markdown** on a long text field and **Show as long text**
back, a reviewed `schema.setFieldPresentation` that changes no value. Guarded by
`markdown-editor.test.mjs` and `Gate-WorkbenchShell`.

The numeric editor takes a decimal with a dot or with one comma, as the numpad types
it on a Danish, German or French keyboard: `12,5` is saved as `12.5`. Where this
device's language writes its decimals with a dot, `1,234` (one to three digits
without a leading zero, a comma, then three digits) could be a thousands grouping and
is refused; `0,125` and `1234,567` are decimals everywhere. Where the language writes
them with a comma, `1,234` is 1.234. Grouping, a second separator and an exponent are
refused. A whole number takes digits only, and its input asks a touch keyboard for the
numeric keypad.

The Data filter takes a plain date (`YYYY-MM-DD`) against a date and time as this
device's day: Equals is the whole day, from its start to the next day's start, and
the comparisons are made against the start of the day, which the status line says.
Does not equal with a plain date is refused, because a filter cannot say or.

Multi-choice is not a scalar type; it needs a relationship/join model. General JSON
editing is not offered. Unknown future types stay visible and read-only.

## 7. Authority boundary

The table component is a renderer and interaction surface. It does not own
persistence or the Nendo application model. It receives no:

- SQLite connection or SQL;
- database or filesystem path;
- shell, process or network authority;
- generic native host object;
- MCP credential or proposal authority.

It calls named, validated operations such as:

```text
data.queryRecords
data.searchRecords
data.buildSearchIndex
data.createRecord
data.setField
data.setFields
data.moveRecord
data.deleteRecord
data.executeCommand
```

`data.searchRecords` backs the *Search text* box in the per-type table's filter bar
([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)). It finds that type's
records by any word in their text, best match first, and lists them under the bar
with an excerpt. The table and its filter stay as they are, and a result opens the
record. It searches once two letters are typed, as Ctrl K and the @ menu do, and
says so below that: one letter is a prefix of most of the index. While the file has
no index, the box offers *Build the search index*: `data.buildSearchIndex`, one
host-owned Definition revision that changes no record. The same search lists records
under the commands in Ctrl K.

The bridge has no bulk-paste or saved-table-view method.

Every mutation includes an active application/session identifier, stable semantic
IDs, optimistic version preconditions and an idempotency key. A value is
authoritative only after the host commits it and returns the resulting version.

Schema actions that start from a column menu are application-lane operations. The
table never executes DDL.

## 8. Grid component

ADR-0015 selects AG Grid Community behind an adapter that Nendo owns, in the single
local web Workbench inside a thin WinUI host (ADR-0002). No AG Grid Enterprise module
is used. Windows scaling, keyboard/focus and screen-reader checks are owner-reported;
no lane instruments them ([roadmap](../roadmap.md)).

## 9. Safe-mode fallback

If the primary table renderer cannot initialise, Studio keeps a bounded fallback
that can:

- list entities;
- inspect one record at a time;
- export data;
- inspect file health;
- reach backup and recovery actions.

A renderer crash must not close the database, replay an unconfirmed mutation or
corrupt the application session.

Studio never hosts custom-view code. A custom view runs in a frame with a renderer
process of its own, and its crash or hang stays in its own place on the page; only a
failure of the Workbench's own renderer or of the browser brings up the native
recovery panel, which can also restart without custom views
([custom views](custom-views.md#when-a-view-fails)).

## 10. Requirements

- An empty `.nendo` file opens into a useful Studio without an agent.
- Every entity receives a usable table and record editor automatically.
- Records are created and edited without SQL or a custom surface.
- Entity and field creation stays available through host-owned tooling.
- A large flat table is block-loaded, never copied whole into the UI process.
- Edits are atomic, attributed, idempotent and version checked.
- Invalid or conflicting edits are never presented as committed.
- Custom surfaces can fail while Studio stays usable.
- The packaged experience works offline.
- Ordinary SQLite inspection still exposes understandable user data.

## 11. Settings

Settings is drawn by the host beside Studio ([ADR-0038](../decisions/0038-settings-in-one-place.md)).
It opens as a page from **Settings** in the navigation, **Ctrl ,** and the command box, with or without a file, in a read-only file and in recovery.

- **Rows.** The host's settings catalogue (`settings.describe`, `SettingsCatalogue`) names each
  setting, its section (General, Agents, Custom views, This file), its group, its control and its
  home. The page draws a row for each, in the catalogue's order, and searches their titles, help,
  groups, sections and homes.
- **Homes.** Each row says where its value is kept: **This computer**, **This file, here** or
  **In the file**. A row that needs a file says *Open a file to choose this.* without one; a row in
  the file is read-only, with the reason, while the file is.
- **Values.** Each value is read and changed through the method its own control has always used:
  `appearance.set`, `agent.setMode` and `agent.setSettings`, `agentSession.setViewAccess` and
  `agentSession.setStartIn`, `extension.settings.set`, `behaviour.approve` and `behaviour.revoke`.
  What Close does and Record failures, which only the tray changed, are changed with
  `settings.set`. Shortcut hints and pictures from the web stay in the page storage of this device.
  A change made at the status line, the tray, the Agent page, Custom views or Health is the one
  Settings shows, and those places link to their row (*Also in Settings*).
- **Changes to the file.** A purpose or a name for a new file typed here waits in **N changes to
  the file** with **Review** and **Discard**. Review prepares one proposal with an operation each
  (`application.setPurpose`, `application.setNewFileLabel`) and opens Studio's review. The look is
  changed in About this file.
- **Icons.** This file → Icons has a row for each record type and each of the file's screens, with
  its icon and where it came from: *Chosen*, *Guessed from the name* or *Nothing guessed*. **Change**
  opens the icon picker: a search over the set's names and search words, its groups, the icons used
  last on this device, and a grid the arrow keys move through, Enter choosing. **Use the guessed
  icon** clears a choice. A choice waits in the bar as `schema.setEntityIcon` for a record type, or
  `ui.setProperty` / `ui.removeProperty` of the screen's `icon`. Right-clicking a record type or a
  screen in the navigation opens the same picker, and its choice opens straight in the review. A
  record type whose name suggests no icon shows a box, and a screen the layout icon.
- **Overrides.** `NENDO_DESKTOP_CLOSE_ACTION` makes its row read-only, and the row names it.
- **A page in a browser** offers no window, tray or agent setting.
