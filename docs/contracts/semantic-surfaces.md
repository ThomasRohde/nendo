# Semantic surfaces contract

How stored surface definitions compile into render plans. The authoritative
vocabulary table is `src/Nendo.Engine/SemanticVocabulary.cs`, published live as
`nendo://application/vocabulary`; this document covers the rules around it.

ADR-0008's bounded calculation and action design is delivered;
[calculations-and-actions.md](calculations-and-actions.md) is its implementation
contract, and the [design notes](../design/adr-0008-semantics.md) behind it are
history. It adds no expressions to this surface vocabulary and does not change
stored declarative commands: a calculated field is bound here by ID like any other
field, and a surface never carries a formula. Calculation consumers use the shared
Engine service and preserve Studio, typed writes and proposal review; arbitrary
HTML/code and custom controls remain outside that authority.

**Contract version 3 is the only shape this host compiles.** Versions 1 and 2
were removed on 2026-09-12 before the format had users, and their fixed
form/list/board/command slots went with them: there is one compile path, one plan
shape and one digest projection. A stored root declaring `definitionVersion` 1 or
2 is refused by `NUI003`, which names the supported version; every custom plan is
suppressed and Studio, the data and recovery are unaffected.

Each surface has one root with ordered children. A file may have several entity
groups, selected explicitly in Use. Zero custom nodes leaves permanent Studio.
Board card fields come from ordered `fieldBinding` children; the parallel
`cardFieldIds` property is gone.

## How many roots of a kind an entity may own

Every kind that can be a root declares its ceiling in the vocabulary table, and the
compiler reads it from there rather than hard-coding it. Which ceiling depends on what the
root belongs to: `maxRootsPerEntity` for a root about a record type, and `maxRootsPerFile`
for one that belongs to the file — the S4 `overviewSurface` is the only kind that declares
the second, and no kind declares both. A client reading only the first would have found no
ceiling at all on the front page, so both are published.
Under the ADR-0004 2026-09-12 amendment `recordList`, `boardSurface`,
`calendarSurface` and `recordCommand` each declare **eight**, and `timelineSurface`
(the 2026-09-14 amendment, S3) and `gallerySurface` (S2) declare the same; `detailSurface` and
`recordForm` keep one, with their existing page precedence — detail first,
otherwise form. Eight is a bounded initial product choice, not a measured optimum.

Over the ceiling is `NUI153`, whose message counts the roots found and the number
accepted, and whose hint is generated from the same table: it states the ceiling
in grammar that follows the number and names the kinds a further one may be nested
inside. A hint reading "more than one" against a table permitting eight is worse
than no hint, which is why both are generated rather than written.

A nested `recordCommand` remains supported and still carries the `commandId` that
`nendo.data.execute_command` takes. It used to be the only way to have a second
command on an entity; it is now one of two, and nothing was migrated.

Sibling `filterClause` children are ANDed: a record must satisfy every one of them
to appear. Contract version 3 has no OR and no grouping. The combinator is
published in the vocabulary because it was previously true and unstated — an
author who declared two clauses intending AND had no way to confirm it from the
interface. In a proposal, a clause added with its terms is one line — *Show only
records where Status is not Done*, or on a progress ring *Count only records where
Stage is Closed won* — rather than a line that says nothing followed by the field,
the comparison and the value on a line each; a term changed on a clause the file
already has keeps its own line, because that is a change to something the person
has.

Missing roots remain absent in compiled plans. The host does not invent a board,
command or custom form. A form-only application offers bounded record selection;
list/board records without a custom form can open the host-owned Studio inspector.
Commands are selected by their stable ID and apply only to their declared entity.
Every error suppresses all custom plans rather than returning a partial app.

## Selecting a surface, not a kind

Use offers every `recordList`, `boardSurface`, `gallerySurface`, `calendarSurface`
and `timelineSurface` root of the selected record type, in compiled order, each by
its own title. The file's `overviewSurface` is not among them: it belongs to the file, so
it is offered beside the record types rather than among one type's surfaces, and Use opens
it first when the file has one. The selection is a
stable surface ID per entity; the default is the first compiled root. Resolving by
kind returned the first of a kind, so seven of eight lists on an entity had no way
to be shown at all — and a board/list *mode* could not name a third view.

A missing selected root falls back to the first eligible one **without erasing the
remembered choice**, so a surface removed by one proposal and restored by the next
comes back selected. Selection, the open tab and the month a calendar shows are
file-session-local renderer state and never reach the `.nendo` file. They are
cleared on a file switch.

Each surface owns its own query and its own read window, keyed by its stable
semantic ID. A window carries the query it was opened with, from page one onward,
and every continuation resends exactly those arguments: the host hashes the whole
query into the cursor scope, so an unfiltered continuation of a filtered query is
refused as `invalid-cursor` rather than answered over the wider set. Only the
selected surface is read; an unselected one keeps whatever window it already had
for the current revision and is reloaded when it is chosen. A selected surface
with no loaded window shows loading, empty or a failure with retry — never the
records of another surface and never an unfiltered default. Studio keeps its own
independent browsing and query state.

## Totals on a list or board

`summaryTile` is a child of `recordList` and `boardSurface` as well as of a record
page, a section and a related list. On a list or board it states one exact number
over the records that surface shows — the root filters AND the tile's own clauses,
independent of which page is loaded — and the renderer labels it with what it
covers, because a total over a filtered set otherwise reads as a count of the cards
on screen.

In a proposal, a tile that arrives with its terms is one line saying what it counts,
over what, and its label — *Count the records in each column as "Delivered"*, *Total
Amount over every record shown as "Pipeline"*, *Count the records over every related
record as "Axioms"* — and an ordering that arrives with its surface is one line in the
field's own terms: *Order by Completed on, newest first*, *Order by Title, A to Z*,
*Order by Amount, largest first*. A property changed on a tile or an ordering the file
already has keeps its own line, because that is a change to something the person has.

**A number may be as of a moment ago.** Every total, chart, ring and range is its own
exact read at a stated revision, and a surface asks again when the file moves on — at most
once a second, one pass at a time, and never while somebody has hold of the page. An
answer that arrives after the file has moved is kept: it answered about the revision it
names, and discarding it meant a file being written to continuously could never show a
number at all. So while writing continues, two tiles on one page may sit at different
revisions; each is exact for the revision it names, and they converge when the writing
stops. What is never shown is a number belonging to another view or another file.

**A board draws the columns it can contain.** Its columns are the grouping field's
options, in the field's own order, less any the board's own clauses exclude: an `eq`
on the grouping field leaves one column, and each `ne` removes one. Only those two
operators are read, because a comparison or a null test over a choice says nothing
definite about which options remain, and a board that guessed would hide a column
that could hold a record. The rule exists because the alternative lies: a board
filtered to `status ne Done` that still draws a Done column reads 0 under that
heading, and 0 there says nothing is done rather than that this board does not show
it. Clauses on other fields change which records land in a column, never which
columns exist, and the ungrouped column is unaffected.

