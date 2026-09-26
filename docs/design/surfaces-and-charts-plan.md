# Surfaces and charts plan

The ideas for new custom surfaces and the first charts, with the order to build
them in and the foundation the first slice must lay. Written 2026-09-14, the day
the [vision](../vision.md) admitted charts and dashboards into scope.

**This is a plan, not authority.** Its ADR-0004 amendment was accepted on
2026-09-14, and every slice below lands as one entry under that amendment in
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), with its rules
in the [semantic surfaces contract](../contracts/semantic-surfaces.md). The
amendment text is at the end. Where this plan and the
shipped code disagree once a slice is built, the contract is current and this
file is a transfer.

## What "visually pleasing" has to mean here

Every custom surface today is typographic and monochrome except for focus: a
list, a board, a form, a record page, a month grid. They are honest and they are
grey. The lever that changes that is not a widget library. It is colour, shape
and proportion carried by application meaning the file already stores — which
choice a record is in, which date it happened on, how many there are, how much
they add up to.

So every idea obeys the rules the contract already enforces:

- **Declarative.** A root or tile is typed semantic properties and ordered
  children. No layout, no expression, no renderer configuration is stored.
  Column widths, chart heights and animation belong to the renderer.
- **Bounded reads.** Records arrive in cursor pages; numbers arrive as exact
  aggregates; one query spends at most eight effective filters, counting the
  ones the host adds.
- **Exact or absent.** A number is exact or reads *Unavailable* with the reason.
  Nothing is sampled, estimated or computed in the renderer beyond drawing a
  proportion of two numbers that are both on screen.
- **Studio untouched.** A surface failing suppresses every custom plan and
  leaves the table, the data and recovery reachable.
- **Reviewable.** Every kind and property has an owner-facing diff sentence, a
  path in Use and a path in read-only proposal preview. Every visible node is
  keyboard-reachable and named for a screen reader, in Light and Dark.

### The line the vision now draws around charts

A chart in Nendo draws exact aggregates over a **closed grouping**, and nothing
else. The closed groupings are:

| Grouping | Groups |
| --- | --- |
| A single-choice field | each configured option, plus the unset column, plus a stated data issue for a stored value that is neither |
| A Boolean field | true, false, unset |
| A Date field within two bounds | months, weeks or days between the bounds; civil dates, no time zone |

A chart never draws a page of records as if it were the whole set, never shows a
percentage without both of its numbers, and inherits every refusal a tile already
makes: `avg` is refused by name, a calculated field cannot be grouped or totalled,
and `aggregate-not-representable` reads *Unavailable* with no Retry. There is no
grouping query language, no cross-entity join and no expression over the result.
A person can always flip a chart to the table of numbers it was drawn from.

## Step 0: the common foundation

Five things every later slice leans on. Build these first, on their own, with
the record-page header as the visible proof.

### F1. Choice tone

A choice option gains an optional `tone`, closed to eight named hues plus none:
`red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet`, `grey`. It is a
semantic token in the sense the existing field presentations are — an author
says *Trying is teal*, never a hex value — so ADR-0004's ban on renderer
configuration holds. The renderer owns two luminance levels per tone for Light
and Dark. Retired options keep their tone.

The existing choice-option operation carries it, the diff reads *Name choice
Exploring, mark it available and colour it teal*, and on day one Studio's choice cells, board columns, calendar chips and
list badges pick it up. Everything below draws with these eight hues and nothing
else, so a file reads as one palette across every surface an agent builds.

### F2. Exact grouped aggregate

The Engine's exact aggregate service answers one number per query today, which
is why a board with a tile in every column issues one read per column, four at a
time. Add one grouped form: the same aggregate, the same clauses, plus one closed
grouping from the table above, answering one exact number per group in one read.
The grouping is not a filter and does not spend the budget of eight.

This is the load-bearing engine piece for every chart, it lets a tile row load
as one read, and it answers the question the roadmap left open for the calendar
— whether a month is complete — without paging every entry. It crosses the
Workbench bridge as one revision bump, and it is read through the host services
like every other aggregate; the MCP interface gains nothing, because agents
author charts and people read them.

### F3. The renderer chart kit

One small SVG module in the Workbench, tested with `node --test` like the other
models, and no chart library: AG Grid Community has no charts and the repository
gate refuses the edition that does. Five primitives, each drawn from exact
numbers handed in:

