# Semantic surfaces contract

How stored surface definitions compile into render plans. The authoritative
vocabulary table is `src/Nendo.Engine/SemanticVocabulary.cs`, and the host
publishes it live as `nendo://application/vocabulary`. This document covers the
rules around that table.

A surface binds a calculated field by ID like any other field and never carries a
formula ([calculations-and-actions.md](calculations-and-actions.md)). Arbitrary
HTML, code and custom controls are outside this vocabulary; custom views are
[at the end](#custom-view-definitions).

**Contract version 3 is the only shape this host compiles**, with one compile path,
one plan shape and one digest projection. Roots that declare `definitionVersion` 1
or 2 are `NUI003`, which names the supported version; roots that declare different
versions are `NUI002`. Every error suppresses all custom plans, and the host never
returns a partial app; Studio, the data and recovery are unaffected.

Each surface has one root with ordered children. A file may have several entity
groups, selected explicitly in Use. With zero custom nodes, permanent Studio
remains. Missing roots stay absent: the host does not invent a board, command or
custom form. A form-only application offers bounded record selection, and list or
board records without a custom form open the Studio inspector. Commands are
selected by their stable ID and apply only to their declared entity.

**A surface nests at most twenty-four levels**, its root counted as the first
(`MaximumNodeDepth`, published as `limits.nodeDepth`). The first node past it is
`NUI456`, said once per branch, before anything is compiled. Every record type's
surfaces are compiled even when an earlier type's are broken, so one validation
reports them all.

**A filter clause compiles only if storage can read it.** `today` compares with a
Date or DateTime field and `now` with a DateTime field; anything else is `NUI457`.
`thisWeek` and `thisMonth` are spans of days on a Date or DateTime field, a week
from Monday, compared by an edge: `lt` before it, `gte` from its first day, `lte` to
its last day and `gt` after it, so *within this month* is `gte` and `lte` together.
Any other operator is `NUI460`, and a command step cannot assign one (`NUI287`). The
reader resolves these words when it reads, in the person's own calendar. None takes
a `value`; one beside them is ignored and warned about (`NUI458`). A literal is
written as storage keeps the field: a Date as `yyyy-MM-dd`, a DateTime as an ISO
timestamp with seconds and its zone, a Uuid hyphenated (`NUI277`). In a custom
view's filters the same mistakes are `NUI450`, and a malformed literal `NUI277`. A
command step that sets a retired choice is warned about (`NUI286`), since every
press would be refused; a filter may still match one.

Sibling `filterClause` children are ANDed. Contract version 3 has no OR and no
grouping, and the vocabulary publishes the combinator.

### Rules every surface shares

- **Renderer state.** The selected surface, open tab, calendar month, timeline year,
  drill, quick filter and step back are file-session renderer state: never written
  to the `.nendo` file, and cleared by a file switch.
- **Entries.** An entry, card or row opens the record page or the Studio inspector.
  New records, edits and date changes go through the typed forms; a calendar, a
  timeline or a gallery writes nothing itself.
- **Layout under the inspector.** Opening an entry never recomputes a calendar's day
  tracks or a gallery's columns. When the side inspector takes horizontal space,
  the surface keeps its width and scrolls horizontally; at the compact overlay
  breakpoint it stays at the viewport width.
- **Dates.** Grouping uses civil `YYYY-MM-DD` values and never a JavaScript `Date`
  (`new Date('2026-03-01')` is UTC midnight read back locally, which moves the day
  west of Greenwich). A DateTime is refused by name wherever records are grouped
  by day, because that would need a time zone this contract does not define.
- **Calculated fields** cannot group, bucket, be an axis or be a date bound
  (`NUI214`); a calculated Integer or Decimal may be totalled.
- **Proposal preview** draws each surface over the validated clone's bounded sample
  and labels it as a sample. Numbers that are live reads over a whole record type
  (a ring, the front page) are described, not drawn.
- **Review lines.** A node that arrives with its terms is one line in the person's
  words (*Show only records where Status is not Done*, *Order by Amount, largest
  first*). A property that changes on a node the file already has keeps its own
  line.

## How many roots of a kind an entity may own

Every root kind declares its ceiling in the vocabulary table, and the compiler
reads it from there: `maxRootsPerEntity` for a root about a record type,
`maxRootsPerFile` for a root that belongs to the file. No kind declares both, and
the vocabulary publishes both.

| Ceiling | Kinds |
| --- | --- |
| eight per entity | `recordList`, `boardSurface`, `calendarSurface`, `recordCommand`, `timelineSurface`, `gallerySurface`, `outlineSurface`, `matrixSurface`, `extensionGraphSurface`, `extensionRecordsSurface` |
| one per entity | `detailSurface`, `recordForm`; a page uses the detail first, otherwise the form |
| one per file | `overviewSurface` |
| eight per file | `extensionView` |

Eight is a bounded product choice, not a measured optimum. Too many roots is
`NUI153`. Its message counts the roots found and accepted, and its hint, generated
from the same table, states the ceiling in agreeing grammar and names the kinds
inside which a further root may be nested. A nested `recordCommand` is supported and
carries the `commandId` that `nendo.data.execute_command` takes.

## Selecting a surface, not a kind

Use offers every `recordList`, `boardSurface`, `gallerySurface`, `calendarSurface`,
`timelineSurface`, `matrixSurface`, `outlineSurface`, `extensionGraphSurface` and
`extensionRecordsSurface` root of the selected record type, in compiled order, each by
its own title. The file's `overviewSurface` and then its `extensionView` roots are
offered beside the record types, before them. When an `extensionView` says
`opensFile` and custom views run in the file, Use opens on that view; otherwise an
overview opens first. The selection is a stable surface ID per entity; the default
is the first compiled root.

**A record type with no screen is not a place.** The navigation and the breadcrumb's
first picker offer a record type only when it has one of the roots above. A type
whose only roots are its record page and commands, such as a join type, is reached
from a related row, a view or `ui.openRecord`; while one of its records is open, the
picker lists it to say where Use is. It is never the type Use shows by default.

A missing selected root falls back to the first eligible one **without erasing the
remembered choice**, so a surface removed by one proposal and restored by the next
comes back selected.

**A list draws every field it binds**: the first `fieldBinding` as the row's heading
and each later one as a column, under a head row that names them. A list that binds
no field shows its record type's first three. Board card fields come from ordered
`fieldBinding` children.

Each surface owns its query and read window, keyed by its semantic ID. Every
continuation resends exactly the query the window was opened with. The host hashes
the whole query into the cursor scope and refuses an unfiltered continuation of a
filtered query as `invalid-cursor`. Only the selected surface is read. An
unselected surface keeps any window it had for the current revision and reloads
when chosen. A selected surface with no window shows loading, empty or a failure
with retry, never another surface's records or an unfiltered default. Studio keeps
its own browsing and query state.

## Totals on a list or board

`summaryTile` is a child of `recordList`, `boardSurface`, `gallerySurface`,
`matrixSurface`, a record page, the front page, a section and a related list. On a
list or board it states one exact number over the records the surface shows, the
root filters AND the tile's own clauses, independent of the loaded page, and is
labelled with what it covers. Review lines read *Count the records in each column
as "Delivered"* or *Total Amount over every record shown as "Pipeline"*.

**A number may be as of a moment ago.** Every total, chart, ring and range is its
own exact read at a stated revision. A surface asks again when the file moves on and
when the person's civil day turns (an answer under `today` or a range word was about
its day): at most once a second, one pass at a time, and never while somebody has
hold of the page — a menu or dialog open, a text field or picker focused, a short
time after an interaction, or a record page with unsaved changes. An answer that
arrives after the file has moved is kept, because it is exact for the revision it
names; discarding it would leave a file under continuous writes with no number. Two
tiles may therefore show different revisions until writing stops. A surface never
shows another view's or another file's number.