Its optional `scope` is closed to `surface` (the default) and `group`. `group`
narrows the number to one board column and is accepted **only on a direct child of
a `boardSurface`**: a tile nested deeper has no column to belong to, and searching
upward for one would invent a grouping rule nothing publishes. An unknown value is
`NUI296`; `group` in the wrong place is `NUI297`. A column is addressed by its
stored choice ID, and the ungrouped column by `isNull` — never by a display name
and never by `eq null`. A loaded card whose stored choice is neither absent nor one
of the configured options is a data issue the column states, not a record folded
into the null total. A configured column stays visible when it carries a total,
because the number is the answer.

Existing page and relation tile meanings are unchanged, as are exact aggregates,
numeric lexemes, the empty-set result and the named refusal of `avg`.

A sum is exact or absent. Past int64 for an integer field, or 28 significant digits
for a decimal one, the tile reads *Unavailable* with the reason and no Retry — the
host answered `aggregate-not-representable`, a refusal that recomputing cannot
change. A stored integer may itself reach int64 max, so a total of several such is
a real ceiling, stated rather than wrapped.

## Named tabs on a record page

`tabGroup` is non-root, takes an optional `title`, and contains one or more
`section` children and nothing else — so a tab is always a titled section, named
by the title a section already requires. It is accepted beneath `detailSurface`,
`recordForm` and `section`. An empty group is `NUI310`. A nested group is `NUI311`,
including through an intervening section: `section` is shared, so the ancestor is
tracked rather than inferred from the parent. Tabs organise named record
information; they are not a generic layout API, and this adds no commands to the
section child vocabulary.

The record page is rendered as an ordered recursive walk of the tree, so fields,
tiles and related lists keep the positions they were authored at. The old
flattening collected every field into a list of titled groups, which could not
keep a related list between two sections and had nowhere to put a tab.

Every panel is rendered into one record form, so changing tab is a visibility
change rather than a re-render: an unsaved value in the tab being left is still
there to save. A field bound twice on one page gets one editor, at its first
authored position, and the repeat says where that is — one draft value and one
validation state. Where a page has tabs the renderer owns validation, because a
required control inside a hidden panel is not focusable and the browser would
block the submit with an error nobody can act on: every declared field is checked,
the first invalid one has its tab opened and is focused, and only then is the
failure reported. Saving remains one typed record mutation against the expected
version.

**What unsaved typing survives, and what declines.** A record page is dirty exactly
when saving it would write: a field typed into and put back is not an edit, a reference
picker's search box names no field and never counts, and a save that finds nothing to
send says *No changes to save.* where a person can see it and leaves the page clean. Two
moves preserve a dirty page by patching its read-only parts in place — changing tab, and
paging a related list, which reads the next page and redraws only the relation. Every
other move off the page redraws it, and a redraw is the typing gone, so each declines in
the board drag's words, *Save your changes or close record details before …*: another
surface, another record type or the front page, another record, another page of records,
Add, a calendar or timeline move, a drill or its dismissal, a retry, a command on the
record, another view, and both history arrows. A redraw nobody asked for — a read the
screen chases, or the file being followed after a write from elsewhere — waits while the
page holds unsaved typing, as it already waits while a menu is open, and lands the moment
the draft is saved or closed. Nothing saves on the person's behalf so that their next
click can proceed.

## The Date calendar

`calendarSurface` is a root with `definitionVersion`, `entityId`, a required
`dateFieldId`, an optional `title` and the existing ordering properties. Its
children are `fieldBinding` and `filterClause`.

The bound field must be an active **Date** field. A DateTime is refused by name
with `NUI321`, because placing one on a month grid means choosing a time zone to
group by, and that needs its own contract change. Dates are civil `YYYY-MM-DD`
values throughout: nothing constructs a JavaScript `Date` for grouping, since
`new Date('2026-03-01')` is UTC midnight read back locally and moves the day west
of Greenwich. Default order is the date ascending with the existing stable
record-ID tie-break; a declared order overrides it and then orders entries within
each day.

A month is a Monday-first seven-column grid with previous/next month and Today,
and the current month opens first. The month query is the calendar's own clauses
plus `date >= monthStart AND date < nextMonthStart`. **A first page is never
presented as a complete month**: bounded cursor pages accumulate, each loaded
entry is placed on its date, and Load more continues until the cursor is
exhausted. While a cursor is open the calendar says so and a day with no loaded
entry reads as "None loaded yet" rather than empty; when it is exhausted it says
the month is complete. A revision change discards the accumulated pages rather
than merging two snapshots. A separate Undated view is the same root filters plus
`isNull(dateFieldId)`, so a record with no date is never silently lost. An entry
opens the existing record page or the Studio inspector; new records, edits and
date changes go through the existing typed forms, and the calendar writes nothing
itself.

Opening a calendar entry must not recompute the seven day tracks. When the
side inspector takes horizontal space, the calendar retains its existing width
and the surface scrolls horizontally; at the compact overlay breakpoint the
calendar remains at the viewport width.

## The timeline

`timelineSurface` (ADR-0004, 2026-09-14 amendment, S3) is a root with
`definitionVersion`, `entityId`, a required `dateFieldId`, an optional `title`, the
existing ordering properties, and three optional field roles. Its children are
`fieldBinding` and `filterClause`, and it owns eight roots per entity like a
calendar. It reads exactly what a calendar reads — bounded cursor pages between two
civil-date bounds, and the same undated view — and draws them as a spine.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `dateFieldId` | an active stored Date field; a DateTime by name, as the calendar refuses it | `NUI370` when absent, `NUI371` |
| `endDateFieldId` | an active stored Date field other than `dateFieldId` | `NUI372` |
| `titleFieldId` | an active stored Text field that is not a single choice, as on a record page | `NUI373` |
| `accentFieldId` | an active single-choice field, as on a record page | `NUI374` |

A calculated field in any of the four is `NUI214`, as everywhere a bounded query
would read one. The date rule is the calendar's and the title and accent rules are
the record page's, shared in the compiler rather than copied, so the same field is
refused with the same sentence wherever it is misused. A timeline with no
`fieldBinding` is `NUI211`.

**One civil year at a time.** The year query is the timeline's own clauses plus
`date >= 1 January AND date < 1 January next`, so a year is two implicit
predicates like a month and a timeline carries at most six declared clauses. The
year shown is renderer state per surface — this year in the device's calendar at
first open, Earlier and Later to move, This year to return — cleared on a file
switch and never written to the file. The spine is a heading for every month of
the year, in order, with the loaded entries placed under the month their date falls
in. Grouping is client-side over the accumulated pages, as the calendar groups by
day: the first page is never presented as the whole year, Load more continues
until the cursor is exhausted, a month with nothing loaded reads *None loaded yet*
until then and *Nothing this month* after, and the state line says whether the year
is complete. A revision change discards the pages rather than merging snapshots.
Default order is the date ascending; a declared order orders entries within a
month, and the months run December first only when the effective sort is the date
field itself, descending.

**An entry** is a button that opens the record page or the Studio inspector, as a
calendar entry does. It carries a dot in the tone of its `accentFieldId` option
(the derived hue when the option has none; muted when the field is unset), the day
and short month, its title — the `titleFieldId` value, else the first bound field —
and the remaining bound fields. The timeline writes nothing itself.

