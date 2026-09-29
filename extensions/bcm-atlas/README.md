# Capability Atlas

A business capability map for any record type a file keeps as a tree. The embedded package
is `org.nendo.bcm-atlas`, and this folder is exactly what a file carries. No server or
installed plugin is needed to use it. `workspace/BCM.nendo` carries it over the fictional
Northstar model.

## Use

Open BCM.nendo in Nendo and choose **Capability → Capability map** in Use. The map has
Map, Assessment, Outline, Importance × health and Capability × application views, search,
seven colour modes (maturity, maturity gap, change since, application coverage, importance,
investment, neutral) and the compact and ordered reference layouts.

- **Assessments over time** (W-080). Where the view's configuration names an assessment
  record type, each capability's maturity is its latest Maturity assessment, and the
  inspector shows the latest score on each dimension (Maturity, Business value, IT health)
  with its date and how many there have been. Every assessment is a record, so the history
  keeps each one; the capability's page lists them under Assessment history.
- **Change since** colours each card by its latest maturity less the one in force on a
  chosen date (Since lists every date anything was assessed): lower, no change, up one, up
  two or more, or not comparable where either judgement is missing.
- **Application coverage** (W-081) colours each card by how many distinct applications
  support it or anything below it: none, one, or two or more, where the overlap may be worth
  a look. A group counts its children's applications once each.
- **Capability × application** lists each capability in scope that an application supports,
  against those applications, with the role and fit of each link in its cell, toned by fit.
  A cell opens the link.
- **Initiatives in scope**: an initiative covers several capabilities through a link record
  each, and the inspector lists the initiatives that cover the selected capability.
- **Importance × health** places every capability in scope by its strategic importance
  against its latest IT health score, with a column for those not yet assessed. A cell
  lists its capabilities; pressing one selects it.

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
- **Drag** a card to restructure the model: over the middle of a card it goes in, as that
  card's last child; over a card's left or right edge it goes beside it. A drop into its own
  group is refused before anything is written. **Alt+Shift+Up/Down** move the selected card
  among its siblings, **Alt+Shift+Right** puts it under the card above and **Alt+Shift+Left**
  after its parent, as in Nendo's outline. **F2** renames it in place. Each move is one
  versioned write; a refused one shows the map as the file holds it and says why.
- **Edit** and **+ Child** change the model; **Open record** opens Nendo's own record page
  with the related application support and initiatives.
- **Export** writes the map as **SVG**, to edit, or **PNG**, twice the size, for a slide: the
  scope at the chosen levels in the chosen colour, with a title, the file's banner and the
  legend, whatever part of it the camera shows. The SVG is plain shapes and text with hex
  colours, so a slide editor keeps the text as text. **Light colours for print** puts it on
  white paper in the light theme's colours. Search and selection are not exported.

The other screens are Capability register, Investment directions, Strategic positioning,
Application landscape, Application coverage, Change portfolio and Transformation roadmap.
All four record types have authored detail screens.

**In Nendo's toolbar.** On a Nendo that offers it, the Atlas draws no toolbar of its own.
Nendo shows these controls in the toolbar above the map, lists them in Ctrl K under the view's
title, and runs their keys:

- Map, Assessment and Outline;
- Levels, Colour and Find (Ctrl F);
- Pan, and the zoom: Ctrl − and Ctrl + zoom, and Ctrl 0 fits;
- the layout, under the settings button;
- Export.

Nendo's own **Add Capability** adds a capability under the selected card, or else under the
focused group. A right-click on a card opens Nendo's menu, with Open record, Edit, Add a
capability under it, Rename, Focus this group and the four moves, each greyed where it cannot
happen. The breadcrumbs join the summary line. On an older Nendo the Atlas shows its own
toolbar, as it always has.

## Showing it in a file

The package names no record type and no field. It takes both from the view that shows it,
an `extensionRecordsSurface` whose `packageId` is `org.nendo.bcm-atlas`, and from the
file's schema (`nendo.schema.describe`). A view on another record type binds its own.

**Required.**

- The view's record type declares a hierarchy
  ([ADR-0019](../../docs/decisions/0019-hierarchies-in-the-schema.md)). The map is the tree
  `records.treeAll` reads, and the editor writes the declared parent field. Without one,
  the view says which reference to declare instead of drawing a map.
- The view's `labelFieldId` names each capability. Nendo requires it of every view.

**Optional parts.** The view's `configuration` names each part's field under `fields`. The
field must belong to the record type and be one the view binds: its label, its status, or
a `fieldBinding`.