**A board draws the columns it can contain**: the grouping field's options, in the
field's order, less those its own clauses exclude. An `eq` on the grouping field
leaves one column, and each `ne` removes one. Only those two operators are read;
any other says nothing definite and guessing would hide a column that could hold a
record. Clauses on other fields change which records go into a column, never which
columns exist.

`ne` never matches an unset value, and every operator except `isNull` leaves out an
unset record (`queries.md`); Studio and Help say so beside the operator. So a board
with any clause on its grouping field other than `isNull` draws no Ungrouped column
for its total. A loaded record whose value is outside the columns still appears
there with its data issue stated. Without such a clause, Ungrouped stays whenever it
carries a total.

A tile's `scope` is closed to `surface` (the default) and `group`, which narrows
the number to one board column and is accepted **only on a direct child of a
`boardSurface`**. An unknown value is `NUI296`; `group` elsewhere is `NUI297`. A
column is addressed by its stored choice ID and the ungrouped column by `isNull`,
never by a display name or `eq null`. A loaded card whose stored choice is neither
absent nor configured is stated as a data issue, not folded into the null total. A
configured column stays visible when it carries a total.

Aggregates are exact and carried as numeric lexemes, with a defined empty-set
result; `avg` is refused by name. A sum is exact or absent: past int64 for an
integer field, or 28 significant digits for a decimal one, the host answers
`aggregate-not-representable` and the tile reads *Unavailable* with the reason and
no Retry. It never wraps.

## Named tabs on a record page

`tabGroup` is non-root, takes an optional `title`, and holds one or more `section`
children and nothing else, so a tab is a titled section. It is accepted beneath
`detailSurface`, `recordForm`, `overviewSurface` and `section`. An empty group is
`NUI310`. A nested group is `NUI311`, also through an intervening section; the
compiler tracks the ancestor. Tabs add no commands to the section vocabulary.

The record page is an ordered recursive walk of the tree, so fields, tiles and
related lists keep their authored positions. Every panel is in one record form, so a
tab change is a visibility change and an unsaved value in a tab left behind is still
there to save. A field bound twice gets one editor, at its first position, with one
draft value and one validation state; the repeat says where the editor is.

Where a page has tabs the renderer owns validation, because a required control in a
hidden panel cannot take focus: it checks every declared field, opens the tab of the
first invalid one, focuses it, then reports. Saving is one typed record mutation
against the expected version.

**What unsaved typing survives.** A page is dirty exactly when saving would write. A
field typed into and put back is not an edit, nor is a reference picker's search
box. A save with nothing to send says *No changes to save.* and leaves the page
clean. A tab change and paging a related list patch the page in place and keep a
draft. Every other move redraws the page, so each declines with *Save or discard
your changes before …*: another surface, record type or the front page; another
record; another page of records; Add; a calendar or timeline move; a drill or its
dismissal; a retry; a command on the record; another view; both history arrows.
Closing the record (close button, Back to Data or Escape) asks *Discard your
changes?* first.

A redraw nobody asked for (a chased read, or following a write from elsewhere) waits
while the page holds unsaved typing, as it waits while a menu is open, and runs once
the draft is saved or closed. Nothing saves on the person's behalf. A draft retained
read-only after authority loss also holds refresh after focus leaves the form, and
stays readable through file-change notifications and backup dialogs until the person
leaves the page.

## The Date calendar

`calendarSurface` is a root with `definitionVersion`, `entityId`, a required
`dateFieldId`, an optional `title` and the ordering properties; its children are
`fieldBinding` and `filterClause`. The field must be an active **Date** field; a
DateTime is `NUI321`. The default order is the date ascending with the record-ID
tie-break; a declared order orders entries within each day.