**A span.** When `endDateFieldId` is named and the record's end is on or after its
start, the entry states the span in words — *14 Sep – 30 Nov · 78 days*, counting
both ends — and draws a bar beside the sentence whose width is those days over the
year's days. One line under the year header states the denominator and the
placement rule: *Spans are drawn to scale over the 365 days of 2026; a span that
began before 1 Jan 2026 is on that year's spine.* So the proportion is of numbers
that are on screen, and the bar is decoration a screen reader skips. A span whose
end lies past the year is cut at 31 December and says how many days are shown and
that it continues; an end before the start is stated on the entry as a data issue
and draws no bar, never a bar drawn backwards. **Placement is by the start date
only**: a record appears on the year its `dateFieldId` falls in, and a span that
began in an earlier year is on that year's spine. An overlap query would need an OR
the closed clause set has not got, and two windows would double the accumulator;
the rule is stated on the surface rather than left to be inferred.

**The undated view** is the calendar's: the same root filters plus
`isNull(dateFieldId)`, as a record list, so a record with no start date is never
silently lost, whatever its end date.

Proposal preview draws the same spine over the validated clone's sample — the year
the sample falls in, the months that hold a sample entry, the dots and the spans —
and says so. The diff reads *Add a timeline of a date field, with its own undated
view*, *Place each record on the timeline by Decided*, *End each span at Review
date*, *Title each entry with Title* and *Colour each entry by State*. A timeline
raises the file's minimum host to 1.21.

## Folding a section away

Every `section` on a record page or on the front page can be folded away by the person
reading it and opened again; its heading is the control, and it opens and closes from
the keyboard as it does from a pointer ([ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md),
2026-09-20 amendment). Nothing is authored for that. The one thing an author says is
how the section starts: `opens`, one of the closed words `open` and `closed`, and
`open` when absent. A word outside the set is `NUI312`. A tab's body neither folds nor
takes `opens` (`NUI313`), because the tab strip already opens and closes it; a section
inside the tab may. `visibleWhen` and `opens` compose: the first decides whether the
section is on the page, the second how it starts when it is.

**A closed section reads nothing.** Its tiles, charts, ranges, recent and ranked lists
and related lists are not read while it is closed, or folding would save the person
nothing and cost the file the same reads; opening it makes them pending and they read
then, showing the state a tile shows before its first read. A value once read stays
until the file changes. On a record page a closed section's fields stay in the form,
hidden rather than removed, exactly as `visibleWhen` keeps them, and a required field
left empty reveals its section the way it reveals its tab.

What the person has done with a fold is renderer state scoped to the open file, like a
selected tab (F-027): it never reaches the file and is gone when the file is closed. The
diff reads *Add the section "Lately", starting closed.* when the property arrives with
the section, and *Start the section closed.* or *Start the section open.* when it changes
on a section the file already has; the review preview draws a section as it starts. A
`section` carrying `opens` raises the file's minimum host to 1.28.

## Showing a field only when a calculation says so

`fieldBinding` and `section` accept an optional `visibleWhen`, naming a **calculated**
field of the record type in context whose result type is Boolean. A stored Boolean is
refused (`NUI330`), and so is a calculation of any other type (`NUI331`): hiding one
field behind another field's typed value is a form rule this contract does not define,
and what this adds is a read-only consumer of the bounded expression service —
ADR-0008's P8.

It decides what is on screen and nothing else.

- The field stays in the form and keeps its value, so a save carries exactly what it
  would have carried with the node visible. Visibility grants no write authority and
  removes none.
- Studio never reads it. The permanent route into a file cannot be concealed by a
  surface, which is why an invalid surface disables custom views and leaves Studio
  reachable.
- Only a definite `false` hides anything. A result that is empty, still being worked
  out, or impossible to calculate leaves the node on screen: hiding on uncertainty is
  how a person stops being told something is there, and an empty page is
  indistinguishable from a page with nothing to say.

A file using it records a minimum host of 1.18, because a host that cannot evaluate
the calculation has no way to know whether to show the node.

The value is the calculated field's `fieldId` — not its definition ID, which a
review sent first. `nendo://application/vocabulary` says so under `propertyNotes`,
beside the kinds, and the review of a proposal that sets it reads *Show this only
when Needs retest is yes*. A `fieldBinding` to a calculated field reads *Show the
calculated field …* rather than *Bind to unknown field*. Studio's editor never
reads `visibleWhen`; it is a rule for the Use view's record page.

## The gallery

`gallerySurface` (ADR-0004, 2026-09-14 amendment, S2) is a root with
`definitionVersion`, `entityId`, an optional `title`, the existing ordering
properties and two optional field roles. Its children are `fieldBinding`,
`filterClause` and the three tile kinds a list takes; it owns eight roots per entity.

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI380` |
| `accentFieldId` | an active single-choice field | `NUI381` |

A calculated field in either is `NUI214`. Both are optional: a card with no declared
title leads with its **first bound field**, as a timeline entry does, so a gallery card
and a board card are titled by one rule and the card itself is drawn by one function.
A gallery with no `fieldBinding` is `NUI211`.

**It is a list's window drawn as cards.** The read is the surface's own `filterClause`
children and nothing else — a gallery adds no implicit predicate, so it carries the full
eight — and it pages with the same Previous and Next a list has, against the same cached
window. Its `summaryTile`, `breakdownChart` and `progressTile` children sit in the same
row above the grid, scoped and composed exactly as a list's are; `scope: group` is
refused, because a gallery has no columns. Drill-through still opens the record type's
first `recordList`, so a gallery's charts navigate away rather than narrowing the cards.

**A card** is a button that opens the record page or the Studio inspector. The title
leads; a choice value among the bound fields reads as a chip, as it does on a board card;
everything else is a labelled value pair. Where `accentFieldId` is named, the record's
option tones the card's left edge and tints its background, the way the record-page header
band is toned, and a record whose choice is unset gets the neutral card. Cards are
typographic because a field cannot hold an image, which is the strength of the shape when
the hierarchy is good.

Opening a card must not recompute the grid. When the side inspector takes horizontal
space, the gallery retains its existing width and the surface scrolls horizontally, as the
calendar's day tracks do; at the compact overlay breakpoint the grid remains at the
viewport width. A column count that recomputes under the pointer that opened a card moves
the layout out from under the reader.

Proposal preview draws the same cards over the validated clone's sample and labels it. The
diff reads *Add a gallery of cards, one per record.*, *Title each card with Title* and
*Colour each card by State*. A gallery raises the file's minimum host to 1.22.

## The overview page

A file may own one `overviewSurface`: the first root that belongs to the file rather than
to a record type (ADR-0004, 2026-09-14 amendment, S4). It carries `definitionVersion`, an
optional `title`, an optional `description`, and **no `entityId`** — declaring one is
`NUI390`. A second one in the same file is `NUI391`, whose hint states the ceiling the
vocabulary publishes as `maxRootsPerFile`; every other root keeps `maxRootsPerEntity`, and
no kind states both.

Because there is no record type in context, every child that reads records names its own:

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `summaryTile`, `breakdownChart`, `progressTile` | their existing properties plus `entityId` | unchanged | what they state elsewhere, over the record type they name |
| `rangeTile` | `entityId`, `fieldId` (required), `title`, `scope` | `filterClause` | the smallest and largest value of one field, as two exact aggregates |
| `recentList` | `entityId` (required), `title`, `limit`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause` | a list's ordered window, bounded to at most ten records |