| Primitive | Draws |
| --- | --- |
| Proportion bar | one stacked horizontal bar of toned segments with a legend |
| Bars | horizontal bars, one per group, labelled with the number |
| Ring | a filled arc with "12 of 40" in the centre |
| Columns | a series of columns over date buckets |
| Strip | a min and a max on a line |

Every primitive carries its numbers beside the shape, exposes a table of the
same numbers behind one toggle, names every segment for a screen reader, takes
keyboard focus per segment, respects reduced motion, and reads *Unavailable*
with the reason when its number is absent. Tones come from F1; the rest of the
palette is Console's graphite, hairlines and violet accent ([console-direction.md](console-direction.md); Molded Workbench's warm white, deep navy and cobalt until 2026-09-26).

### F4. The slice checklist

Each new kind costs the same twelve things, and a slice is not done until all
twelve are there. Naming the list once means every slice below can cite it
instead of restating it.

1. One rule row in the vocabulary table, so `nendo://application/vocabulary`
   publishes it with `propertyNotes`.
2. Compiler validation with named diagnostics for every wrong shape.
3. A diff sentence for every property, read in review as a person would say it.
4. A render plan and the Use path.
5. The read-only proposal preview path over the validated clone.
6. A rung on the capability ladder, computed from the tree's shape.
7. An authoring example in the examples resource.
8. A step in `Gate-AgentAuthoring.mjs` that builds it through MCP alone and
   drives the running app.
9. Engine and Workbench tests, and an acceptance fixture.
10. A phase in the blackbox prompt so the next outside review reaches it.
11. The contract, ADR amendment and architecture text updated in the same change.
12. Light and Dark, keyboard and screen-reader checks recorded.

### F5. Drill-through as renderer state

Clicking a bar, a segment, a ring or a matrix cell opens the entity's first
list with that group's predicate applied as a transient filter, in the same way
a selected surface or an open tab is remembered: file-session-local, cleared on
a file switch, never written to the `.nendo` file. It is what makes a chart a
way in rather than a picture, and it stores nothing.

## The ideas

Cost is small, medium or large relative to the calendar slice. Rungs are
proposed; the ladder is assigned when the amendment is accepted.

### Family A: colour and headers, no new roots

| Idea | Stored shape | Why it pleases | Cost |
| --- | --- | --- | --- |
| **A1 Choice tone** | F1 | The whole product gains a palette | Small |
| **A2 Record-page header** | `detailSurface` gains optional `titleFieldId`, `subtitleFieldId`, `accentFieldId` (a single-choice field) | A hero band at the top of every record page, toned by the record's own choice | Small |
| **A3 Scale presentation** | Field presentation `rating` on an Integer field with a closed `min`/`max` (span at most ten) | Stars or dots wherever the field appears, in Studio and on every surface, editable as dots | Small |

A2 refuses a title field that is not Text and an accent that is not a
single-choice field. A3 is a schema-level presentation like `date`, so no surface
kind changes and a value outside the span reads as the number with a data issue
rather than as an invented star count.

### Family B: new record surfaces

| Idea | Stored shape | Reads | Why it pleases | Cost |
| --- | --- | --- | --- | --- |
| **B1 Gallery** | `gallerySurface`: `titleFieldId`, optional `accentFieldId`, ordered `fieldBinding`, `filterClause`, `summaryTile` | Exactly a list's window | A card grid: large title, toned edge, two or three lines of typographic body. Cards are type because there are no image fields, which is a strength when the hierarchy is good | Small |
| **B2 Timeline** | `timelineSurface`: `dateFieldId`, optional `endDateFieldId`, `titleFieldId`, ordering, `fieldBinding`, `filterClause` | Exactly the calendar's bounded pages between two bounds, plus an undated view | A vertical spine with month and year headers and toned dots; an end date turns entries into spans, so a project plan reads as bars without becoming a scheduler | Medium |
| **B3 Matrix** | `matrixSurface`: `rowByFieldId`, `columnByFieldId` (both single-choice), `fieldBinding`, `filterClause`, `summaryTile` with `scope: cell` | One window grouped client-side like a board; a cell tile spends root clauses plus two predicates | Priority against status, effort against value: the Eisenhower grid people draw on whiteboards, with counts in every cell | Medium |
| **B4 Ranked list** | `rankedList`: `rankByFieldId` (Integer or Decimal), `orderDirection`, `limit` (at most fifty), `fieldBinding`, `filterClause` | One page of at most `limit` records plus one exact `max` | A leaderboard: rank numerals and a bar per row proportional to the exact maximum, so the top record fills its row | Small |
| **B5 Board by reference** | `boardSurface.groupByFieldId` widened to a Reference field | The referenced entity's label as a bounded page of columns, with a stated ceiling | A lane per project, per person, per client | Medium |
| **B6 Outline** | A self-referencing entity as an indented tree | Bounded windows against a recursive shape, and cycles | Parked: pretty, and the hardest here | Large |