A month is a Monday-first seven-column grid with previous/next month and Today,
opening on the current month. Its query is the calendar's clauses plus `date >=
monthStart AND date < nextMonthStart`. **A first page is never presented as a
complete month**: cursor pages accumulate, Load more continues until the cursor is
exhausted. While a cursor is open the calendar says so and a day with nothing loaded
reads "None loaded yet"; once exhausted, it says the month is complete. A revision change discards the pages rather
than merging snapshots. The Undated view is the same root filters plus
`isNull(dateFieldId)`, so no record is silently lost.

## The timeline

`timelineSurface` is a root with `definitionVersion`, `entityId`, a required
`dateFieldId`, an optional `title`, the ordering properties and three optional field
roles; its children are `fieldBinding` and `filterClause`. It reads what a calendar
reads and draws it as a spine.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `dateFieldId` | an active stored Date field; a DateTime is refused by name | `NUI370` when absent, `NUI371` |
| `endDateFieldId` | an active stored Date field other than `dateFieldId` | `NUI372` |
| `titleFieldId` | an active stored Text field that is not a single choice, as on a record page | `NUI373` |
| `accentFieldId` | an active single-choice field, as on a record page | `NUI374` |

A calculated field in either date property is `NUI214`; in `titleFieldId` or
`accentFieldId` it is refused by that property's code. The compiler shares these
rules with the calendar and the record page. A timeline with no `fieldBinding` is
`NUI211`.

**One civil year at a time.** The year query is the timeline's clauses plus `date >=
1 January AND date < 1 January next`, so it carries at most six declared clauses. It
opens on this year in the device's calendar; Earlier, Later and This year move it.
The spine is a heading for every month, with loaded entries under the month of their
date. As on the calendar, the first page is never the whole year: a month reads
*None loaded yet* until the cursor is exhausted, then *Nothing this month*, and the
state line says whether the year is complete. The default order is the date
ascending; a declared order orders entries within a month, and months run December
first only when the effective sort is the date field descending.

An entry carries a dot in its `accentFieldId` option's tone (the derived hue when the
option has none, muted when unset), the day and short month, its title (the
`titleFieldId` value, else the first bound field) and the remaining bound fields.

**A span.** When `endDateFieldId` is named and the end is on or after the start, the
entry states the span, both ends counted (*14 Sep – 30 Nov · 78 days*), beside a bar
of those days over the year's days. A line under the year header states the
denominator and placement rule (*Spans are drawn to scale over the 365 days of 2026;
a span that began before 1 Jan 2026 is on that year's spine.*); the bar is
decoration a screen reader skips. A span past the year is cut at 31 December and
says how many days are shown and that it continues. An end before the start is a
data issue with no bar. **Placement is by the start date only**; an overlap query
would need an OR. The undated view is the calendar's.

## Folding a section away

The person can fold away every `section` on a record page or the front page; the
heading is the control, by keyboard as by pointer. An author states only how it
starts: `opens`, `open` (the default) or `closed`. Another word is `NUI312`. A tab's
body does not fold and does not take `opens` (`NUI313`); a section inside it may.
`visibleWhen` decides whether a section is on the page, `opens` how it starts.

**A closed section reads nothing**: its tiles, charts, ranges, recent and ranked
lists and related lists read when it opens, showing the pending state first. A value
once read stays until the file changes. A closed section's fields stay in the form,
hidden, and a required field left empty reveals its section.

A fold never reaches the file. The device keeps it in the Workbench's local storage
under `nendo.sectionFolds.<applicationId>`, a map from section node ID to `open` or
`closed`, so it survives reopening and restarting, and a copy of the file on the
same device opens with the same folds. An untouched section starts as `opens` says;
after that the person's choice wins. A section opened by the page to reveal a
required field is not remembered. Unavailable storage leaves `opens` in charge
silently. Review lines: *Add the section "Lately", starting closed.*, *Start the
section closed.*, *Start the section open.*

## Showing a field only when a calculation says so

`fieldBinding` and `section` accept an optional `visibleWhen`: the `fieldId` (not the
`definitionId`; the vocabulary's `propertyNotes` says so) of a **calculated** field of
the record type in context whose result is Boolean. A stored Boolean is `NUI330`; a
calculation of another type is `NUI331`.

- It decides what is on screen and nothing else. The field stays in the form with its
  value, so a save carries what it would carry visible.
- Studio never reads it, so a surface cannot hide the permanent route into a file.
- Only a definite `false` hides. An empty, pending or failed result leaves the node on
  screen.

Review lines: *Show this only when Needs retest is yes*; a binding to a calculated
field reads *Show the calculated field …*.

## The gallery

`gallerySurface` is a root with `definitionVersion`, `entityId`, an optional `title`,
the ordering properties and three optional field roles. Its children are
`fieldBinding`, `filterClause` and the tiles and charts a list takes.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI380` |
| `accentFieldId` | an active single-choice field | `NUI381` |
| `coverFieldId` | an active media field ([ADR-0031](../decisions/0031-media-in-user-data.md)) | `NUI459` |

A calculated field in any of them is refused by that property's code. A gallery with
no `fieldBinding` is `NUI211`. A card without a declared title leads with its first
bound field, as a board card and timeline entry do.

**It is a list's window drawn as cards**: its own clauses only, so the full eight, the
same Previous and Next and cached window, and tiles and charts in a row above the
grid. `scope: group` is refused. Drill-through opens the record type's first
`recordList`.

A card shows the title first, choice values as chips and everything else as labelled
pairs. `accentFieldId` tones the card's border and tints its background; an unset
choice gets the neutral card. No card or callout carries a coloured left stripe.
`coverFieldId` tops the card with the record's picture in a square, edge to edge, from
the file's media origin; no picture gives an empty square of the soft surface, and one
that fails to load a dashed one. The cover field is not repeated among the values.
Without a cover, cards are typographic.

## The outline

`outlineSurface` ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)) draws a
record type's declared hierarchy as an expandable outline. It is a root with
`definitionVersion`, `entityId`, an optional `title` and the properties below; its
only children are `fieldBinding`, drawn as columns beside the title.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `entityId` | a record type that declares a hierarchy | `NUI430` |
| `titleFieldId` | an active stored Text field that is not a single choice; without it, the label field of the hierarchy's parent reference | `NUI431` |
| `accentFieldId` | an active single-choice field, toning each row's marker | `NUI432` |
| `expandDepth` | a whole number from 1 to 4, the levels open when it first shows; 2 without it | `NUI433` |
| `reorder` | `true` to let a person move records, `false` or absent to only read | `NUI434` |

**No filter and no ordering**: the tree is read in the hierarchy's sibling order, and
a filter would hide the ancestors that give a match meaning. A find box reads up to 20
records whose title contains the text and opens each one's path.

It reads the top level, then each open record's children, through `data.treeRecords`
in pages of 100, each record with its child count; a level with more says *Show
more*. The first draw opens `expandDepth` levels with at most 40 level reads. A
calculated column is the outline's rollup. Rows a person opens or closes are kept on
the device under `nendo.outlineRows.<applicationId>`, by node and record ID, and win
over `expandDepth`.

The rows are an ARIA treegrid with one tab stop: Up and Down move, Right opens or
steps in, Left closes or steps out, Space toggles, Enter opens the record page. With
`reorder` on and the file editable, Alt+Shift+arrow, Move up, Move down, Outdent and
Indent move the focused record, and a row can be dragged onto the top or bottom
quarter of another row to sit beside it, or the middle to become its last child. Each
move is `data.moveRecord` under the Engine's cycle and sibling rules; a refusal leaves
the rows and says why. Without the hierarchy's order field only Outdent, Indent and a
drop onto a row are offered. `schema.removeHierarchy` is refused as
`hierarchy-field-in-use` while an outline shows the hierarchy.