`entityId` on a tile or a chart is **required under an overview and refused anywhere
else** (`NUI394`): on a surface a tile takes its record type from the surface it sits on,
and a tile that named a different one would have two answers to one question. A tile that
names a record type the file does not have is `NUI393`. A `recentList` outside an overview
is `NUI395` — on a surface that already has a record type, a `recordList` shows the same
records with a pager — and its `limit` is refused outside one to ten (`NUI396`) rather
than clamped, so the stored definition and the screen cannot say different things. A
recent list with no `fieldBinding` is `NUI401`.

A `rangeTile` is **not a chart**. It has no grouping, so it draws no proportion and has
nothing to drill into, and it reads an Integer, Decimal or **Date** field: `min` and `max`
over a set of civil dates is a comparison over the fixed-width ISO form and needs no
arithmetic, which is why the range is the one aggregate that reads a date and why `sum`
over one stays refused by name (`NUI397` names the shape a range can read). Both ends are
shown or neither is — one end of a range is a bound — and a set with no records has no
range and says so rather than reading zero to zero.

A `fieldBinding` and a `relatedList` need a record in hand and the front page has none, so
both are `NUI398`; a `visibleWhen` calculation answers per record and is `NUI399` for the
same reason. An overview with nothing that reads records is `NUI400`: a heading over an
empty space is not a front page, and a description is not a substitute for one, because
saying what the file is for is not the same as showing any of it.

The overview's `description` belongs to the overview. What the **file** is for is a
different thing, stored on the file itself, carried by `application.setPurpose` and led
with by `nendo://application/describe` — a file with no front page has one too, and the
two never stand in for each other. The MCP interface contract describes it.

The overview composes **nothing** across record types. Each child reads the one type it
names, and the overview adds no predicate of its own, so a child carries the full eight
declared clauses. There is no join, no number made from two record types, and no expression
over a result.

Use opens the overview first when one exists, and offers it beside the record types rather
than among one type's surfaces — it is not one of them, and it has no entity to be listed
under. A file without one opens exactly as it did. Each tile is read live over the whole
record type it names, four reads at a time, each with its own loading, empty and failed
state. Drill-through from a front-page chart opens that record type's first list, which
means leaving the front page: the narrowed list belongs to the type, not to the file.

Proposal preview **describes** the front page rather than drawing it. Every number on it is
a live read over a whole record type and the clone carries a bounded sample, so stating
what each tile will count is the only honest thing to draw, as it already is for a ring.
The diff reads *Add a front page for this file, whose tiles each name the record type they
read.*, *Say what this file is for: …*, *Read Axiom for this number.*, *State the smallest
and largest Accepted.* and *Show at most 5 of them.* Any of the three kinds raises the
file's minimum host to 1.23.

## A scale on an Integer field

An Integer field may carry `presentation: rating` with a closed `min` and `max`
(ADR-0004, 2026-09-14 amendment, S2). Both bounds are required together on a rating and
refused by name on every other presentation, the way `options` are refused off a single
choice; the span counts both ends and carries **at most ten values**, because a scale a
person cannot count at a glance is a number, which the plain Integer presentation already
shows. Like every presentation, a scale is set when the field is created and does not
change afterwards.

The scale is stored in its own protected table, `__nendo_field_scale`, which is now the
last rung of the layout ladder — after the choice-tone table, for the same reason that one
gives: the protected layout is a fingerprint of verbatim DDL, so a column on the field
table would move every known layout and need an `ALTER TABLE` on files that already exist.
A row exists only for a rating field; the first one creates the whole prefix, and a file
that rates nothing keeps the layout and the minimum host it had. A rating field without a
scale, or a scale on a field that is not a rating Integer, is mapping drift rather than an
unknown presentation.

**The scale bounds the drawing, not the column.** A write is never refused for being
outside it: a rating can be declared over values that already exist, so a number outside
the scale is stored, read back exactly, and reported by the compiler as a data warning
beside the one a value outside a field's choices already makes. The renderer shows that
number with *outside 1–5* next to it, and the editing control leaves every dot unchosen so
that touching nothing rewrites nothing. A CSV import is not checked against the scale
either.

The renderer draws the scale as dots, filled to the value, with the number carried in the
accessible name: *4 of 5* when the scale starts at one, and *4 on a scale of 2 to 6*
otherwise, because the short form would be a different fact. It is edited as one radio per
value of the scale, plus *Not set* when the field is optional, in the record form and in
Studio's record dialogs; Studio's table draws the dots and edits them by choosing one of
the scale's numbers. A rating raises the file's minimum host to 1.22 through the field
operation's own evidence, as a choice tone raises it to 1.19.

**One value carries one mark.** The radio *is* the dot: the first build drew a dot beside
the browser's own radio, so every value showed two circles of the same shape and the chosen
one looked chosen twice. A dot is also not a control sized for typing — the base rule gives
every input a 39 pixel minimum height and 8 by 10 padding, which drew it as a 21 by 39 oval
in a pill twice the height of the fields around it — so the rating's own rule restates the
size, the padding and the minimum height, and the gate measures all three.

**A form's field names are chrome, not content.** A press that lands on a name or a legend
and slides a few pixels used to sweep a selection across the whole form, which is what a
form full of controls looks like being dragged through; names, legends and the rating's
pills start no selection at all. The values keep theirs — a `user-select: none` on an
ancestor reaches into a control, so each one restates it — because copying a record out of
the page is a thing people do.

## Colour on a choice option

A choice option may carry a `tone`, set through the existing
`schema.setChoiceMetadata` operation beside its label and availability. The set is
closed and published as `choiceTones` in the vocabulary: `red`, `orange`, `amber`,
`green`, `teal`, `blue`, `violet`, `grey`. A tone is a semantic token in the sense a
field presentation is — the file stores the name, and the renderer owns the Light
and Dark colours behind it — so a hex value is refused by name, and so is `gray`.

The operation sets the whole of an option's metadata. A rename that carries the
tone keeps it; one that omits it clears it, and the review line says which: *Name
choice Trying, mark it available and colour it teal; preserve its stored ID* against
*… and give it no colour*. Compensating either puts the previous label, availability
and tone back together.

Where an option has a tone, everything that shows the option draws with it: the
board column and its dot, the card chips, the dot beside a list row or a calendar
entry (the first single-choice field the surface binds), Studio's choice cells, and
the record-page header below. An option without a tone keeps the renderer's older
habit of a hue derived from its stored ID, so a file authored before tones existed
looks as it did.

