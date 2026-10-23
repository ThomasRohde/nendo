# Archi in Nendo: the design

`workspace/Archi.nendo` is an ArchiMate modeller built as a Nendo application, and
`extensions/archi/` is its view. It follows archi-online (the sibling repository
`../archi-online`), the browser clone of desktop [Archi](https://www.archimatetool.com/) 5.9, and
runs offline in Nendo. Its purpose is to find how far Nendo can be pushed: where Nendo falls short,
the gap becomes a host feature with its own ADR rather than a workaround hidden in the view.

## The shape of the solution

- **One file is one model.** Each model is its own `.nendo` file, and several files open in their
  own windows.
- **The records are the model.** Elements, relationships, folders, views, diagram objects,
  connections and properties are ordinary records, so Studio, CSV, History and MCP work on a model
  without the Archi view.
- **The Archi window is one custom view.** The package `extensions/archi` carries the workbench:
  model tree, diagram editor, palette, properties, validator and analysis. It is a view of the file
  itself, and Archi.nendo opens on it.
- **archi-online's model code is reused, not rewritten.** Its `src/model` has no React and makes
  every change inside an Immer transaction. The view keeps a mirror of the file's records in
  archi-online's `ModelState` shape, runs archi-online's operations against it unchanged, and writes
  the difference before and after as typed Nendo writes: one record created or deleted, or one
  field set, per changed value. Ported code keeps archi-online's MIT notice.
- **The package is plain JavaScript, with one built file.** `view.js` and `model.js` need no build.
  `canvas.js` is archi-online's renderer, geometry and router with the mirror and the camera
  (`tools/archi/canvas`), bundled with React by esbuild (`tools/archi/build-canvas.mjs`) at the
  pinned archi-online commit `6205a6a`. It is committed, so neither the file nor the tests need
  archi-online.
- **Changes from elsewhere reach the mirror.** The view listens to `changes` and reads again what
  changed. A write refused as stale reloads the records it touched and tells the person, rather
  than overwriting.

## Record types

Every type that Archi identifies carries an **Archi ID**: unique single-line text holding the `id`
Archi wrote. It keeps identity across `.archimate` round trips, and CSV import resolves references
by it.

| Type | Fields | Notes |
| --- | --- | --- |
| **Model** | Name, documentation, language, version, the 15 Dublin Core fields as text, Archi ID | One record |
| **Folder** | Name, kind (Strategy, Business, Application, Technology, Motivation, Implementation & Migration, Other, Relations, Views; empty for a user folder), documentation, label expression, parent, order, Archi ID | A hierarchy ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)); the nine top-level folders are seeded |
| **Concept type** | Key (unique, for example `BusinessActor`), name, category (Element, Relationship), layer (nine options), default fill, default width and height, relationship letter | 72 seeded records: 61 element types and 11 relationship types. A choice holds 32 options, so the type is a reference to this lookup, which also carries the notation's defaults |
| **Concept** | Name, type (Concept type, required), category (Element or Relationship, so a screen can filter on it), documentation, folder, order in folder, source and target (both Concept), access type (Write, Read, Access, Read and write), influence strength, directed, junction type (And, Or), specialization, Archi ID | Elements and relationships in one type, because a reference targets one type. A relationship's end may be another relationship, and a junction is an element. A Concept page lists its relationships from and to it and its occurrences |
| **Specialization** | Name, concept type, Archi ID | Archi's profiles, without images |
| **View** | Name, documentation, folder, order in folder, viewpoint (the viewpoint's key), router (Manual, Manhattan), Archi ID | Sketch and Canvas views are out, as in archi-online |
| **Diagram item** | View (required), kind (Element, Group, Note, View reference, Relationship connection, Connection), concept, referenced view, parent, order, source and target (both Diagram item), x, y, width, height, bendpoints, name, documentation, content, figure, border type, connection type, name visible, text alignment and position, fill, line and font colour, fill, line and font alpha, gradient, line style and width, icon visibility and colour, derived line colour, font, label expression, legend options, Archi ID | Nodes and connections in one type, because a connection may end on another connection. Nesting is the hierarchy; order is z-order. Bounds are typed integers relative to the parent, as Archi stores them. Bendpoints are a JSON list in text, in Archi's relative `startX/startY/endX/endY` form, and legend options are JSON text, because Nendo has no list type |
| **Property** | Key, value, order, and one owner of: concept, view, folder, diagram item, model | Archi's ordered key/value lists. A reference targets one type, so a property has five optional owner references, exactly one set; each owner's page lists its properties |
| **Allowed relationship** | Source type, target type, relationship type (each a Concept type) | ArchiMate's relationship table as 12,829 seeded records, kept in a new file. Concepts declare a link rule over it ([ADR-0026](../decisions/0026-allowed-links.md)): Source, Target and Type on a relationship, Type on each end. The table's *Relationship* end is spelled out for each of the eleven relationship types |

| **Agent ask** | Request, mode (Propose, Answer), context, state (Waiting, Working, Answered, Proposed, Failed, Cancelled), progress, reply, asked, finished | A request from the workbench's Agent panel to the person's launched agent, written before the agent is messaged ([ADR-0033](../decisions/0033-a-view-messages-the-launched-agent.md)). Its context names the open view and the selection by record ID, as text, so nothing an agent was asked about stops a delete |
| **Agent proposal** | Ask, title, summary, view, writes, status (Proposed, Applied, Rejected), order | A change the agent would make, as record writes in JSON without versions; the person previews it in the editor and applies or rejects it. The file's skill package `org.nendo.archimate` tells an agent both protocols |

**What stays in code.** The relationship table, the 25 viewpoints, the figures, the
label-expression grammar and the validator's rules are ArchiMate's and do not change with a model.
They live in the package, generated from archi-online's tables. The relationship table is also
records (*Allowed relationships*, seeded by `tools/Build-Archi.mjs` from
`tools/archi-relationships.mjs`), because the Engine reads it to refuse an invalid relationship
from the view, a form, CSV, an agent or an automatic action; the package keeps its own copy for the
palette, the magic connector and the validator.

**Screens without the view.** Studio lists every type. Use adds a Concepts list by layer, a Views
list, and a Concept page with related relationships, occurrences and properties, so the model stays
readable and editable when the view is off or broken.

## Scope

| archi-online area | Standing |
| --- | --- |
| ArchiMate 3.2 metamodel, junctions, relationship attributes | In |
| Folders, model tree, filter and search, rename, drag to folder | In |
| Properties panel and property lists | In |
| Diagram rendering: both figures per type, groups, notes, view references, connections, bendpoints, Manhattan router, nesting, zoom, navigator | In |
| Editing: palette, create, move, resize, nest, connect, reconnect, bendpoints, magic connector, delete, direct rename, set concept type, invert relationship | In, with edits collected and committed |
| Undo and redo | In |
| Align, distribute, match size, grid and snap, z-order, copy and paste, duplicate, format painter | In: archi-online's own operations, in its context menu and Nendo's row |
| Appearance: colours, alpha, gradient, line style and width, icons, fonts, text position; label expressions; legends | In: archi-online's Appearance and Label tabs beside the view; legend options kept and drawn, not edited |
| Automatic relationships on nesting, Generate View For, ELK layout | In, with ELK in a worker from the package; a generated view is saved as one revision, and History cannot reverse it, since it creates records |
| Viewpoints: palette filter, ghosting | In: archi-online's table, checked against Desktop Archi 5.9's `viewpoints.xml` |
| Validator: the eight Archi 5.9 checks | In |
| Analysis: model relations, used in views, Visualiser | In |
| Specializations Manager, Properties Manager, Find and Replace | In, under Tools in Nendo's row; each saved as one revision |
| `.archimate` open and save | In, without images |
| Open Exchange XML, with XSD validation | In: told from an .archimate by its content; saved after libxml2 checks it against Archi 5.9's schemas, in `xsd.js`, loaded only then |
| Archi's three-file CSV | In |
| PNG and SVG export | In |
| Static HTML report, presentation mode, settings dialog, `.architemplate` templates, import and merge of another model, cross-model paste | Later |
| Images: image nodes, element and specialization images | Out: Archi.nendo holds no images |
| C4 profile, packed capability maps and heatmaps | Out: the Capability Atlas is Nendo's capability map |
| jArchi scripting and archi-online's extension runtime | Out |
| Share links, gists, read-only viewer URLs, PWA, IndexedDB autosave, dock layout | Out: the file and Nendo's window already do what they do in a browser |
| Collaboration | Out, as in archi-online and Nendo's vision |
| Sketch and Canvas views | Out, as in archi-online; the Open dialog counts them under Left out |

## Nendo limits this design meets

| Limit | What the design does |
| --- | --- |
| A reference targets exactly one record type | One Concept type; one Diagram item type; five owner references on Property |
| A choice holds 32 options | The ArchiMate type is a reference to Concept type |
| No list or JSON field kind | Bendpoints and legend options as JSON text |
| The operation-row and revision-row bounds | See [the write budget](#the-write-budget) |
| A calculated count on every read | *On views* and *Diagram objects* cost a read; kept as the price of a model that says which concepts are unused without the workbench |
| No search across record types | The workbench's tree search covers the model |

## Editing: edits wait, then commit

Edit opens the view in archi-online's own ViewEditor and Palette, on an archi-online store filled
from the mirror. Each gesture is a transaction on that store and writes nothing. Undo and Redo are
archi-online's own over what waits. Commit writes the difference between the model as last read and
the model now (`tools/archi/canvas/records.ts`): one revision, a create or delete per record and a
field set per field the edits changed. A field somebody else set meanwhile keeps its value. Discard
drops the edits. Waiting edits are kept in the view's `localStorage` with their view, so leaving the
screen or Back opens the editor on them again, carried onto the file as it now stands. A refused
commit keeps them waiting.

- Commit admits at most 200 record writes; a larger difference is refused before any request is
  sent and leaves all edits available. The bound is the Commit's alone, because its later writes
  point at records its earlier ones create, which a second batch cannot name. Other gestures, such
  as deleting a large folder from the tree, go in batches of 200; a Nendo without `records.batch`
  writes one by one.
- Rows follow the net change, not the gestures: two drags of one box, an undo and a redo commit as
  one field set of its place in one revision.
- Editing a view holds file changes back while the pointer is pressed, because archi-online cancels
  a drag whose model is replaced under it.

**Undo after commit.** Every gesture the workbench writes is one `records.batch`, and the workbench
keeps only its revision; Nendo undoes it ([ADR-0023](../decisions/0023-a-view-undoes-its-own-revisions.md)).
`records.undo` compensates the batch whole, a deleted record restored from its retained values, a
created one deleted, version-checked, and `records.redo` compensates the undo. A view cannot undo a
delete by creating the record again, because a deleted record ID stays reserved
(`record-id-reserved`). A record changed, deleted or newly pointed at by somebody else refuses the
step, and nothing is written. The steps are the visit's, a gesture over 200 writes is not
undoable, and History compensates the same revisions, creates included.

## The validator

The validator is archi-online's `validateModel`, bundled in `canvas.js` and run on the mirror: the
eight Archi 5.9 checks, which a person can turn off, and archi-online's model-integrity pass.
Nothing about the rules is rewritten, so parity is a question of the mirror.
`tools/archi/validation.test.mjs` turns each of archi-online's example models, phase fixtures and
validation cases into records as an import writes them, reads them back through the mirror and
requires the issues, messages, locations and objects archi-online reports
(`validation-parity.json`). The panel jumps to what an issue names, and validates the editor's
model, waiting edits included, while a view is edited.

How far the checks reach without code:

| Check | Declarative? | How |
| --- | --- | --- |
| Unused elements, unused relationships | Yes | A calculated *On views* count (`RelatedAggregate` over Diagram item's concept) in the Elements and Relationships lists and on a concept's page; Concepts → *Not on any view* filters on it. The count is third in Elements and Views (`tools/archi/definition.test.mjs`) |
| Empty views | Yes | *Diagram objects* on Views, with Views → *Empty views* |
| Invalid relationships | Yes | The Engine refuses one on every path. The validator keeps its own check, from the package's table, for a file that has not declared the rule |
| Viewpoint violations | No | Needs the 25 viewpoints' element lists |
| Nested elements | No | Two hops over two record types and a type test |
| Duplicate names | No | Compares records of one type with each other; a unique field is unique across all concepts and would refuse the write rather than report it |
| Mixed junction relationships | No | Compares the types of every relationship at a junction |

## Analysis and the Visualiser

A concept's Analysis is archi-online's `modelRelations` and `viewsUsing` on the mirror, in its
order: relationships starting at the concept, then those ending at it, each by name, and the views
by name; a relationship from a concept to itself is listed once. A view in it opens with the object
archi-online's `findInView` names selected. The Visualiser is archi-online's `buildAnalysisGraph`,
its layout request, ELK in the package's worker and its `VisualiserCanvas`, in `canvas.js`, laid out
left to right as archi-online does. The panel around it is the workbench's, because archi-online's
`VisualiserPanel` reads stores of archi-online's own app; its controls are the same and are kept in
the view's `localStorage`. The SVG export is archi-online's `renderAnalysisGraphSvg`.
`tools/archi/analysis.test.mjs` measures it against `analysis-parity.json`, made by
`make-analysis-fixture.mjs` from archi-online's own models.

## The model tools

The Specializations Manager, the Properties Manager and Find and Replace are archi-online's own
operations (`replaceProfiles`, `renamePropertyKey`, `deletePropertyKey`, `applyFindReplace`), run on
a store of their own around the mirror, as Generate View For is (`tools/archi/canvas/manage.ts`).
What reaches the file is `writesFor`'s difference, sent as one `records.batch`: one revision, which
Undo takes back. A change over 200 record writes is refused before anything is written.

`writesFor` plans specializations (name and type), the model's name and documentation, the
top-level folders' name, documentation and label expression (never making or removing them), and
properties. The mirror keeps each property's record ID beside archi-online's key and value, so a
renamed key or replaced value is an update of that record and a deleted key a delete. A property
with no record, new or copied with its object, is a new record after the owner's others; reordering
stays the properties panel's.

## The write budget

A file refuses writes at 99,000 rows of `__nendo_operation`, and inspects `__nendo_revision`
against the same bound (`SqliteNendoStore.Inspection.cs`). A person folds older history into a
checkpoint ([ADR-0021](../decisions/0021-folding-old-history.md)), which brings a file back to what
its last 1,000 revisions (at most 25,000 rows) wrote.

**What a write costs.** A record created or deleted is one operation row whatever it holds, a
field set is one row per field (`NendoApplicationService.SetFieldsAsync` makes one
`SetFieldOperation` per value), and a save or a batch is one revision.

| Gesture on Archisurance | Rows |
| --- | --- |
| Move one object | 2 |
| Move five objects | 10 |
| Resize one object (width and height) | 2 |
| Create an element or a relationship on the view (concept and diagram item) | 2 |
| Rename an element, write documentation, add a bendpoint | 1 |
| Fill colour on three objects | 3 |
| Align or match size of five objects | 4 |
| Distribute five objects | 3 |
| Nest an object in a group | 3 |
| Delete an element from the model (with its occurrence and relationship) | 4 |

Opening Archisurance costs 787 rows. Drawing it by hand costs about 3,200 rows over about 1,900
gestures, 1.7 rows a gesture. At one gesture every six seconds, an hour of active modelling costs
about 1,000 operation rows, so a file without folding stops accepting writes after about 100 active
hours; folding history is what lets a modelling file live for years. Bounds stay four typed fields
rather than one, trading at most 1.5 times the life for typed, readable data. View state such as
zoom and open tabs stays in the device's `localStorage`, because every `nendo.state` write also
costs a row.

## A new model

A second model is a new file of Archi, made with **File → New Archi model…**
([ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md)), never by
deleting the first: a delete keeps every value in History and reserves every `ar-` record ID, so
importing the model again collides. A new file keeps the application's records: Concept type's 72
records by default, the nine top-level folders each marked kept, and the Allowed relationships. The
Model record is left out, so the workbench starts an empty one (*New model*) in a file that has
none. `tools/Build-Archi.mjs` sets the default and the label in its `newFile` stage and marks the
folders in `seed`; `compare` checks what a new file would keep and that nothing points out of it.

## Archi's own files

The workbench opens and saves `.archimate` files with archi-online's parser and serializer, bundled
in `canvas.js` with fflate for Archi's archives (`tools/archi/canvas/io.ts`). The person chooses
the file in the workbench's own dialog, because a picker opens only on a click inside the view
([ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md)), or drops it on the workbench.

- **Open into an empty model.** Open reads into a file with no model yet; a file that holds a model
  is refused before anything is chosen. Record IDs are `ar-` and the Archi ID, so a reference is
  known before its target is written. Each top-level folder keeps its record and takes Archi's ID,
  documentation and label expression, and the Model record takes the name, purpose and Dublin Core
  metadata. `tools/Import-Archimate.mjs` uses the same mapping from `io.ts`.
- **Batches.** `records.batch` calls of at most 200, each one revision named *Open ‹file› (n of m)*.
  A reference to a record an earlier batch made names version 1, one to a record the file held
  names its version, one within the batch names none.
- **Checked before writing.** Before the dialog offers Open, every reference must name a record the
  plan makes or the file holds, and every relationship must be one ArchiMate allows between its
  ends. A file that fails is refused, naming the first offender, before anything is written, as
  ADR-0026 asks. A file that is not well-formed XML is refused too. A refusal part-way, from a
  change made elsewhere meanwhile, leaves the earlier batches, and the status line says how many
  went through.
- **Order.** Archi keeps a folder's concepts and views, and each object's outgoing and incoming
  connections, in file order, and archi-online's semantics compare that order. Concepts and views
  carry an *Order in folder*; a connection's *Order* is the order Archi drew it in, one sequence
  that keeps both of each object's lists. A concept, view or connection the workbench makes has
  none and comes after. A file without order saves in record order.
- **Save** downloads plain XML, each object under its Archi ID: the one it came with, or its record
  ID without `ar-`.
- **Left out.** Images: image objects, the connections that end on one, pictures on figures and
  specializations, and an archive's image files. The dialog counts each.

**Pictures of a view** are archi-online's own export (`renderViewSvg`, in `canvas.js`): the view
drawn offscreen, its labels as SVG text, cropped with Archi's 10-pixel margin; PNG at 1×, 2× or 4×
through a canvas, capped at 16,384 pixels a side and 64 million in all; SVG; and Copy as picture.
A command from Nendo's row reaches the view without focus, and the clipboard refuses a frame
without focus, so Copy takes focus first. Copy always keeps the white page, because a transparent
picture pasted from Windows' bitmap shows its see-through pixels as black.

`tools/archi/verify-archimate-io.mjs` opens Archisurance and the phase 1 to 3 files into an empty
model, saves them and has archi-online read them back with the original's semantics, images aside.

## How it is built and checked

- **The file.** `tools/Build-Archi.mjs` builds `workspace/Archi.nendo` from an empty file over MCP:
  the schema as change sets, then the seeded folders, concept types, allowed relationships and
  model record, then a comparison of the seeded types with their table.
  `tools/archi-definition.mjs` holds the shape and `tools/archi-concept-types.mjs` the 72 types,
  generated from archi-online. The empty file is made by Nendo itself:
  `Nendo.Desktop.exe -new <path>`, the command Explorer's New menu sends.
- **Import over MCP.** `tools/Import-Archimate.mjs` runs archi-online's `parseArchimate` (bundled
  with esbuild, jsdom for the `DOMParser`), maps the model with the workbench's `io.ts`, writes in
  the order references need, and compares every count, bound and bendpoint with the parse.
- **Parity.** archi-online's fixtures are the oracle: Archisurance, the phase 1 to 3 pairs and
  their `*.semantics.json` contracts, and the exchange samples, compared by the tests under
  `tools/archi/`.
- **The lane.** `pwsh ./tools/Review-ArchiWorkbench.ps1` (`tools/Gate-ArchiWorkbench.mjs`) drives
  the workbench in a page: editing and commit, undo, the validator panel, Analysis and the
  Visualiser, and the empty model. Geometry is compared as numbers (bounds, routes), not
  screenshots.

## Sources

- archi-online at the pinned commit: `ARCHITECTURE.md`, `docs/wiki/Archi-Compatibility.md`,
  `docs/wiki/User-Guide.md`, `src/model/types.ts`, `src/model/store.ts`, `src/model/data/`.
- Nendo: [custom views](../contracts/custom-views.md),
  [relationships](../contracts/relationships.md),
  [calculations and actions](../contracts/calculations-and-actions.md),
  [CSV](../contracts/csv.md), [ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md),
  [ADR-0019](../decisions/0019-hierarchies-in-the-schema.md),
  `src/Nendo.Engine/Storage/SqliteNendoStore.Inspection.cs`.