## The overview page

A file may own one `overviewSurface`, a root of the file. It carries
`definitionVersion`, an optional `title`, an optional `description`, and **no
`entityId`** (`NUI390`). A second overview is `NUI391`. Every child that reads records
names its own record type:

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `summaryTile`, `breakdownChart`, `progressTile`, `trendChart`, `activityGrid` | their usual properties plus `entityId` | unchanged | what they state elsewhere, over the record type they name |
| `rangeTile` | `entityId`, `fieldId` (required), `title`, `scope` | `filterClause` | the smallest and largest value of one field, as two exact aggregates |
| `recentList` | `entityId` (required), `title`, `limit`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause` | a list's ordered window, bounded to at most ten records |
| `rankedList` | `entityId` and `rankByFieldId` (required), `orderDirection`, `limit`, `title` | `fieldBinding`, `filterClause` | the few records at the top of one stored number (see [Grids](#grids)) |

`entityId` on a tile or chart is **required under an overview and refused anywhere
else** (`NUI394`); a record type the file lacks is `NUI393`. A `recentList` outside an
overview is `NUI395`; its `limit` outside one to ten is `NUI396`, not clamped; one with
no `fieldBinding` is `NUI401`.

A `rangeTile` is not a chart: no grouping, proportion or drill. It reads an Integer,
Decimal or **Date** field, since `min` and `max` over ISO dates are comparisons; `sum`
over a date stays refused (`NUI397` names what a range can read). It shows both ends
or neither, and an empty set says it has no range.

A `fieldBinding`, `relatedList` or custom record panel needs a current record, so each
is `NUI398` here, and `visibleWhen` is `NUI399`. An overview with no `summaryTile`,
`breakdownChart`, `progressTile`, `rangeTile`, `recentList`, `rankedList`,
`trendChart` or `activityGrid` is `NUI400`; a description does not count.

The overview's `description` is not the file's purpose, which is stored on the file,
set by `application.setPurpose`, and leads `nendo://application/describe` (see the
MCP interface contract).

The overview composes **nothing** across record types: no join, no number from two
types, no expression over a result, and no predicate of its own, so each child keeps
the full eight clauses less any its own kind adds. Each tile is read live over its
whole record type, four reads at a time, with its own loading, empty and failed
state. A front-page chart drills into that type's first list. Review lines: *Add a
front page for this file, whose tiles each name the record type they read.*, *Say
what this file is for: …*, *Read Axiom for this number.*, *State the smallest and
largest Accepted.*, *Show at most 5 of them.*

## A scale on an Integer field

An Integer field may carry `presentation: rating` with a closed `min` and `max`, both
required together; any other presentation refuses them by name. The span counts both
ends and holds **at most ten values**. Like every presentation, it is set when the
field is created.

The scale is stored in its own protected table, `__nendo_field_scale`, the layout
ladder's rung after the choice-tone table; the application-purpose table follows it.
The protected layout is a fingerprint of verbatim DDL, so the scale is never a column
on the field table. A row exists only for a rating field; the first row creates the
whole prefix, and a file that rates nothing keeps its layout. A rating without a
scale, or a scale on anything else, is mapping drift.

**The scale bounds the drawing, not the column.** No write or CSV import is refused
for being outside it. Such a number is stored exactly, reported as a data warning,
shown with *outside 1–5* beside it, and leaves every dot of the editing control
unchosen, so touching nothing rewrites nothing.

Dots fill to the value, with the number in the accessible name: *4 of 5* when the
scale starts at one, else *4 on a scale of 2 to 6*. It is edited as one radio per
value, plus *Not set* when optional, in the record form and Studio's record dialogs;
Studio's table edits it by choosing one of the scale's numbers. **The radio is the
dot**, with no browser radio beside it, and the rating's own rule restates the size,
padding and minimum height that the base input rule (39 pixel minimum height, 8 by
10 padding) would impose; the gate measures all three.

**A form's field names are chrome.** Names, legends and the rating's pills start no
selection. Values keep theirs, and each restates the setting because a
`user-select: none` on an ancestor reaches into a control.

## Colour on a choice option

A choice option may carry a `tone`, set by `schema.setChoiceMetadata` with its label
and availability. The closed set, published as `choiceTones`, is `red`, `orange`,
`amber`, `green`, `teal`, `blue`, `violet`, `grey`; the renderer owns the Light and
Dark colours. A hex value is refused by name, and so is `gray`.

The operation sets the whole of an option's metadata: a rename that omits the tone
clears it, and the review line says which (*Name the Stage choice Trying, mark it
available and colour it teal; preserve its stored ID* against *… and give it no
colour*). Compensation restores label, availability and tone together.

`schema.addChoice` appends a new option with its label and optional tone (*Add the
option Table to Kind on Block, after its other options, and colour it teal; records
can choose it at once*). A board grouped by the field gains the column at its end.
The undo is refused while a record holds the option.

A tone colours the board column and its dot, card chips, the dot beside a list row or
calendar entry (the first single-choice field the surface binds), Studio's choice
cells and the record-page header. An option without a tone takes a hue derived from
its stored ID.

A tone is stored in its own protected table, `__nendo_choice_tone`, on the layout
ladder after the behaviour table; the first tone creates the whole prefix. A file
that colours nothing keeps its layout.

## The record-page header

