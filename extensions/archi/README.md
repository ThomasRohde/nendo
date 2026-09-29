# Archi

An ArchiMate 3.2 modeller in the manner of [Archi](https://www.archimatetool.com/), over
Archi.nendo's record types (I-007; [the design](../../docs/design/archi-in-nendo.md)). The
package is `org.nendo.archi`, and this folder is exactly what a file carries.
`workspace/Archi.nendo` carries it over Archisurance.

## Use

Open Archi.nendo and choose **Views → Archi** in Use.

- **The model tree** starts at the model and holds Archi's nine top-level folders in Archi's
  order; a folder shows its folders first, then its concepts and views by name. An unnamed
  relationship reads as its type and its two ends.
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
  properties. The view is read-only until W-111.

On a Nendo that cannot draw the controls in its own row, the workbench draws them above the
tree.

## Files

- `model.js`: every rule, and every change as the record writes it makes. No DOM, so
  `tools/archi/model.test.mjs` tests it over Archisurance.
- `view.js`, `view.css`, `index.html`: the tree, the middle and the properties.
- `canvas.js`: the drawing. Built by `tools/archi/build-canvas.mjs` from `tools/archi/canvas`
  (the mirror of the records as archi-online's model, and the camera) with archi-online's
  renderer, geometry and router at a pinned commit, and React. Do not edit it; rebuild it. A
  rebuild from the same sources is byte for byte the same. `THIRD-PARTY.txt` carries the
  licences of what it includes.
- `kit/nendo-view-kit.js`: the view kit, byte for byte (`tools/view-kit/kit.test.mjs`).

## Checked by

`tools/Review-ArchiWorkbench.ps1`, in the production gate: the model tests, the canvas test
(every Archisurance object's bounds and every connection's route against archi-online's own
geometry of its own parse, `tools/archi/archisurance-geometry.json`), then the package
framed by the fixture broker over Archisurance (`tools/archi/archisurance.json`) in Edge,
driven with real keys and clicks, with record writes and batches offered.
`node tools/Build-Archi.mjs workbench` puts the package, and the first time its screen, into
the open Archi.nendo.