A tone is stored in its own protected table, `__nendo_choice_tone`, at the end of
the layout ladder: the first tone a file takes creates the whole prefix, as a first
choice edit or a first behaviour definition does, and a file that never colours
anything keeps the layout it had. A file that carries a tone records a minimum host
of 1.19, because a host that does not know the table would draw the option grey
and, on the next choice edit, would not know to keep the colour.

## The record-page header

`detailSurface` accepts three optional properties, each the `fieldId` of a field on
the page's record type:

| Property | Accepts | Refused by |
| --- | --- | --- |
| `titleFieldId` | an active stored Text field that is not a single choice | `NUI340` |
| `subtitleFieldId` | an active stored or calculated field other than the title | `NUI341` |
| `accentFieldId` | an active single-choice field | `NUI342` |

The renderer draws them as a band above the form: the title as a heading, the
subtitle under it, and the accent as a chip in its option's tone, with the band
itself tinted the same way. The record's commands sit directly under the band,
above the form, because a command is the action a person opens the page for and
under the Save button of a long form it went unfound. The values are read from the record and never edited in
the band; the form below remains the only place a value changes. A page that names
none of them is unchanged, and `recordForm` takes none of them, because a form is
where a record is typed in rather than read. Proposal preview draws the same band
over the validated clone's sample record.

The diff reads *Head the page with Handle*, *Show Statement under the page title*
and *Colour the page by Status*. A page with any of the three raises the file's
minimum host to 1.19 through the capability table, like every other shape of the
tree.

## Charts

A chart is an exact aggregate over a **closed grouping**, drawn as proportion with
its numbers beside it (ADR-0004, 2026-09-14 amendment, S1). Two kinds exist, and
both are tiles in the sense a `summaryTile` is: accepted where it is accepted
(`recordList`, `boardSurface`, `detailSurface` and `section`; not yet inside a
`relatedList`, which is refused rather than drawn empty), scoped as it is scoped,
and refusing the numbers it refuses by the same codes.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `breakdownChart` | `groupByFieldId` and `aggregate` (required), `fieldId`, `title`, `scope` | `filterClause` | one exact number per group, over the records its scope covers |
| `progressTile` | `title` | `filterClause` (at least one) | the records matching its own clauses over everything its scope covers, as two exact counts |

The closed groupings are a single-choice field's options, in their configured
order, and `false` then `true` for a Boolean; the unset group comes last. A stored
value that is none of them is counted apart as *unrecognised* and stated by the
chart, never folded into a group nobody configured and never drawn as a segment.
The grouping field must be active and one of those two kinds (`NUI350`); a
calculated field cannot group, as it cannot be totalled; at `group` scope on a
board it must not be the board's own grouping, because every column would break
down into itself (`NUI352`). A ring with no clause would always be full and is
refused (`NUI360`).

The grouping is not a filter and spends none of the budget of eight. The Engine
answers a grouped aggregate in one read: one streamed fold into a bucket per
group, shared by the SQLite read and the safe-mode snapshot so the two cannot
disagree, capped at 366 groups. A ring is two counts, the numerator its clauses
over its scope and the denominator the scope alone, and it is drawn only when both
have answered: one number is a count, not a proportion.

### Over time

Two kinds group by a civil date rather than by a closed set of options (ADR-0004,
2026-09-16 amendment, S5). They are accepted where the other charts are accepted
and scoped as those are scoped, and they take `filterClause` children the same way.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `trendChart` | `dateFieldId`, `bucket`, `range` and `aggregate` (required), `fieldId`, `title`, `scope`, `entityId` | `filterClause` | one exact number per bucket of the range |
| `activityGrid` | `dateFieldId` and `range` (required), `title`, `scope`, `entityId` | `filterClause` | one exact count per day of the range |

**Their groups are generated, not declared**, and every rule below follows from it.
A single-choice field's options are written into the definition, so an option
nobody has used is a group without anyone arranging it; a month is written down
nowhere. The host produces every bucket from the resolved bounds before it reads a
single row, so **a bucket with nothing in it is still a bucket**: a month with no
records is stated as empty and drawn as a gap at zero, and a quiet day is the
lightest square rather than a hole. A chart that returned only the buckets the data
touched would draw the shape of the data while looking exactly like the shape of
the range.

`bucket` is closed to `month` and `week`. `range` is a closed word the host
resolves to civil-date bounds **each time it reads**, never a stored date and with
no literal alternative: a definition written in January would otherwise still mean
January in December. A `trendChart` takes `last12Months`, `last6Months`,
`last90Days` or `last30Days` (`NUI356`); an `activityGrid` takes `thisYear` or
`lastTwelveMonths` (`NUI358`), because it draws one square per day and only a
year-shaped range fits the 366-group ceiling. A word outside its own kind's set is
refused naming the set it may use, and an unknown `bucket` is refused the same way
(`NUI355`).

`dateFieldId` is an active stored Date field. A DateTime is refused by name
(`NUI354`, `NUI357`) rather than truncated, as on a calendar and a timeline:
truncating one to its date means choosing a time zone to group by, which this
contract version does not define. A calculated field cannot bucket, as it cannot
group or be totalled.

An `activityGrid` **counts only** and has no `aggregate` or `fieldId` at all: a
square toned by a sum is a heat map of a number a person cannot recover from the
square. A `trendChart` takes the same exact aggregates a `summaryTile` does, and
`avg` stays refused by name.

**The range spends two of the filter budget.** The two bounds are predicates the
host adds to the query, so a `trendChart` carries at most six authored
`filterClause` children where a tile elsewhere carries eight, and the `NUI300`
refusal names the two the host adds rather than leaving the author to work out why
six was the number. Because the bounds are in the query, a record with no date, or
one outside the range, never reaches the fold: the result has **no unset group**,
which is why a day grid over a leap year spends the 366-group ceiling exactly
rather than one short.

The renderer draws a trend as one column per bucket, an empty bucket keeping its
slot and its label and drawing a baseline tick, and an activity grid as squares in
week columns toned in five steps against the busiest day, with zero its own step.
Both put every number in the table behind the same one toggle the other charts use,
and both drill: a bucket opens the record type's first list narrowed to that
bucket's two bounds, which is the one drill in the product that spends two clauses.
Safe mode folds the same buckets over the snapshot rather than declining, because a
chart that is exact against the file and *Unavailable* against a read-only copy of
it would be two answers to one question.

The renderer draws a breakdown as one stacked bar of segments in the options'
tones, with a legend carrying every group's exact lexeme, and a ring with both
numbers in its centre; a zero total is an empty track that says so, an absent
number reads *Unavailable* with the reason, and a table of the same numbers is one
toggle away. Each segment is a button named with its label and number.

Clicking a segment or a ring opens the record type's first list narrowed to that
group: one predicate that replaces the list's own clauses rather than composing
with them, so it spends one filter and can never refuse a list that compiled. It
is renderer state, like the selected surface: shown as a dismissible pill, cleared
on a file switch, never written to the file. While it lasts the surface's own
totals and charts stand down, because they would describe the surface's set rather
than the records on screen. Proposal preview counts the validated clone's bounded
sample per group, whatever the chart aggregates, and says so; a ring in preview is
described, since its counts are live reads.

