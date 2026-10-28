# Archi

An ArchiMate 3.2 modeller in the manner of [Archi](https://www.archimatetool.com/), over
Archi.nendo's record types ([the design](../../docs/design/archi-in-nendo.md)). The package is
`org.nendo.archi`, and this folder is exactly what a file carries. `workspace/Archi.nendo`
carries it over Archisurance.

## Use

Archi.nendo opens on the workbench, a view of the file itself. Elsewhere in Use, **Archi** is
the first choice in the breadcrumb's first picker, before the record types. With custom views
off for the file or the device, the file opens on its record types, and Studio is always a
click away.

**A new model** is **File → New Archi model…** (ADR-0022): a new file of Archi with the 72
concept types and the nine top-level folders, and none of this model's concepts, views or
history. The workbench starts an empty model in it, named *New model*; rename it in
Properties. The file you were in does not change.

### The tree, the middle and the properties

- **The model tree** starts at the model and holds Archi's nine top-level folders in Archi's
  order; a folder shows its folders first, then its concepts and views by name. An unnamed
  relationship reads as its type and its two ends. A cyclic endpoint reference ends with
  `[cycle]`, so relationships can still be selected and their properties opened.
- **Find** (Ctrl F) and **Layer**, in Nendo's row, narrow the tree to what matches and open
  the folders on the way. Where the model has specializations, **Specialization** narrows it
  to the concepts given one, and a specialized concept's row says so in its tooltip.
- **The middle** shows what the selection is part of: a concept's relationships and the views
  it is on, a view's objects and connections and the elements on it. Each entry selects its
  record everywhere.
- **Properties** edit the selection's fields as Archi's Properties view does, the
  type-specific ones included (access, influence strength, directed, junction type), and its
  ordered key/value properties. A changed type stays within its category and takes the
  concept to its new layer's folder, as Set Concept Type does. Rapid key/value edits keep
  their pending rows until saved; a refusal keeps the draft for correction or retry.
  Overlapping reads keep the newest model and record versions.
- **New** makes an element of any type (Nendo's Add does the same), a folder or a view. A new
  element goes to the selected folder if it is of its layer, otherwise to its layer's
  top-level folder. The dialog offers the specializations of the type chosen, and New, in the
  row and in the tree's menu, offers each specialization of an element type: an element of
  its type, named after it and given it.
- **Drag** a concept, a view or a folder onto a folder of the same layer's tree; a drop
  anywhere else is not offered. **F2** renames, starting from the stored name, never from the
  label the tree shows a relationship by. **Delete** removes the selection with everything
  Archi removes with it (relationships, the diagram objects and connections that show it,
  what is nested in them, properties), after saying how much that is, as one revision where
  Nendo has batch writes.
- **The keyboard**: the tree is one tab stop; Up, Down, Home and End move, Right opens a
  folder or steps into it, Left closes it or steps out, Enter goes to the properties.
- **Analysis**, in a concept's properties: its **Model relations**, what starts at it and then
  what ends at it, each by name, and the views it is **Used in**, by name, from
  archi-online's own code run on the file's records. A relationship selects it; a view opens
  with the concept's first object on it outlined.
- **Viewpoint**, in a view's properties: None or one of Archi's 25 viewpoints, by name.
  Elements whose type the viewpoint leaves out are drawn faint, with the lines that end on
  them, in the drawing and in the editor, and the palette greys out their types; Junction and
  Grouping are always allowed, and Layered allows everything. The change shows at once. The
  table is archi-online's port of Archi's, checked against the `viewpoints.xml` Desktop Archi
  5.9 ships. A key no viewpoint has, from another tool, is kept and shown as unknown.

### The open view and the editor

- **The open view**: choosing a view draws it in the middle with Archi's own figures, icons
  and connection routes, as archi-online draws them, on white paper in both themes. Drag the
  paper or scroll to pan, Ctrl and the wheel to zoom; Zoom and Fit are in Nendo's row (Ctrl -,
  Ctrl 0, Ctrl +). The navigator in the corner shows the whole view and moves the camera. A
  click selects the object under the pointer and its concept in the tree; selecting a concept
  in the tree outlines every box that shows it; a double-click on a view reference opens that
  view.
- **Edit** (Ctrl E) opens the view in archi-online's own editor: its palette by layer,
  placing, moving, resizing and nesting boxes, drawing relationships of only the types
  ArchiMate allows between the two ends, reconnecting, bendpoints, the magic connector,
  marquee selection, Delete from the view and direct renaming. Edits collect rather than
  write: **Undo** (Ctrl Z) and **Redo** (Ctrl Y) work on them, **Commit** (Ctrl S) writes all
  of them to the file as one revision, up to 200 record writes, and **Discard** drops them. A
  larger Commit saves nothing and keeps every edit waiting; use Undo to reduce it, then
  commit. A box moved five times is one change of its place when committed. Waiting edits are
  kept in this browser, so leaving the screen or the file finds them again, opened in the
  editor, and edits found on another view than the one they were made on say which view that
  was. A change to the file meanwhile is carried under them, and a commit writes only what the
  edits changed. Edit closes only when nothing waits. Edit opens a view fitted to the space.
- The palette is as wide as you drag its edge (or step it with the arrow keys), and its
  buttons fill the width in columns; the width is kept on this device. A box dropped into an
  element box is nested in it, and archi-online's own dialog asks which relationship the
  nesting stands for, None among the choices.
- **Appearance**, a toggle in Nendo's row while editing, shows archi-online's own Appearance
  and Label tabs beside the view for the one box or line selected: fill, line and font colour
  and opacity, gradient, line width and style, font, text alignment and position, icon, the
  alternate figure, a note's border, a plain line's ends, and the label expression with its
  preview. Each change waits like a move and commits to the box's record; the view draws a
  label expression as archi-online evaluates it. The panel starts hidden and this device
  remembers the choice. Its tabs are drawn as Nendo draws tabs. The font list is
  archi-online's common fonts: a view is never allowed the computer's own list. A legend's
  options are kept and drawn, but not edited here.
- **Arrange**, **Copy and paste** and the **editor settings** are menus in Nendo's row while
  editing, with **Lay out**, each an icon whose name shows on hover, and so in Ctrl K. Undo,
  Redo, Appearance, Validator and Export are icons too; what does not fit in a narrow window
  is in Nendo's More menu at the row's end. On a Nendo that lacks the clipboard, layout, undo
  and redo icons, those controls carry their words. Arrange aligns the selected boxes six ways
  to the last one selected, matches their width, height or size, distributes three or more,
  and brings them forward or sends them back. Copy and paste holds cut, copy, paste, paste as
  reference (new boxes for the same elements) or as copy (new elements), duplicate and select
  the same type. The gear holds the grid, snapping to it and to alignment guides, and
  Automatic relationships. Each command is archi-online's own operation, as its context menu,
  still there on a right-click, runs it: one edit waiting and one Undo step. Ctrl+click adds
  to the selection; Ctrl D, X, C and V and the arrow keys work in the view, Shift with an
  arrow by a grid step, and the format painter is in the palette. The grid and snapping
  choices are kept in this view's own storage on this device.
- **Lay out → Left to right** and **Top to bottom** place the boxes selected, or every box at
  the top of the view when fewer than two are, in layers with ELK, and route the lines between
  them at right angles; what is nested in a box moves with it. It is archi-online's own
  layout: one edit waiting and one Undo step. A layout that needs more than the 200 writes a
  Commit can save is taken back at once, and the status line says to lay out a selection.
- **Automatic relationships…**, behind the gear, is Archi's preferences page for nesting:
  whether nesting a box made from the palette, dropped from the tree or moved offers a
  relationship, which types it offers parent to child and child to parent (a Specialization
  always runs child to parent), and which types a nesting stands for, so their lines are not
  drawn. Archi's defaults: six types offered, none reversed, every type hidden while nested.
  The choices are kept in this view's own storage on this device, for every Archi model, and
  the drawing outside Edit follows them as the editor does.
- **Export**, in Nendo's row while a view is open, makes a picture of the view as Archi's
  File › Export › View As Image does: **PNG** at the view's own size, at **2×** or at **4×**,
  **SVG** with every label as text, or **Copy as picture** to paste elsewhere. It is
  archi-online's own export: cropped to the drawing with a 10-pixel margin, in the canvas's
  font, and named after the view. **Transparent background in files** leaves out the white
  page in the PNG and SVG files. Copy as picture copies at 2× and always keeps the white page,
  as Archi's copy does, because a program that pastes Windows' bitmap shows see-through pixels
  as black. The picture is what the view shows, waiting edits included. A PNG too large for
  one picture comes out at the largest scale one holds, and the status line says so.

### Undo and redo

**Undo** (Ctrl Z) and **Redo** (Ctrl Y), in Nendo's row, work on every screen. While edits
wait in the editor they undo and redo those, by archi-online's own steps. Otherwise they undo
what the file has saved, one gesture at a time and newest first: a rename, a change in the
properties, a property list, a new element, folder or view, a move, a delete with everything
it took, a commit of the editor's edits, a generated view, a model tool's change. The button
names the gesture, so Ctrl K and More list *Undo Rename Customer*.

Nendo undoes each gesture (ADR-0023): one revision, linked to the gesture's in History,
version-checked, and a deleted element comes back under its own record ID. If something it
would put back has changed or been deleted since, or is now used by something new, it is
refused with *Something it would put back has changed or been deleted since. Nothing was
changed.* and writes nothing. The steps belong to this visit: they go when the workbench is
left, and a change made elsewhere refuses the steps it touches. A gesture of more than 200
writes, or one made on a Nendo without `records.undo`, is not undoable here, and Undo then
names nothing older, so Ctrl Z never runs the gesture before it instead. A delete that large
says so in its confirmation, and one refused after its first batches says it was done only in
part. Nendo claims no universal undo.

### Generate, validate, visualise

- **Generate view for…**, in the tree's menu on an element and in New: a new view of the
  element, or of the boxes selected on the view while editing, and the elements related to
  them, to a depth of one to six, incoming, outgoing or both, optionally with every
  relationship between them and with a viewpoint the elements fit. It is archi-online's own
  operation, laid out with ELK, saved at once as one revision and opened. Undo takes it away
  as one revision.
- **Validator**, in Nendo's row, opens Archi's validator under the workbench: Archi 5.9's
  eight checks (invalid relationships, unused elements and relationships, empty views,
  viewpoint violations, nested elements without a nesting relationship, duplicate names, mixed
  junction relationships) and its model-integrity pass, grouped by source and severity. It
  runs when opened and on **Validate**, over the file, or over what the editor shows with its
  waiting edits while a view is being edited, and says when the model has changed since.
  Choosing an issue opens what it names: the object on its view, outlined, or the concept,
  view or folder in the tree. Each check is a setting the package declares (`check.` and the
  rule's ID, ADR-0038): the file can turn one on or off for everyone who opens the model, and
  **Rules…** or Nendo's Settings page keeps this computer's choice over it.
- **Visualiser**, in Nendo's row, opens under the workbench archi-online's graph of the
  concept selected and those related to it, laid out by ELK from left to right. It follows the
  selection unless **Pin**ned. A click on a box selects its concept; a double-click makes it
  the focus, and **Back** steps back; **Home** returns to the selection. **Depth** (one to
  six), **Direction**, **Viewpoint**, **Relationship names** and **Types…** change what it
  shows, and this device keeps them. The drawing pans and zooms on white in both themes, and
  **SVG**, **PNG** and **Copy** export it. While a view is being edited it shows what the
  editor shows, waiting edits included.

### Tools

**Tools**, in Nendo's row, holds Archi's three model tools, each archi-online's own operation
run on the file's records and saved as one revision, which Undo takes back:

- **Specializations…** is the Specializations Manager: a table of named kinds of an element
  or relationship type. Add, rename, retype or remove them and **Save** them together. A name
  is unique for its type; one given to concepts keeps its type; one removed is taken from
  every concept that has it, and the dialog says how many. Images are not kept. A concept is
  given one in its properties, from New, or from the editor's palette, which shows each one
  under its type's layer.
- **Properties…** is the Properties Manager: every property key in the model, with how many
  times and on how many objects it is used, and where. **Rename everywhere** gives a key a new
  name on every property that has it; to a key already in use it asks first, and the
  properties stay separate rows. **Delete the key…** takes every property with it away.
  Choosing a place opens its object in the tree or on its view.
- **Find and replace…** searches names and text, documentation and property values, in the
  whole model or in the open view, by case and as a regular expression if asked. **Preview**
  lists every place a replace would change, before and after; untick what to leave, and
  **Replace** changes the rest. A place changed since the preview refuses the whole replace.

A change over 200 record writes is refused whole before anything is written, and while edits
wait in the editor the tools ask for them to be committed or discarded first.

### Archi files

**Archi file**, in Nendo's row:

- **Open .archimate…** reads an Archi model, plain XML or Archi's archive with images, into an
  empty model: make one with **File → New Archi model…** first; in a file that already holds a
  model the dialog says so and offers nothing. Choose the file in the dialog, or drop it
  anywhere on the workbench. The dialog says what the file holds and what is left out, because
  Archi.nendo holds no images: image objects, the connections that end on one, and the
  pictures on figures and specializations; nor Sketch and Canvas views, which it counts, with
  any view reference to one and the connections to such a reference. A file that is not
  well-formed XML, such as one cut short while it downloaded, is refused in the parser's own
  words, and so is one Nendo would refuse part of: a reference to something the file does not
  hold, or a relationship ArchiMate does not allow between its two ends, named in the dialog.
  **Open** saves the model in batches of at most 200 record writes, each a change in History
  named *Open ‹file› (n of m)*. History cannot undo them; to start again, make a new Archi
  model.
- **Save as .archimate** downloads the model as plain XML that Desktop Archi opens, each object
  under the Archi ID it came with, or its record ID without `ar-` when the workbench made it.
  Waiting edits are not in it, and the status line says so.
- **Open Exchange XML**: the same dialog reads The Open Group's exchange format, told from an
  .archimate by what the file holds, and **Open Exchange XML…** in the menu opens it too.
  **Save as Exchange XML** downloads the model in that format with its folders as the
  organization, its language and its Dublin Core metadata, after libxml2 has checked it
  against Archi 5.9's five schemas. A file the schemas refuse is not saved, and the status
  line names what they refused. The check is `xsd.js`, 1.2 MB, which loads only when you save.
- The workbench reads at most 50,000 records of a kind; a file that holds more is said to be
  read in part, by the type's name, and neither Save writes a file that would leave the rest
  out. Like every download, the file goes to Downloads, as `Archisurance (1).xml` when
  `Archisurance.xml` is already there.

### Working with the agent

**Agent** in Nendo's row (Ctrl Shift A) opens the Agent panel under the workbench, where you ask
your own agent, the one Nendo launches on its Agent page ([ADR-0033](../../docs/decisions/0033-a-view-messages-the-launched-agent.md)),
about the model or for a change. The file carries the agent's half as a skill, *Modelling
ArchiMate in Archi* (`org.nendo.archimate`, from `tools/archi/skill/`): the record types,
ArchiMate's allowed relationships, how a view's boxes and lines are stored, and what follows.

- **Ask** sends what you type, with the open view, box by box, and what is selected in the
  editor or the tree. *Propose changes* (the default) has the agent change nothing itself and
  write a proposal; *Just answer* has it reply and write nothing else. Ctrl Enter asks too.
- **Quick asks** above the box follow what is open and selected: explain, review or complete the
  open view; document the selected elements, suggest their relationships or draft a view around
  them; draft a view or a first model from a description; say what the model is missing. With the
  validator's findings listed, **Ask the agent to fix them** in the validator sends them as well.
- **Every request is an Ask** in *Agent asks*, written before the agent is messaged, so a
  refusal, a reload or a closed screen never loses it. The panel shows each Ask's state, the
  agent's last progress line with its step ("2 of 5"), Stop while it runs, and its reply. When
  the agent's turn ends and it left the Ask unfinished, the workbench finishes it with the reply
  it gave. A message Nendo did not send, because you said Not now or views may not message the
  agent, finishes the Ask as Failed with the reason, and **Ask again** sends it once more.
- **A proposal** (*Agent proposals*) is a list of record writes the agent wrote and never
  applied. The panel says what it adds, changes and removes, and names anything the file would
  refuse, such as a relationship ArchiMate does not allow, which keeps Apply from it.
  **Preview** opens it on its view in the editor as the edits waiting there, its new boxes
  selected; boxes the agent gave no place go below the view's boxes, and on a view the proposal
  makes, ELK lays them out. Change them as you like, then **Commit** applies them and marks the
  proposal Applied in one revision, which Undo takes back whole; **Discard** drops the preview
  and leaves the proposal waiting. **Apply** does the same without the editor; **Reject** marks
  it Rejected. When an Ask you just sent ends with proposals and nothing waits in the editor, the
  first opens at once.
- The workbench fills in what the agent may leave out: a concept's category and folder, a box's
  kind and size, a line's two boxes from its relationship's ends; it gives its own IDs record
  IDs, and a delete takes what Archi's would.
- **Clear finished** removes the Asks that are done, with their proposals, unless a proposal
  still waits.
- Where Nendo cannot message an agent from a view, **Leave for the agent** writes the Ask and
  leaves it Waiting: an agent connected to the file over MCP works every waiting Ask when told to
  "work the Archi asks".

### Without the workbench, and on a smaller Nendo

In Use, Concepts → Elements and Relationships show an *On views* column, a concept's page
shows it under Details, and Views → Views shows a *Diagram objects* column (third in Elements
and Views, so a Nendo that draws only three fields shows them too). They are calculated counts
of the diagram objects that show a concept or that a view holds. Concepts → *Not on any view*
and Views → *Empty views* list the zeros.

On a Nendo that cannot draw the controls in its own row, the workbench draws them above the
tree, with Edit, Commit and Discard, so waiting edits are never stranded. The row it declares
to Nendo is kept within Nendo's 16 KiB: with many specializations, New's specialization
entries lose their detail lines, then their number, and the specialization filter its
options, until it fits.

A diagram item whose Bendpoints or Legend options are not readable JSON, after an edit on its
record page or by an agent, is drawn without them; the status line says so when the workbench
starts, and the validator lists each one under Model integrity, opening it on its view.

## Files

- `model.js`: every rule, and every change as the record writes it makes. No DOM, so
  `tools/archi/model.test.mjs` tests it over Archisurance.
- `agent.js`: what a request to the agent says and carries, and a proposal made into the edits
  the editor previews. No DOM, so `tools/archi/agent.test.mjs` tests it over Archisurance.
- `view.js`, `view.css`, `index.html`: the tree, the middle and the properties.
- `canvas.js`: the drawing, the editor, the validator, the Analysis and the Visualiser. Built
  by `tools/archi/build-canvas.mjs` from `tools/archi/canvas` (the mirror of the records as
  archi-online's model and its inverse, the camera, and the editor's mount) with
  archi-online's renderer, geometry, router, ViewEditor, Palette, operations, validator,
  Analysis and VisualiserCanvas, its `.archimate` parser and serializer, with fflate for
  Archi's archives (`tools/archi/canvas/io.ts`), at a pinned commit, and React. Every id
  archi-online makes in it is a record ID, `ar-id-…`. Do not edit it; rebuild it. A rebuild
  from the same sources is byte for byte the same. `THIRD-PARTY.txt` carries the licences of
  what it includes.
- `editor.css`: archi-online's own rules for its editor, palette, menus and Visualiser, with
  its colour variables mapped onto Nendo's tokens.
- `vendor/elkjs/`: the ELK worker that layouts run in, elkjs 0.11.1 unchanged, with its
  licence and hashes. `canvas.js` builds archi-online's layouts against
  `tools/archi/canvas/elk.ts`, which starts this worker, rather than loading ELK on the page.
- `kit/nendo-view-kit.js`: the view kit, byte for byte (`tools/view-kit/kit.test.mjs`).

`node tools/Build-Archi.mjs workbench` puts the package, and the first time its screen, into
the open Archi.nendo; `node tools/Build-Archi.mjs skill` puts the agent's skill, and
`node tools/Build-Archi.mjs agent` the Agent asks and Agent proposals.

## Checked by

`tools/Review-ArchiWorkbench.ps1`, in the production gate, runs:

- **Node tests** in `tools/archi/`: `model.test.mjs`; `canvas.test.mjs` (every Archisurance
  object's bounds and connection's route against archi-online's geometry of its own parse,
  `archisurance-geometry.json`, and unreadable Bendpoints and Legend options); the validation
  test (archi-online's example models and validation cases, turned into records as an import
  writes them, against `validation-parity.json` from `make-validation-fixture.mjs`);
  `io.test.mjs` (the `.archimate` mapping both ways over Archisurance, the versions each batch
  names, refusals before any write, Sketch and Canvas views, and the Exchange export validated
  with libxml2); `automation.test.mjs` (nesting, Generate View For and layout with the
  vendored ELK worker, each read back as the model archi-online left); `agent.test.mjs` (a
  request's message and context within Nendo's bounds, and proposals planned, placed, laid out by
  ELK and made into the writes Commit sends); `manage.test.mjs` (each
  model tool's writes read back, then undone and redone to the byte); and `view.test.mjs`
  (the shipped `view.js`: undo bounds, the 16 KiB row, F2, the 50,000-record read, kept
  edits and the layout bound).
- **The browser lane**: the package framed by the fixture broker over Archisurance
  (`tools/archi/archisurance.json`) in Edge, driven with real keys and clicks, with record
  writes and batches offered. It saves and reopens `.archimate` and Exchange files by a drop
  and through the dialog, and compares every record; refuses cut-short files, a relationship
  to nothing, and leaves out Sketch and Canvas views; exports every Archisurance view and
  checks the crop, text, font, scales, transparency and Copy as picture; nests, arranges,
  lays out and generates views and checks each commit against archi-online's own operation;
  commits Appearance changes and reads them back; checks viewpoint ghosting at 0.4 and the
  palette at 0.35; undoes and redoes nine tree gestures and an editor commit to the exact
  records, and refuses an undo of a record changed elsewhere; runs each model tool, including
  a replace over 200 places refused with nothing written; and measures the rename box's
  contrast (at least 4.5) and the Properties Manager in both themes. With the broker's stand-in
  agent it asks from the Agent panel and checks the Ask, the message and its context, previews a
  proposal on its view, applies it with its Applied mark in one batch that one Undo takes back,
  rejects one, names a relationship ArchiMate refuses, finishes a refused message as Failed, lays
  out and discards a new view, and leaves an Ask waiting where no agent can be messaged. The broker keeps deletion
  history as Nendo does, so a create of a deleted record ID is refused there as in a file.

The Engine's `RecordWritesUndoTests` walk a batch back and forward, a chain of gestures on one
record, and the refusals.

On request, outside the gate:

- `node tools/archi/verify-archimate-io.mjs` opens and saves Archisurance and archi-online's
  phase fixtures, compares archi-online's semantics of each save with the original's, images
  aside, checks every label expression after the trip through the records, and has Desktop
  Archi open and save each one again.
- `node tools/archi/verify-exchange-io.mjs` opens archi-online's two Exchange fixtures and
  Desktop Archi's own Exchange export of Archisurance as the workbench does, and each equals
  archi-online's reading of it.
- `node tools/archi/verify-viewpoints.mjs` compares the bundled table with Desktop Archi 5.9's
  `viewpoints.xml`: 25 viewpoints by id, name and order, and 1,525 viewpoint and element type
  pairs.
