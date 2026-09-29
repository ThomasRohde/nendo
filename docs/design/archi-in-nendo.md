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
- **The package is built.** Its TypeScript is bundled with esbuild into plain files in
  the package folder, so the file carries what the Atlas carries: HTML, JavaScript and
  CSS. The dev loop is W-063's *Develop from folder*.
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
| **Concept** | Name, type (Concept type, required), documentation, folder, source and target (both Concept), access type (Write, Read, Access, Read and write), influence strength, directed, junction type (And, Or), specialization, Archi ID | Elements and relationships in one type (D-001). A relationship's source or target may be another relationship, and a junction is an element, so neither needs anything new. A Concept page lists its relationships from and to it and its occurrences |
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
| Editing: palette, create, move, resize, nest, connect, reconnect, bendpoints, magic connector, delete, direct rename | In | W-111 |
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
| No undo | The mirror keeps each gesture's inverse. See below | W-103, W-112 |
| A view cannot read a file the person picks | `.archimate`, XML and CSV import wait for it | W-104 |
| A view is only a record-type screen or a record-page panel | The workbench is a screen of View | W-106, Later |
| The operation-row and revision-row bounds, about 100,000 each | See [the write budget](#the-write-budget) | W-101 (D-002) |
| A calculated field is shown, not filtered | An *Unused elements* screen cannot filter on an occurrence count; the validator panel does it in code | Measured in W-117 |
| Binary fields are out of scope | Images are dropped on import, with a notice | F-208 |
| No search across record types | The workbench's tree search covers the model | None |

**Undo may not need the host.** archi-online keeps every transaction's inverse
patches. The view can offer undo by writing a gesture's inverse as a new revision,
version-checked so that a record changed since is refused rather than overwritten.
That is compensation done by the view, and it declares no universal undo. W-103 is
then only needed if undo should also reach History's own compensation. W-112 tries the
view's route first.

## The write budget

A file refuses writes at 99,000 rows of `__nendo_operation`, and inspects
`__nendo_revision` against the same bound
(`SqliteNendoStore.Inspection.cs`). Nothing compacts either table.

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

## How it is built and checked

- **The file.** `tools/Build-Archi.mjs` builds `workspace/Archi.nendo` from an empty
  file over MCP, as `tools/Build-Planner.mjs` builds the planner: the schema as change
  sets, then the seeded folders and concept types (W-107). A converter turns an
  `.archimate` file into one CSV per record type for the native import, which loads
  Archisurance before any host feature exists (W-108).
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
