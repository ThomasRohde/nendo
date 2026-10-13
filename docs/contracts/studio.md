# Studio contract

This contract gives the requirements for the permanent host-owned database editor.

- **Decision:** [ADR-0015](../decisions/0015-host-owned-database-studio-and-ag-grid-community.md)

## 1. Axiom

Every valid `.nendo` file opens with a permanent human workspace that the host supplies. This workspace is **Nendo Studio**.

Studio is available when:

- the database contains no user entities;
- no agent is connected;
- no custom surface exists;
- a custom definition or declarative command is invalid;
- the file opens in a restricted safe mode.

Application content cannot remove, replace or hide the route back to Studio.

Agent connection settings are bound to the file session at request admission
inside the controller gate. Switching files while a request waits refuses it;
port and lease duration are both validated before either preference is saved or
the listener restarts. A refused combined request keeps the current connection
and edit lease.

## 2. Experience target

The default Data workspace should feel closer to a modern Notion database table than to a raw SQLite browser. This is a target for interaction quality. It is not a target for visual imitation or feature parity.

A user should experience records as typed objects with understandable properties, relations, validation and history. The user should not see anonymous rows and foreign-key values.

The minimum Studio destinations are:

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

## 3. Empty database experience

A new Nendo file contains only kernel metadata and a genesis revision. Studio opens on Data and offers **Create record type**. When a known application recipe applies, Data also offers a button that starts it. The navigation also reaches:

- **Agent**, for agent access and its Activity, Launch and Connect tabs: Connect
  carries the connection guidance for a client the person runs, and Launch starts an
  agent program installed on this computer in a conversation tab beside the file
  ([launched agents](launched-agents.md));
- **Health**, for file identity, versions and health.

File → **Import CSV** becomes available when the file has a record type that is not retired.

Studio does not add a sample entity, record or custom surface implicitly.

## 4. Automatic experience for every entity

When an entity exists, Studio immediately supplies:

- a table in **Data**, headed with the record type's name (`<Type> data`);
- a generated record inspector/form;
- create, edit and delete paths;
- sorting, filtering and quick search;
- schema and record-history inspection;
- CSV import and export.

These are runtime projections from the semantic schema. A generated default does not have to become stored application content until the user customises or names it.

## 5. Table interaction contract

The first MVP should provide:

- inline editing for scalar fields;
- explicit pending, committed, validation-failed and conflicted states;
- keyboard focus, navigation, edit, commit and cancel behaviour;
- a persistent new-record affordance;
- resizable, movable and hideable columns;
- field-aware sort and filter operations;
- row selection and a small set of atomic bulk operations;
- bounded TSV copy and paste;
- a record inspector for long text, relationships and metadata;
- deterministic row ordering and block loading for large entities;
- light, dark and high-contrast presentation;
- accessible names, roles, errors and focus;
- stable semantic test targets based on entity, field and record IDs.

**A cell save, as built.** A saved cell keeps the keyboard on that cell and the columns where
they were scrolled, and the message line says it saved. A refused edit puts the stored value
back in its cell beside the reason, rather than leaving the refused one drawn as if it were
saved. The filter takes values as the grid shows them: Yes and No for a Boolean, a choice by
its label, and a reference by choosing its record in the picker a record form uses; its status
names the value as given, never a stored ID (W-210). A delete says what it deleted and offers
**Open History**, where the entry names the record and Undo brings it back.

**Leaving a record with unsaved typing.** Every move off a record page declines while it holds
unsaved typing, Health included, and says "Save or discard your changes before …". Closing the
record, by its close button, Back to Data or Escape, asks "Discard your changes?" first.

**History names what changed.** Each operation of an entry reads in words, with the field, the
record type and the record it acts on, by the record's label even after a delete. The action is
**Undo**, offered only where Nendo can reverse the change; the classes read "Can be undone",
"Can be undone if nothing has changed it since" and "Cannot be undone", except that a created
record and a record an undo brought back read "Undone by deleting the record; its ID stays
reserved", which is what History's Undo does to them (W-212, R2RM-05). A structure change is
offered only while it is the file's latest, and an undo of an undo is named Redo. It is not
universal undo.

