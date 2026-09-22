# Implement S1: the first charts

Status: **carried out 2026-09-14**, the day it was proposed. Every stage below
landed; the measured outcomes are in the S1 entry of
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), and the rules in the
[semantic surfaces contract](../contracts/semantic-surfaces.md). Two defaults moved
while building: a chart inside a `relatedList` is refused rather than compiled and
not drawn, and a drilled list clears its cached window rather than keying a second
one. Where this plan and the shipped code disagree, the contract is current and this
file is kept as the transfer it was. The programme it belongs to is the
[surfaces and charts plan](surfaces-and-charts-plan.md).

## 1. Start here

Deliver the first two charts and everything they stand on: one exact grouped
aggregate in the Engine, one renderer chart kit, a breakdown chart and a progress
ring as tiles on lists, boards and record pages, and drill-through from a chart into
a filtered list as renderer state. A chart is an exact aggregate over a closed
grouping, drawn as proportion with its numbers shown and a table of them one toggle
away. Nothing here stores layout, an expression or a sample.

Read the [semantic surfaces contract](../contracts/semantic-surfaces.md) for how a
`summaryTile` composes its read, because both charts compose theirs the same way,
and the [operation outcomes contract](../contracts/operation-outcomes.md) for how a
read that cannot be answered is stated. S0 is the worked precedent for the whole
checklist: `ChoiceToneTests`, `RecordPageHeaderTests`, the `tones` module and the
S0 entry in the ADR show the shape each stage's evidence takes.

### Non-goals

No date buckets (S5), no overview page (S4), no range tile (S4), no grouping by a
reference or a calculated field, no `avg`, no chart library, no stored chart
configuration beyond the properties named here, and no MCP read of aggregates:
agents author charts and people read them.

## 2. What S1 delivers

| Piece | What a person sees |
| --- | --- |
| Breakdown chart | On a list, board or record page: one proportion bar of toned segments per option of a single-choice or Boolean field, with a legend carrying each count or exact sum, a note for records whose stored value is outside the options, and a table view behind one toggle |
| Progress ring | A ring with "12 of 40" in the centre: records matching the tile's own clauses over the records the surface shows |
| Drill-through | Clicking a segment or the ring opens the record type's first list narrowed to that group, with a dismissible pill naming the narrowing |
| Grouped aggregate | The Engine answers one exact number per group in one read, so a chart costs one read rather than one per option |

## 3. Stages, in order

### S1-A: the exact grouped aggregate (Engine)

`NendoRecordGroupedAggregateQuery(EntityId, GroupByFieldId, Aggregate, FieldId?)`
with `Filters`, beside `NendoRecordAggregateQuery` in `ReadQueries.cs`. The
grouping field must be a single-choice Text field or a Boolean; anything else, and
a calculated field, is a `NendoValidationException` naming the rule. `count` reads
no field; `sum`, `min` and `max` read one Integer or Decimal field, exactly as the
single aggregate does. The grouping is not a filter and does not spend the budget
of eight; `RecordQuerySemantics.Validate` runs over the filters alone.

The result, `NendoRecordGroupedAggregate`, carries one row per group in the
field's configured option order (or `true`, `false` for a Boolean), then the unset
row, each with the exact value as a JSON element and its `valueLexeme` projection,
its contributing-record count, and one `unrecognised` count for stored values that
are neither absent nor a configured option, which is a data issue the renderer
states rather than a record folded into the unset row. The fold is one streamed
`SELECT group_column, target_column … WHERE predicates` into a dictionary of
`ExactAggregate` accumulators keyed by group, so memory is bounded by the number of
groups; a group with no contributing value is stated as empty, never as zero. The
safe-mode snapshot path folds the in-memory records the same way, as
`AggregateRecordsAsync` does.

Files: `ReadQueries.cs`, `NendoWriteCoordinator.ReadQueries.cs`,
`Storage/SqliteNendoStore.ReadQueries.cs`, `ExactAggregate.cs` unchanged.
Tests, `ExactGroupedAggregateTests`: per-option counts and sums exact over decimals
and integers; the unset row; an unrecognised stored value counted apart; Boolean
grouping; a declared filter honoured; refusals for a non-choice field, a calculated
field, `avg` and a non-numeric sum field; the filter ceiling; snapshot parity; and
an empty group stated as empty.