The diff reads *Add a breakdown chart of the records this surface covers, one exact
number per group*, *Break the numbers down by Status* and *Add a progress ring of
the records matching its conditions over everything this surface covers*. Either
kind raises the file's minimum host to 1.20.

### Grids

Two kinds state a number the surfaces above cannot (ADR-0004, 2026-09-17 amendment,
S6). A `matrixSurface` is a root of its own; a `rankedList` is a front-page tile.

| Kind | Properties | Children | What it states |
| --- | --- | --- | --- |
| `matrixSurface` | `definitionVersion`, `entityId`, `rowByFieldId` and `columnByFieldId` (required), `title`, `orderByFieldId`, `orderDirection` | `fieldBinding`, `filterClause`, and the tiles and charts a board takes | one exact count in every cell of two crossed groupings |
| `rankedList` | `entityId` and `rankByFieldId` (required), `orderDirection`, `limit`, `title` | `fieldBinding`, `filterClause` | the few records at the top of one stored number, each against the exact largest |

**A matrix is one read, not one read per cell.** The host makes every cell key from
the cross product of the two option sets — each axis carrying its own unset lane —
before it reads a record, and folds the record type once into those keys. So a grid
costs the same one read at four cells or two hundred, **a cell with nothing in it is
still a cell**, and every number it states is exact over everything the surface's
clauses cover rather than over the page of records in view. The alternative
considered and not taken was a `summaryTile` per cell, which is one read each,
arrives four at a time, and fills the grid in like a slow page.

Because the cell holds both an exact number and the surface's one loaded window, it
states them as the two different quantities they are: where the window holds fewer
than the number, the cell says **showing 4 of 17**. A board column has never been
able to say that without a tile of its own.

`rowByFieldId` and `columnByFieldId` are active single-choice or Boolean fields —
the grouping rule a `breakdownChart` already applies — and they **must be different
fields** (`NUI412`): a field against itself fills one diagonal and leaves every other
cell empty. An axis that is neither kind is `NUI410` for the rows and `NUI411` for
the columns, and a calculated field cannot be an axis, as it cannot group.

Rows and columns are the field's options **less the ones the surface's own `eq` and
`ne` clauses exclude**, which is the board's rule applied twice, and only those two
operators are read. Every reachable option is drawn even when it is empty, because
an option is something a person arranged and its emptiness is the answer. The
**unset lane** on each axis is different: nobody arranged it, so each is drawn only
when its own exact number is not zero. Every record the surface covers is in exactly
one cell, and a stored value that is none of the field's options is counted apart as
*unrecognised*, never folded into a cell nobody configured.

**The cross product spends the group ceiling.** `MaximumAggregateGroups` is 366 and
the two option sets plus their unset lanes must multiply inside it, so the widest
honest grid is about nineteen by nineteen. A definition already over it is refused
when it is authored (`NUI413`, naming both fields and their counts); a definition
that grows over it later is refused **when it is read**, and the surface states that
it cannot draw the grid. Option sets change without the screen being touched, so both
are needed — and drawing the cells that fit is the one wrong answer, because a matrix
missing its last four columns looks exactly like a matrix.

A cell drills with **two predicates**, one per axis, opening the record type's first
list narrowed to that cell — the second two-clause drill in the product after a
bucket's two bounds, and renderer state on the same terms. An unset lane drills with
`isNull`. Moving a card between cells is not in this slice: a board's drag sets one
field and the same gesture here would set two, which is a different promise about
what one movement writes.

A `rankedList` lives where a `recentList` lives — under an `overviewSurface` or a
`section` within one — and is refused elsewhere (`NUI422`), because on a surface that
already has a record type, a list ordered by the same field shows the same records
with a pager. `rankByFieldId` is an active stored Integer or Decimal; a **Date is
refused by name** (`NUI420`), and it is the one place a Date is refused where a
`rangeTile` accepts one, because `min` and `max` over a Date are comparisons while a
bar is arithmetic. `limit` is one to fifty, refused above rather than clamped
(`NUI421`), and absent means the ceiling.

**A record with no number is not ranked.** The host adds an `isNotNull` predicate on
the rank field, so a ranking carries at most **seven** authored `filterClause`
children where a tile elsewhere carries eight, and the `NUI300` refusal names the one
the host adds. The bar is against one exact `max` over everything the ranking covers,
not over the page, so it means the same thing however many rows are shown; when the
largest value is **not greater than zero no bars are drawn at all** and every row
states its number, because a proportion of a non-positive maximum is a drawing of
nothing. **Equal numbers share a rank numeral and the next numeral skips it**, and the
limit is a limit on rows, so a tie straddling it is cut: *the top ten by value* is ten
rows, not everyone who reached tenth.

Safe mode folds the same cells over the snapshot rather than declining, through the
same `CellAggregateFold` the SQLite read uses, so the two cannot disagree about which
cell a pair of stored values lands in.

The diff reads *Add a matrix crossing two choice fields, with an exact count in every
cell*, *Make one row per Status*, *Make one column per Priority*, *Rank the records by
Value, largest first* and *Rank at most 10 of them*. Either kind raises the
file's minimum host to 1.26.

## A board grouped by a reference

Under the ADR-0004 2026-09-17 amendment (S7) `boardSurface.groupByFieldId` takes a
single-choice field, whose options are its columns, or a **bound Reference field**, whose
target records are. Nothing else about the board changes: the same kind, the same
properties, the same children, the same cards, the same group-scoped tiles.

**The columns are every active record of the target type**, ordered by the reference's
configured label field, ascending, which is the order the reference picker already reads
them in. Not only the records something points at. A lane nobody has used is an answer, the
way an empty cell and an empty month are; a column that appeared and vanished with the data
would make the board's shape depend on which page had loaded; and "the records in use"
could only be computed from the board's own loaded window, so it would mean the records in
use *on this page*. `orderByFieldId` continues to order the cards inside a lane and never
the lanes, because a record type carries no order an author arranged.

**The board draws at most `boards.maximumReferenceColumns` of them, which is 24.** Above
it the board draws **no columns at all** and states the record type, how many records it
holds and the ceiling. Drawing the first twenty-four would be the one wrong answer, for the
reason a partial grid is: a board missing its last lanes looks exactly like a board. It
also follows from all-or-nothing that no card can point at a column the board did not draw.

**At the other end it draws the board and states the absence.** A target type with no
records is `ready` with no columns, not a failure, and the rule that every record of the
type is a column is as true at zero as it is at four. The board names the type and says it
has no columns, and it keeps drawing: over the ceiling there is nothing to lose by
replacing the board, but at zero the Ungrouped lane holds every card there is, and hiding
the records to explain the columns would answer a smaller question than the one asked. The
sentence names what a person can do from the screen they are on — the Showing picker and
Add are both on that toolbar — and sends them to Studio instead when the target type has
no view of its own.