**Columns as built.** A column's header carries the field's name. Clicking it, or Enter
on the focused header, sorts every record of the type by that field through
`data.queryRecords` — ascending, descending, then record order — never a reorder of the
loaded page; a calculated column sorts the same way, and the outline does not sort. The
filter above the table keeps the sort and the sort keeps the filter. A width is dragged at
the column's edge, or fitted by double-clicking it, and kept for the device by application
ID and record type, never in the file. The header's pencil, or F2, renames the field: Enter
prepares `schema.renameField` as a proposal to review. Opening a record is an icon at the
row's start, faint until the row is pointed at or focused; Enter or Space on that cell
opens it too. Movable and hideable columns are not built.

**An outline for a declared hierarchy** ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)).
A record type that declares a hierarchy opens as an outline, with a switch to the flat
table. The outline is a pinned first column: each record indented by its depth, a toggle
and a child count on a record with children, and "Show more" where a level has more than
the 200 read. Enter or Space opens or closes the focused record. Move up, Move down, Indent
and Outdent — or Alt+Shift and an arrow — move it with `data.moveRecord`; a move that would
pass siblings not yet read is not offered. The other columns edit as in the table.

Outline rows, layout choices and pending reads belong to the open file session. A file
switch clears them even when both files have the same type IDs and change sequence;
late replies from the old session cannot refill the cache. Background reads wait to
redraw while the person is interacting or holds an edited or retained draft. A failed
read offers **Try reading again**, which can retry the same revision.

**Unique and numbered fields** ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)).
Structure shows a field's rules beside its requirement: a *Unique* tag, and *Numbered* with an
example code (`Numbered W-001`). A single-line Text or plain Integer field offers **Make unique**
or **Allow duplicates**; a unique Text field offers **Number automatically**, a form with a prefix
and a digit count whose example follows the inputs, or **Stop numbering**. Each is a reviewed
proposal. Allow duplicates is disabled on a numbered field, saying why. On a new record a numbered
field that is empty is not required and says *Assigned when saved*, with the next code as an
example; a code typed there is kept if it is free.

### Calculated fields in Structure

A record type's calculated fields ([calculations and actions](calculations-and-actions.md))
follow its stored fields in a read-only **Calculated** group: name, stable ID, result type
(and *May be empty* where the result can be), the formula as written, and the fields it reads.
The heading counts them apart: *6 stored fields · 1 calculated*. A stored field that a
calculation reads says so under its name (*Seeds per gram reads this field, so it cannot be
retired while that calculation stays*) and does not offer **Retire**, since the host would
refuse the retirement as `retired-binding`; **Retire record type** is withheld the same way
while the type owns a calculation or one elsewhere reads it. A calculation that reads other
calculations names them among its reads. The reads come from the record type's schema,
`derivedFields[].readsFieldIds`, `readsCalculationIds` and `readsEntityIds`, matched by ID as
the host's check matches them (UIT-19, accepted 2026-10-13).

### Reviewing a proposal Studio prepared

Accepting a proposal that Structure, Screens or Data prepared returns to that page, with the
outcome on it (*Add Effort points field accepted.*). Only a proposal that builds the file's
first screens lands on Use, where they now are; a view the Add view form made lands on the
view. For a proposal Studio itself prepared (origin `workbench`) the review's first button
is **Discard**: it rejects the proposal (`proposal.reject`) and says so, so no validated copy
of the file is left waiting where nothing reaches it. Any other proposal opened there, a
custom view's or an agent's, has **Back**, which leaves it waiting for its author or for the
Agent page, where Reject asks first. Escape leaves the review without rejecting anything, and
the trail's Back returns to it; a package import or update is not lost to a stray key. The **Preview** panel names the record
types and screens the change addresses, read from the IDs its lines carry, and the read-only
preview opens on the first of them. Each line is marked as an addition, a removal (a retired
field or a removed package, among others) or a change. Where History would not undo the
proposal as a whole, each line reads *Can be undone, but not from History*, and History says the
same beside an entry it does not offer to undo. A proposal that removes a package names each
screen and panel that will then say the package is missing.

