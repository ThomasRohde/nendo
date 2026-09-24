# Semantic surfaces contract

How stored surface definitions compile into render plans. The authoritative
vocabulary table is `src/Nendo.Engine/SemanticVocabulary.cs`, and the host
publishes it live as `nendo://application/vocabulary`. This document covers the
rules around that table.

ADR-0008's bounded calculation and action design is delivered.
[calculations-and-actions.md](calculations-and-actions.md) is its implementation
contract, and the [design notes](../design/adr-0008-semantics.md) behind it are
history. The design adds no expressions to this surface vocabulary and does not
change stored declarative commands. A surface binds a calculated field by ID like
any other field, and a surface never carries a formula. Calculation consumers use
the shared Engine service and preserve Studio, typed writes and proposal review.
Arbitrary HTML/code and custom controls remain outside that authority.

**Contract version 3 is the only shape this host compiles.** Versions 1 and 2
were removed on 2026-09-12, before the format had users. Their fixed
form/list/board/command slots were removed with them. There is one compile path,
one plan shape and one digest projection. If the stored roots declare
`definitionVersion` 1 or 2, `NUI003` refuses them and names the supported version.
Roots that declare different versions are `NUI002`.
Every custom plan is then suppressed; Studio, the data and recovery are
unaffected.

Each surface has one root with ordered children. A file may have several entity
groups, selected explicitly in Use. With zero custom nodes, permanent Studio
remains. Board card fields come from ordered `fieldBinding` children. The
parallel `cardFieldIds` property no longer exists.

## How many roots of a kind an entity may own

Every kind that can be a root declares its ceiling in the vocabulary table. The
compiler reads the ceiling from that table and does not hard-code it. The ceiling
that applies depends on what the root belongs to:

- `maxRootsPerEntity` applies to a root about a record type.
- `maxRootsPerFile` applies to a root that belongs to the file.

The S4 `overviewSurface` is the only kind that declares `maxRootsPerFile`, and no
kind declares both. A client that read only `maxRootsPerEntity` would find no
ceiling at all on the front page, so the vocabulary publishes both.
Under the ADR-0004 2026-09-12 amendment, `recordList`, `boardSurface`,
`calendarSurface` and `recordCommand` each declare **eight**. `timelineSurface`
(the 2026-09-14 amendment, S3) and `gallerySurface` (S2) declare the same.
`matrixSurface` (the 2026-09-17 amendment, S6) and `extensionGraphSurface`
(ADR-0013) also declare eight. `detailSurface` and `recordForm` keep one, with their existing page precedence:
detail first, otherwise form. Eight is a bounded initial product choice. It is
not a measured optimum.

A number of roots over the ceiling is `NUI153`. Its message counts the roots found
and the number accepted. Its hint is generated from the same table: the hint
states the ceiling in grammar that agrees with the number, and it names the kinds
inside which a further root may be nested. A hint that reads "more than one"
against a table that permits eight is worse than no hint. That is why the message
and the hint are both generated from the table and not written by hand.

A nested `recordCommand` remains supported and still carries the `commandId` that
`nendo.data.execute_command` takes. It was previously the only way to have a
second command on an entity. It is now one of two ways, and nothing was migrated.

Sibling `filterClause` children are ANDed: a record must satisfy every one of them
to appear. Contract version 3 has no OR and no grouping. The vocabulary publishes
the combinator because the rule was previously true but not stated. An author who
declared two clauses and intended AND had no way to confirm it from the
interface. In a proposal, a clause added with its terms is one line, for example
*Show only records where Status is not Done*, or on a progress ring *Count only
records where Stage is Closed won*. It is not a line that says nothing, followed
by the field, the comparison and the value on one line each. If a term changes on
a clause the file already has, that term keeps its own line, because that is a
change to something the person has.

Missing roots remain absent in compiled plans. The host does not invent a board,
command or custom form. A form-only application offers bounded record selection.
List/board records without a custom form can open the host-owned Studio
inspector. Commands are selected by their stable ID and apply only to their
declared entity. Every error suppresses all custom plans; the host does not
return a partial app.

## Selecting a surface, not a kind

Use offers every `recordList`, `boardSurface`, `gallerySurface`, `calendarSurface`,
`timelineSurface`, `matrixSurface` and `extensionGraphSurface` root of the selected
record type, in compiled order, each by
its own title. The file's `overviewSurface` is not among them. It belongs to the
file, so Use offers it beside the record types and not among the surfaces of one
type. When the file has an overview, Use opens it first. The selection is a
stable surface ID per entity; the default is the first compiled root. Resolution
by kind returned the first root of a kind, so seven of eight lists on an entity
could not be shown at all. Also, a board/list *mode* could not name a third view.

If the selected root is missing, Use falls back to the first eligible one
**without erasing the remembered choice**. Thus, if one proposal removes a surface
and the next proposal restores it, the surface comes back selected. Selection,
the open tab and the month a calendar shows are file-session-local renderer state
and never reach the `.nendo` file. A file switch clears them.

Each surface owns its own query and its own read window, keyed by its stable
semantic ID. A window carries the query it was opened with, from page one onward.
Every continuation resends exactly those arguments. The host hashes the whole
query into the cursor scope, so it refuses an unfiltered continuation of a
filtered query as `invalid-cursor`. It does not answer that continuation over the
wider set.

Only the selected surface is read. An unselected surface keeps any window it
already had for the current revision, and it is reloaded when it is chosen. If a
selected surface has no loaded window, it shows loading, empty or a failure with
retry. It never shows the records of another surface and never an unfiltered
default. Studio keeps its own independent browsing and query state.

## Totals on a list or board

`summaryTile` is a child of `recordList`, `boardSurface`, `gallerySurface` and
`matrixSurface`, and also of a record page, the front page, a section and a
related list. On a list or board, the tile states one exact
number over the records that the surface shows. That set is the root filters AND
the tile's own clauses, independent of which page is loaded. The renderer labels
the tile with what it covers, because a total over a filtered set otherwise reads
as a count of the cards on screen.

In a proposal, a tile that arrives with its terms is one line. The line says what
the tile counts, over what, and its label, for example *Count the records in each
column as "Delivered"*, *Total Amount over every record shown as "Pipeline"* or
*Count the records over every related record as "Axioms"*. An ordering that
arrives with its surface is one line in the field's own terms: *Order by Completed
on, newest first*, *Order by Title, A to Z*, *Order by Amount, largest first*. If
a property changes on a tile or an ordering the file already has, that property
keeps its own line, because that is a change to something the person has.

**A number may be as of a moment ago.** Every total, chart, ring and range is its
own exact read at a stated revision. A surface asks again when the file moves on:
at most once a second, one pass at a time, and never while somebody has hold of
the page. A person has hold of the page while a menu or a dialog is open, while a
text field or a picker has focus, for a short time after an interaction, and while a
record page has unsaved changes. If an answer arrives after the file has moved, the surface keeps it,
because that answer is about the revision it names. If the surface discarded it,
a file that receives continuous writes could never show a number at all. So while
writing continues, two tiles on one page may show different revisions. Each is
exact for the revision it names, and they converge when the writing stops. A
surface never shows a number that belongs to another view or another file.

**A board draws the columns it can contain.** Its columns are the grouping field's
options, in the field's own order, less any that the board's own clauses exclude.
An `eq` on the grouping field leaves one column, and each `ne` removes one. The
board reads only those two operators. A comparison or a null test over a choice
says nothing definite about which options remain, and a board that guessed would
hide a column that could hold a record. The rule exists because the alternative
gives false information.