**The Ungrouped lane's advice is true of the board it is on.** With named columns it still
reads *Move a card to a named column to assign it.* With none it says there is no named
column to move a card to, rather than instructing a person to do something the screen
cannot do. The same is true of a board or a grid whose own `eq` and `ne` clauses have
excluded every option of the field it groups by: it states that its own filter is what
emptied it, and names the field to remove a condition from.

This ceiling is checked **when the board is read, not when it is authored**, and that is
the one place it departs from the grid ceiling it is modelled on. A matrix is refused at
authoring because the definition carries both option sets; a definition cannot carry how
many records a record type holds. The renderer learns it from the read it was making
anyway, by asking for one record more than the ceiling, and reads an exact count only in
the case that refuses — so the sentence names a number rather than "more than".

**An unbound Reference field is refused when the board is authored** (`NUI237`), because it
has no target type to read columns from and no label to head them with; binding it is a
reviewed proposal of its own. A target type that is missing or retired is `NUI238`, and a
missing or retired label field is `NUI239`. Each names the field and what is absent rather
than repeating the choice-field diagnostic, which would send an author looking for the
wrong fix. `NUI236` now reads *The board needs an active bounded choice field or a bound
reference.*

**A reference column carries no tone.** A tone is something an author put on an option, and
a record has nowhere to hold one. The column takes the hue the renderer already derives for
an option nobody coloured — stable per value and shared by every surface — so no new rule
is written and nothing new is stored.

**Ungrouped is unchanged**: a record with no reference is in it, and a drag into it clears
the field. A stored reference to a record that is not in the target type is stated as a
data issue beside the lane, as a value outside a field's options already is. It is not
reachable through anything the host offers — deleting a record something points at is
refused by name (`record-referenced`) — and no promise is made that it can occur.

