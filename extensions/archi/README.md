# Archi

An ArchiMate 3.2 modeller in the manner of [Archi](https://www.archimatetool.com/), over
Archi.nendo's record types (I-007; [the design](../../docs/design/archi-in-nendo.md)). The
package is `org.nendo.archi`, and this folder is exactly what a file carries.
`workspace/Archi.nendo` carries it over Archisurance.

## Use

Open Archi.nendo and choose **Views → Archi** in Use.

**A new model** is **File → New Archi model…** (ADR-0022): a new file of Archi with the 72
concept types and the nine top-level folders, and none of this model's concepts, views or
history. The workbench starts an empty model in it, named *New model*; rename it in
Properties. The file you were in does not change.

- **The model tree** starts at the model and holds Archi's nine top-level folders in Archi's
  order; a folder shows its folders first, then its concepts and views by name. An unnamed
  relationship reads as its type and its two ends. A cyclic endpoint reference ends with
  `[cycle]`, so relationships can still be selected and their properties opened.
- **Find** (Ctrl F) and **Layer**, in Nendo's row above the view, narrow the tree to what
  matches and open the folders on the way to it.
- **The middle** shows what the selection is part of: a concept's relationships and the views
  it is on, a view's objects and connections and the elements on it. Each entry selects its
  record everywhere.
- **Properties** edit the selection's fields as Archi's Properties view does, the
  type-specific ones included (access, influence strength, directed, junction type), and its
  ordered key/value properties. A changed type stays within its category and takes the
  concept to its new layer's folder, as Set Concept Type does.
- **New** makes an element of any type (Nendo's Add does the same), a folder or a view. A new
  element goes to the selected folder if it is of its layer, otherwise to its layer's
  top-level folder.
- **Drag** a concept, a view or a folder onto a folder of the same layer's tree; a drop
  anywhere else is not offered. **F2** renames. **Delete** removes the selection with
  everything Archi removes with it (relationships, the diagram objects and connections that
  show it, what is nested in them, properties), after saying how much that is, as one
  revision where Nendo has batch writes.
- **The keyboard**: the tree is one tab stop; Up, Down, Home and End move, Right opens a
  folder or steps into it, Left closes it or steps out, Enter goes to the properties.

- **The open view** (W-110): choosing a view draws it in the middle with Archi's own figures,
  icons and connection routes, as archi-online draws them, on white paper in both themes. Drag
  the paper or scroll to pan, Ctrl and the wheel to zoom, and Zoom and Fit are in Nendo's row
  (Ctrl -, Ctrl 0, Ctrl +). The navigator in the corner shows the whole view and moves the
  camera. A click selects the object under the pointer and its concept in the tree; selecting
  a concept in the tree outlines every box that shows it; a double-click on a view reference
  opens that view. A concept's model relations and views are under Analysis in its
  properties.
- **Edit** (Ctrl E, W-111) opens the view in archi-online's own editor: its palette by layer,
  placing, moving, resizing and nesting boxes, drawing relationships of only the types
  ArchiMate allows between the two ends, reconnecting, bendpoints, the magic connector,
  marquee selection, Delete from the view and direct renaming. Edits collect rather than
  write: **Undo** (Ctrl Z) and **Redo** (Ctrl Y) work on them, **Commit** (Ctrl S) writes all
  of them to the file as one revision, up to 200 record writes, and **Discard** drops them.
  A larger Commit saves nothing and keeps every edit waiting; use Undo to reduce it, then
  commit. A box moved five times is one change of its place when committed. The waiting
  edits are kept in this browser, so
  leaving the screen or the file finds them again, opened in the editor; a change to the file
  meanwhile is carried under them, and a commit writes only what the edits changed. Edit
  closes only when nothing waits.
  The palette is as wide as you drag its edge (or step it with the arrow keys), and its
  buttons fill the width in columns; the width is kept on this device.
  A box dropped into an element box is nested in it, and archi-online's own dialog asks which
  relationship the nesting stands for, None among the choices (W-113; before, the question
  had no place to show and the move was lost).
- **Arrange** (W-113), in Nendo's row while editing, and so in Ctrl K: align the selected
  boxes six ways to the last one selected, match their width, height or size, distribute
  three or more, bring forward or send back, select the same type, duplicate, cut, copy,
  paste, paste as reference (new boxes for the same elements) or as copy (new elements), and
  show the grid or snap to it and to alignment guides. Each is archi-online's own operation,
  as its context menu, still there on a right-click, runs it: one edit waiting and one Undo
  step. Ctrl+click adds to the selection; Ctrl D, X, C and V and the arrow keys work in the
  view, Shift with an arrow by a grid step, and the format painter is in the palette. The grid
  and snapping choices are kept in this view's own storage on this device.
- **Validator** (W-117), in Nendo's row, opens Archi's validator under the workbench. It is
  archi-online's: Archi 5.9's eight checks (invalid relationships, unused elements and
  relationships, empty views, viewpoint violations, nested elements without a nesting
  relationship, duplicate names, mixed junction relationships) and its model-integrity pass,
  grouped by source and severity. It runs when opened and on **Validate**, over the file, or
  over what the editor shows with its waiting edits while a view is being edited, and says
  when the model has changed since. Choosing an issue opens what it names: the object on its
  view, outlined, or the concept, view or folder in the tree. **Rules…** turns checks off,
  on this device.
- **Archi file** (W-120), in Nendo's row. **Open .archimate…** reads an Archi model, plain
  XML or Archi's archive with images, into an empty model: make one with **File → New Archi
  model…** first, and in a file that already holds a model the dialog says so and offers
  nothing. Choose the file in the dialog, or drop it anywhere on the workbench. The dialog
  says what the file holds and what is left out, because Archi.nendo holds no images: image
  objects, the connections that end on one, and the pictures on figures and specializations.
  **Open** saves the model in batches of at most 200 record writes, each a change in History
  named *Open ‹file› (n of m)*. History cannot undo them; to start again, make a new Archi
  model. **Save as .archimate** downloads the model as plain XML that Desktop Archi opens,
  each object under the Archi ID it came with, or its record ID without `ar-` when the
  workbench made it. Edits still waiting to be committed are not in it, and the status line
  says so.
- **Export** (W-123), in Nendo's row while a view is open, makes a picture of the view as
  Archi's File › Export › View As Image does: **PNG** at the view's own size, at **2×** or at
  **4×**, **SVG** with every label as text, or **Copy as picture** to paste elsewhere. It is
  archi-online's own export: cropped to the drawing with a 10-pixel margin, in the canvas's
  font, and named after the view. **Transparent background in files** leaves out the white
  page in the PNG and SVG files; Archi's figures draw the same in both themes. Copy as picture
  copies at 2×, and always keeps the white page, as Archi's copy does: a program that pastes
  Windows' bitmap shows see-through pixels as black. The picture is what the view shows, edits
  still waiting included. A PNG too large for one picture comes out at the largest scale one
  holds, and the status line says so.
- **Without the workbench**, in Use: Concepts → Elements and Relationships show an *On views*
  column, a concept's page shows it under Details, and Views → Views shows a *Diagram objects*
  column (third in Elements and Views, so a Nendo that draws only three fields shows them too). They are calculated counts of the
  diagram objects that show a concept or that a view holds. Concepts → *Not on any view* and
  Views → *Empty views* list the zeros (Nendo 1.40.0, which filters on a calculated field).

On a Nendo that cannot draw the controls in its own row, the workbench draws them above the
tree.

## Files

- `model.js`: every rule, and every change as the record writes it makes. No DOM, so
  `tools/archi/model.test.mjs` tests it over Archisurance.
- `view.js`, `view.css`, `index.html`: the tree, the middle and the properties.
- `canvas.js`: the drawing, the editor and the validator. Built by `tools/archi/build-canvas.mjs` from
  `tools/archi/canvas` (the mirror of the records as archi-online's model and its inverse, the
  camera, and the editor's mount) with archi-online's renderer, geometry, router, ViewEditor,
  Palette, operations and validator, its `.archimate` parser and serializer, with fflate for
  Archi's archives (`tools/archi/canvas/io.ts`), at a pinned commit, and React. Every id archi-online makes in it is
  a record ID, `ar-id-…`. Do not edit it; rebuild it. A
  rebuild from the same sources is byte for byte the same. `THIRD-PARTY.txt` carries the
  licences of what it includes.
- `editor.css`: archi-online's own rules for its editor, palette and menus, with its colour
  variables mapped onto Nendo's tokens.
- `kit/nendo-view-kit.js`: the view kit, byte for byte (`tools/view-kit/kit.test.mjs`).

## Checked by

`tools/Review-ArchiWorkbench.ps1`, in the production gate: the model tests, the canvas test
(every Archisurance object's bounds and every connection's route against archi-online's own
geometry of its own parse, `tools/archi/archisurance-geometry.json`), the validation test
(each of archi-online's example models and the cases of its validation tests, turned into
records as an import writes them and validated through the mirror, against what archi-online
reports: `tools/archi/validation-parity.json`, from `make-validation-fixture.mjs`), then the package
framed by the fixture broker over Archisurance (`tools/archi/archisurance.json`) in Edge,
driven with real keys and clicks, with record writes and batches offered. The io test checks
the `.archimate` mapping both ways over Archisurance, value for value, and the versions each
batch names; the lane saves Archisurance from Nendo's row and opens the saved file into a new
model, by a drop and through the dialog's file input, and compares every record.
`node tools/archi/verify-archimate-io.mjs`, on request, opens and saves Archisurance and
archi-online's phase fixtures and compares archi-online's semantics of each save with the
original's, images aside, and has Desktop Archi open and save each one again.
`node tools/Build-Archi.mjs workbench` puts the package, and the first time its screen, into
the open Archi.nendo. The lane also exports every Archisurance view from the Export menu:
the SVG's crop against archi-online's geometry, every element's name as text, the canvas
font, PNG at 1×, 2× and 4× of the SVG's size, the transparent background, and Copy as picture
with focus in Nendo's page, its picture opaque on the white page even with Transparent
background in files chosen. In the editor it nests a box in Organisation Tree View through
the dialog and commits the relationship chosen, and runs Arrange on boxes selected with real
clicks: what each commit holds is what archi-online's own operation makes of the same records
and selection, and what each command means is checked on the boxes themselves (Align left:
the anchor's x, on boxes of three widths; Match size; equal gaps; Send to back first);
duplicate and paste as copy make a new element, paste as reference none.