For example, a board filtered to `status ne Done` that still draws a Done column
reads 0 under that heading. That 0 states that nothing is done. It does not state
the true fact, which is that this board does not show done records. Clauses on
other fields change which records go into a column, but never which columns
exist. The ungrouped column is unaffected.

A tile's optional `scope` is closed to `surface` (the default) and `group`.
`group` narrows the number to one board column. It is accepted **only on a direct
child of a `boardSurface`**. A tile nested deeper has no column to belong to, and
a search upward for a column would invent a grouping rule that nothing publishes.
An unknown value is `NUI296`; `group` in the wrong place is `NUI297`.

A column is addressed by its stored choice ID, and the ungrouped column by
`isNull`. A column is never addressed by a display name, and never by `eq null`.
If a loaded card's stored choice is neither absent nor one of the configured
options, the column states this as a data issue. The record is not folded into
the null total. A configured column stays visible when it carries a total,
because the number is the answer.

Existing page and relation tile meanings are unchanged. Exact aggregates, numeric
lexemes, the empty-set result and the named refusal of `avg` are also unchanged.

A sum is exact or absent. Past int64 for an integer field, or past 28 significant
digits for a decimal field, the tile reads *Unavailable* with the reason and no
Retry. The host answered `aggregate-not-representable`, and a recomputation cannot
change that refusal. A stored integer can itself reach int64 max, so a total of
several such integers is a real ceiling. The tile states that ceiling; it does not
wrap the value.

## Named tabs on a record page

`tabGroup` is non-root, takes an optional `title`, and contains one or more
`section` children and nothing else. So a tab is always a titled section, and its
name is the title that a section already requires. `tabGroup` is accepted beneath
`detailSurface`, `recordForm`, `overviewSurface` and `section`. An empty group is `NUI310`. A nested
group is `NUI311`, also through an intervening section: because `section` is
shared, the compiler tracks the ancestor and does not infer it from the parent.
Tabs organise named record information. They are not a generic layout API, and
this adds no commands to the section child vocabulary.

The record page is rendered as an ordered recursive walk of the tree, so fields,
tiles and related lists keep the positions they were authored at. The old
flattening collected every field into a list of titled groups. It could not keep
a related list between two sections and had no place for a tab.

Every panel is rendered into one record form, so a tab change is a visibility
change and not a re-render. An unsaved value in the tab that the person leaves is
still there to save. If a field is bound twice on one page, it gets one editor, at
its first authored position, and the repeat says where that editor is. The field
has one draft value and one validation state.

Where a page has tabs, the renderer owns validation. A required control inside a
hidden panel is not focusable, and the browser would block the submit with an
error that nobody can act on. So the renderer checks every declared field, opens
the tab of the first invalid field and focuses that field, and only then reports
the failure. Saving remains one typed record mutation against the expected
version.

**What unsaved typing survives, and what declines.** A record page is dirty
exactly when saving it would write. A field typed into and put back is not an
edit. A reference picker's search box names no field and never counts. If a save
finds nothing to send, it says *No changes to save.* where a person can see it,
and it leaves the page clean. Two moves preserve a dirty page by patching its
read-only parts in place: a tab change, and paging a related list, which reads
the next page and redraws only the relation.

Every other move off the page redraws it, and a redraw removes the typing. So
each of these moves declines, in the words of the board drag, *Save your changes
or close record details before …*:

- another surface, another record type or the front page
- another record
- another page of records
- Add
- a calendar or timeline move
- a drill or its dismissal
- a retry
- a command on the record
- another view
- both history arrows.

A redraw that nobody asked for waits while the page holds unsaved typing. Such a
redraw is a read that the screen chases, or the file being followed after a write
from elsewhere. It already waits in the same way while a menu is open. It occurs
as soon as the draft is saved or closed. Nothing saves on the person's behalf so
that their next click can proceed.

## The Date calendar

`calendarSurface` is a root with `definitionVersion`, `entityId`, a required
`dateFieldId`, an optional `title` and the existing ordering properties. Its
children are `fieldBinding` and `filterClause`.

The bound field must be an active **Date** field. `NUI321` refuses a DateTime by
name. To place a DateTime on a month grid, the host must choose a time zone to
group by, and that needs its own contract change. Dates are civil `YYYY-MM-DD`
values throughout. Nothing constructs a JavaScript `Date` for grouping, because
`new Date('2026-03-01')` is UTC midnight read back locally, which moves the day
west of Greenwich. The default order is the date ascending, with the existing
stable record-ID tie-break. A declared order overrides it and then orders entries
within each day.

A month is a Monday-first seven-column grid with previous/next month and Today.
The current month opens first. The month query is the calendar's own clauses
plus `date >= monthStart AND date < nextMonthStart`. **A first page is never
presented as a complete month.** Bounded cursor pages accumulate, and each loaded
entry is placed on its date. Load more continues until the cursor is exhausted.

While a cursor is open, the calendar says so, and a day with no loaded entry
reads as "None loaded yet" and not as empty. When the cursor is exhausted, the
calendar says that the month is complete. A revision change discards the
accumulated pages; the calendar does not merge two snapshots. A separate Undated
view is the same root filters plus `isNull(dateFieldId)`, so a record with no
date is never silently lost.

An entry opens the existing record page or the Studio inspector. New records,
edits and date changes go through the existing typed forms. The calendar writes
nothing itself.

Opening a calendar entry must not recompute the seven day tracks. When the side
inspector takes horizontal space, the calendar keeps its existing width and the
surface scrolls horizontally. At the compact overlay breakpoint, the calendar
stays at the viewport width.

## The timeline

`timelineSurface` (ADR-0004, 2026-09-14 amendment, S3) is a root with
`definitionVersion`, `entityId`, a required `dateFieldId`, an optional `title`, the
existing ordering properties, and three optional field roles. Its children are
`fieldBinding` and `filterClause`. Like a calendar, it owns eight roots per
entity. It reads exactly what a calendar reads: bounded cursor pages between two
civil-date bounds, and the same undated view. It draws them as a spine.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `dateFieldId` | an active stored Date field; a DateTime is refused by name, as the calendar refuses it | `NUI370` when absent, `NUI371` |
| `endDateFieldId` | an active stored Date field other than `dateFieldId` | `NUI372` |
| `titleFieldId` | an active stored Text field that is not a single choice, as on a record page | `NUI373` |
| `accentFieldId` | an active single-choice field, as on a record page | `NUI374` |

A calculated field in `dateFieldId` or `endDateFieldId` is `NUI214`, as
everywhere a bounded query would read one. A calculated field in `titleFieldId` or
`accentFieldId` is refused by that property's own code. The date rule is the
calendar's rule, and the title and accent rules are the record page's rules. The
compiler shares these rules and does not copy them, so the same field is refused
by the same rule wherever it is misused, in words that name the surface. A timeline with no `fieldBinding` is `NUI211`.

**One civil year at a time.** The year query is the timeline's own clauses plus
`date >= 1 January AND date < 1 January next`. So, like a month, a year is two
implicit predicates, and a timeline carries at most six declared clauses. The
year shown is renderer state per surface. At first open it is this year in the
device's calendar. Earlier and Later move it, and This year returns to it. A file
switch clears it, and it is never written to the file.

The spine is a heading for every month of the year, in order. The loaded entries
are placed under the month their date falls in. Grouping is client-side over the
accumulated pages, as the calendar groups by day:

- The first page is never presented as the whole year.
- Load more continues until the cursor is exhausted.
- Until then, a month with nothing loaded reads *None loaded yet*. After that, it
  reads *Nothing this month*.
- The state line says whether the year is complete.

