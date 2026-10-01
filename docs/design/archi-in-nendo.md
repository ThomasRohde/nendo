# Archi in Nendo: the design

`Archi.nendo` is an ArchiMate modeller built as a Nendo application. It follows
archi-online (the sibling repository `../archi-online`), the browser clone of desktop
[Archi](https://www.archimatetool.com/) 5.9, and it runs offline in Nendo. It is
initiative I-007 in the planner. Its purpose is to find how far Nendo can be pushed:
where Nendo falls short, the gap becomes a host feature with its own ADR rather than a
workaround hidden in the view.

This document is W-100. It says which record types hold a model, where the Archi user
interface lives, what is in and out of scope, which Nendo limits the design meets, and
what one editing session costs against the file's write bound. The work items W-101 to
W-125 build it.

**Decisions.** D-001 (one Concept record type) and D-003 (relationship rules are
checked in the view and reported by the validator) were decided on 2026-09-29.
D-002, how the editor stays inside the operation-row bound, is open. The
[write budget](#the-write-budget) below gives it a measured number.

## The shape of the solution

- **One file is one model.** Archi opens several models in one window. In Nendo, each
  model is its own `.nendo` file, and several files open in their own windows (W-089).
  Cross-model paste and model merge are Later.
- **The records are the model.** Elements, relationships, folders, views, diagram
  objects, connections and properties are ordinary records, so Studio, CSV, History and
  MCP work on a model without the Archi view. That is Nendo's axiom that data is usable
  before specialised presentation, and it is what the Archi file gains over a
  `.archimate` document.
- **The Archi window is one custom view.** A package, `extensions/archi`, carries the
  workbench: model tree, diagram editor, palette, properties, validator and analysis.
  It is a screen of the View record type until a view can be a file's own screen
  (W-106).
- **archi-online's model code is reused, not rewritten.** Its `src/model` has no React
  and makes every change inside an Immer transaction. The view keeps a mirror of the
  file's records in archi-online's `ModelState` shape. It runs archi-online's
  operations against the mirror unchanged, and writes the difference between the state
  before and after as typed Nendo writes: one record created or deleted, or one field
  set, per changed value. Alignment, the magic connector, nesting rules, Generate View
  For, CSV and XML import all come across this way. The canvas, figures and icons are
  ported from `src/canvas`. Ported code keeps archi-online's MIT notice, and the package
  names the archi-online commit it came from (`6205a6a` at the time of writing).
- **The package is plain JavaScript, with one built file.** The workbench (`view.js`,
  `model.js`) needs no build. The drawing, `canvas.js`, is archi-online's renderer, geometry
  and router with the mirror and the camera (`tools/archi/canvas`), bundled with React by
  esbuild at a pinned archi-online commit; it is committed, so neither the file nor the tests
  need archi-online (W-110). The dev loop is W-063's *Develop from folder*.
- **Changes from elsewhere reach the mirror.** The view listens to `changes` and reads
  again what changed. A write refused as stale reloads the records it touched and tells
  the person, rather than overwriting.

## Record types

Every type that Archi identifies carries an **Archi ID**: unique single-line text,
holding the `id` Archi wrote. It keeps identity across `.archimate` round trips, and it
is the code that CSV import resolves references by (W-075).

| Type | Fields | Notes |
| --- | --- | --- |
| **Model** | Name, documentation, language, version, the 15 Dublin Core fields as text, Archi ID | One record |
| **Folder** | Name, kind (Strategy, Business, Application, Technology, Motivation, Implementation & Migration, Other, Relations, Views; empty for a user folder), documentation, label expression, parent, order, Archi ID | A hierarchy ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)); the nine top-level folders are seeded |
| **Concept type** | Key (unique, for example `BusinessActor`), name, category (Element, Relationship), layer (nine options), default fill, default width and height, relationship letter | 72 seeded records: 61 element types and 11 relationship types. A choice holds 32 options, so the type is a reference to this lookup, which also carries the notation's defaults (D-001) |
| **Concept** | Name, type (Concept type, required), category (Element or Relationship, so a screen can filter on it), documentation, folder, source and target (both Concept), access type (Write, Read, Access, Read and write), influence strength, directed, junction type (And, Or), specialization, Archi ID | Elements and relationships in one type (D-001). A relationship's source or target may be another relationship, and a junction is an element, so neither needs anything new. A Concept page lists its relationships from and to it and its occurrences |
| **Specialization** | Name, concept type, Archi ID | Archi's profiles. Images are out (F-208) |
| **View** | Name, documentation, folder, viewpoint (the viewpoint's key), router (Manual, Manhattan), Archi ID | Sketch and Canvas views are out, as in archi-online |
| **Diagram item** | View (required), kind (Element, Group, Note, View reference, Relationship connection, Connection), concept, referenced view, parent, order, source and target (both Diagram item), x, y, width, height, bendpoints, name, documentation, content, figure, border type, connection type, name visible, text alignment and position, fill, line and font colour, fill, line and font alpha, gradient, line style and width, icon visibility and colour, derived line colour, font, label expression, legend options, Archi ID | Nodes and connections in one type, because a connection may end on another connection. Nesting is the hierarchy; order is z-order. Bounds are typed integers relative to the parent, as Archi stores them. Bendpoints are a JSON list in text, in Archi's relative `startX/startY/endX/endY` form, because Nendo has no list type. Legend options are JSON text for the same reason |
| **Property** | Key, value, order, and one owner of: concept, view, folder, diagram item, model | Archi's ordered key/value lists. A Nendo reference targets one type, so a property has five optional owner references, exactly one set; each owner's page lists its properties |

**What stays in code.** The relationship table (3,973 lines of generated source in
archi-online), the 25 viewpoints, the figures, the label-expression grammar and the
validator's rules are ArchiMate's, not the modeller's, and they do not change with a
model. They live in the package, generated from archi-online's tables as archi-online
generates them from Archi's `relationships.xml` and `viewpoints.xml`. Kept as records,
the relationship table alone would cost about 4,000 writes before the first element.
If W-105 builds an Engine-checked constraint, the table becomes records then.

**Screens without the view.** Studio lists every type. The Use side adds a Concepts
list by layer, a Views list, and a Concept page with related relationships,
occurrences and properties. They are there so the model stays readable and editable
when the view is off or broken.

## Scope

In means built under I-007; Later means kept in the planner and not scheduled; Out means
not built, with the reason.

| archi-online area | Standing | Work |
| --- | --- | --- |
| ArchiMate 3.2 metamodel, junctions, relationship attributes | In | W-107 |
| Folders, model tree, filter and search, rename, drag to folder | In | W-109 |
| Properties panel and property lists | In | W-109 |
| Diagram rendering: both figures per type, groups, notes, view references, connections, bendpoints, Manhattan router, nesting, zoom, navigator | In | W-110 |
| Editing: palette, create, move, resize, nest, connect, reconnect, bendpoints, magic connector, delete, direct rename, with edits collected and committed | In | W-111 |
| Undo and redo | In | W-103, W-112 |
| Align, distribute, match size, grid and snap, z-order, copy and paste, duplicate, format painter | In | W-113 |
| Appearance: colours, alpha, gradient, line style and width, icons, fonts, text position; label expressions; legends | In | W-114 |
| Automatic relationships on nesting, Generate View For, ELK layout | In | W-115 |
| Viewpoints: palette filter, ghosting | In | W-116 |
| Validator: the eight Archi 5.9 checks | In | W-117 |
| Analysis: model relations, used in views, Visualiser | In | W-118 |
| Specializations, properties manager, find and replace | In | W-119 |
| `.archimate` open and save | In, without images | W-120 |
| Open Exchange XML, with XSD validation | In | W-121 |
| Archi's three-file CSV | In | W-122 |
| PNG and SVG export | In | W-123 |
| Static HTML report | Later | W-124 |
| Set concept type, invert relationship | In, with the editor | W-111 |
| `.architemplate` templates, import and merge of another model, cross-model paste | Later | none yet |
| Images: image nodes, element and specialization images | Out: binary fields in user data need an ADR | F-208 |
| C4 profile, packed capability maps and heatmaps | Out: the Capability Atlas is Nendo's capability map | none |
| jArchi scripting and archi-online's extension runtime | Out, by the owner's scope | none |
| Share links, gists, read-only viewer URLs, PWA, IndexedDB autosave, dock layout | Out: they are the browser's answer to what the file and Nendo's window already do | none |
| Presentation mode, settings dialog | Later | none yet |
| Collaboration | Out, as in archi-online and in Nendo's vision | none |
| Sketch and Canvas views | Out, as in archi-online | none |

## Nendo limits this design meets

| Limit | What the design does | Host work |
| --- | --- | --- |
| A reference targets exactly one record type | One Concept type; one Diagram item type; five owner references on Property | None (D-001) |
| A choice holds 32 options | The ArchiMate type is a reference to Concept type | None |
| No list or JSON field kind | Bendpoints and legend options as JSON text | None; noted, not requested |
| No rule refuses an invalid relationship on every path | The view offers only valid types; the validator reports the rest | W-105, Later (D-003) |
| A view writes one record per call, each its own revision | A gesture is several writes, not atomic, and several History rows | W-102 |
| No undo | Edits wait in the editor, where archi-online's Undo and Redo work on them, until Commit. See below | W-103, W-112 |
| A view cannot read a file the person picks | `.archimate`, XML and CSV import wait for it | W-104 |
| A view is only a record-type screen or a record-page panel | The workbench is a screen of View | W-106, Later |
| The operation-row and revision-row bounds, about 100,000 each | See [the write budget](#the-write-budget) | W-101 (D-002) |
| A calculated field was shown, not filtered | *On views* and *Diagram objects* are counts; since F-222 a list filters on them, so *Not on any view* and *Empty views* are screens | Fixed 2026-09-30; see [the validator](#the-validator) |
| Binary fields are out of scope | Images are dropped on import, with a notice | F-208 |
| No search across record types | The workbench's tree search covers the model | None |

**Edits wait, then commit (W-111).** The owner's suggestion, 2026-09-29. Edit opens the view
in archi-online's own ViewEditor and Palette, on an archi-online store filled from the mirror.
Each gesture is a transaction on that store and writes nothing. Undo and Redo are
archi-online's own, over what waits. Commit writes the difference between the model as last
read and the model now (`tools/archi/canvas/records.ts`): one revision, a create or delete per
record and a field set per field the edits changed. A field somebody else set in the meantime
keeps its value. Discard drops the edits. They are kept in the view's `localStorage` with the
view they were made on, so leaving the screen or Back opens the editor on them again, carried
onto the file as it now stands. A refused commit keeps them waiting. Commit admits
at most 200 record writes; a larger difference is refused before any request is
sent and leaves all edits available for undo, adjustment or discard. The bound is the
Commit's alone: its later writes point at records its earlier ones create, which a second
batch cannot name. Other gestures, such as deleting a large folder from the tree, still go in
batches of 200, and a Nendo without `records.batch` writes one by one without a batch limit.

This changes the budget below: rows follow the net change, not the gestures. Two drags of one
box, an undo and a redo commit as one field set of its place in one revision (measured by
`Review-ArchiWorkbench.ps1`). A session that moves boxes about until they sit right costs the
rows of where they ended.

Measured by the same lane on 2026-09-29: an editing session on Archisurance's Layered View of
twelve gestures — two drags of one box, an undo and a redo, an element placed from the palette,
a relationship refused and one drawn, a resize, a nest into a group, a new bendpoint, a
reconnected end, a delete from the view that was discarded, and one more drag whose first
commit was refused — committed **17 operation rows in four revisions**. The drag that was
undone, the refused relationship, the discarded delete and the refused commit cost nothing:
about 1.4 rows a gesture made, against the 1.7 the scenario below assumes. What collecting saves
is every gesture that is undone, discarded or made again before it is committed.
Editing a view holds file changes back while the pointer is pressed, because archi-online
cancels a drag whose model is replaced under it.

**Undo may not need the host.** archi-online keeps every transaction's inverse
patches. The view can offer undo by writing a gesture's inverse as a new revision,
version-checked so that a record changed since is refused rather than overwritten.
That is compensation done by the view, and it declares no universal undo. W-103 is
then only needed if undo should also reach History's own compensation. W-112 tries the
view's route first.

## The validator

W-117. Archi's validator is archi-online's `validateModel`, bundled in `canvas.js` and run on the
mirror: the eight Archi 5.9 checks, which a person can turn off, and archi-online's
model-integrity pass. Nothing about the rules is rewritten, so parity is a question of the
mirror. `tools/archi/validation.test.mjs` answers it: each of archi-online's example models and
phase fixtures (the two malformed phase 2 files aside, since records cannot hold a connection
whose end is missing) and each case of archi-online's validation tests, flagged and cleared, is
turned into records as an import writes them, read back through the mirror and validated. The
issues, their messages, locations and objects must equal what archi-online reports for the model
itself (`validation-parity.json`). On 2026-09-30 all 25 did: Archisurance has 64 nested-element
advices and 8 duplicate names, and the integrity pass finds nothing in any of them. The panel
jumps to what an issue names, and validates the editor's model, waiting edits included, while a
view is edited (`Gate-ArchiWorkbench.mjs`).

**How far the checks reach without code**, recorded for Nendo:

| Check | Declarative? | Why |
| --- | --- | --- |
| Unused elements, unused relationships | Yes | A calculated *On views* count (`RelatedAggregate` over Diagram item's concept) shows in the Elements and Relationships lists and on a concept's page, and Concepts → *Not on any view* lists the concepts whose count is 0. Until F-222 was fixed (2026-09-30) a list could not filter on a calculated field (`NUI214`, refused on Archi.nendo itself), so the count was a column to read by eye. The count is third in Elements and Views, where a host that drew only three fields (F-225) draws it too (`tools/archi/definition.test.mjs`); a `ui.moveNode` sets one node's position and renumbers none, so the first move tied it with Folder, behind it |
| Empty views | Yes | The same, as *Diagram objects* on Views, with Views → *Empty views*. A view of more than 256 objects had no count but `calculation-limit-reached` (measured on a view of 300) until a plain count on a read became the store's own count (F-223, 2026-09-30) |
| Invalid relationships | No | Needs ArchiMate's relationship table (about 4,000 lines), which is package code (D-003); W-105 would make it an Engine constraint |
| Viewpoint violations | No | Needs the 25 viewpoints' element lists, package code |
| Nested elements | No | Compares a box's parent box with the relationships between their concepts: two hops over two record types and a type test |
| Duplicate names | No | Compares records of the same type with each other; a unique field is unique across all concepts, not per type, and would refuse the write rather than report it |
| Mixed junction relationships | No | Compares the types of every relationship at a junction |

The counts are not free for the workbench, which reads every concept and view after each change
and so has them calculated each time. Measured on 2026-09-30 against the Engine, reading all
concepts and views in pages of 200 (median of seven): 1.5 ms without them and 10.2 ms with them
at Archisurance's size (296 concepts, 17 views, 448 diagram objects), and 12.4 ms against 91.1 ms
at 5,000 concepts, 200 views and 7,500 objects; with the counts answered by the store's own count
(F-223), 7.0 ms and 67.3 ms. That is kept, as the price of a model that says
which of its concepts are unused without the workbench.

## The write budget

A file refuses writes at 99,000 rows of `__nendo_operation`, and inspects
`__nendo_revision` against the same bound
(`SqliteNendoStore.Inspection.cs`). Until 2026-09-30 nothing compacted either table; now a
person folds older history into a checkpoint ([ADR-0021](../decisions/0021-folding-old-history.md),
W-101), which brings a file back to what its last 1,000 revisions (at most 25,000 rows) wrote.

**What a write costs.** Read from the Engine, not measured: a record created or deleted
is one operation row whatever it holds (the bound's own note measures 10,003 rows for
10,000 records), and a field set is one row per field
(`NendoApplicationService.SetFieldsAsync` makes one `SetFieldOperation` per value). A
save is one revision.

**What a gesture costs, measured.** A temporary test in archi-online (at `6205a6a`,
removed after the run) loaded Archisurance, ran archi-online's own operations, and
diffed the model before and after each one at this design's field granularity: one row
per created or deleted record, and one per changed field, with bounds as four fields
and bendpoints as one. Run on 2026-09-29.

| Gesture on Archisurance | Rows |
| --- | --- |
| Move one object | 2 |
| Move five objects | 10 |
| Resize one object (width and height) | 2 |
| Create an element on the view (concept and diagram item) | 2 |
| Create a relationship on the view (concept and connection) | 2 |
| Rename an element | 1 |
| Write documentation | 1 |
| Fill colour on three objects | 3 |
| Align five objects left | 4 |
| Match size of five objects | 4 |
| Distribute five objects | 3 |
| Add a bendpoint | 1 |
| Nest an object in a group | 3 |
| Delete an element from the model (with its occurrence and relationship) | 4 |

**Importing Archisurance** costs 787 rows: 120 elements, 176 relationships, 17 views,
249 diagram objects, 199 connections and 26 folders, each one create.

**Drawing Archisurance by hand** is a scenario built from those costs, with its
assumptions stated. Each element is created on a view (2 rows), each other diagram
object added (1), each relationship drawn (2) and each other connection added (1).
Every named concept is renamed once (1), and every diagram object is moved three times
and resized once (8). Every bendpoint is edited twice (1 each), and every styled
object gets its colour or font (1). That is **about 3,200 rows over about 1,900
gestures, 1.7 rows a gesture**. One file holds that about 31 times.

**An hour of modelling** is where the number becomes a rule. At one gesture every six
seconds of active work, an hour costs about 1,000 operation rows and at least 600
revisions. A file then stops accepting writes after **about 100 hours of active modelling**. An
architect who models two hours a day reaches it in about three months. Without batch writes
every record written is its own revision; with them (W-102) a gesture is one revision,
and the revision bound binds later, at about 165 hours. The operation bound does not
move either way.

Storing bounds as one field instead of four would make a move one row and bring the
scenario to about 2,200 rows. It trades typed, readable data for at most 1.5 times the
life, and it does not change the conclusion. The design keeps bounds typed.

**What this means for D-002.** Batching (C) is needed for atomic gestures but saves
no operation rows. Raising the bound (B) moves the wall and raises the cost of opening
the file, which inspects every row. Only history compaction (A) lets a modelling file
live for years. The recommendation is to build W-102 first, write W-101's ADR for
compaction, and meanwhile treat a file as good for about 100 active hours. View state
such as zoom and open tabs stays in the device's `localStorage`, because every
`nendo.state` write also costs a row.

## A new model

One file is one model, so a second model is a new file of Archi, made with **File → New Archi
model…** ([ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md),
W-130), never by deleting the first: deleting Archisurance costs 779 operation rows, keeps every
value in History and reserves every `ar-` record ID, so importing it again collides. What a new
file keeps is the application's: Concept type keeps its 72 records by default, and the nine
top-level folders are each marked kept. The rest is a model's work and is left out, the Model
record too, so the workbench starts an empty one (*New model*) in a file that has none.
`tools/Build-Archi.mjs` sets the default and the label in its `newFile` stage, marks the folders
in `seed`, and `compare` checks that a new file would keep 81 records and nothing points out of
them. The Archi lane (`Gate-ArchiWorkbench.mjs`, `emptyModel`) measures the empty model: one
model created, nine folders under it.

## Archi's own files

The workbench opens and saves `.archimate` files (W-120) with archi-online's parser and
serializer, bundled in `canvas.js` with fflate for Archi's archives
(`tools/archi/canvas/io.ts`). The person chooses the file in the workbench's own dialog,
because a picker opens only on a click inside the view ([ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md),
files a person hands a view), or drops it on the workbench.

- **Open into an empty model.** One file is one model, so Open reads into a file with no
  model yet, which **File → New Archi model…** makes; a file that holds a model is refused
  before anything is chosen. The mapping is the one `tools/Import-Archimate.mjs` has always
  used, now shared from `io.ts`: record IDs are `ar-` and the Archi ID, each top-level folder
  keeps its record and takes Archi's ID, documentation and label expression, and the Model
  record takes the name, purpose and Dublin Core metadata.
- **Batches.** Archisurance is 778 records and a Model update: four `records.batch` calls of
  at most 200, each one revision named *Open ‹file› (n of m)*. A reference to a record an
  earlier batch made names version 1, one to a record the file held names its version, one
  within the batch names none. A refusal part-way leaves the earlier batches, and the status
  line says how many went through.
- **Order.** Archi keeps a folder's concepts and views, and each object's outgoing and
  incoming connections, in the order its file holds them, and archi-online's semantics compare
  that order. The `order` stage gives concepts and views an *Order in folder*; a connection's
  *Order* is the order Archi drew it in, one sequence that keeps both of each object's lists,
  since Archi appends a connection to both as it is drawn. A concept, view or connection the
  workbench makes has none and comes after, as it came.
- **Save** downloads plain XML, each object under its Archi ID: the one it came with, or its
  record ID without `ar-`.
- **Left out.** Images (F-208): image objects, the connections that end on one, pictures on
  figures and specializations, and an archive's image files. The dialog counts each.

**Pictures of a view** (W-123) are archi-online's own export (`renderViewSvg`, in
`canvas.js`): the view drawn offscreen, its labels turned into SVG text, cropped with Archi's
10-pixel margin; PNG at 1×, 2× or 4× through a canvas, capped at 16,384 pixels a side and 64
million in all; SVG; and Copy as picture. Chosen in Nendo's row, a command reaches the view
without focus, and the clipboard refuses a frame without focus ("Document is not focused."),
so Copy takes focus first (measured in a real host, G36 of `Review-ExtensionViews.mjs`). Copy
always keeps the white page: a transparent picture pasted from Windows' bitmap shows its
see-through pixels as black (F-231).

Measured on 2026-10-01 by `tools/archi/verify-archimate-io.mjs`: Archisurance, phase 1
online and desktop, phase 2 online and desktop, and phase 3, each opened into an empty model,
saved, and read back by archi-online, have the original's Phase 2 semantics with the images
taken out, and Desktop Archi 5.9.0.202604140726 opens and saves each save with the same
semantics. Before the order fields, Archisurance came back with 362 differences
(`$.folders[0].itemIds[0]: "1393" != "843"`); before the connection order, with 122
(`$.nodes[24].sourceConnectionIds[0]: "3755" != "3752"`). Files imported before W-120 carry
no order, so their folders and connections save in record order.

## How it is built and checked

- **The file.** `tools/Build-Archi.mjs` builds `workspace/Archi.nendo` from an empty
  file over MCP, as `tools/Build-Planner.mjs` builds the planner: the schema as five change
  sets, then the seeded folders, concept types and model record, then a comparison of the
  seeded types with their table (W-107). `tools/archi-definition.mjs` holds the shape and
  `tools/archi-concept-types.mjs` the 72 types, generated from archi-online. The empty file
  is made by Nendo itself: `Nendo.Desktop.exe -new <path>`, the command Explorer's New menu
  sends. `tools/Import-Archimate.mjs`
  loads an `.archimate` file over MCP (W-108): it runs archi-online's
  own `parseArchimate` (bundled with esbuild, jsdom for the `DOMParser`), maps the model
  onto the record types with the workbench's own mapping (`io.ts`, W-120), writes them in the order their references need, and
  compares every count, bound and bendpoint with the parse. Record IDs are `ar-` and the
  Archi ID, so a reference is known before its target is written.
- **Parity.** archi-online's fixtures are the oracle: Archisurance, the phase 1 to 3
  pairs and their `*.semantics.json` contracts, and the exchange samples. Each work item
  compares its output with archi-online's for the same input, by script, and W-125
  gathers them into one lane.
- **Measurement over screenshots.** Geometry is compared as numbers (bounds, routes),
  and the budget is re-measured once the editor writes for real (W-111).

## Sources

- archi-online, commit `6205a6a`: `ARCHITECTURE.md`, `docs/wiki/Archi-Compatibility.md`,
  `docs/wiki/User-Guide.md`, `src/model/types.ts`, `src/model/store.ts`,
  `src/model/data/`, and the deleted gap register at `git show b7a887b^:PARITY.md`.
- Nendo: [custom views](../contracts/custom-views.md),
  [relationships](../contracts/relationships.md),
  [calculations and actions](../contracts/calculations-and-actions.md),
  [CSV](../contracts/csv.md), [ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md),
  [ADR-0019](../decisions/0019-hierarchies-in-the-schema.md),
  `src/Nendo.Engine/Storage/SqliteNendoStore.Inspection.cs`.