**Dragging a card between reference columns writes the grouping field with the target
record's current version.** A reference write is refused without it (`target-version-
required`) where a choice literal needs none; the board holds the versions because it read
the target type to draw the columns. Where the target moved under the board the write is
refused (`target-version-conflict`), and the board says so in its own words and reads its
columns again rather than passing on the host's message about selecting the target — there
is no picker on a board to select one in.

A reference board spends no new filter budget: a column tile still composes the board's
clauses, its own, and one column predicate, which is an `eq` on the reference field. The
diff reads *Give the board one column per Client record, from Client, and draw nothing above
24 of them*, and the preview's size sentence *one column per Client record, 12 of them* —
"per {name} record" because the name is the person's, and *one column per Initiatives, 6 of
them* is what a plural one read as. A reference board raises the file's minimum host to 1.27.

## Adding and opening from a related list

A `relatedList` offers two actions on a record page (ADR-0004, 2026-09-18 amendment):
**Add**, which opens a new record of the related type with the reference back at the record
in view already filled in, and **open**, which opens a related row as its own record page.

Nothing is authored and nothing is stored for either. The node already carries
`targetEntityId` and `viaFieldId`, and the compiler has already proved the target is an
active record type and the field an active Reference aimed at this one (`NUI260`–`NUI266`),
so there is nothing left for an author to say. **The file is unchanged, so nothing raises
its minimum host**: a rung says what a file needs, and a file that is what it was needs what
it needed. A host without this draws the same relation without the buttons.

| What it does | The rule |
| --- | --- |
| Add | The related type's own record page, rendered as a create form in the place the record page was. Its sections, its tabs and its required fields apply unchanged; a type with no page falls back to its field list, as a create form already does. The form shows no relations of its own, so an Add cannot nest. |
| The reference back | Filled in before the form is shown, named by the label field the reference was configured with rather than by the stable ID, and carrying the record's current version, which a non-null reference write is refused without (`target-version-required`). It stays editable. |
| A page that does not bind it | The reference is added to the form anyway, first, and it is what the form is open for. A child's record page usually does not bind the field that points back at the parent, and a form wired to only what the page binds would save a record pointing at nothing. |
| open | The related record is read by its own ID and opened as its own page. It is not looked for in the target surface's loaded window: a relation is ordered as its author arranged it, so the row clicked need not be there, and narrowing that surface to one record would answer a question nobody asked about the surface. |
| Getting back | One step, named after the record it returns to, and taken away once it is taken. Not a history: opening a third record replaces the answer rather than stacking behind it. Renderer state, like a drill or a selected surface — never in the file, cleared when the record context is left. |
| A record page with unsaved edits | Declines both, in the board drag's own words. Both redraw the page, and a redraw discards a form's drafts. Switching tabs and paging the relation still preserve a draft: those paths patch in place and never redraw. A picker searched and cancelled is not an edit, and neither is a field put back to its stored value. |
| A row whose record has gone | Says so — *That record is no longer there* — after the redraw that follows the click, and leaves the person on the page they were on, with busy cleared. The read comes before anything moves, so nothing moves. |
| A related type with no screen | Offers neither, and says so beside the heading. Use shows the record types that have a compiled surface; without one there is nowhere for the new record to go and no page to open a row on. |

A relation whose window was read against an older revision is not that relation's answer,
and reads as loading until it is read again — as every other window here already does. A
record page chases its relations on the same bounded terms its totals are chased on.

Nothing here allocates the reference codes a file's own convention may require. The host
requires a Reference field to be non-empty and does not fill it in, enforce uniqueness or
stop it being changed, so a file whose records are named by hand still has a person
deciding which name is next.

## Bounded query composition

One bounded query carries at most **eight** effective filters, counting the ones
the host adds itself. `MaximumEffectiveFilters` is one constant, read both by the
published vocabulary and by the record-query validation that refuses, so the
stated ceiling cannot drift from the ceiling that refuses. Composition is what
spends it:

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
| Progress ring | its own clauses over its scope, and the scope alone, as two counts |

An over-budget definition is `NUI300`, naming the node, the property path, the
count it composes to and where each clause came from. The host never drops a
clause, widens a query, deduplicates, or raises the limit as a convenience.

## Capability versions

Contract version 3's tree is preserved across the widening, so the version number
on a root no longer says what a host must understand: a plain form and a tabbed
page with two boards are both version 3. `NendoSemanticCapability` computes what a
stored definition needs from its **shape**, plus one thing the shape cannot show (below),
and the ladder is:

| Feature | Minimum host |
| --- | --- |
| Any custom surface | 1.1 |
| Composable semantic surfaces (`definitionVersion` 3) | 1.11 |
| A summary tile on a list or board, or any `scope` | 1.12 |
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

Every row but the last is a shape of the node tree. The last is not: a board grouped by a
reference and a board grouped by a choice carry the same kind, the same `groupByFieldId`
and the same children, and only the grouping field's storage kind tells them apart. So the
calculation reads the stored fields beside the tree. Without that it would return 1.26 for
a file that needs 1.27 — and because one refused surface makes a whole definition invalid,
a host on the older rung would have reported that a custom surface cannot run safely over
every authored screen in the file while naming none of them.

The calculation runs over the tree a mutation leaves behind, not over the
operations it submitted, for two reasons. An inline `ui.addNode` expands to a node
operation plus one property operation each, so judging operations one at a time
would answer differently depending on expansion order. And a `ui.moveNode` that
puts an existing tile under a board, or an existing section into a tab group, adds
no node and sets no property yet changes what the definition needs. Only a
mutation that touches UI nodes recomputes it.

A file's recorded minimum is only ever raised, so removing a feature leaves the
file stating the host it once needed. An ordinary existing definition keeps its
minimum and opening a file never rewrites it. A raise appears in the semantic diff
as its own irreversible `raiseMinimumHostVersion` line, because the operations
alone do not state it; rejection leaves the active file untouched and promotion
remains canonical operation replay. File inspection reports an insufficient
minimum by naming the widened features the file uses, not only the number. Product
release version, semantic contract version and file capability version remain
three separate things.

## The mutation is the materialization boundary — for the definition lane only

A record type exists physically from the end of the mutation that created it, not
from the end of the change set. So a required field must sit in the same mutation
as its `schema.createEntity`; adding one in a later mutation refuses with
`NPROP004`, which names the field, the record type and both remedies. The other
remedy is to add the field optional and require it with `schema.setFieldRequired`
in a later mutation of the same change set. The rule is not arbitrary: an
intervening mutation may write records, and a required column added after them
would leave those rows with no value.

UI nodes are exempt. A surface root added in one mutation accepts children added
in a later one, which is what lets a large surface tree be split across calls at
all. The asymmetry is real, it is between the definition lane's physical
materialization and the UI lane's stored node tree, and it was previously
documented nowhere.

Within one change set the definition revision advances by one per definition-lane
mutation and not at all for a data-only mutation. A caller may omit
`expectedDefinitionRevision` entirely and the MCP adapter fills in the value for
that operation's position before compiling; the stored canonical operation still
carries an exact integer, so replay and promotion concurrency are unchanged.

`ui.addNode` accepts an inline `properties` map over MCP. It is a boundary
convenience and nothing behind the boundary sees it: the adapter expands it into
the canonical `ui.addNode` plus one `ui.setProperty` per property, in stable
property-name order, before compilation, diff, history or promotion. What changes
is the cost of a build — a node and its configuration are one submitted operation
rather than one plus one per property — and the two budgets are published and
echoed separately, so the expansion is bounded rather than implicit.

Proposal preview renders the validated derivative's bounded plans and record
values, with no mutation handlers or write authority. Its summary counts are
taken over the validated clone rather than over the compiled plans, so a
schema-only change set previews as what it adds; a raise in the file's minimum
host version is a `raiseMinimumHostVersion` line in the semantic diff, because it
is a durable compatibility change that the operations alone do not state.
Root/record selection is preview-local. Promotion continues canonical operation
replay against current definitions and touched-record versions; it never swaps in
the derivative file.

Acceptance fixtures cover each optional root, multiple entities, mixed versions,
over-ceiling roots, invalid bindings, retired definitions, unknown effects,
bounded records, host command targeting, reject/accept/reopen and renderer
recovery. `Gate-AgentAuthoring.mjs` builds the widened vocabulary through MCP
alone and then drives the running app: the surface selector, a surface total and
per-column totals, a second list with its own filter, the month grid and undated
view, the timeline's year with a span cut at its end and its own undated view, a
gallery of toned cards showing a rating as dots, and a tab change that keeps an
unsaved value. On a reopened file it then measures the record page's own rules: a
picker searched and cancelled and a save with nothing to save both leave the way back
open while a reference actually chosen holds it; a related row pointed at a record that
has gone says so and stays put; and a page holding typing keeps it across a paged
relation and a write from elsewhere, and declines another record type, Add, another
record, another surface and another page of records — each refusal measured readable in
Light and Dark. Render and Computer checks remain required separately.

### Use navigation and layout

Use keeps the selected surface name visible in a View disclosure picker and in
the page heading. The picker lists each surface with its kind; it supports
keyboard focus and Escape to close. Surface totals have an inset below the
toolbar. Board headers and group summaries size to their content, with remaining
column height assigned to the card area rather than stretching summary values.

Calendar controls, status, grid and undated rows share the same 16px content
inset as lists and boards. Studio row actions use compact outlined buttons
centered in their grid cells.

A record page opened from a related row offers one step back to the record it was opened
from, named after it, in the same toolbar group as the surface picker and the drill pill.
It is taken away once it is taken, and is cleared with the rest of the view whenever the
record context is left.

Beside it, and available from every view rather than only from a relation, the workspace
header's control group leads with a back and a forward arrow, dressed as the theme control
they sit next to and placed before the File menu. Each says where it goes, by the same
eyebrow and title the header shows — "Back to Use · Work — All work" — and a direction
that leads nowhere is disabled and named only for itself. Alt+Left and Alt+Right do what
they do, and stand aside for a dialog, the file menu and any field with focus.

A place is the view, the record type, the front-page choice, the surface, the record, the
drill, the open tab of each tab group on that record type's page, the month and view of a
calendar or the year and view of a timeline, the Help topic, the labelled step back where
there was one, and — for a proposal review — where its Close button leads. Those are carried as values rather than named, so going back to a
list that has since been drilled returns it whole. Nothing of this reaches the `.nendo`
file: the trail is bounded, belongs to the open file, and is emptied when another one is
opened. The record type a place names is the one on screen, which is not always the one
that was picked: until somebody uses the picker, Use shows the first compiled type while
nothing has been selected.

A place that no longer exists is declined with a sentence and dropped from the trail,
rather than resolved to a neighbouring screen and presented as the one that was asked
for. That covers a deleted record, a surface a proposal removed, a record type that no
longer has a screen, a retired record type behind a Studio page, a front page the file no
longer has, and a view the file's capabilities no longer allow. A Studio page is judged on
its own record type: a place carries the Use selection so that going back restores the
whole view, but a Structure page is not refused because a proposal removed a screen
somewhere else. Both arrows decline while a record form holds unsaved typing, in the same
words the labelled step back uses.

**How long a sentence lasts.** A screen that reads on its own account redraws when those
reads land, and a redraw rebuilds the slot a sentence is said in. So every sentence is
kept with the view it was said on and put back after each redraw, and what ends it
depends on what it was. A success stays until an action clears it or the view is left. A
notice with a Refresh view button stays until that button succeeds. A refusal — a declined
step back, a declined move off a page holding typing, a row whose record has gone, a
failed write — stays until the person does the next thing: their next press or key
anywhere but on the sentence itself, or leaving the view. Written into the pane and
nothing more, a refusal lasted exactly as long as the next chased read, which on a screen
with a tile is under a second; the sentence about a place that had gone was once wiped
before the authoring gate could read it, and a person pressing Back at that moment saw
nothing at all (F-086). The gate now writes to the file from elsewhere after the sentence,
watches the screen follow the write, and reads the sentence again.

## Isolated custom graph definitions

ADR-0013 authorizes `extensionGraphSurface`, a root naming an exact device package
and a bounded graph projection. It uses the same canonical UI operations, semantic
review and replay as other roots. Required properties, preservation and execution
limits are in [custom views](custom-views.md). No package or consent is stored in
the file; missing packages preserve the definition. The new shape requires host
1.29.0. Desktop rendering and device consent are still being integrated.
