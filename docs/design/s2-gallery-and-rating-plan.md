# Implement S2: the gallery and the rating presentation

Status: **carried out 2026-09-14**, the day it was proposed. Every stage below landed; the
measured outcomes are in the S2 entry of
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), and the rules in the
[semantic surfaces contract](../contracts/semantic-surfaces.md) and the
[Studio contract](../contracts/studio.md). Two defaults moved while building: Studio's
table edits a rating by choosing one of the scale's numbers rather than through a custom
dot editor, which would have been the grid's first custom component and needs a module the
app does not register; and the gallery's title became optional, falling back to the first
bound field as a timeline entry's does, so a gallery card and a board card are titled by
one rule. Where this plan and the shipped code disagree, the contracts are current and
this file is kept as the transfer it was. The programme it belongs to is the
[surfaces and charts plan](surfaces-and-charts-plan.md).

S3 was asked for before S2 and took rung 1.21.0, so S2 takes **1.22.0**: the ladder is
monotone and a host never advertises a later feature than it has, so rungs follow delivery
order rather than the order the programme proposed.

## 1. Start here

Deliver two ideas that share one rung:

- **B1, the gallery.** `gallerySurface` is a root that draws an entity's records as a card
  grid: a large title, a left edge and tint in an optional accent choice's tone, and the
  ordered bound fields as a typographic body. It reads exactly a list's bounded window with
  the list's pager, and takes the list's tiles and charts in the same summary row. Cards are
  type, because there are no image fields, which is a strength when the hierarchy is good.
- **A3, the rating presentation.** An Integer field may carry `presentation: rating` with a
  closed `min` and `max` spanning at most ten values, drawn as dots wherever the field
  appears and editable as dots. A value outside the scale reads as the number with a data
  issue, never as an invented dot count.

Read the [Studio contract](../contracts/studio.md) §6 first for what a presentation already
promises, and the *Colour on a choice option* section of the semantic surfaces contract,
because the rating scale is stored the way a tone is: its own protected table at the end of
the layout ladder, reached through the field operation's own evidence rather than through
the shape of the node tree.

### Non-goals

No image or file fields, so a card is typographic. No scale change after a field is created,
as no presentation changes after creation. No write-time refusal for a value outside a
scale. No custom cell editor in Studio's grid. No new read: a gallery is a list's window.

## 2. What S2 delivers

| Piece | What a person sees |
| --- | --- |
| Gallery | In Use, beside lists, boards, calendars and timelines: a responsive grid of cards, each with a large title, a toned edge, chips for choice values and labelled value pairs for the rest; Previous and Next pages as a list has them; totals and charts above it |
| Rating field | In Studio's field list "Rating 1–5"; in the data grid a row of dots with the number, edited from a select of the scale's numbers; in the record form and Studio's record dialogs a row of dot radios, with "Not set" when the field is optional; on list rows, cards and timeline entries the same dots, named "3 of 5" for a screen reader |
| Honest values | A value outside the scale reads as its number with "outside 1–5" beside it, the form offers the dots with none chosen, the compiler states it as a data warning, and neither a CSV import nor an agent's write is refused for it |
| Authoring | `schema.addField` takes `presentation: rating` with `min` and `max`; the vocabulary notes and the schema resource publish the scale; Studio's add-field dialog offers Rating with its bounds |
| Review | A diff sentence for every gallery property; read-only proposal preview draws the cards over the clone's sample; an example authors both; the gate builds both over MCP and drives the running app |

## 3. Stages, in order

### S2-A: the rating (Engine, storage, MCP)

`AddFieldOperation` takes an optional `min` and `max`, exposed as a `NendoRatingScale`, and
`ValidatePresentation` admits `rating` beside `singleLine`, `longText`, `singleChoice` and
`date`: Integer storage, both bounds, at most ten values, and bounds refused by name on any
other presentation, exactly as options are refused off a single choice. The canonical
payload writes them after `options` and omits them when absent, so no stored operation's
digest moves.

The scale lives in `__nendo_field_scale`, a new last rung of the protected layout ladder,
for the reason the tone table gives: the layout is a fingerprint of verbatim DDL, so a
column on `__nendo_field` would move every known layout and need an `ALTER TABLE` on files
that already exist. A row exists only for a rating field, the first one creates the whole
prefix, and a file that never rates anything keeps the layout and the minimum host it had.
The field operation's evidence carries 1.22.0 for a rating, as the choice operation's
carries 1.19.0 for a tone.

