# Archi

An ArchiMate 3.2 modeller in the manner of [Archi](https://www.archimatetool.com/), over
Archi.nendo's record types (I-007; [the design](../../docs/design/archi-in-nendo.md)). The
package is `org.nendo.archi`, and this folder is exactly what a file carries.
`workspace/Archi.nendo` carries it over Archisurance.

## Use

Open Archi.nendo: it opens on the workbench, a view of the file itself (W-106, Nendo 1.42.0).
Elsewhere in Use, **Archi** is the first choice in the breadcrumb's first picker, before the
record types. With custom views off for the file or the device, the file opens on its record
types as before, and Studio is always a click away.

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
- **Appearance** (W-114), a toggle in Nendo's row while editing, shows archi-online's own
  Appearance and Label tabs beside the view for the one box or line selected: fill, line and
  font colour and opacity, gradient, line width and style, font, text alignment and position,
  icon, the alternate figure, a note's border, a plain line's ends, and the label expression
  with its preview. Each change waits like a move and commits to the box's record; the view
  draws a label expression as archi-online evaluates it. The panel starts hidden, because it
  takes room from the drawing, and this device remembers the choice. Its tabs are drawn as
  Nendo draws tabs. Edit opens a view fitted to the space, as the drawing outside Edit is. The font list is
  archi-online's common fonts: a view is never allowed the computer's own list. A legend's
  options are kept and drawn, but not edited here.
- **Viewpoint** (W-116), in a view's properties: None or one of Archi's 25 viewpoints, by
  name. Elements whose type the viewpoint leaves out are drawn faint, with the lines that end
  on them, in the drawing and in the editor, and the palette greys out their types; Junction
  and Grouping are always allowed, and Layered allows everything. The change shows at once.
  The table is archi-online's port of Archi's, checked against the `viewpoints.xml` Desktop
  Archi 5.9 ships. A key no viewpoint has, from another tool, is kept and shown as unknown.
- **Arrange**, **Copy and paste** and the **editor settings** (W-113), four menus in Nendo's row
  while editing with **Lay out**, each an icon whose name shows on hover, and so in Ctrl K.
  Undo, Redo, Appearance, Validator and Export are icons too, so the row fits beside Add; what
  still does not fit in a narrow window is in Nendo's More menu at the row's end. On a Nendo
  from before W-115, which lacks the clipboard, layout, undo and redo icons, those controls
  carry their words instead. Arrange aligns the selected boxes six ways
  to the last one selected, matches their width, height or size, distributes three or more,
  and brings them forward or sends them back. Copy and paste holds cut, copy, paste, paste as
  reference (new boxes for the same elements) or as copy (new elements), duplicate and select
  the same type. The gear holds the grid, snapping to it and to alignment guides, and
  Automatic relationships. Each command is archi-online's own operation, as its context menu,
  still there on a right-click, runs it: one edit waiting and one Undo step. Ctrl+click adds to
  the selection; Ctrl D, X, C and V and the arrow keys work in the view, Shift with an arrow by
  a grid step, and the format painter is in the palette. The grid and snapping choices are kept
  in this view's own storage on this device. One Arrange menu of 27 entries was too crowded
  (the owner, W-115).
- **Lay out** and **Automatic relationships** (W-115). **Lay out → Left to right** and **Top to
  bottom** place the boxes selected, or every box at the top of the view
  when fewer than two are, in layers with ELK, and route the lines between them at right
  angles; what is nested in a box moves with it. It is archi-online's own layout: one edit
  waiting and one Undo step. **Automatic relationships…**, behind the gear, is Archi's preferences page for
  nesting: whether nesting a box made from the palette, dropped from the tree or moved offers a
  relationship, which types it offers parent to child and child to parent (a Specialization
  always runs child to parent), and which types a nesting stands for, so their lines are not
  drawn. Archi's defaults: six types offered, none reversed, every type hidden while nested.
  The choices are kept in this view's own storage on this device, for every Archi model, and
  the drawing outside Edit follows them as the editor does.
- **Generate view for…** (W-115), in the tree's menu on an element and in New: a new view of
  the element, or of the boxes selected on the view while editing, and the elements related to
  them, to a depth of one to six, incoming, outgoing or both, optionally with every
  relationship between them and with a viewpoint the elements fit. It is archi-online's own
  operation, laid out with ELK, and it is saved at once as one revision and opened. While
  editing it is also one Undo step there: Undo and Commit take the view away again. Outside
  Edit, delete the view to take it away; History cannot reverse a change that creates records.
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
  **Open Exchange XML** (W-121): the same dialog reads The Open Group's exchange format,
  told from an .archimate by what the file holds, as archi-online reads it, and **Open
  Exchange XML…** in the menu opens it too. **Save as Exchange XML** downloads the model in
  that format with its folders as the organization, its language and its Dublin Core
  metadata, after libxml2 has checked it against Archi 5.9's five schemas. A file the
  schemas refuse is not saved, and the status line names what they refused. The check is
  `xsd.js`, 1.2 MB, which loads only when you save, not with the workbench. Like every
  download, the file goes to Downloads, as `Archisurance (1).xml` when `Archisurance.xml` is
  already there (F-237).
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
- `vendor/elkjs/`: the ELK worker that layouts run in (W-115), elkjs 0.11.1 unchanged, with its
  licence and hashes. `canvas.js` builds archi-online's layouts against
  `tools/archi/canvas/elk.ts`, which starts this worker, rather than loading ELK on the page.
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
`node tools/archi/verify-exchange-io.mjs`, on request, opens archi-online's two Exchange
fixtures and Desktop Archi's own Exchange export of Archisurance as the workbench does, and
each equals archi-online's reading of it. The workbench's Exchange XML of Archisurance
validates against Archi 5.9's schemas; Desktop Archi imports it as archi-online does, apart
from four defaults the two importers fill in differently on Desktop's own export too; and
read back it loses only what archi-online's own export of Archisurance loses. The io test
validates the export with libxml2 on every run, and the lane saves it from Nendo's row and
reads a dropped Exchange file in the browser.
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
duplicate and paste as copy make a new element, paste as reference none. The Appearance
toggle shows the tabs; a fill, a gradient, a line width, a font and a label expression set on
Board commit to its record, the font as Archi's own string, the view draws the label, and the
workbench started again shows each in the tabs. Picking Strategy for Organisation Tree View in
its properties ghosts, at once and at 0.4, exactly the boxes and drawn lines archi-online's rules
name for the stored records, in the editor and outside it, and greys those types in the palette
at 0.35; None clears both. `node tools/archi/verify-viewpoints.mjs`, on request, compares the bundled table
with Desktop Archi 5.9's own `viewpoints.xml`: 25 viewpoints by id, name and order, and 1,525
viewpoint and element type pairs. `verify-archimate-io.mjs` also checks that
every label expression in archi-online's fixtures reads as archi-online reads it after the
trip through the records.
`tools/archi/automation.test.mjs` (W-115) runs archi-online's nesting, Generate View For and
layout on Archisurance's records with the vendored ELK worker, and checks that the writes each
makes, read back, are the model archi-online left: a move within a parent offers nothing; a
nesting offers only the default types (Specialization child to parent) and its line is hidden
until nested connections are turned off; configured reverse types run child to parent; a box
made from the palette inside another is four creates in one Undo step; a box taken out gets the
line its nesting stood for; a generated view holds the element and those related to it without
overlaps, as creates only; and a layout writes only places and bends, without overlaps. The
lane lays Organisation Tree View out from the Lay out menu and commits exactly archi-online's
layout of the same records, every box and bend, as one batch of moves after an Undo and Redo;
shows the automatic relationships dialog with Archi's defaults and draws the line of the
nesting above once nested connections are off; and generates a view for Board while editing,
equal box for box to archi-online's, saved as one batch of creates, opened in the editor, and
taken away by Undo and Commit as one batch of deletes.
