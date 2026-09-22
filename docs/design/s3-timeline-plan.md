# Implement S3: the timeline

Status: **carried out 2026-09-14**, the day it was proposed. Every stage below landed;
the measured outcomes are in the S3 entry of
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), and the rules in the
[semantic surfaces contract](../contracts/semantic-surfaces.md). Three defaults moved
while building: the calendar's page accumulator became one map and one loader serving
both surfaces rather than a second copy; the year header states the span scale and
the placement rule on the surface itself, because a reader would otherwise infer an
overlap query; and the gate authors the timeline as its own proposal, because a change
set holds at most 128 operations and the register's screens already filled one, which
also puts the minimum-host raise on a review of its own. Where this plan and the
shipped code disagree, the contract is current
and this file is kept as the transfer it was. The programme it belongs to is the
[surfaces and charts plan](surfaces-and-charts-plan.md).

S2, the gallery and the rating presentation, has not been built. S3 was asked for next, so
it takes the next rung, 1.21.0, and S2 takes 1.22.0 when it lands: the ladder is monotone
and a host must never advertise a later feature than it has, so rungs follow delivery order.

## 1. Start here

Deliver idea B2: a `timelineSurface` root that draws an entity's records on a vertical spine
by a Date field, one civil year at a time under month headings, with a toned dot from a
single-choice accent field, an optional end date that turns an entry into a span, and a
separate undated view. It reads exactly what the calendar reads — bounded cursor pages
between two civil-date bounds, plus the `isNull` undated query — and stores nothing the
calendar does not: no layout, no expression, no renderer state.

Read the calendar section of the [semantic surfaces contract](../contracts/semantic-surfaces.md)
first, because the timeline composes its read and states its completeness the same way, and
the record-page header section, because `titleFieldId` and `accentFieldId` obey the same
rules on an entry as on a page. The calendar slice is the worked precedent for the whole
checklist: `DateCalendarTests`, `calendar-model.ts`, `wireCalendar` and `loadCalendarPage`
show the shape each stage's evidence takes.

### Non-goals