Saved views are desirable, but they are secondary to correct editing. The MVP may ship one default view plus one saved custom view per entity before it supports a general view-management system.

### What a new file keeps

Every grid has an *In new files* column (ADR-0022): *Kept* or *Left out* for a record's own
mark, *Kept (type)* or *Left out (type)* for one that follows its record type. Choosing in the
cell writes `data.setKeptInNewFiles`, which moves no version. Above the grid a sentence says the
type's default, with a button that prepares `schema.setKeptInNewFiles` as a proposal.

## 6. Field presentations

The Studio maps semantic storage and constraints to editors:

| Semantic form | Storage/relationship | Table experience |
| --- | --- | --- |
| short text | `text` | inline text editor |
| long text | `text` + presentation hint | clipped cell and record inspector editor |
| Markdown text | `text` + `markdown` presentation (host 1.44.0, W-173) | clipped cell; the record page shows it formatted (headings, nested lists, tables, code, emphasis, quotes, hard line breaks and backslash escapes; links not followed; each block takes its direction from its own text) above an **Edit** disclosure holding the source, and the formatted text follows the source as it is typed. Structure offers **Show as Markdown** on a long text field and **Show as long text** back, a reviewed `schema.setFieldPresentation` that changes no value |
| integer/decimal | numeric scalar | locale-aware numeric editor |
| checkbox | `boolean` | direct toggle with nullable state where declared |
| date/datetime | canonical date value | date picker; a date and time is shown and typed in this device's time and saved as an exact timestamp with its offset (Studio's grid edits it as text) |
| single choice | scalar + allowed stable option IDs | searchable choice picker; the cell shows the tone of the option as a dot |
| rating | `integer` + a closed min/max scale of at most ten values | the cell draws dots filled to the value; the user edits it by choosing one of the numbers of the scale; a value outside the scale shows as that number with the issue stated, never as a dot count that nobody chose |
| reference | relationship/foreign key | related-record label and picker |
| UUID | `uuid` | normally read-only abbreviated value |

The numeric editor takes a decimal with a dot or with one comma, as the numpad types it on a
Danish, German or French keyboard: `12,5` is saved as `12.5`. Where this device's language writes
its decimals with a dot, `1,234` (one to three digits without a leading zero, a comma, then three
digits) could be a thousands grouping and is refused; `0,125` and `1234,567` are decimals
everywhere. Where the language writes them with a comma, `1,234` is 1.234. Grouping, a second
separator and an exponent are refused. A whole number takes digits only, and its input asks a
touch keyboard for the numeric keypad.

The Data filter takes a plain date (`YYYY-MM-DD`) against a date and time as this device's day:
Equals is the whole day, from its start to the next day's start, and the comparisons are made
against the start of the day, which the status line says. Does not equal with a plain date is
refused, because a filter cannot say or.

Multi-choice is not an MVP scalar type. It requires a relationship/join model and is deferred. Binary fields/assets and general JSON editing are also deferred.

Unknown future types stay visible and read-only. They do not disappear.

## 7. Authority boundary

The table component is a renderer and interaction surface. It does not own persistence or the Nendo application model.

It receives no:

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
([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)). It finds that type's records by
any word in their text, best match first, and lists them under the bar with an excerpt. The table
and its filter stay as they are, and a result opens the record. It searches once two letters are
typed, as Ctrl K and the @ menu do, and says so below that: one letter is a prefix of most of the
index and about twenty times the work (PERF-09, 2026-10-13). While the file has no index, the
box offers *Build the search index*: `data.buildSearchIndex`, one host-owned Definition revision
that changes no record. The same search lists records under the commands in Ctrl K.

The bridge has no bulk-paste or saved-table-view method.

Every mutation includes an active application/session identifier, stable semantic IDs, optimistic version preconditions and an idempotency key. A value is authoritative only after the host commits it and returns the resulting version.