`detailSurface` accepts three optional field IDs:

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI340` |
| `subtitleFieldId` | an active stored or calculated field other than the title | `NUI341` |
| `accentFieldId` | an active single-choice field | `NUI342` |

They draw as a band above the form: the title as a heading, the subtitle under it,
the accent as a chip in its tone, the band in the same tint. The record's commands
sit directly under the band. The band is read-only; the form is where values change.
`recordForm` takes none of them. Review lines: *Head the page with Handle*, *Show
Statement under the page title*, *Colour the page by Status*.

## Charts

A chart is an exact aggregate over a **closed grouping**, drawn as proportion with its
numbers beside it. Charts are accepted where a `summaryTile` is: `recordList`,
`boardSurface`, `gallerySurface`, `matrixSurface`, `overviewSurface`, `detailSurface`
and `section`; inside a `relatedList` they are refused. They refuse the numbers a
summary tile refuses, by the same codes.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `breakdownChart` | `groupByFieldId` and `aggregate` (required), `fieldId`, `title`, `scope`, `entityId` | `filterClause` | one exact number per group, over the records its scope covers |
| `progressTile` | `title`, `entityId` | `filterClause` (at least one) | the records matching its own clauses over everything its scope covers, as two exact counts |

A `progressTile` takes no `scope` and counts over the records where it sits; with no
clause it would always be full (`NUI360`).

The closed groupings are a single-choice field's options in their order, and `false`
then `true` for a Boolean, with the unset group last. A stored value outside them is
counted apart as *unrecognised*, never folded into a group or drawn as a segment. A
breakdown may also group by a **Reference** whose target and label are set: a group
per record the data points at, ordered by label then ID, unset last; past 365 groups
the read is refused whole as `aggregate-too-many-groups`. Any other grouping field is
`NUI350`. At `group` scope on a board, the grouping must not be the board's own
(`NUI352`).

The grouping is not a filter. The Engine answers a grouped aggregate in one streamed
fold into a bucket per group, capped at 366 groups, shared by the SQLite read and the
safe-mode snapshot. A ring is two counts, its clauses over its scope and the scope
alone, drawn only when both have answered.

A breakdown is one stacked bar in the options' tones with a legend carrying every
group's exact lexeme; a ring has both numbers in its centre. A zero total is an empty
track that says so; an absent number reads *Unavailable* with the reason. A table of
the numbers is one toggle away, and each segment is a button named with its label and
number. A segment or ring drills into the record type's first list narrowed by one
predicate that replaces the list's own clauses, so it can never refuse a list that
compiled. It shows as a dismissible pill, and while it lasts the surface's own totals
and charts are suspended. Preview counts the sample per group whatever the
aggregate. Review lines: *Add a breakdown chart of the records this surface covers,
one exact number per group*, *Break the numbers down by Status*, *Add a progress ring
of the records matching its conditions over everything this surface covers*.

### Over time

Two kinds group by a civil date, accepted and scoped where the other charts are.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `trendChart` | `dateFieldId`, `bucket`, `range` and `aggregate` (required), `fieldId`, `title`, `scope`, `entityId` | `filterClause` | one exact number per bucket of the range |
| `activityGrid` | `dateFieldId` and `range` (required), `title`, `scope`, `entityId` | `filterClause` | one exact count per day of the range |

**Groups are generated, not declared**: the host makes every bucket from the resolved
bounds before reading, so an empty month is a gap at zero and a quiet day the
lightest square, never a missing bucket.

`bucket` is `month` or `week` (`NUI355`). `range` is a closed word resolved to
civil-date bounds **each time it reads**, never a stored date: a `trendChart` takes
`last12Months`, `last6Months`, `last90Days` or `last30Days` (`NUI356`); an
`activityGrid` takes `thisYear` or `lastTwelveMonths` (`NUI358`), since one square
per day fits 366 groups only for a year. Each refusal names its kind's set.
`dateFieldId` is an active stored Date field; a DateTime is refused by name (`NUI354`,
`NUI357`), not truncated.

An `activityGrid` **counts only**, with no `aggregate` or `fieldId`. A `trendChart`
takes a summary tile's aggregates, `avg` refused. Signed trend columns share a zero
baseline, negatives below it; labels state negative and zero values, and only an
empty aggregate is called none.

**The range spends two of the filter budget**, so these kinds carry at most six
authored clauses, and a `group` scope's column predicate is a third; `NUI300` names
the two added predicates. A record with no date or outside the range never reaches
the fold, so there is **no unset group**, and a leap-year day grid uses exactly 366.

A trend is one column per bucket; an empty one keeps its slot and label with a
baseline tick. An activity grid is squares in week columns, toned in five steps
against the busiest day with zero as its own step. Both have the table toggle, and a
bucket drills with its two bounds.

**An edge bucket is clipped to the range.** `last30Days` and `last90Days` start
mid-month, and a week bucket starts on the Monday on or before the range's first day.
The host counts only days inside the resolved bounds and returns them with the
buckets; the renderer labels a clipped bucket with the days it holds (`Sep 11–30`,
`1–2 Nov`) and drills exactly those days. So `last30Days` by month on 10 October is
`Sep 11–30` and `Oct 1–10`. An uncut bucket keeps its whole-period label. Across two
calendar years a clipped bucket names its year (`Oct 13–31 2025`). Safe mode folds
the same buckets over the snapshot.

### Grids

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `matrixSurface` | `definitionVersion`, `entityId`, `rowByFieldId` and `columnByFieldId` (required), `title`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause`, and the tiles and charts a board takes | one exact count in every cell of two crossed groupings |
| `rankedList` | `entityId` and `rankByFieldId` (required), `orderDirection`, `limit`, `title` | `fieldBinding`, `filterClause` | the few records at the top of one stored number, each against the exact largest |

**A matrix is one read.** The host makes every cell key from the cross product of the
two option sets, each with its own unset lane, then folds the record type once, so a
cell with nothing in it is still a cell and every number is exact over the surface's
clauses. A cell also shows the loaded window and says **showing 4 of 17** where the
window holds fewer.

The axes are active single-choice or Boolean fields (`NUI410` rows, `NUI411` columns)
and **must differ** (`NUI412`). Rows and columns are the options less those the
surface's own `eq` and `ne` exclude, every reachable one drawn even when empty. An
unset lane is drawn only when its number is not zero. Each covered record is in
exactly one cell; a value outside the options is counted as *unrecognised*.

**The cross product spends the group ceiling**: `MaximumAggregateGroups` is 366, so
options plus unset lanes on both axes must multiply within it (about nineteen by
nineteen). It counts every option, whatever the clauses, so `NUI413` names fewer
options as the remedy and states the rows, columns and cells. A definition over the
ceiling is refused when authored; one that grows over it later is refused **when
read**, and the surface says it cannot draw the grid. It never draws only the cells
that fit.

A cell drills with **two predicates**, one per axis (`isNull` for an unset lane). A
matrix does not move cards, since one movement would write two fields. Safe mode uses
the same `CellAggregateFold` as the SQLite read. Review lines: *Add a matrix crossing
two choice fields, with an exact count in every cell*, *Make one row per Status*,
*Make one column per Priority*.