No overlap query (a span that began in an earlier year is on that year's spine), no
positioned time axis, no DateTime (refused by name as the calendar refuses it), no tiles or
charts under a timeline yet, no week or day scheduling, no drag-to-date, and no MCP read of
a timeline: agents author it and people read it.

## 2. What S3 delivers

| Piece | What a person sees |
| --- | --- |
| Timeline surface | In Use, beside lists, boards and calendars: a year header, twelve month headings in order, and under each an entry per record placed by its date — a toned dot on a left rail, the day and short month, the title, the bound fields |
| Spans | With an end-date field named: "14 Sep – 30 Nov · 78 days" and a duration bar proportional to the days shown over the year, clipped at 31 Dec with "continues past 31 Dec 2026"; an end before the start states a data issue and draws no bar |
| Honest loading | Cursor pages accumulate with Load more; the state line says whether the year is complete; a month with nothing loaded reads "None loaded yet" until the cursor is exhausted, then "Nothing this month" |
| Undated view | The same root filters plus `isNull(dateFieldId)`, as a record list, so a record with no date is never lost |
| Navigation | Earlier and Later shift a year; This year resets; renderer state per surface, cleared on a file switch, never stored |
| Review | A diff sentence for every property; read-only proposal preview draws the same spine over the clone's sample; the vocabulary publishes the kind with property notes; an example authors it; the gate builds it over MCP and drives the running app |

## 3. Stages, in order

### S3-A: the kind (Engine vocabulary, compiler, diff, capability)

One row in `SemanticVocabulary.cs`: `timelineSurface` is a root with `definitionVersion`,
`entityId`, `title`, a required `dateFieldId`, optional `endDateFieldId`, `titleFieldId` and
`accentFieldId`, and the existing ordering properties; its children are `fieldBinding` and
`filterClause`; it owns eight roots per entity like a calendar. The property notes explain
`dateFieldId` and `endDateFieldId` once, and `titleFieldId` and `accentFieldId` gain their
timeline meaning beside their page meaning. The effective-filter table gains *Timeline year
or undated view: the timeline's clauses plus two date-bound predicates, so at most six
declared clauses*.

The compiler validates the timeline with the calendar's rules shared, not copied: the Date
shape check behind `NUI321` becomes one helper that the timeline calls with `NUI371`, and
the header rules behind `NUI340` and `NUI342` become helpers the timeline calls with
`NUI373` and `NUI374`. Its own refusals are `NUI370` (no `dateFieldId`), `NUI371` (the date
field missing, a DateTime by name, or not a Date), `NUI372` (the end date blank, missing, a
DateTime, not a Date, or the same field as the start), `NUI373` (a title that is not a stored
Text field or is a single choice) and `NUI374` (an accent that is not a single-choice field).
A calculated field in any of the four is `NUI214`, as everywhere. A timeline with no
`fieldBinding` is `NUI211`. A year is two implicit predicates, and the budget refusal names
them as *date bounds the host adds*.

Diff sentences: *Add a timeline of a date field, with its own undated view.*, *Place each
record on the timeline by Decided.*, *End each span at Review date.*, *Title each entry with
Title.*, *Colour each entry by State.* Capability: `NendoFormat.TimelineMinimumHostVersion`
= `1.21.0`, the feature "a timeline" present when the kind is in the tree,
`CurrentHostVersion` moved with it.

Tests: `TimelineSurfaceTests` in the shape of `DateCalendarTests` (compile, each refusal by
code and property path, the budget at six and seven clauses, the root ceiling, the rung
raised irreversibly, the vocabulary row and its notes), plus rows in the capability,
diff-summary and behaviour-surface assertions.

### S3-B: the spine (Workbench model, Use, preview, styles, help)

A pure `timeline-model.ts` beside `calendar-model.ts`, tested with `node --test`: the year
bounds and the year query (the timeline's clauses plus `date >= 1 Jan AND date < 1 Jan next`,
sorted by the declared field or the date), the undated query reused from the calendar, the
window key, civil day arithmetic with no JavaScript `Date`, `spanOf` (inclusive days,
clipped at the year end, an end before the start as an issue), grouping into all twelve
months, and the state, empty and date labels.

One accumulator serves both surfaces: the calendar's page accumulator and its loader are
generalised, keyed by the namespaced cache key each surface builds, and the timeline adds
its own year and mode maps as renderer state. `main.ts` and the Use view dispatch on "a
kind that accumulates its own pages" rather than on the calendar by name. The markup
mirrors the calendar's attribute for attribute — toolbar, state line, retry, Load more, an
entry as a button that opens the record — and adds the month sections, the rail, the dot,
the span bar with its sentence, and one line under the year header stating that spans are
drawn to scale over the year's days and that a span which began before the year is on that
year's spine. Proposal preview draws the same spine over the validated clone's sample and
says so. Help gains a Timelines section beside Calendars.

Two repairs ride along in the files touched: three focus and today rings that read an
undeclared `--accent` token now read `--cobalt`, and Studio's Surfaces page and the review
label gain the calendar case they lacked, beside the timeline case.

### S3-C: agents, gates and documents

- **Authoring example.** `a-timeline-of-spans`: a Project entity with toned stages, a start
  and an end date, and a timeline of spans; the examples test exercises it against the real
  boundary, and the examples row in the MCP interface contract is repaired to name all nine.
- **Agent-authoring gate.** The Axiom Register gains a Retired date; the accepted axiom gets
  one in the following January so its span is always clipped; a timeline titled *Accepted
  over time* is authored over MCP alone, and the gate reads off the running app the year,
  the twelve month headings, a green dot, the span sentence, the state line, exactly one
  record read per selection, the undated view with two records, and an entry opening the
  headed record page.
- **Decision Log.** The neutrality fixture gains a decided date and a timeline of decisions
  from their decided date to their review date, through both fixture loaders and the
  neutrality runtime lane, so the timeline is proved on a second application without a
  branch named for it.
- **Blackbox prompt.** Phase 3 asks for a timeline with an end date so that one entry is a
  span, and for reading the year, the span and the undated view back.
- **Contracts.** `semantic-surfaces.md` gains *The timeline*; the budget row and the ladder
  row; `architecture.md`, `mcp-interface.md`, the roadmap, the glossary and the programme
  plan are updated in the same change; the ADR's amendment log gains the S3 entry with the
  measured outcomes.

Validation is the S1 sequence: `Test-Production.ps1`, then `Publish-NendoPayload.ps1`,
`Build-NendoInstaller.ps1`, `Test-NendoSetupIsolated.ps1`,
`Test-AgentAuthoringGate.ps1 -Executable artifacts/build/publish/payload/Nendo.Desktop.exe`,
and `Review-NeutralityRuntime.ps1` for the Decision Log lane.

## 4. Decisions taken by default

Stated so they are choices rather than accidents; each is a bounded initial value.

- One civil year per view. The range is renderer state, so it could widen without a stored
  change; a year gives the spine its month headings and costs the same two bounds a month does.
- Placement is by the start date only. An overlap query needs an OR the closed clause set
  has not got, and two windows would double the accumulator. The year header states the
  rule on the surface, not only in the documents.
- A span is a duration bar, not a positioned axis: its width is the days shown over the
  year's days, both dates and the day count sit beside it, and the year's day count is
  stated once under the year header, so the proportion is of numbers on screen. Bars
  positioned on a per-row year axis were rejected as two time axes on one surface.
- Day counts are inclusive; an end equal to the start is a one-day span; an end before the
  start is a data issue on the entry, never a bar drawn backwards.
- Months are reversed only when the effective sort is the date field descending; a declared
  order by another field orders entries within a month, as the calendar orders within a day.
- The undated view is the record list, as the calendar's is.
- No tiles or charts under a timeline yet; the summary row is kind-agnostic and one
  vocabulary row would admit them.
- The Decision Log fixture gains a decided date and a timeline without tones: an untoned
  option gets its derived hue everywhere, and tones are proved on the register.

## 5. Checkpoints

Commit and push after S3-A (Engine green), after S3-B (Workbench check, tests and build
green), and after S3-C (production gate, installer lanes, the authoring gate and the
neutrality lane green, documents and the ADR entry in place). Each checkpoint records
changed paths, the exact commands and their literal outcomes, and the next unfinished
acceptance item.