### S1-B: the two kinds (Engine vocabulary, compiler, diff, capability)

Two rows in `SemanticVocabulary.cs`, accepted wherever `summaryTile` is accepted:
`recordList`, `boardSurface`, `detailSurface`, `section` and `relatedList`.

| Kind | Properties | Required | Children |
| --- | --- | --- | --- |
| `breakdownChart` | `groupByFieldId`, `aggregate`, `fieldId`, `title`, `scope` | `groupByFieldId`, `aggregate` | `filterClause` |
| `progressTile` | `title` | | `filterClause` |

The compiler validates a breakdown chart with the tile's own rules reused, not
copied: `ValidateSummaryScope` for `scope`, `RequireFilterBudget` for composition
(the surface's clauses plus the chart's own, plus one column predicate at `group`
scope; the grouping itself is free), and the aggregate and `fieldId` rules behind
`NUI290`–`NUI295`. Its own refusals are `NUI350` (grouping field missing or not a
single choice or Boolean, naming the field's actual shape) and `NUI351` (grouping by
a calculated field, with the reason a tile gives). A progress tile with no
`filterClause` child narrows nothing and is `NUI360`; its denominator is the
surface's set on a list, board or related list and the whole record type on a page,
exactly as a tile's scope already reads.

Diff sentences: *Add a breakdown chart.*, *Break the numbers down by Stage.*,
*Add a progress ring.*; `aggregate`, `fieldId`, `title`, `scope` and clause
sentences are the existing ones. Capability: `NendoFormat.FirstChartsMinimumHostVersion`
= `1.20.0`, the feature "a chart" present when either kind is in the tree,
`CurrentHostVersion` moved with it. The vocabulary description gains a `charts`
note stating the closed groupings, exactness and the table toggle, and
`PropertyNoteTable` entries for `groupByFieldId` on a chart.

Tests: `BreakdownChartTests` and `ProgressTileTests` in the shape of
`RecordPageHeaderTests` (compile, each refusal by code and property path, budget
composition at surface and group scope, capability rung, vocabulary shape), plus a
row in the existing capability and vocabulary assertions.

### S1-C: the read across the bridge (Desktop)

`data.groupAggregateRecords` beside `data.aggregateRecords`: a constant in
`WorkbenchProtocol.cs`, a row in `WorkbenchCancellation.cs`, a
`GroupAggregateRecordsAsync` on `DesktopSessionController` through `QueryAsync`,
and the dispatch that already routes `DataCountRecords`. The payload mirrors the
single aggregate's, with `groups[]` of `{ key, valueLexeme, contributingRecords }`
and `unrecognised`. It is additive, so the bridge revision does not move. One
Desktop protocol test mirrors the existing aggregate test.

### S1-D: the chart kit and the charts (Workbench)

Two pure modules, each with a `node --test` suite added to `package.json`:

- `chart-kit.ts` builds SVG markup from exact numbers handed in and nothing else:
  `proportionBar`, `bars` and `ring`, each returning the drawing, the legend with
  every number, and a `<table>` of the same numbers. Segments are focusable
  `<button>`s named for a screen reader; a zero total draws an empty track and
  says so; an absent number renders *Unavailable* with the reason; nothing animates
  under `prefers-reduced-motion`. Colours come from `choiceStyle` in `tones.ts`,
  so a toned option keeps its tone and an untoned one its derived hue.