**Filter.** A `recordList`, `boardSurface` or `matrixSurface` in Use offers one select
per active single-choice field and bound reference field of its type. A pick adds one
clause, `eq` on the value or `isNull` for *Not set*, to the screen's own clauses for
its window (`effectiveSurfaceQuery`), a matrix's cells and a cell's drill. It is
renderer state (`quickFilters`) carried by each place on the trail, so tabs keep their
own pick and Back, Forward or a tab switch restores it; changing it amends the place.
A drill on the same list replaces both the pick and the list's clauses. While a pick
stands, the screen's surface and column tiles and charts are neither drawn nor read. A
reference offers at most 100 targets ordered by its label field, read when the menu
opens, and says so when there are more. A screen whose own clauses spend all eight
offers no Filter.

A `rankedList` goes only under an `overviewSurface` or a `section` within one
(`NUI422`). `rankByFieldId` is an active stored Integer or Decimal; a **Date is refused
by name** (`NUI420`), since a bar is arithmetic. `limit` is one to fifty, refused above
(`NUI421`), and the ceiling when absent. The host adds `isNotNull` on the rank field,
so at most **seven** authored clauses (`NUI300` names it). Bars are against one exact
`max` over everything ranked; when it is **not greater than zero, no bars are drawn**
and every row states its number. **Equal numbers share a rank numeral and the next
numeral skips it**, and a tie crossing the limit is cut. Review lines: *Rank the
records by Value, largest first*, *Rank at most 10 of them*.

## A board grouped by a reference

`boardSurface.groupByFieldId` takes a single-choice field, whose options are its
columns, or a **bound Reference field**, whose target records are; nothing else about
the board changes.

**The columns are every active record of the target type**, ordered by the reference's
label field ascending, not only those something points at, so the layout never
depends on which page loaded. `orderByFieldId` orders cards inside a lane, never the
lanes.

**At most `boards.maximumReferenceColumns` (24).** Above that the board draws **no
columns at all** and states the record type, its record count and the ceiling. The
ceiling is checked when the board is read, by asking for one record more than it, and
an exact count is read only then. A target type with no records is `ready` with no
columns: the board names the type, says it has no columns, keeps every card in
Ungrouped, and points to the breadcrumb's record-type picker and Add, or to Studio
when the target type has no view.

The Ungrouped lane's advice is true of its board: *Move a card to a named column to
assign it.* with named columns, otherwise that there is none. A board or grid whose
own `eq` and `ne` exclude every option of its grouping field says its own filter
emptied it and names the field.

An unbound Reference is `NUI237`; a missing or retired target type `NUI238`; a missing
or retired label field `NUI239`. `NUI236` reads *The board needs an active bounded
choice field or a bound reference.* A reference column carries no tone, only the
derived hue.

Ungrouped holds records with no reference, and a drag into it clears the field. A
stored reference outside the target type is stated as a data issue; the host refuses
deleting a referenced record (`record-referenced`). **A drag between reference
columns writes the target record's current version**, required for a reference write
(`target-version-required`); if the target moved, the write is refused
(`target-version-conflict`), and the board says so in its own words and reads its
columns again.

A column tile composes the board's clauses, its own, and one `eq` on the reference
field. Review line: *Give the board one column per Client record, from Client, and
draw nothing above 24 of them*; preview: *one column per Client record, 12 of them*.

## Adding and opening from a related list

A `relatedList` offers **Add**, a new record of the related type with the reference
back already filled in, and **open**, a related row as its own record page. Nothing is
authored or stored: the node's `targetEntityId` and `viaFieldId` are already proved
(`NUI260`–`NUI266`), so the file and its minimum host are unchanged.

| What it does | The rule |
| --- | --- |
| Add | The related type's record page as a create form in place of this page, with its sections, tabs and required fields; a type with no page falls back to its field list. It shows no relations, so an Add cannot nest. |
| The reference back | Filled in first, named by the reference's label field, carrying the record's current version (`target-version-required` otherwise). It stays editable, and is added to the form first even where the page does not bind it. |
| open | Reads the related record by its own ID and opens its page, not looking in the target surface's window. |
| Getting back | One step named after the record it returns to, removed once taken and replaced, not stacked, by a third record. Cleared when the record context is left. |
| Unsaved edits | Declines both, as the board drag does; a tab change and paging the relation keep the draft. |
| A row whose record has gone | Says *That record is no longer there* and stays on the page with busy cleared; the read comes before anything moves. |
| A related type with no screen | Offers neither, and says so beside the heading. |

### A related list of links

A record type is a link when the field pointing back is required and at least one
other reference is required too. That is read from the schema; nothing is stored and
the minimum host does not move.

| What it does | The rule |
| --- | --- |
| Link ‹other type› | One button per other required reference, beside Add: Add's form with the other end's picker open, so a link is never saved without its own fields. |
| Remove link | On each row; asks first, naming the row, then deletes the link record at the version the row was read at, an ordinary delete restorable in History. The ends are untouched. |
| Either side | Wherever a page shows the relation, each side offers Link at the other end. |
| A custom view | Uses `records.create` with both references in `targetVersions`, and `records.delete` ([custom views](custom-views.md)). |
| Unsaved edits | Declines both. |

A relation window read at an older revision reads as loading until read again; a
record page chases its relations on the same terms as its totals.