| Part | Field | What it drives |
| --- | --- | --- |
| `code` | text | The reference on cards, in the outline and the parent picker, and search |
| `description` | text | The definition in the inspector and editor, and search |
| `owner` | text | Owner in the inspector and editor, and search |
| `maturity` | whole number | Maturity colour, the card's score, the pips, the Maturity column and the awaiting-assessment count. Levels come from the field's scale, 1 to 5 when it has none |
| `target` | whole number | With maturity: the gap colour, the Target and Gap columns and the below-target count |
| `importance` | choice | Importance colour in each choice's own tone, the badge and the column |
| `investment` | choice | Investment colour, the badge and the Direction column |
| `lifecycle` | choice | The badge, and a new capability's first choice. The view's `statusFieldId` when the configuration names none |
| `reviewed` | date | Reviewed in the inspector and editor |
| `evidence` | text | Evidence in the inspector and editor |

A part the view does not give is not offered: its colour mode, figure, column, badge and
editor input are hidden, and the editor writes only the label, the parent and the parts it
has. A part given a field the record type does not have, one the view does not bind, or
one that holds the wrong kind of value is left out, and a line above the map says what to
bind.

**Related record types** come from the schema. A record type with exactly two references,
one to the Atlas's record type, is a link: its section lists the records it links to, by
their label (BCM's Application support). Any other record type that refers to it lists
its own records (BCM's initiatives). Each row opens its record. By default a section is
titled with the record type's name, and each row shows its choices. `configuration.related`
may give a record type's section a `title`, a `row` template of `{fieldId}` placeholders
and an `empty` line. Sections come in the order `configuration.related` lists them; record
types it does not name follow, links before lists. Nendo lists record types by ID, so that
order is never the inspector's.

**The banner** at the right of the figures is `configuration.banner`, `{title, note}`.
Without one there is no banner.

**Coverage** is `configuration.coverage`: `entityId` names the link record type, and
`capability`, `application`, `role` and `fit` its reference to the capabilities, its reference to
the applications and two optional choice fields. The coverage colour and the matrix need it.

**Assessments** are `configuration.assessments`: `entityId` names a record type, and
`capability`, `dimension`, `score` and `date` name its reference to the capabilities, a choice
field, a whole-number field and a date field. `dimensions` maps `maturity`, `health` and
`value` to the dimension field's choice IDs. With them the latest Maturity assessment stands
for the maturity field, which the editor then no longer offers; Change since needs them, and
Importance × health needs `health` and an importance part. A record type that does not fit is
named above the map, and the Atlas carries on with the stored maturity.

BCM.nendo's Capability map carries this configuration
([`tools/bcm-atlas/definition.mjs`](../../tools/bcm-atlas/definition.mjs)):

```json
{
  "fields": {
    "code": "cap.code", "description": "cap.description", "owner": "cap.owner",
    "maturity": "cap.maturity", "target": "cap.target", "importance": "cap.importance",
    "investment": "cap.investment", "lifecycle": "cap.lifecycle", "reviewed": "cap.reviewed",
    "evidence": "cap.evidence"
  },
  "banner": { "title": "NORTHSTAR / DEMONSTRATION MODEL", "note": "Fictional data · replace with your organisation" },
  "related": {
    "bcm.support": { "title": "Application support", "row": "{support.fit} fit · {support.role}",
      "empty": "No applications linked. Add support links in the record page." },
    "bcm.initiative": { "title": "Change portfolio", "row": "{initiative.stage} · {initiative.end}",
      "empty": "No initiatives linked." },
    "bcm.scope": { "title": "Initiatives in scope", "row": "{scope.note}", "empty": "No initiative covers this capability." },
    "bcm.assessment": { "title": "Assessment history", "row": "{assess.dimension} {assess.score} · {assess.date}",
      "empty": "Not assessed yet. Add an assessment in the record page." }
  },
  "coverage": { "entityId": "bcm.support", "capability": "support.capability",
    "application": "support.application", "role": "support.role", "fit": "support.fit" },
  "assessments": {
    "entityId": "bcm.assessment", "capability": "assess.capability", "dimension": "assess.dimension",
    "score": "assess.score", "date": "assess.date",
    "dimensions": { "maturity": "Maturity", "health": "IT health", "value": "Business value" }
  }
}
```

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

The package reaches the file only through `window.nendo`. It reads the tree the Engine
keeps with `records.treeAll`. The Engine refuses any write that would close a loop or go
deeper than 32 levels, whoever makes it, and orders each level, so the package repairs and
sorts nothing. Creates and updates carry the record's version and the parent's version; a
rejected save, a loop included, keeps the form's draft and says why. The parent picker
offers only places the capability can go. A change to the view's definition binds the
Atlas again. No request leaves Nendo.

## Development

The tooling lives in [`tools/bcm-atlas/`](../../tools/bcm-atlas/), outside the package:

- `definition.mjs` is BCM.nendo's application: record types, references, choice tones,
  the declared tree and the Capability map with its configuration. `build-model.mjs`
  writes the schema, screen and seed batches from it, and `build-expansion.mjs` the
  additive catalogue batches, under `artifacts/bcm-atlas`. Neither writes to Nendo.
- `northstar.mjs` generates the shipped model: the 60-capability starter with its
  applications, links and initiatives, and `northstar-expansion.txt`, which grows it to
  635. The live file's records equal its output.
- `assessments.mjs` derives assessments from capabilities: `migrated` moves each current
  maturity into one Maturity assessment dated when it was last reviewed, with its evidence and
  owner, and changes nothing on the capability; `demonstration` is the Northstar demo's
  fictional history (an earlier baseline, Business value and IT health), each one saying so.
- `upgrade.mjs` is what a BCM.nendo built before 2026-09-29 needs: the Assessment record
  type and its screens, the Initiative scope link type (W-081) with a list on each side, a unique capability code (W-075), both ends of a support link required
  (W-076) and the map's configuration. `node tools/bcm-atlas/upgrade.mjs` writes
  `upgrade-operations.json`, which `BcmAtlasUpgradeTests` validates and applies to a copy of
  `workspace/BCM.nendo`. To upgrade the live file, open it with Agent access on and run
  `node tools/bcm-atlas/Upgrade-BcmAtlas.mjs schema`, accept the proposal, run
  `node tools/Put-NendoPackage.mjs extensions/bcm-atlas`, accept it, then
  `node tools/bcm-atlas/Upgrade-BcmAtlas.mjs data` to import the assessments.
- `fixtures.mjs` hands the package two files as the Workbench would: BCM.nendo, and a
  business-area map whose record types, field IDs, choice IDs and parts are all different.
- `export.test.mjs` tests `export.js`, which builds the exported SVG from the packed layout:
  its size and cards, escaping, wrapping, and that it uses nothing but hex colours and
  presentation attributes.
- `model.test.mjs`, `syntax.test.mjs` and `layout-parity.test.mjs` test the bindings, the
  hierarchy and level rules, module syntax, and the frozen lab coordinates in
  `lab-reference-proof.json`.
- `review/` drives a running Nendo that has BCM.nendo open with CDP on port 49321:
  `layout-parity.mjs`, `levels.mjs` and `pan.mjs` only read; `journey.mjs` creates and
  deletes a temporary capability; `native-pan.mjs <pid>` sends Windows input and moves
  the real pointer. Each starts by switching Nendo to Use.

`tools/Review-BcmAtlas.ps1` runs inside `Test-Production.ps1`: the node tests, then the
package in Edge through the fixture broker. Over BCM it measures level counts, every
colour mode, the banner and the related rows in BCM's own words, no repacking while
searching or recolouring, the latest assessment on each dimension, every leaf's change
since each assessment date against the fixture's own history, every card's maturity as its
latest assessment, all 635 capabilities placed by importance against health and one in its
exact cell, every card's coverage tone against the fixture's support links rolled up to
groups, the capability-against-application matrix's size and one cell's role and fit, a
capability listing an initiative that covers it besides its primary one, the camera kept across a data change, Ctrl-drag from a card, a
definition change binding again, the notice without a declared tree, both themes and a
600px pane; moving by the real pointer into a group and before a sibling, a drop into its
own group refused unsent, the keyboard's moves, F2's rename and a stale move shown as the
file holds it; and the exports: an SVG holding exactly the map's cards, span and legend, the
same file after zooming and panning, no packing, a PNG at twice the SVG's size, the dark
canvas and the white print palette, and the SVG opened on a page of its own. Over the second
file it measures that only that file's record types are read,
that Importance × health is not offered without IT health assessments,
that the parts it does not bind are not offered, that the unbound one is named, that
scores and tones follow its own fields, that its related sections are found, and that the
editor writes only its own bound fields with the parent's version.

Install a changed package with
`node tools/Put-NendoPackage.mjs extensions/bcm-atlas`, which proposes only the files
that differ.