B2 refuses DateTime by name for the reason the calendar does, and a span whose
end precedes its start is a data issue the entry states, not a bar drawn
backwards. B3's two fields must differ. B5 needs a ceiling on columns before it
is honest: a reference to an entity with three hundred records is not a board.

The **S7 entry in [ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md) is the
authority for B5**. Its ceiling is 24 and it is one-sided: read-time only, because a
definition cannot know how many records a record type holds, where B3's is refused at
authoring as well.

The **S6 entry in [ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md) is the
authority for B3 and B4**, and it departs from those two rows in three named places: a
matrix is one grouped read rather than a `summaryTile` per cell, an axis may be a
Boolean as well as a single choice, and a ranked list is an overview tile rather than a
root surface.

### Family C: charts as tiles

Each is a child of `recordList`, `boardSurface`, `detailSurface`, `section`,
`relatedList` and the overview page below, and takes `filterClause` children
like `summaryTile` does.

| Idea | Stored shape | Reads | Draws | Cost |
| --- | --- | --- | --- | --- |
| **C1 Breakdown** | `breakdownChart`: `groupByFieldId` (single-choice or Boolean), `aggregate`, `fieldId` for a sum, `title`, `scope` | One grouped aggregate (F2) | A proportion bar or bars per option in the option's tone, with the legend and the numbers | Small once F2 exists |
| **C2 Progress** | `progressTile`: `title`; its own `filterClause` children are the numerator over the surface's set | Two exact counts | A ring with "12 of 40" | Small |
| **C3 Trend** | `trendChart`: `dateFieldId` (Date), `bucket` closed to `month` and `week`, `range` closed to a short list relative to today, `aggregate`, `fieldId` | One grouped aggregate with two date bounds; at most six authored clauses, as a calendar | Columns per bucket; a month with nothing is a gap, not a missing month | Medium |
| **C4 Range** | `rangeTile`: `fieldId` (Integer, Decimal or Date), `title` | Two existing exact aggregates, `min` and `max` | A strip with both ends labelled | Small |
| **C5 Activity grid** | `activityGrid`: `dateFieldId`, `range` closed to `thisYear` and `lastTwelveMonths` | One grouped aggregate by day, at most 366 groups | A year of toned squares, one per day, the way a contribution graph reads | Medium |

C3 and C5 refuse DateTime by name. `range` is a value kind like `today` is: a
closed word the host resolves to civil-date bounds when it reads, so a stored
definition never carries a date that goes stale.

### Family D: the dashboard

**D1 Overview page** — delivered 2026-09-15. `overviewSurface` is the first root
that belongs to the file rather than to a record type. Its children are `section`, `tabGroup`, every
Family C chart, `summaryTile` and a new `recentList`, and because there is no
entity in context each tile and chart names its own `entityId`. `recentList`
names an entity, an order, a `limit` of at most ten, ordered bindings and
filters. Use opens the overview first when one exists, and it is the front page
of the file: pages read, ideas by stage, decisions this quarter, the five most
recent entries.

One overview per file to begin with. Tiles load four at a time as they do now,
each with its own loading, empty and failed state, so a slow chart never blanks
the page. Cost: medium, and everything in Family C is reused unchanged.

## Suggested order

Each slice is one ADR-0004 amendment entry, one contract section and one
capability rung, and ships the F4 checklist in full.