- `charts.ts` composes reads and labels: a breakdown chart under a scope becomes
  one grouped read (`tileRead`'s composition, plus the grouping field); a progress
  tile becomes two count reads, numerator and denominator, and the ring is drawn
  only when both have answered; group labels come from the field's options and
  choices in option order; the unrecognised count becomes the data-issue note the
  board column already uses; a loaded/complete line states what the numbers cover.

`main.ts` loads charts beside tiles with the same bounded concurrency and the same
generation guard, renders them in the summary-tiles row of a surface, inside board
columns at `group` scope, and in page sections in authored order, and owns the
table toggle (`aria-pressed`, renderer state per chart). `surface-preview.ts` draws
the same charts over the validated clone's sample records, computed client-side
from the sample and labelled as such by the existing sample note. `styles.css`
adds `.chart-tile`, the bar and ring geometry, and the table view.

Tests: `chart-kit.test.mjs` (numbers present in markup and table, zero total,
unavailable, focusable segments, tone styles) and `charts.test.mjs` (read
composition at surface, group, relation and page scope; option ordering; the
unrecognised row; a ring never drawn from one number).

### S1-E: drill-through (Workbench)

A segment or ring click opens the record type's first `recordList` narrowed to
that group: `fieldId eq key`, or `isNull` for the unset row, or `eq true` /
`eq false` for a Boolean. The narrowing is renderer state keyed by entity: it is
shown as a dismissible pill in the Use toolbar (*Showing Stage: Trying*), cleared
on a file switch, and never written to the file. It does not compose with the
list's own clauses, so it spends one filter and cannot cross the ceiling; the
window key carries a `drill:` prefix so a cached unfiltered window is never shown
for it. A record type with no list root draws the segments without a drill. Tests
in `surface-model.test.mjs` and `record-window.test.mjs` cover the key, the query
and the pill's dismissal.

### S1-F: agents, gates and documents

- **Authoring example.** The deal example gains a breakdown by stage on its open
  list and a progress ring of closed-won deals; the examples test exercises both
  against the real boundary.
- **Agent-authoring gate.** `Gate-AgentAuthoring.mjs` authors a breakdown by
  status on the axiom board and a progress ring on the open list over MCP alone,
  then reads off the running app: the bar's segments carry the authored tones and
  the numbers match the column totals, the table toggle shows the same numbers,
  and a segment click opens the open list with the pill and exactly one record
  read.
- **Blackbox prompt.** Phase 3 asks for a breakdown chart and a progress ring and
  for reading their numbers back against a count.
- **Contracts.** `semantic-surfaces.md` gains *Charts*: the closed groupings, the
  exactness rules, the budget row *Chart on a surface: the surface's clauses plus
  the chart's own; the grouping is not a filter*, the refusals, drill-through as
  renderer state, and the ladder row for 1.20. `architecture.md` names the grouped
  read and the rung. `mcp-interface.md`'s vocabulary row names `charts`. The Help
  topic that says there are no charts says what a chart is instead.
- **Record.** The ADR's amendment log gains the S1 entry with the measured
  outcomes; the roadmap and the programme plan mark S1 delivered and S2 next.

Validation is the S0 sequence: `Test-Production.ps1`, then
`Publish-NendoPayload.ps1`, `Build-NendoInstaller.ps1`, `Test-NendoSetupIsolated.ps1`
and `Test-AgentAuthoringGate.ps1 -Executable artifacts/build/publish/payload/Nendo.Desktop.exe`.

## 4. Decisions taken by default

Stated so they are choices rather than accidents; each is a bounded initial value.

- A grouped read answers at most 366 groups. A choice field's options and a
  Boolean's three values are well inside it; the ceiling exists for S5's day
  buckets and is published now so nothing has to move later.
- An unrecognised stored value is one number apart, never folded into the unset
  row and never drawn as a segment, because a segment nobody configured is a
  colour nobody chose.
- A progress ring is drawn only from two answered counts. One number is a count,
  not a proportion.
- Drill-through replaces the list's own clauses rather than composing with them.
  Composition would spend the budget of eight silently and could refuse a list
  that compiled.
- Preview computes a chart from the clone's bounded sample and says so; it never
  reads active-file totals, as tiles in preview never do.
- `scope: group` on a breakdown chart is accepted, so a board column can break
  its cards down by a second choice field; the grouping field must differ from
  the board's, refused as `NUI352`.
- Both kinds are accepted on a record page and inside a section, where they read
  the whole record type as a page tile does; no chart is accepted inside a
  `tabGroup` directly, because a tab group holds sections only.

## 5. Checkpoints

Commit and push after S1-B (Engine green, 603 plus the new tests), after S1-D
(Workbench check, tests and build green), and after S1-F (production gate,
installer lanes and the authoring gate green, documents and the ADR entry in
place). Each checkpoint records changed paths, the exact commands and their
literal outcomes, and the next unfinished acceptance item.