A write is never refused for being outside the scale. The compiler warns instead, beside the
warning it already makes for a stored value outside a field's choices, so the diagnostic
reaches proposal preview and the surfaces resource rather than only the screen.

Tests are `ChoiceToneTests`' four: stored, read back, raising the rung and keeping it;
refused by name with the snapshot unmoved; landing on the new layout and reopening with the
scale; and a file without one keeping its layout.

### S2-B: the gallery (Engine vocabulary, compiler, diff, capability)

One row in the vocabulary: `gallerySurface` is a root with `definitionVersion`, `entityId`,
an optional `title`, `titleFieldId` and `accentFieldId`, and the existing ordering
properties; its children are `fieldBinding`, `filterClause` and the three tile kinds; it
owns eight roots per entity. The title is optional and falls back to the first bound field,
as a timeline entry's does, so a gallery card and a board card obey one rule.

The compiler reuses the record page's title and accent helpers with card wording, refusing
by `NUI380` and `NUI381`, and the gallery joins the list and the board in the implicit-clause
table with zero predicates of its own — a kind absent from that table is scoped as a page,
and its own clauses would then not be counted against a tile's budget while the renderer
composes them.

### S2-C: the Workbench (both)

A pure `rating.ts` draws the dots and builds the radio control; one markup helper puts a
field's value on a card, a list row, a timeline entry or a page as dots or as text, so every
surface agrees. The record form and Studio's record dialogs share one control, because they
already share one builder. Studio's grid draws dots and edits with the built-in select over
the scale's numbers; a custom dot editor would be the grid's first custom component and
needs a module the app does not register.

The gallery is a body branch and a card grid: the same card the board draws, with an
optional tone on its edge, over the window a list would have read. Nothing in the read path,
the pager, the tiles, the charts or the drill changes.

### S2-D: agents, gates and documents

- **Example.** A gallery and a rating on a neutral Book entity, registered tenth.
- **Gate.** The Axiom Register gains a confidence rating; the accepted axiom is seeded with
  four of five; a gallery is authored as its own proposal, and the gate reads off the
  running app the cards, the tone, the dots, the tile, the pager and the record page.
- **Decision Log.** The neutrality fixture gains a gallery of decision cards, through both
  fixture loaders and the neutrality runtime lane.
- **Blackbox prompt.** A rating field with a value outside its scale, and a gallery.
- **Contracts.** The gallery and the scale in the semantic surfaces contract, a `rating` row
  in the Studio contract, a sentence each in scalars and CSV, the MCP interface rows, the
  architecture, the roadmap, the glossary, and the ADR's S2 entry.

Validation is the S3 sequence: `Test-Production.ps1`, then `Publish-NendoPayload.ps1`,
`Build-NendoInstaller.ps1`, `Test-NendoSetupIsolated.ps1`,
`Test-AgentAuthoringGate.ps1 -Executable artifacts/build/publish/payload/Nendo.Desktop.exe`,
and `Review-NeutralityRuntime.ps1`.

## 4. Decisions taken by default

Stated so they are choices rather than accidents; each is a bounded initial value.

- The scale has its own protected table and its own rung, not a column and not `options_json`,
  which every consumer reads as choice IDs.
- `min` and `max` are flat integer keys on the write and read back as `scale`, the words the
  author wrote. They are set once, as every presentation is.
- At most ten values; one to five is Studio's default.
- No write-time range check. A stored value outside the scale is a data issue the compiler
  states and the renderer shows, because a scale can be authored after the values exist.
- Dots are native radios in forms and dialogs: keyboard arrows, focus, form data and edit
  tracking come free, and an unchecked group already reads as no value.
- The gallery's title is optional and falls back to the first binding; its accent is
  optional; its window and its pager are the list's.
- One rung constant for both, reached two ways, as colour and the record-page header are.

## 5. Checkpoints

Commit and push after S2-A (Engine green), S2-B (Engine green), S2-C (Workbench check,
tests and build green) and S2-D (the production gate, the installer lanes, the authoring
gate and the neutrality lane green, documents and the ADR entry in place). Each checkpoint
records changed paths, the exact commands and their literal outcomes, and the next
unfinished acceptance item.