Schema actions that start from a column menu are application-lane operations. The table never executes DDL.

## 8. Component and containing architecture status

ADR-0002 selected a single local web workbench in a thin WinUI host. DS1 then
compared AG Grid Community and Tabulator through that containing boundary. It
recommended AG Grid Community for DS2. DS2 qualified the Windows provider,
automation, high-contrast, focus, packaging and lifecycle paths. ADR-0015 then
accepted AG Grid Community behind an adapter that Nendo owns. The real 200%
Windows scale has no recorded pass. It is an explicit hardening obligation after
selection and before release.

The acceptance of ADR-0015 resolved the component decision. Before acceptance,
the decision had to price the full system, and not only the grid. The ADR records
these costs:

- duplicate typed editors;
- theming and high contrast;
- accessibility rigs;
- UI automation rigs;
- focus and clipboard seams;
- virtualisation and paging;
- JavaScript/NuGet supply chains;
- packaging and crash isolation;
- long-term replacement cost.

The semantic renderer, containing-architecture and functional-grid experiments
are complete. Their prototypes stay disposable evidence. They are not production
scaffolding. Acceptance of the direction does not select the production source
structure, and it does not waive the host/service boundary.

## 9. Prototype gates

ADR-0015 was accepted after the following evidence and the explicit owner risk
disposition were recorded. The ADR is now the only record of them. The
gates below are the record of what the acceptance required. They are not open
work. The one obligation that remains is the real 200% Windows scale in DS2, as
section 8 states.

### DS1 — functional grid spike — complete

The DS1 result
records a pass for both candidates and recommends AG Grid Community for DS2.

Prove against the chosen containing architecture:

- empty and populated database states;
- 100, 10,000 and 100,000-row fixtures through one bounded query contract;
- text, numeric, boolean, date, choice and reference editors;
- inline edit, row creation, deletion, selected-row bulk action and bounded TSV paste;
- optimistic conflicts and idempotent retry;
- database session survival after renderer reload/crash;
- all application assets local and offline;
- no commercial/Enterprise module dependency when evaluating AG Grid Community.

### DS2 — accessibility, automation and lifecycle

Prove:

- keyboard-only use;
- Narrator or equivalent Windows accessibility evidence;
- visible focus across shell/component boundaries;
- 200% text/display scaling and high contrast;
- stable semantic automation targets;
- light/dark theme propagation;
- packaged offline launch;
- dependency inventory and update policy;
- measured implementation duplication for the chosen architecture.

### Exit rule

Vendor documentation and a mock-up that looks convincing are not sufficient. The experiment result must record commands, versions, measurements, observations, failures and unresolved limitations.

## 10. Safe-mode fallback

If the primary table renderer cannot initialise, Studio must keep a bounded fallback that can:

- list entities;
- inspect one record at a time;
- export data;
- inspect file health;
- reach backup and recovery actions.

A renderer crash must not close the database, replay an unconfirmed mutation or corrupt the application session.

Studio never hosts custom-view code. A custom view runs in a frame with a renderer process of its own, and its crash or hang stays in its own place on the page; only a failure of the Workbench's own renderer or of the browser brings up the native recovery panel, which can also restart without custom views ([custom views](custom-views.md#when-a-view-fails)).

## 11. MVP acceptance criteria

- [ ] Empty `.nendo` files open into a useful Studio without an agent.
- [ ] Every entity receives a usable table and record editor automatically.
- [ ] Users can create and edit records without SQL or a custom surface.
- [ ] Basic entity/field creation stays available through host-owned tooling.
- [ ] A large flat table is block-loaded. It is not copied whole into the UI process.
- [ ] Edits are atomic, attributed, idempotent and version checked.
- [ ] Invalid or conflicting edits are never presented as committed.
- [ ] Custom surfaces can fail while Studio stays usable.
- [ ] Keyboard, accessibility, scaling, high-contrast and automation gates pass.
- [ ] The packaged experience works offline.
- [ ] CI enforces the selected grid/component licence and dependency boundary.
- [ ] Ordinary SQLite inspection still exposes understandable user data.
