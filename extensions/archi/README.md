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

The diagram itself is W-110. On a Nendo that cannot draw the controls in its own row, the
workbench draws them above the tree.

## Files

- `model.js`: every rule, and every change as the record writes it makes. No DOM, so
  `tools/archi/model.test.mjs` tests it over Archisurance.
- `view.js`, `view.css`, `index.html`: the tree, the middle and the properties.
- `kit/nendo-view-kit.js`: the view kit, byte for byte (`tools/view-kit/kit.test.mjs`).

## Checked by

`tools/Review-ArchiWorkbench.ps1`, in the production gate: the model tests, then the package
framed by the fixture broker over Archisurance (`tools/archi/archisurance.json`) in Edge,
driven with real keys and clicks, with record writes and batches offered.
`node tools/Build-Archi.mjs workbench` puts the package, and the first time its screen, into
the open Archi.nendo.