A revision change discards the pages; the timeline does not merge snapshots. The
default order is the date ascending. A declared order orders entries within a
month. The months run December first only when the effective sort is the date
field itself, descending.

**An entry** is a button that opens the record page or the Studio inspector, as a
calendar entry does. It carries:

- a dot in the tone of its `accentFieldId` option (the derived hue when the
  option has none; muted when the field is unset)
- the day and short month
- its title: the `titleFieldId` value, else the first bound field
- the remaining bound fields.

The timeline writes nothing itself.

**A span.** When `endDateFieldId` is named and the record's end is on or after its
start, the entry states the span in words, for example *14 Sep – 30 Nov · 78
days*, with both ends counted. Beside the sentence, it draws a bar whose width is
those days over the year's days. One line under the year header states the
denominator and the placement rule: *Spans are drawn to scale over the 365 days
of 2026; a span that began before 1 Jan 2026 is on that year's spine.* So the
proportion is of numbers that are on screen, and the bar is decoration that a
screen reader skips.

If the end of a span lies past the year, the span is cut at 31 December, and the
entry says how many days are shown and that the span continues. If the end is
before the start, the entry states this as a data issue and draws no bar. It
never draws a bar backwards. **Placement is by the start date only**: a record
appears on the year its `dateFieldId` falls in, and a span that began in an
earlier year is on that year's spine. An overlap query would need an OR, which
the closed clause set does not have, and two windows would double the
accumulator. The surface states the rule, so the reader does not have to infer
it.

**The undated view** is the calendar's: the same root filters plus
`isNull(dateFieldId)`, as a record list. So a record with no start date is never
silently lost, whatever its end date.

Proposal preview draws the same spine over the validated clone's sample, and says
so. It shows the year the sample falls in, the months that hold a sample entry,
the dots and the spans. The diff reads *Add a timeline of a date field, with its
own undated view*, *Place each record on the timeline by Decided*, *End each span
at Review date*, *Title each entry with Title* and *Colour each entry by State*.
A timeline raises the file's minimum host to 1.21.

## Folding a section away

The person who reads a record page or the front page can fold away every
`section` on it and open it again. The section heading is the control, and it
opens and closes from the keyboard as it does from a pointer
([ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), 2026-09-20
amendment). Nothing is authored for that. The one thing an author states is how
the section starts: `opens`, one of the closed words `open` and `closed`, and
`open` when absent.

A word outside the set is `NUI312`. A tab's body does not fold and does not take
`opens` (`NUI313`), because the tab strip already opens and closes it. A section
inside the tab may fold and take `opens`. `visibleWhen` and `opens` compose:
`visibleWhen` decides whether the section is on the page, and `opens` decides how
it starts when it is on the page.

**A closed section reads nothing.** While a section is closed, its tiles, charts,
ranges, recent and ranked lists and related lists are not read. Otherwise folding
would save the person nothing and cost the file the same reads. When the section
opens, they become pending and read then, and they show the state a tile shows
before its first read. A value once read stays until the file changes. On a
record page, a closed section's fields stay in the form, hidden and not removed,
exactly as `visibleWhen` keeps them. A required field left empty reveals its
section in the same way it reveals its tab.

What the person does with a fold is their own view of the page, and it never reaches
the file. It is kept for the device in the Workbench's local storage, the way the theme
and the rail are, under `nendo.sectionFolds.<applicationId>` as a map from section node
ID to `open` or `closed` (ADR-0004, 2026-09-24 entry). So a fold survives closing and
reopening the file and restarting Nendo. The key is the application ID, not the
instance ID, so a duplicate or fork of the file on the same device opens with the same
folds. A section the person has never touched starts as `opens` says; after that their
choice wins. A section the page opened by itself to reveal a required field is not
remembered. Storage that is unavailable or unreadable leaves `opens` in charge, without
an error. The diff reads *Add the section "Lately", starting closed.* when the
property arrives with the section. It reads *Start the section closed.* or *Start
the section open.* when the property changes on a section the file already has.
The review preview draws a section as it starts. A `section` carrying `opens`
raises the file's minimum host to 1.28.

## Showing a field only when a calculation says so

`fieldBinding` and `section` accept an optional `visibleWhen`. It names a
**calculated** field of the record type in context whose result type is Boolean.
A stored Boolean is refused (`NUI330`), and so is a calculation of any other type
(`NUI331`). To hide one field behind the typed value of another field is a form
rule that this contract does not define. What this adds is a read-only consumer
of the bounded expression service, ADR-0008's P8.

`visibleWhen` decides what is on screen and nothing else.

- The field stays in the form and keeps its value, so a save carries exactly what
  it would carry with the node visible. Visibility grants no write authority and
  removes none.
- Studio never reads it. A surface cannot conceal the permanent route into a
  file. For this reason, an invalid surface disables custom views and leaves
  Studio reachable.
- Only a definite `false` hides anything. If a result is empty, not yet
  calculated, or impossible to calculate, the node stays on screen. If a node
  were hidden on uncertainty, a person would no longer be told that something is
  there. Also, an empty page cannot be distinguished from a page with nothing to
  say.

A file that uses it records a minimum host of 1.18, because a host that cannot
evaluate the calculation has no way to know whether to show the node.

The value is the calculated field's `fieldId`. It is not the calculation's
`definitionId`. A review sent the `definitionId` first, and the refusal corrected
it one round trip late. `nendo://application/vocabulary` states this under
`propertyNotes`, beside the kinds. The review of a proposal that sets it reads
*Show this only when Needs retest is yes*. A `fieldBinding` to a calculated field
reads *Show the calculated field …* and not *Bind to unknown field*. Studio's
editor never reads `visibleWhen`; it is a rule for the Use view's record page.

## The gallery