These flows allocate no code. A code field is what its schema makes it
([ADR-0020](../decisions/0020-unique-and-generated-fields.md)): unique refuses a
duplicate as `value-not-unique`; numbered (`schema.setFieldSequence`), the form says
"Assigned when saved" and the host writes the next code when the field is left empty;
otherwise a required one must be filled ([relationships](relationships.md#unique-fields)).

## Bounded query composition

One bounded query carries at most **eight** effective filters, including those the
host adds. `MaximumEffectiveFilters` is one constant, read by the vocabulary and by the
validation that refuses.

| Context | Effective filters |
| --- | --- |
| List, board or gallery window | the surface's own `filterClause` children |
| Surface tile | the surface's clauses plus the tile's own |
| Board column tile | the board's clauses, the tile's own, and one column predicate |
| Matrix window and its one crossed read | the surface's own `filterClause` children; neither grouping is a filter |
| Ranked list | its own clauses plus the one predicate the host adds to keep the records that have a number |
| Related list, and a tile inside one | the relation's clauses, the tile's own if any, and one reference predicate |
| Calendar month or undated view | the calendar's clauses plus two date bounds, so at most six declared clauses |
| Timeline year or undated view | the timeline's clauses plus two date bounds, so at most six declared clauses |
| Record page tile | the tile's own clauses, over the whole record type |
| Overview tile, chart or recent list | its own clauses, over the whole record type it names; an overview adds no predicate of its own |
| Chart on a surface | the surface's clauses plus the chart's own; the grouping is not a filter |
| Board column chart | the board's clauses, the chart's own, and one column predicate |
| Trend chart or activity grid | its context's clauses, its own, and the two date bounds of its range; at `group` scope, also one column predicate |
| Progress ring | its own clauses over its scope, and the scope alone, as two counts |
| Custom view | its `filterClause` children on each record type, one query per type: the node type's, and on a graph the edge type's |

Over budget is `NUI300`, naming the node, the property path, the composed count and
each clause's source. The host never drops a clause, widens a query, deduplicates or
raises the limit.

## Icons

A screen and a custom view may carry an **icon**: the name of one icon from Nendo's
set ([ADR-0038](../decisions/0038-settings-in-one-place.md#icons-for-record-types-and-screens)),
listed by `nendo://application/icons` with each icon's group and search words. It is
drawn wherever the screen or view is: the navigation, the tabs, the breadcrumb
pickers, the command box and the front page. Without one, the icon is guessed from the
title.

- **Where.** `icon` is an optional property of every surface root kind except
  `recordCommand`, and of every custom-view kind: `extensionView`,
  `extensionGraphSurface`, `extensionRecordsSurface` and `extensionRecordPanel`. On any
  other kind it is `NUI090`. `ui.setProperty` sets it and `ui.removeProperty` clears it.
- **What.** A name the set holds, as text. `ui.setProperty` refuses any other name when
  it is written. A definition that already holds a name this version does not know, such
  as one from a later set, still compiles: the warning `NUI461` names the node and the
  name, and the screen is drawn with the guessed icon. A value that is not text is the
  error `NUI462`. Both hints point at the icons read.
- **The plan.** A node with an icon carries it twice: in `properties.icon` as stored,
  and as `icon` beside `kind`, so a client reads it without knowing which kinds take
  one. A node without an icon carries neither, which keeps its digest as it was. A name
  the set does not hold stays in `properties.icon` and is left out of `icon`. A
  record type's surfaces are at `applications[].surfaces[].icon`, the file's own views
  at `views[].icon`, the front page at `overview.surface.icon`, and a record panel on
  its page's node as one of the `children`.
- **A record type's icon** is not a surface property. `schema.setEntityIcon` sets it in
  the definition, and the session snapshot's `entities[].icon` and the MCP schema read
  carry it ([MCP interface](mcp-interface.md#vocabulary-areas)).

## Capability versions

A root's version number does not say what a host must understand.
`NendoSemanticCapability` computes it from the definition's **shape**, plus the stored
fields where the shape cannot tell. The ladder is:

| Feature | Minimum host |
| --- | --- |
| Any custom surface | 1.1 |
| Composable semantic surfaces (`definitionVersion` 3) | 1.11 |
| A summary tile on a list, board or gallery, or any `scope` | 1.12 |
| More than one `recordCommand` root on one record type | 1.13 |
| More than one `recordList` or `boardSurface` root on one record type | 1.14 |
| Named tabs (`tabGroup`) | 1.15 |
| A Date `calendarSurface` | 1.16 |
| A `fieldBinding` or `section` with `visibleWhen` | 1.18 |
| A choice option with a tone, or a record page with a header | 1.19 |
| A breakdown chart or a progress ring | 1.20 |
| A `timelineSurface` | 1.21 |
| A `gallerySurface`, or an Integer field with a rating scale | 1.22 |
| An `overviewSurface`, a `recentList` or a `rangeTile` | 1.23 |
| A `trendChart` or an `activityGrid` | 1.25 |
| A `matrixSurface` or a `rankedList` | 1.26 |
| A `boardSurface` grouped by a Reference field | 1.27 |
| A `section` with `opens` | 1.28 |
| An `extensionGraphSurface` (a custom graph) | 1.29 |
| A custom view that declares `protocolVersion` 2 | 1.30 |
| An `extensionRecordsSurface` (one record type as typed columns) | 1.31 |
| An `extensionRecordPanel` (a custom view on a record page) | 1.32 |
| A custom view that only the open rules accept: no package pin, a configuration with anything in it, a calculated label or field, a filter whose value kind is not `literal`, more fields or panels than the 1.32 rules allowed | 1.34 |
| An `outlineSurface` | 1.36 |
| A `filterClause` on, or an `orderByFieldId` naming, a calculated field | 1.40 |
| An `extensionView` (a custom view as a screen of the file) | 1.42 |
| A `gallerySurface` with a `coverFieldId` | 1.52 |
| A `filterClause` whose value kind is `thisWeek` or `thisMonth`; a formula that calls `AddDays` states it on its own evidence | 1.53 |
| A `summaryTile`, `breakdownChart` or `rankedList` over a calculated number, or a `breakdownChart` grouped by a Reference | 1.54 |
| A screen's root or a custom view with an `icon` | 1.56 |

Every rung above 1.11 that is not in the table is not a shape of the node tree: 1.17,
1.24, 1.33, 1.35, 1.37, 1.38, 1.39, 1.41, 1.43, 1.44, 1.45, 1.46, 1.47, 1.48, 1.49, 1.50, 1.51, 1.55 and 1.57 (`NendoFormat`).
An operation declares each on its own evidence, as it does 1.52 for a media field:

| Rung | A file that |
| --- | --- |
| 1.17.0 | stores behaviour definitions (ADR-0008) |
| 1.24.0 | carries a purpose |
| 1.33.0 | carries a custom-view package (ADR-0013) |
| 1.35.0 | declares a hierarchy (ADR-0019) |
| 1.37.0 | has a unique field (ADR-0020) |
| 1.38.0 | chose its own look |
| 1.39.0 | had its older history folded into a checkpoint (ADR-0021) |
| 1.41.0 | marks what a new file keeps, or was started with New (ADR-0022) |
| 1.43.0 | carries a skill package (ADR-0024) |
| 1.44.0 | has a text field presented as Markdown |
| 1.45.0 | declares a link rule (ADR-0026) |
| 1.46.0 | built its full-text index (ADR-0028) |
| 1.47.0 | has behaviour that uses a create step's links, `IsEmpty` or a total over a calculation |
| 1.48.0 | cleared a screen property with `ui.removeProperty` |
| 1.49.0 | has a formula that calls `ToText` |
| 1.50.0 | carries the three history indexes a fold adds (ADR-0021) |
| 1.51.0 | changed a reference's label with `schema.setReferenceLabel` |
| 1.52.0 | has a media field or an embedded picture (ADR-0031) |
| 1.55.0 | has its own picture as its icon |
| 1.57.0 | carries a view package that declares settings (ADR-0038) |

A history fold, which is not an operation, states 1.50.0 in the manifest, covering the
fold table's 1.39.0; a file started with New states 1.50.0 too, since its copy is
folded. At 1.19 and 1.22 a field operation also raises the rung: a choice tone and a
rating scale. At 1.56 `schema.setEntityIcon` does, for a record type's icon.

Rows 1.27, 1.34, 1.40 and 1.54 read the stored fields beside the tree, because the
shape alone cannot tell: a board or breakdown grouped by a reference looks like one
grouped by a choice, and a filter, ordering or total on a calculated field like one on
a stored field (a field the nearest record type names but does not store is
calculated; that type is a list's `entityId` or a related list's `targetEntityId`).
Without this an older host would refuse every authored screen without naming one. For
1.34, a view the 1.32 rules accept keeps its earlier rung, and a question the tree
cannot answer without the fields counts as not beyond.

The calculation runs over the tree a mutation leaves behind, not the operations
submitted: an inline `ui.addNode` expands into several operations, and a `ui.moveNode`
can change what a definition needs without adding anything. Only a mutation that
touches UI nodes recomputes it. A file's recorded minimum is only ever raised, and
opening a file never rewrites it. A raise is its own irreversible
`raiseMinimumHostVersion` line in the semantic diff. File inspection reports an
insufficient minimum with the features that need it. Product release version, semantic
contract version and file capability version are three separate things.

## The mutation is the materialization boundary — for the definition lane only

A record type exists physically from the end of the mutation that created it. So a
required field must be in the same mutation as its `schema.createEntity`; a later
mutation that adds one is refused as `NPROP004`, which names the field, the record type
and both remedies, the other being to add it optional and require it with
`schema.setFieldRequired` in a later mutation. An intervening mutation may write
records that would have no value. UI nodes are exempt: a root added in one mutation
accepts children in a later one, so a large tree can be split across calls.

Within one change set, the definition revision advances once per definition-lane
mutation and not for a data-only one. A caller may omit `expectedDefinitionRevision`;
the MCP adapter fills in the value for that position before compiling, and the stored
operation carries the exact integer.

`ui.removeProperty {surfaceId, nodeId, propertyName}` removes one property, as if never
given; it is how an optional property (`subtitleFieldId`, `visibleWhen`, `opens`, an
ordering) is cleared, since validators refuse null. It refuses an absent property
(`ui-property-absent`), retains the removed value, and is the undo of a
`ui.setProperty` that gave a first value.

Over MCP, `ui.addNode` accepts an inline `properties` map, which the adapter expands
before compilation, diff, history or promotion into the canonical `ui.addNode` plus one
`ui.setProperty` per property in property-name order. The two budgets are published and
echoed separately.

A node's `position` is a sort key among siblings (then surface and node ID), stored as
given. Over MCP, `ui.addNode` and `ui.moveNode` may name `beforeNodeId` or
`afterNodeId` instead. The adapter resolves the anchor when the operation is added,
against the file and the change set's earlier operations, to the key between the
neighbours; with no free key it takes the next one and adds a `ui.moveNode` for each
later sibling that must move up, stopping at the first already clear. Those moves are
ordinary, budgeted, reviewed operations. The node takes the anchor's parent; a
differing `parentNodeId` is refused.

Proposal preview renders the validated derivative's bounded plans and values with no
write authority; its summary counts come from the validated clone, so a schema-only
change set previews as what it adds. Root and record selection is preview-local.
Promotion is canonical operation replay against current definitions and touched-record
versions, never a swap of the derivative file. `Gate-AgentAuthoring.mjs` builds the
vocabulary through MCP alone and drives these surfaces and page rules in Light and
Dark.

### Use navigation and layout

The View disclosure picker and the page heading show the selected surface; the picker
lists each surface with its kind, takes keyboard focus and closes on Escape. Surface
totals sit inset below the toolbar. Board headers and group summaries size to content
and the card area takes the remaining height. Calendar controls, grid and undated rows
share the 16px content inset of lists and boards. Studio row actions are compact
outlined buttons centred in their cells.

A record opened from a related row offers one step back, named after its record, in
the toolbar group with the surface picker and drill pill.

The address row over each tab starts with back and forward arrows, before the place it
names and the command box. Each arrow says where it goes with the header's eyebrow and
title ("Back to Use · Work — All work"), or is disabled and named only for itself.
Alt+Left and Alt+Right do the same, yielding to a dialog, the file menu and a focused
field. A place is the view, record type, front-page choice, surface, record, drill,
open tab of each tab group on the type's page, a calendar's month and view or a
timeline's year and view, the Help topic, the labelled step back, and for a proposal
review the destination of its Close button. They are carried as values, so going back
to a since-drilled list returns it whole. The trail is bounded, belongs to the open
file and empties when another opens. Until somebody uses the picker, Use shows the
first compiled type that has a screen.

A place that no longer exists (a deleted record, a removed surface, a type without a
screen, a retired type behind a Studio page, a removed front page, a view the file's
capabilities no longer allow) is declined with a sentence and dropped, never resolved
to a neighbour. A Studio page is judged on its own record type only. While a record
form holds unsaved typing, both arrows decline.

**How long a sentence lasts.** Each sentence is kept with its view and put back after
every redraw. A success stays until an action clears it or the view is left; a notice
with Refresh view until that succeeds; a refusal (a declined step or move, a vanished
record, a failed write) until the person's next press or key off the sentence, or a
move off the view. The authoring gate checks a refusal survives a write from elsewhere.

## Custom view definitions

ADR-0013 authorizes four custom-view kinds: the `extensionGraphSurface` and
`extensionRecordsSurface` roots, the `extensionRecordPanel` on a record page or form,
and the `extensionView` root, a screen of the file. Each names a package the file
carries by `packageId` and runs that package's code when shown, through the same
canonical UI operations, review and replay as other roots. A view whose package is
missing compiles with the warning `NUI452`, and the definition is preserved.
Properties, the rungs from 1.29.0 to 1.34.0 and what view code may do are in
[custom views](custom-views.md#view-definitions).
