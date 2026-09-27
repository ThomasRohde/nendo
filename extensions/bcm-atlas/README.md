# Capability Atlas

A business capability modelling application carried by `workspace/BCM.nendo`. The
embedded package is `org.nendo.bcm-atlas`, and this folder is exactly what the file
carries. No server or installed plugin is needed to use it.

## Use

Open BCM.nendo in Nendo and choose **Capability → Capability map** in Use. The map has
Map, Assessment and Outline views, search, five colour modes (maturity, maturity gap,
importance, investment, neutral) and the compact and ordered reference layouts.

- **Levels** shows 1 to 5 levels, or All, and adapts if the model's depth changes. The
  map opens at two levels. A collapsed group shows how many capabilities it holds.
- **Double-click** a group, or choose Focus group, to focus it. The chosen levels then
  count below that group, so one level always shows its immediate children. The
  breadcrumbs return to the enterprise.
- **Search** dims what does not match and says when a match lies below the chosen depth;
  All reveals it. Summary totals describe the whole scope; the footer separates shown
  cards from the scope and the model.
- **Pan** by dragging the background, by holding Ctrl and dragging anywhere (Ctrl may be
  pressed before or after the button), or by turning on **Pan** and dragging without a
  key. A four-pixel threshold avoids accidental pans, and a pan selects nothing.
- **Fit** fits the visible cards to the canvas with a 12px inset. Resizing refits;
  editing data, here or anywhere else, keeps the camera where it is.
- **Edit** and **+ Child** change the model; **Open record** opens Nendo's own record page
  with the related application support and initiatives.

The other screens are Capability register, Investment directions, Strategic positioning,
Application landscape, Application coverage, Change portfolio and Transformation roadmap.
All four record types have authored detail screens.

## Model

| Record type | Meaning |
| --- | --- |
| Capability | Hierarchical business ability: owner, definition, maturity, target, importance, investment direction, evidence and review date |
| Application | Supporting system: owner, vendor, lifecycle and criticality |
| Application support | Capability-to-application link with role and business fit |
| Initiative | Change with one primary capability, owner, stage, dates and success measure |

The shipped data is the **fictional Northstar model**: 635 capabilities in six domains,
531 of them leaves, up to five levels deep, with 8 applications, 8 support links and
6 initiatives. Assessment values are examples, not claims about a real organisation. A
missing assessment stays missing; gap is target minus current maturity; a group's
assessment is its own judgement, never an average of its children.

Maturity runs 1 Initial, 2 Repeatable, 3 Defined, 4 Managed, 5 Optimising. Investment
direction is Tolerate, Invest, Migrate or Eliminate.

## Layout and integration

`layout.js` is the owner's dependency-free BCM layout reference v1.0.0, wrapped as
`window.BcmLayout`: fixed leaf geometry, parents packed bottom-up. `layout-profile.js`
holds the lab preset exactly — 160 × 56 leaves, padding 8, title band 24, gap 8, grid 8,
frame objective and a 16:9 target — and the camera's Fit. Resizing changes only the
display scale. The map packs again only when the tree, the scope, the levels or the
layout mode change; search and colour restyle the cards in place. Each new packing is
checked with the reference validator.

The package reaches the file only through `window.nendo`. The file declares **Parent
capability** a hierarchy, with **Display order** as its order
([ADR-0019](../../docs/decisions/0019-hierarchies-in-the-schema.md)), and the map reads the
tree the Engine keeps with `records.treeAll`. The Engine refuses any write that would close a
loop or go deeper than 32 levels, whoever makes it, and orders each level, so the package
repairs and sorts nothing. A file that does not declare the hierarchy gets a notice instead
of a map. Creates and updates carry the record's version and the parent's version; a
rejected save, a loop included, keeps the form's draft and says why. The parent picker
offers only places the capability can go. No request leaves Nendo.

## Development

The tooling lives in [`tools/bcm-atlas/`](../../tools/bcm-atlas/), outside the package:

- `northstar.mjs` generates the shipped model: the 60-capability starter with its
  applications, links and initiatives, and `northstar-expansion.txt`, which grows it to
  635. The live file's records equal its output.
- `build-model.mjs` writes the schema, screen and seed batches, and `build-expansion.mjs`
  the additive catalogue batches, under `artifacts/bcm-atlas`. Neither writes to Nendo.
- `model.test.mjs`, `syntax.test.mjs` and `layout-parity.test.mjs` test the hierarchy and
  level rules, module syntax, and the frozen lab coordinates in `lab-reference-proof.json`.
- `review/` drives a running Nendo that has BCM.nendo open with CDP on port 49321:
  `layout-parity.mjs`, `levels.mjs` and `pan.mjs` only read; `journey.mjs` creates and
  deletes a temporary capability; `native-pan.mjs <pid>` sends Windows input and moves
  the real pointer. Each starts by switching Nendo to Use.

`tools/Review-BcmAtlas.ps1` runs inside `Test-Production.ps1`: the node tests, then the
package in Edge against the Northstar model through the fixture broker — level counts,
no repacking while searching or recolouring, the camera kept across a data change,
Ctrl-drag from a card, both themes and a 600px pane.

Install a changed package with
`node tools/Put-NendoPackage.mjs extensions/bcm-atlas`, which proposes only the files
that differ.