`gallerySurface` (ADR-0004, 2026-09-14 amendment, S2) is a root with
`definitionVersion`, `entityId`, an optional `title`, the existing ordering
properties and two optional field roles. Its children are `fieldBinding`,
`filterClause` and the tiles and charts that a list takes. It owns eight roots per
entity.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI380` |
| `accentFieldId` | an active single-choice field | `NUI381` |

A calculated field in either is refused by that property's own code. Both are
optional. If a card has no
declared title, it leads with its **first bound field**, as a timeline entry does.
So one rule titles a gallery card and a board card, and one function draws the
card itself. A gallery with no `fieldBinding` is `NUI211`.

**It is a list's window drawn as cards.** The read is the surface's own
`filterClause` children and nothing else. A gallery adds no implicit predicate, so
it carries the full eight. It pages with the same Previous and Next that a list
has, against the same cached window. Its tile and chart children sit in the same row above the grid, scoped and composed
exactly as a list's are. `scope: group` is refused, because a gallery has no
columns. Drill-through still opens the record type's first `recordList`, so a
gallery's charts navigate away and do not narrow the cards.

**A card** is a button that opens the record page or the Studio inspector. The
title leads. A choice value among the bound fields reads as a chip, as it does on
a board card. Everything else is a labelled value pair.

Where `accentFieldId` is named, the record's option tones the left edge of the
card and tints its background, in the same way the record-page header band is
toned. A record whose choice is unset gets the neutral card. Cards are
typographic because a field cannot hold an image. When the hierarchy is good,
this is a strength of the card.

Opening a card must not recompute the grid. When the side inspector takes
horizontal space, the gallery keeps its existing width and the surface scrolls
horizontally, as the calendar's day tracks do. At the compact overlay breakpoint,
the grid stays at the viewport width. If the column count recomputes under the
pointer that opened a card, the layout moves while the person reads it.

Proposal preview draws the same cards over the validated clone's sample and
labels it. The diff reads *Add a gallery of cards, one per record.*, *Title each
card with Title* and *Colour each card by State*. A gallery raises the file's
minimum host to 1.22.

## The overview page

A file may own one `overviewSurface`. It is the first root that belongs to the
file and not to a record type (ADR-0004, 2026-09-14 amendment, S4). It carries
`definitionVersion`, an optional `title`, an optional `description`, and **no
`entityId`**. An overview that declares an `entityId` is `NUI390`. A second
overview in the same file is `NUI391`, and its hint states the ceiling that the
vocabulary publishes as `maxRootsPerFile`. Every other root keeps
`maxRootsPerEntity`, and no kind states both.

Because there is no record type in context, every child that reads records names
its own record type:

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `summaryTile`, `breakdownChart`, `progressTile`, `trendChart`, `activityGrid` | their existing properties plus `entityId` | unchanged | what they state elsewhere, over the record type they name |
| `rangeTile` | `entityId`, `fieldId` (required), `title`, `scope` | `filterClause` | the smallest and largest value of one field, as two exact aggregates |
| `recentList` | `entityId` (required), `title`, `limit`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause` | a list's ordered window, bounded to at most ten records |
| `rankedList` | `entityId` and `rankByFieldId` (required), `orderDirection`, `limit`, `title` | `fieldBinding`, `filterClause` | the few records at the top of one stored number (see [Grids](#grids)) |

`entityId` on a tile or a chart is **required under an overview and refused
anywhere else** (`NUI394`). On a surface, a tile takes its record type from the
surface it sits on, and a tile that named a different record type would have two
answers to one question. A tile that names a record type the file does not have
is `NUI393`.

A `recentList` outside an overview is `NUI395`, because on a surface that already
has a record type, a `recordList` shows the same records with a pager. Its
`limit` is refused outside one to ten (`NUI396`) and is not clamped, so the stored
definition and the screen cannot say different things. A recent list with no
`fieldBinding` is `NUI401`.

A `rangeTile` is **not a chart**. It has no grouping, so it draws no proportion
and has nothing to drill into. It reads an Integer, Decimal or **Date** field.
`min` and `max` over a set of civil dates is a comparison over the fixed-width ISO
form and needs no arithmetic. That is why the range is the one aggregate that
reads a date, and why `sum` over a date stays refused by name (`NUI397` names the
shape a range can read). The tile shows both ends or neither, because one end of
a range is a bound. A set with no records has no range, and the tile says so; it
does not read zero to zero.

A `fieldBinding` and a `relatedList` need a current record, and the front page has
none, so both are `NUI398`. A `visibleWhen` calculation answers per record and is
`NUI399` for the same reason. An overview with no `summaryTile`,
`breakdownChart`, `progressTile`, `rangeTile`, `recentList`, `rankedList`,
`trendChart` or `activityGrid` is `NUI400`. A heading over an empty space is not
a front page. A description is not
a substitute for one, because a statement of what the file is for does not show
any of the file.

The overview's `description` belongs to the overview. What the **file** is for is
a different thing. It is stored on the file itself and carried by
`application.setPurpose`, and `nendo://application/describe` leads with it. A file
with no front page has a purpose too, and the two never stand in for each other.
The MCP interface contract describes it.

The overview composes **nothing** across record types. Each child reads the one
type it names, and the overview adds no predicate of its own, so a child carries
the full eight declared clauses, less any predicates that its own kind adds (two
for a `trendChart` or an `activityGrid`, one for a `rankedList`). There is no join, no number made from two record
types, and no expression over a result.

Use opens the overview first when one exists. Use offers it beside the record
types and not among the surfaces of one type, because it is not one of them and
it has no entity to be listed under. A file without an overview opens exactly as
it did before. Each tile is read live over the whole record type it names, four
reads at a time, and each tile has its own loading, empty and failed state.
Drill-through from a front-page chart opens that record type's first list, so the
person leaves the front page. The narrowed list belongs to the type, not to the
file.

Proposal preview **describes** the front page and does not draw it. Every number
on the front page is a live read over a whole record type, and the clone carries a
bounded sample. So the only accurate thing to draw is a statement of what each
tile will count, as it already is for a ring. The diff reads *Add a front page for
this file, whose tiles each name the record type they read.*, *Say what this file
is for: …*, *Read Axiom for this number.*, *State the smallest and largest
Accepted.* and *Show at most 5 of them.* Any of the three kinds raises the file's
minimum host to 1.23.

## A scale on an Integer field

An Integer field may carry `presentation: rating` with a closed `min` and `max`
(ADR-0004, 2026-09-14 amendment, S2). A rating requires both bounds together.
Every other presentation refuses them by name, in the same way `options` are
refused off a single choice. The span counts both ends and carries **at most ten
values**. A scale that a person cannot count at a glance is a number, and the
plain Integer presentation already shows numbers. Like every presentation, a
scale is set when the field is created and does not change afterwards.

The scale is stored in its own protected table, `__nendo_field_scale`. This table
is a rung of the layout ladder after the choice-tone table, for the same reason
that table gives. The application-purpose table is the rung after it. The protected layout is a fingerprint of verbatim
DDL, so a column on the field table would move every known layout and need an
`ALTER TABLE` on files that already exist. A row exists only for a rating field.
The first row creates the whole prefix, and a file that rates nothing keeps the
layout and the minimum host it had. A rating field without a scale, or a scale on
a field that is not a rating Integer, is mapping drift and not an unknown
presentation.

**The scale bounds the drawing, not the column.** A write is never refused for
being outside the scale. A rating can be declared over values that already exist,
so a number outside the scale is stored and read back exactly. The compiler
reports it as a data warning, beside the warning it already makes for a value
outside a field's choices. The renderer shows that number with *outside 1–5* next
to it. The editing control leaves every dot unchosen, so that if the person
touches nothing, nothing is rewritten. A CSV import is not checked against the
scale either.

The renderer draws the scale as dots, filled to the value, with the number carried
in the accessible name. The name is *4 of 5* when the scale starts at one, and *4
on a scale of 2 to 6* otherwise, because the short form would state a different
fact. The value is edited as one radio per value of the scale, plus *Not set* when
the field is optional, in the record form and in Studio's record dialogs.
Studio's table draws the dots and edits them through a choice of one of the
scale's numbers. A rating raises the file's minimum host to 1.22 through the field
operation's own evidence, as a choice tone raises it to 1.19.

**One value carries one mark.** The radio *is* the dot. The first build drew a
dot beside the browser's own radio, so every value showed two circles of the same
shape, and the chosen value looked chosen twice. A dot is also not a control sized
for typing. The base rule gives every input a 39 pixel minimum height and 8 by 10
padding. That rule drew the dot as a 21 by 39 oval in a pill twice the height of
the fields around it. So the rating's own rule restates the size, the padding and
the minimum height, and the gate measures all three.

**A form's field names are chrome, not content.** Previously, a press that landed
on a name or a legend and slid a few pixels swept a selection across the whole
form. That is how a form full of controls looks when it is dragged through.
Names, legends and the rating's pills now start no selection at all. The values
keep their selection, because people copy a record out of the page. A
`user-select: none` on an ancestor reaches into a control, so each value restates
the setting.

## Colour on a choice option

A choice option may carry a `tone`. The existing `schema.setChoiceMetadata`
operation sets it, beside the option's label and availability. The set is closed,
and the vocabulary publishes it as `choiceTones`: `red`, `orange`, `amber`,
`green`, `teal`, `blue`, `violet`, `grey`. A tone is a semantic token in the same
sense as a field presentation. The file stores the name, and the renderer owns the
Light and Dark colours behind it. So a hex value is refused by name, and so is
`gray`.

The operation sets the whole of an option's metadata. A rename that carries the
tone keeps it; a rename that omits the tone clears it. The review line says which:
*Name choice Trying, mark it available and colour it teal; preserve its stored ID*
against *… and give it no colour*. Compensation of either puts the previous
label, availability and tone back together.

Where an option has a tone, everything that shows the option draws with it:

- the board column and its dot
- the card chips
- the dot beside a list row or a calendar entry (the first single-choice field
  the surface binds)
- Studio's choice cells
- the record-page header below.

An option without a tone keeps the renderer's older behaviour: a hue derived from
its stored ID. So a file authored before tones existed looks as it did.

A tone is stored in its own protected table, `__nendo_choice_tone`, on the layout
ladder after the behaviour table. The first tone a file takes creates the whole prefix, as a
first choice edit or a first behaviour definition does. A file that never colours
anything keeps the layout it had. A file that carries a tone records a minimum
host of 1.19. A host that does not know the table would draw the option grey and,
on the next choice edit, would not know to keep the colour.

## The record-page header

`detailSurface` accepts three optional properties. Each is the `fieldId` of a
field on the page's record type:

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI340` |
| `subtitleFieldId` | an active stored or calculated field other than the title | `NUI341` |
| `accentFieldId` | an active single-choice field | `NUI342` |

The renderer draws them as a band above the form. The title is a heading, the
subtitle is under it, and the accent is a chip in its option's tone. The band
itself has the same tint. The record's commands sit directly under the band,
above the form. A command is the action a person opens the page for, and under
the Save button of a long form, people did not find it.

The values are read from the record and never edited in the band. The form below
remains the only place where a value changes. A page that names none of the three
is unchanged. `recordForm` takes none of them, because a form is where a record is
typed in, not read. Proposal preview draws the same band over the validated
clone's sample record.

The diff reads *Head the page with Handle*, *Show Statement under the page title*
and *Colour the page by Status*. A page with any of the three raises the file's
minimum host to 1.19 through the capability table, like every other shape of the
tree.

## Charts

A chart is an exact aggregate over a **closed grouping**, drawn as proportion with
its numbers beside it (ADR-0004, 2026-09-14 amendment, S1). Two kinds exist. Both
are tiles in the same sense as a `summaryTile`:

- They are accepted where a `summaryTile` is accepted: `recordList`,
  `boardSurface`, `gallerySurface`, `matrixSurface`, `overviewSurface`,
  `detailSurface` and `section`. They are not yet accepted inside
  a `relatedList`, where they are refused and not drawn empty.
- They are scoped as a `summaryTile` is scoped.
- They refuse the numbers it refuses, by the same codes.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `breakdownChart` | `groupByFieldId` and `aggregate` (required), `fieldId`, `title`, `scope`, `entityId` | `filterClause` | one exact number per group, over the records its scope covers |
| `progressTile` | `title`, `entityId` | `filterClause` (at least one) | the records matching its own clauses over everything its scope covers, as two exact counts |

The closed groupings are a single-choice field's options, in their configured
order, and `false` then `true` for a Boolean. The unset group comes last. A
stored value that is none of them is counted apart as *unrecognised*, and the
chart states it. It is never folded into a group that nobody configured and never
drawn as a segment.

The grouping field must be active and one of those two kinds (`NUI350`). A
calculated field cannot group, as it cannot be totalled. At `group` scope on a
board, the grouping field must not be the board's own grouping, because every
column would break down into itself (`NUI352`). A ring with no clause would always
be full, so it is refused (`NUI360`).

The grouping is not a filter and spends none of the budget of eight. The Engine
answers a grouped aggregate in one read: one streamed fold into a bucket per
group, capped at 366 groups. The SQLite read and the safe-mode snapshot share
that fold, so the two cannot disagree. A ring is two counts: the numerator is its
clauses over its scope, and the denominator is the scope alone. The ring is drawn
only when both counts have answered, because one number is a count and not a
proportion.

### Over time

Two kinds group by a civil date and not by a closed set of options (ADR-0004,
2026-09-16 amendment, S5). They are accepted where the other charts are accepted
and scoped as those are scoped, and they take `filterClause` children in the same
way.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `trendChart` | `dateFieldId`, `bucket`, `range` and `aggregate` (required), `fieldId`, `title`, `scope`, `entityId` | `filterClause` | one exact number per bucket of the range |
| `activityGrid` | `dateFieldId` and `range` (required), `title`, `scope`, `entityId` | `filterClause` | one exact count per day of the range |

**Their groups are generated, not declared**, and every rule below follows from
this. A single-choice field's options are written into the definition, so an
option that nobody has used is a group with no further action by anyone. A month
is written down nowhere. The host produces every bucket from the resolved bounds
before it reads a single row. So **a bucket with nothing in it is still a
bucket**: a month with no records is stated as empty and drawn as a gap at zero,
and a quiet day is the lightest square and not a hole. A chart that returned only
the buckets that the data touched would show only where the data is, but it would
look exactly like a chart of the whole range.

`bucket` is closed to `month` and `week`. `range` is a closed word that the host
resolves to civil-date bounds **each time it reads**. It is never a stored date,
and it has no literal alternative. Otherwise, a definition written in January
would still mean January in December.

A `trendChart` takes `last12Months`, `last6Months`, `last90Days` or `last30Days`
(`NUI356`). An `activityGrid` takes `thisYear` or `lastTwelveMonths` (`NUI358`),
because it draws one square per day, and only a range of about one year fits the
366-group ceiling. A word outside the set of its own kind is refused, and the
refusal names the set that the kind may use. An unknown `bucket` is refused in the
same way (`NUI355`).

`dateFieldId` is an active stored Date field. A DateTime is refused by name
(`NUI354`, `NUI357`) and is not truncated, as on a calendar and a timeline. To
truncate a DateTime to its date, the host must choose a time zone to group by,
and this contract version does not define that. A calculated field cannot bucket,
as it cannot group or be totalled.

An `activityGrid` **counts only** and has no `aggregate` or `fieldId` at all. A
square toned by a sum is a heat map of a number that a person cannot recover from
the square. A `trendChart` takes the same exact aggregates as a `summaryTile`,
and `avg` stays refused by name.

**The range spends two of the filter budget.** The two bounds are predicates that
the host adds to the query. So a `trendChart` or an `activityGrid` carries at
most six authored `filterClause` children, where a tile elsewhere carries eight.
At `group` scope on a board, the column predicate is a third. The `NUI300`
refusal names the two predicates that the host adds, so the author does not have
to work out why the number is six. Because the bounds are in the query, a record
with no date, or one outside the range, never reaches the fold. So the result has
**no unset group**, and a day grid over a leap year uses the 366-group ceiling
exactly and not one short.

The renderer draws a trend as one column per bucket. An empty bucket keeps its
slot and its label and draws a baseline tick. The renderer draws an activity grid
as squares in week columns, toned in five steps against the busiest day, with
zero as its own step. Both put every number in the table behind the same single
toggle that the other charts use. Both drill: a bucket opens the record type's
first list narrowed to the two bounds of that bucket. This is the one drill in the
product that spends two clauses.

Safe mode folds the same buckets over the snapshot and does not decline. A chart
that is exact against the file and *Unavailable* against a read-only copy of it
would give two answers to one question.

The renderer draws a breakdown as one stacked bar of segments in the options'
tones, with a legend that carries the exact lexeme of every group. It draws a
ring with both numbers in its centre. A zero total is an empty track that says so.
An absent number reads *Unavailable* with the reason. A table of the same numbers
is one toggle away. Each segment is a button named with its label and number.

A click on a segment or a ring opens the record type's first list narrowed to
that group. The narrowing is one predicate that replaces the list's own clauses
and does not compose with them. So it spends one filter and can never refuse a
list that compiled. It is renderer state, like the selected surface: it shows as
a dismissible pill, a file switch clears it, and it is never written to the file.
While it lasts, the surface's own totals and charts are suspended, because they
would describe the surface's set and not the records on screen.

Proposal preview counts the validated clone's bounded sample per group, whatever
the chart aggregates, and says so. A ring in preview is described, because its
counts are live reads.

The diff reads *Add a breakdown chart of the records this surface covers, one exact
number per group*, *Break the numbers down by Status* and *Add a progress ring of
the records matching its conditions over everything this surface covers*. Either
kind raises the file's minimum host to 1.20.

### Grids

Two kinds state a number that the surfaces above cannot state (ADR-0004,
2026-09-17 amendment, S6). A `matrixSurface` is a root of its own; a `rankedList`
is a front-page tile.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `matrixSurface` | `definitionVersion`, `entityId`, `rowByFieldId` and `columnByFieldId` (required), `title`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause`, and the tiles and charts a board takes | one exact count in every cell of two crossed groupings |
| `rankedList` | `entityId` and `rankByFieldId` (required), `orderDirection`, `limit`, `title` | `fieldBinding`, `filterClause` | the few records at the top of one stored number, each against the exact largest |

**A matrix is one read, not one read per cell.** Before it reads a record, the
host makes every cell key from the cross product of the two option sets, and each
axis carries its own unset lane. The host then folds the record type once into
those keys. So a grid costs the same one read at four cells or two hundred, and
**a cell with nothing in it is still a cell**. Every number the grid states is
exact over everything that the surface's clauses cover, not over the page of
records in view. The alternative that was considered and not taken was a
`summaryTile` per cell. That is one read for each cell, the reads arrive four at a
time, and the grid fills in slowly, like a slow page.

The cell holds both an exact number and the surface's one loaded window, so it
states them as the two different quantities they are. Where the window holds
fewer records than the number, the cell says **showing 4 of 17**. A board column
has never been able to say that without a tile of its own.

`rowByFieldId` and `columnByFieldId` are active single-choice or Boolean fields,
which is the grouping rule a `breakdownChart` already applies. They **must be
different fields** (`NUI412`), because a field against itself fills one diagonal
and leaves every other cell empty. An axis that is neither kind is `NUI410` for
the rows and `NUI411` for the columns. A calculated field cannot be an axis, as it
cannot group.

Rows and columns are the field's options **less the ones that the surface's own
`eq` and `ne` clauses exclude**. This is the board's rule, applied twice, and only
those two operators are read. Every reachable option is drawn even when it is
empty, because an option is something a person arranged, and its emptiness is the
answer.

The **unset lane** on each axis is different. Nobody arranged it, so each unset
lane is drawn only when its own exact number is not zero. Every record that the
surface covers is in exactly one cell. A stored value that is none of the field's
options is counted apart as *unrecognised* and is never folded into a cell that
nobody configured.

**The cross product spends the group ceiling.** `MaximumAggregateGroups` is 366,
and the two option sets plus their unset lanes must multiply to a value inside it.
So the widest grid that fits is about nineteen by nineteen. A definition that is
already over the ceiling is refused when it is authored (`NUI413`, which states
the rows, the columns and the cells, unset lanes included). A definition that grows over the ceiling later is
refused **when it is read**, and the surface states that it cannot draw the grid.
Option sets change without any change to the screen, so both checks are
necessary. To draw only the cells that fit is the one wrong answer, because a
matrix that is missing its last four columns looks exactly like a matrix.

A cell drills with **two predicates**, one per axis, and opens the record type's
first list narrowed to that cell. This is the second two-clause drill in the
product, after a bucket's two bounds, and it is renderer state on the same terms.
An unset lane drills with `isNull`. Moving a card between cells is not in this
slice. A board's drag sets one field, and the same gesture here would set two,
which is a different promise about what one movement writes.

A `rankedList` goes where a `recentList` goes: under an `overviewSurface`, or under
a `section` within one. Elsewhere it is refused (`NUI422`), because on a surface
that already has a record type, a list ordered by the same field shows the same
records with a pager. `rankByFieldId` is an active stored Integer or Decimal. A
**Date is refused by name** (`NUI420`). This is the one place where a Date is
refused but a `rangeTile` accepts one, because `min` and `max` over a Date are
comparisons, while a bar is arithmetic. `limit` is one to fifty. A value above
fifty is refused and not clamped (`NUI421`), and an absent `limit` means the
ceiling.

**A record with no number is not ranked.** The host adds an `isNotNull` predicate
on the rank field. So a ranking carries at most **seven** authored `filterClause`
children, where a tile elsewhere carries eight, and the `NUI300` refusal names the
one predicate that the host adds. The bar is against one exact `max` over
everything the ranking covers, not over the page, so it means the same thing
however many rows are shown. When the largest value is **not greater than zero, no
bars are drawn at all** and every row states its number, because a proportion of a
non-positive maximum draws nothing. **Equal numbers share a rank numeral and the
next numeral skips it.** The limit is a limit on rows, so a tie that crosses the
limit is cut: *the top ten by value* is ten rows, not everyone who reached tenth.

Safe mode folds the same cells over the snapshot and does not decline. It uses the
same `CellAggregateFold` that the SQLite read uses, so the two cannot disagree
about which cell a pair of stored values lands in.

The diff reads *Add a matrix crossing two choice fields, with an exact count in every
cell*, *Make one row per Status*, *Make one column per Priority*, *Rank the records by
Value, largest first* and *Rank at most 10 of them*. Either kind raises the
file's minimum host to 1.26.

## A board grouped by a reference

Under the ADR-0004 2026-09-17 amendment (S7), `boardSurface.groupByFieldId` takes
a single-choice field, whose options are its columns, or a **bound Reference
field**, whose target records are its columns. Nothing else about the board
changes: the same kind, the same properties, the same children, the same cards
and the same group-scoped tiles.

**The columns are every active record of the target type**, ordered by the
reference's configured label field, ascending. That is the order in which the
reference picker already reads them. The columns are not only the records that
something points at, for these reasons:

- A lane that nobody has used is an answer, as an empty cell and an empty month
  are.
- A column that appeared and vanished with the data would make the board's
  layout depend on which page had loaded.
- "The records in use" could only be computed from the board's own loaded window,
  so it would mean the records in use *on this page*.

`orderByFieldId` continues to order the cards inside a lane and never the lanes,
because a record type carries no order that an author arranged.

**The board draws at most `boards.maximumReferenceColumns` of them, which is 24.**
Above that number, the board draws **no columns at all** and states the record
type, how many records it holds and the ceiling. To draw the first twenty-four
would be the one wrong answer, for the same reason as a partial grid: a board that
is missing its last lanes looks exactly like a board. Because the rule is
all-or-nothing, no card can point at a column that the board did not draw.

**At the other end it draws the board and states the absence.** A target type with
no records is `ready` with no columns, not a failure. The rule that every record
of the type is a column is as true at zero as it is at four. The board names the
type, says that it has no columns, and continues to draw. Over the ceiling, the
replacement of the board loses nothing. At zero, the Ungrouped lane holds every
card there is, and to hide the records in order to explain the columns would
answer a smaller question than the one asked.

The sentence names what a person can do from the screen they are on, because the
Showing picker and Add are both on that toolbar. When the target type has no view
of its own, the sentence sends the person to Studio instead.

**The Ungrouped lane's advice is true of the board it is on.** With named columns,
it still reads *Move a card to a named column to assign it.* With none, it says
that there is no named column to move a card to. It does not tell a person to do
something that the screen cannot do. The same is true of a board or a grid whose
own `eq` and `ne` clauses have excluded every option of the field it groups by. It
states that its own filter emptied it, and it names the field from which to
remove a condition.

This ceiling is checked **when the board is read, not when it is authored**. That
is the one place where it departs from the grid ceiling it is modelled on. A
matrix is refused at authoring because the definition carries both option sets. A
definition cannot carry how many records a record type holds. The renderer learns
the count from the read it makes anyway: it asks for one record more than the
ceiling. It reads an exact count only in the case that refuses, so the sentence
names a number and not "more than".

**An unbound Reference field is refused when the board is authored** (`NUI237`).
It has no target type to read columns from and no label to head them with.
Binding it is a separate reviewed proposal. A target type that is missing or
retired is `NUI238`, and a missing or retired label field is `NUI239`. Each names
the field and what is absent. It does not repeat the choice-field diagnostic,
which would send an author to look for the wrong fix. `NUI236` now reads *The
board needs an active bounded choice field or a bound reference.*

**A reference column carries no tone.** A tone is something an author put on an
option, and a record has no place to hold one. The column takes the hue that the
renderer already derives for an option that nobody coloured. That hue is stable
per value and shared by every surface. So no new rule is written and nothing new
is stored.

**Ungrouped is unchanged**: a record with no reference is in it, and a drag into it
clears the field. A stored reference to a record that is not in the target type
is stated as a data issue beside the lane, as a value outside a field's options
already is. Nothing that the host offers can reach this state: the host refuses
to delete a record that something points at, with the named refusal
`record-referenced`. No promise is made that the state can occur.

**Dragging a card between reference columns writes the grouping field with the
target record's current version.** A reference write is refused without it
(`target-version-required`), where a choice literal needs none. The board holds the versions
because it read the target type to draw the columns. If the target moved under the
board, the write is refused (`target-version-conflict`). The board then says so
in its own words and reads its columns again. It does not pass on the host's
message about selecting the target, because a board has no picker to select one
in.

A reference board spends no new filter budget. A column tile still composes the
board's clauses, its own clauses, and one column predicate, which is an `eq` on
the reference field. The diff reads *Give the board one column per Client record,
from Client, and draw nothing above 24 of them*. The preview's size sentence reads
*one column per Client record, 12 of them*. It says "per {name} record" because
the name is the person's, and a plural name read as *one column per Initiatives, 6
of them*. A reference board raises the file's minimum host to 1.27.

## Adding and opening from a related list

A `relatedList` offers two actions on a record page (ADR-0004, 2026-09-18
amendment):

- **Add** opens a new record of the related type, with the reference back at the
  record in view already filled in.
- **open** opens a related row as its own record page.

Nothing is authored and nothing is stored for either action. The node already
carries `targetEntityId` and `viaFieldId`. The compiler has already proved that
the target is an active record type and that the field is an active Reference
aimed at this one (`NUI260`–`NUI266`). So an author has nothing left to state.
**The file is unchanged, so nothing raises its minimum host.** A rung states what
a file needs, and an unchanged file needs what it needed before. A host without
this feature draws the same relation without the buttons.

| What it does | The rule |
| --- | --- |
| Add | The related type's own record page, rendered as a create form in the place of the record page. Its sections, its tabs and its required fields apply unchanged. A type with no page falls back to its field list, as a create form already does. The form shows no relations of its own, so an Add cannot nest. |
| The reference back | Filled in before the form is shown. It is named by the label field that the reference was configured with, not by the stable ID. It carries the record's current version, without which a non-null reference write is refused (`target-version-required`). It stays editable. |
| A page that does not bind it | The reference is added to the form anyway, first, because the form is open for it. A child's record page usually does not bind the field that points back at the parent. A form wired to only what the page binds would save a record that points at nothing. |
| open | The related record is read by its own ID and opened as its own page. It is not looked for in the loaded window of the target surface. A relation is ordered as its author arranged it, so the clicked row need not be in that window. To narrow that surface to one record would answer a question that nobody asked about the surface. |
| Getting back | One step, named after the record it returns to, and removed once it is taken. It is not a history: a third record that opens replaces the step and does not stack behind it. Renderer state, like a drill or a selected surface: never in the file, and cleared when the record context is left. |
| A record page with unsaved edits | Declines both, in the board drag's own words. Both redraw the page, and a redraw discards a form's drafts. A tab change and paging the relation still preserve a draft, because those paths patch in place and never redraw. A picker searched and cancelled is not an edit, and neither is a field put back to its stored value. |
| A row whose record has gone | Says so (*That record is no longer there*) after the redraw that follows the click. It leaves the person on the page they were on, with busy cleared. The read comes before anything moves, so nothing moves. |
| A related type with no screen | Offers neither, and says so beside the heading. Use shows the record types that have a compiled surface. Without one, the new record has no place to go, and there is no page to open a row on. |

If a relation's window was read against an older revision, it is not the answer
for that relation. It reads as loading until it is read again, as every other
window here already does. A record page chases its relations on the same bounded
terms on which it chases its totals.

Nothing here allocates the reference codes that a file's own convention may
require. The host requires a Reference field to be non-empty. It does not fill the
field in, enforce uniqueness or stop a change to it. So in a file whose records
are named by hand, a person still decides which name is next.

## Bounded query composition

One bounded query carries at most **eight** effective filters, and this count
includes the filters that the host adds itself. `MaximumEffectiveFilters` is one
constant. Both the published vocabulary and the record-query validation that
refuses read it, so the stated ceiling cannot drift from the ceiling that
refuses. Composition spends the budget as follows:

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

An over-budget definition is `NUI300`. The refusal names the node, the property
path, the count it composes to and the source of each clause. The host never
drops a clause, widens a query, deduplicates, or raises the limit as a
convenience.

## Capability versions

The tree of contract version 3 is preserved across the widening. So the version
number on a root no longer says what a host must understand: a plain form and a
tabbed page with two boards are both version 3. `NendoSemanticCapability`
computes what a stored definition needs from its **shape**, plus one thing that
the shape cannot show (below). The ladder is:

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
| An `extensionGraphSurface` reference | 1.29 |
| An `extensionGraphSurface` at protocol 2 (disclosed fields, filters) | 1.30 |
| An `extensionRecordsSurface` (one record type as typed columns) | 1.31 |

The gaps at 1.17 and 1.24 are rungs that are not shapes of the node tree.
`1.17.0` goes to a file that stores behaviour definitions (ADR-0008), and `1.24.0`
goes to a file that carries a purpose (the ADR-0004 2026-09-15 amendment). Each
operation declares that version on its own evidence.

Every row except the 1.27 row is a shape of the node tree. At 1.19 and 1.22 a
field operation also raises the rung through its own evidence: a choice tone and a
rating scale. The 1.27 row is not a shape of the tree. A board grouped by a
reference and a board grouped by a choice carry the same kind, the
same `groupByFieldId` and the same children. Only the storage kind of the grouping
field tells them apart. So the calculation reads the stored fields beside the
tree. Without that, it would return 1.26 for a file that needs 1.27. One refused
surface makes a whole definition invalid, so a host on the older rung would report
that a custom surface cannot run safely over every authored screen in the file,
and it would name none of them.

The calculation runs over the tree that a mutation leaves behind, not over the
operations it submitted, for two reasons:

- An inline `ui.addNode` expands to a node operation plus one property operation
  each. So a judgement of operations one at a time would answer differently,
  depending on the expansion order.
- A `ui.moveNode` that puts an existing tile under a board, or an existing section
  into a tab group, adds no node and sets no property, but it changes what the
  definition needs.

Only a mutation that touches UI nodes recomputes it.

A file's recorded minimum is only ever raised. So if a feature is removed, the
file still states the host it once needed. An ordinary existing definition keeps
its minimum, and opening a file never rewrites it. A raise appears in the
semantic diff as its own irreversible `raiseMinimumHostVersion` line, because the
operations alone do not state it. Rejection leaves the active file untouched, and
promotion remains canonical operation replay. File inspection reports an
insufficient minimum and names the widened features that the file uses, not only
the number.

Product release version, semantic contract version and file capability version
remain three separate things.

## The mutation is the materialization boundary — for the definition lane only

A record type exists physically from the end of the mutation that created it, not
from the end of the change set. So a required field must be in the same mutation
as its `schema.createEntity`. If a later mutation adds it, that mutation refuses
with `NPROP004`, which names the field, the record type and both remedies. The
other remedy is to add the field as optional and require it with
`schema.setFieldRequired` in a later mutation of the same change set. The rule
has a reason: an intervening mutation may write records, and a required column
added after them would leave those rows with no value.

UI nodes are exempt. A surface root added in one mutation accepts children added
in a later mutation. Only this makes it possible to split a large surface tree
across calls. The asymmetry is real. It is between the physical materialization of
the definition lane and the stored node tree of the UI lane, and no document
described it before.

Within one change set, the definition revision advances by one per
definition-lane mutation and does not advance for a data-only mutation. A caller
may omit `expectedDefinitionRevision` entirely. The MCP adapter then fills in the
value for the position of that operation before it compiles. The stored canonical
operation still carries an exact integer, so replay and promotion concurrency are
unchanged.

`ui.addNode` accepts an inline `properties` map over MCP. It is a boundary
convenience, and nothing behind the boundary sees it. Before compilation, diff,
history or promotion, the adapter expands it into the canonical `ui.addNode` plus
one `ui.setProperty` per property, in stable property-name order. What changes is
the cost of a build: a node and its configuration are one submitted operation, not
one plus one per property. The two budgets are published and echoed separately,
so the expansion is bounded and not implicit.

Proposal preview renders the validated derivative's bounded plans and record
values, with no mutation handlers or write authority. Its summary counts are
taken over the validated clone, not over the compiled plans, so a schema-only
change set previews as what it adds. A raise in the file's minimum host version is
a `raiseMinimumHostVersion` line in the semantic diff, because it is a durable
compatibility change that the operations alone do not state. Root/record
selection is preview-local. Promotion continues canonical operation replay against
current definitions and touched-record versions. It never swaps in the derivative
file.

Acceptance fixtures cover each optional root, multiple entities, mixed versions,
over-ceiling roots, invalid bindings, retired definitions, unknown effects,
bounded records, host command targeting, reject/accept/reopen and renderer
recovery. `Gate-AgentAuthoring.mjs` builds the widened vocabulary through MCP
alone and then drives the running app through:

- the surface selector
- a surface total and per-column totals
- a second list with its own filter
- the month grid and undated view
- the timeline's year, with a span cut at its end, and its own undated view
- a gallery of toned cards that shows a rating as dots
- a tab change that keeps an unsaved value.

On a reopened file, the gate then measures the record page's own rules:

- A picker searched and cancelled and a save with nothing to save both leave the
  way back open, while a reference that is chosen holds it.
- A related row that points at a record that has gone says so and stays on the
  page.
- A page that holds typing keeps it across a paged relation and a write from
  elsewhere. It declines another record type, Add, another record, another
  surface and another page of records.

Each refusal is measured as readable in Light and Dark. Render and Computer checks
remain required separately.

### Use navigation and layout

Use keeps the selected surface name visible in a View disclosure picker and in
the page heading. The picker lists each surface with its kind. It supports
keyboard focus, and Escape closes it. Surface totals have an inset below the
toolbar. Board headers and group summaries size to their content. The remaining
column height goes to the card area, and summary values do not stretch.

Calendar controls, status, grid and undated rows share the same 16px content
inset as lists and boards. Studio row actions use compact outlined buttons,
centered in their grid cells.

A record page opened from a related row offers one step back to the record it was
opened from. The step is named after that record and sits in the same toolbar
group as the surface picker and the drill pill. It is removed once it is taken.
It is cleared with the rest of the view whenever the record context is left.

Beside it, the control group of the workspace header starts with a back arrow and
a forward arrow. They are available from every view, not only from a relation.
They have the same style as the theme control next to them, and they are placed
before the File menu.

Each arrow says where it goes, with the same eyebrow and title that the header
shows: "Back to Use · Work — All work". If a direction leads nowhere, its arrow is
disabled and named only for itself. Alt+Left and Alt+Right do the same as the
arrows. They yield to a dialog, the file menu and any field that has focus.

A place is:

- the view
- the record type
- the front-page choice
- the surface
- the record
- the drill
- the open tab of each tab group on that record type's page
- the month and view of a calendar, or the year and view of a timeline
- the Help topic
- the labelled step back, where there was one
- for a proposal review, the destination of its Close button.

These are carried as values and not as names. So when a person goes back to a
list that has since been drilled, the list returns whole. Nothing of this reaches
the `.nendo` file. The trail is bounded, belongs to the open file, and is emptied
when another file is opened. The record type that a place names is the one on
screen, which is not always the one that was picked. Until somebody uses the
picker, Use shows the first compiled type while nothing is selected.

If a place no longer exists, it is declined with a sentence and dropped from the
trail. It is not resolved to a neighbouring screen and presented as the screen
that was asked for. This covers:

- a deleted record
- a surface that a proposal removed
- a record type that no longer has a screen
- a retired record type behind a Studio page
- a front page that the file no longer has
- a view that the file's capabilities no longer allow.

A Studio page is judged on its own record type. A place carries the Use selection
so that a step back restores the whole view. But a Structure page is not refused
because a proposal removed a screen somewhere else. While a record form holds
unsaved typing, both arrows decline, in the same words that the labelled step
back uses.

**How long a sentence lasts.** A screen that reads on its own account redraws
when those reads arrive, and a redraw rebuilds the slot a sentence is shown in. So
every sentence is kept with the view it was shown on and put back after each
redraw. What ends a sentence depends on its type:

- A success stays until an action clears it or the view is left.
- A notice with a Refresh view button stays until that button succeeds.
- A refusal stays until the person does the next thing: their next press or key
  anywhere except on the sentence itself, or a move off the view. Refusals
  include a declined step back, a declined move off a page that holds typing, a
  row whose record has gone, and a failed write.

When a refusal was only written into the pane, it lasted exactly as long as the
next chased read. On a screen with a tile, that is under a second. The sentence
about a place that had gone was once wiped before the authoring gate could read
it, and a person who pressed Back at that moment saw nothing at all (F-086). The
gate now writes to the file from elsewhere after the sentence, watches the screen
follow the write, and reads the sentence again.

## Isolated custom graph definitions

ADR-0013 authorizes `extensionGraphSurface`, a root that names an exact device
package and a bounded graph projection. It uses the same canonical UI operations,
semantic review and replay as other roots. Required properties, preservation and
execution limits are in [custom views](custom-views.md). The file stores no
package and no consent. If a package is missing, the definition is preserved. The
new shape requires host 1.29.0, and a view at protocol 2, which discloses more
fields or filters, requires 1.30.0.