| Slice | Contents | Proves itself on | Proposed rung |
| --- | --- | --- | --- |
| **S0 Foundation** — delivered 2026-09-14 | Accept the amendment; F1 choice tone; the renderer palette tokens; F4 as a written checklist; A2 record-page header | Idea Garden: five toned board columns and a toned Idea page; the Axiom Register gate authors toned statuses and a headed page over MCP | 1.19.0 |
| **S1 First charts** — delivered 2026-09-14 ([plan](s1-first-charts-plan.md)) | F2 grouped aggregate; F3 chart kit; C1 breakdown and C2 progress on lists, boards and pages; F5 drill-through | Axiom Register: a breakdown by status on the register list, a progress ring per section | 1.20.0 |
| **S3 Timeline** — delivered 2026-09-14 ([plan](s3-timeline-plan.md)) | B2 timeline with spans, undated view | Decision Log: decisions on a spine by decided date; the Axiom Register gate authors a timeline of spans over MCP | 1.21.0 |
| **S2 Gallery and scale** — delivered 2026-09-14 ([plan](s2-gallery-and-rating-plan.md)) | B1 gallery; A3 rating presentation | Decision Log: decisions as toned cards; the Axiom Register gate authors a gallery and a rated field over MCP | 1.22.0 |
| **S4 Overview** — delivered 2026-09-15 ([plan](s4-overview-plan.md)) | D1 overview page, `recentList`, C4 range | The Axiom Register: a front page reading two record types, authored over MCP | 1.23.0 |
| **S5 Over time** — delivered 2026-09-16 | C3 trend, C5 activity grid | The Axiom Register gate: a trend of accepted axioms by month, a year of days | 1.25.0 |
| **S6 Grids** — delivered 2026-09-17 | B3 matrix, B4 ranked list | The Axiom Register gate: status against domain, and a ranking by confidence | 1.26.0 |
| **S7 Board by reference** — delivered 2026-09-17 | B5, with its column ceiling | The Axiom Register gate: axioms by remit, including a remit nobody points at | 1.27.0 |
| Parked | B6 outline; DateTime, week and day scheduling; drag-to-date; images | | |

S3 was asked for before S2, so it took 1.21.0 and S2 takes 1.22.0: the ladder is
monotone and a host never advertises a later feature than it has, so rungs follow
delivery order rather than the order proposed here. The same correction moved S5
to 1.25.0 and every slice after it by one: 1.24.0 went to the file purpose on
2026-09-15, which this table did not anticipate. Read the rungs here as proposals
and the accepted amendment as the authority.

S0 is deliberately small and visible: a person opens Idea Garden and sees colour
where there was none, and every later slice draws with it. S1 carries the only
engine work of weight, the grouped aggregate, and proves it with the two
cheapest charts. After S1 each slice is mostly vocabulary and renderer.

### A fourth reference application — delivered 2026-09-22

The three reference applications each falsified the vision from a shape the
previous one could not express. A fourth was proposed here as a **Reading Log**,
to prove S4 through S6. It was superseded by **Nendo Station**, which proves the
same slices and several more in one world that has somewhere to put the next
ones: [the plan](nendo-station-plan.md), [the walkthrough](../nendo-station.md).
A reading log would have proved the charts; a station proves the charts, the
relationships, the calculations, the action and the custom-view boundary, and it
carries a schematic of its own that no Nendo screen can draw.

**The rule that keeps it from becoming a museum: a new surface slice adds its
screen to `tools/Build-NendoStation.mjs` in the same change that delivers it.**
The file is an output and the script is the source, so the station is rebuilt
rather than patched, and a slice with nowhere sensible to go in a real
operations room is worth a second look before it ships.

## Decisions taken by default

Stated so they are choices rather than accidents; each is a bounded initial
value, not a measured optimum.

- Eight tones. Enough to tell five board columns apart and few enough to stay
  one palette.
- One overview per file. Several would need a file-level selector that nothing
  else needs yet.
- `bucket` is month or week. Day buckets belong to the activity grid, which
  bounds them to a year.
- A ranked list shows at most fifty; a recent list at most ten.
- A grouped aggregate answers at most 366 groups, which the day grouping over a
  year is the ceiling of.
- Drill-through applies one predicate and opens the entity's first list. It
  does not compose with the list's own filters, because that would spend the
  budget of eight silently.

## The ADR-0004 amendment

Accepted by the owner on 2026-09-14 and recorded in
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md), where each slice
is logged as it lands. The text as proposed, which the ADR carries in full:

> **Accepted amendment — 2026-09-14 (colour, charts and the overview page).**
> A choice option may carry a `tone` from a closed set of named hues. A chart is
> an exact aggregate over one closed grouping — a single-choice field's options,
> a Boolean, or a Date field's months, weeks or days between two bounds — drawn
> as proportion with its numbers shown and a table of them one toggle away. An
> `overviewSurface` is one file-level root of sections, tiles, charts and short
> recent lists, each naming its own entity. Drill-through from a chart is
> transient renderer state. None of this stores layout, an expression, a sample
> or renderer configuration; there is still no grouping query language, no
> cross-entity join and no expression over a result. Each kind arrives with its
> compiler, diff, Use and preview support, its own rung on the capability
> ladder, and the existing refusals of `avg`, calculated-field grouping and
> unrepresentable aggregates.
