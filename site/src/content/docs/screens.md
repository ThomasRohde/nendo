---
title: Screens
description: Every kind of screen a Nendo file can hold, what each one reads, where its parts go, and its limits.
group: Use
order: 20
---

A screen shows the records of a file in a particular way: as a list, a board, a
calendar, a record page and so on. This page lists every kind of screen and the
tiles and charts that go on them. For the terms used here, see
[Concepts](/nendo/docs/concepts).

## How screens work

A screen is data, not code. The file stores each screen as a tree of nodes with
stable IDs: a root node for the screen, and child nodes for its fields, filters,
sections, tiles and commands. The file never holds HTML, styling, scripts or SQL.
Nendo compiles the whole set of screen definitions when it opens the file and
each time the definitions change, then draws the result in **Use**.

The compiler checks every screen before it draws any of them. If one node is
wrong, for example a field binding that names a field the record type does not
have, Nendo turns off
every custom screen and shows the error in Studio's **Surfaces** area. It does
not draw part of an app. Your data, Studio and recovery are not affected, and no
screen can hide Studio.

Most screens belong to one record type. In Use, pick the record type, then pick
a screen from the **View** picker. The front page is the exception: it belongs
to the file, and Use opens it first when the file has one. Which screen, tab,
month or year is open is remembered for the session only and never written to
the file.

A calculated field can appear on any screen as a read-only value. It cannot
filter, sort or group a screen, place a record on a calendar or timeline, or feed
a total.

## Screens for one record type

| Screen | Per record type | What it shows | Main limits |
| --- | --- | --- | --- |
| List | up to 8 | Rows of records, one column per bound field, in a chosen order, with Previous and Next. | |
| Board | up to 8 | Cards in columns, grouped by one field. Drag a card to another column to change that field. | Groups by a single-choice field or a bound reference field. |
| Gallery | up to 8 | The same records and pages as a list, drawn as cards. A title field leads each card; a single-choice accent field colours its edge. | Cards are text only; there are no image fields. |
| Calendar | up to 8 | Records on a month grid by one date field, plus an **Undated** view. | Date fields only. A date-and-time field is refused. |
| Timeline | up to 8 | Records under month headings on a one-year spine, plus an **Undated** view. An optional end date draws a span. | Date fields only. A record is placed by its start date. |
| Matrix | up to 8 | A grid that crosses two fields, with an exact count and the cards in each cell. | At most 366 cells, so about 19 by 19. |
| Custom graph | up to 8 | Records as a node-and-edge graph drawn by an installed package. | See [Custom views](/nendo/docs/custom-views). |
| Record page | 1 | One record: a header, fields in sections and tabs, related lists, tiles and commands. | |
| Form | 1 | One record as a plain form for entering data. | Used only when there is no record page. |
| Command | up to 8 | A button that sets fields on the open record. | |

### Board

A board groups cards into columns by one field, which you name in
`groupByFieldId`.

- **By choice.** The columns are the field's options in their configured order,
  in the option's colour. A filter clause `eq` on the grouping field leaves one
  column, and each `ne` removes one. Other clauses change which cards appear, not
  which columns exist.
- **By reference.** The columns are every active record of the target record
  type, ordered by the reference's label. A board draws at most 24 reference
  columns. Above that, it draws no columns and states the record type, its record
  count and the limit. The reference field must be bound to a target type.

Both kinds have an **Ungrouped** column for records with no value. Dragging a
card writes the grouping field. A tile on a board can count the whole board or
one column (`scope: group`).

### Calendar and timeline

A calendar shows one month at a time, Monday first. A timeline shows one year at
a time, with a heading for every month. Both load records in pages, so until the
period is fully loaded an empty day or month reads *None loaded yet*. Both have
an **Undated** view for records with no date. Neither writes: an entry opens the
record page.

On a timeline, an optional end-date field turns an entry into a span, shown in
days and as a bar drawn to scale over the year. A span that runs past 31 December
is cut there and says so. An end before the start is shown as a data issue.

### Matrix

A matrix crosses two single-choice or Boolean fields: one for rows and one for
columns. They must be different fields. Nendo computes every cell in one read, so
an empty cell still shows 0. When a cell holds more records than the loaded
window, it says, for example, *showing 4 of 17*. A matrix whose rows times
columns, plus one unset lane on each axis, exceeds 366 is refused when it is
authored. If the option lists grow past that later, the matrix states that it
cannot draw the grid. It never draws part of a grid. You cannot drag cards
between cells.

### Record page and form

A record type can have one record page (`detailSurface`) and one form
(`recordForm`). When both exist, Use opens the record page. When neither exists,
a record opens in Studio's editor.

A record page can contain:

- **A header** with a title field, a subtitle field and an accent field whose
  option colours the band. The header only shows values; you edit them in the
  form below it.
- **Field bindings**, each one an editor for one field.
- **Sections**, each with a title. A reader can fold any section. The author sets
  only how it starts, open or closed. A closed section reads nothing until it
  opens.
- **Tab groups**, whose tabs are titled sections. Changing tab keeps unsaved
  typing.
- **Related lists**, which show the records whose reference points at this
  record. **Add** creates a new related record with the reference already filled
  in. Selecting a row opens it as its own record page.
- **Tiles and charts** over the whole record type.
- **Commands**, shown as buttons under the header.

A field binding or a section can be shown only when a Boolean calculated field is
true (`visibleWhen`). Only a definite *false* hides it. The value stays in the
form and is still saved.

A form holds only field bindings, sections, tabs and commands. It has no header,
related lists or tiles.

**Commands.** A command is a labelled button that runs ordered steps on the open record. Each
step sets one field to a fixed value, today's date, the current time or empty. A
command can be its own root or sit inside the record page.

## The front page

A file can have one front page (`overviewSurface`). It belongs to the file, so it
has no record type of its own. Each tile, chart and list on it names the record
type it reads. It never combines two record types in one number. It can have a
title, a sentence of description, sections and tabs. It needs at least one tile,
chart or list. It cannot hold field bindings or related lists, because there is
no current record.

## Tiles and charts

Every number is exact. Nendo does not round, and a sum that does not fit reads
*Unavailable* with the reason. There is no average.

| Part | What it states | Where it can go |
| --- | --- | --- |
| Summary tile | One count, sum, minimum or maximum. | List, board, gallery, matrix, record page, front page, section, related list |
| Breakdown chart | One number per option of a single-choice field, or per yes and no, as a stacked bar. | List, board, gallery, matrix, record page, front page, section |
| Progress ring | The records that match its own clauses, out of all records in its scope. | Same as breakdown chart |
| Range tile | The smallest and largest value of one number or date field. | Same as breakdown chart |
| Trend chart | One number per month or week over the last 12 months, 6 months, 90 days or 30 days. | Same as breakdown chart |
| Activity grid | One count per day, as squares, for this year or the last twelve months. | Same as breakdown chart |
| Recent list | Up to 10 records of one type, in a chosen order. | Front page, or a section on it |
| Ranked list | Up to 50 records at the top of one number field, with bars against the largest. | Front page, or a section on it |

On a list, board, gallery or matrix, a tile covers all records the screen's
filter matches, not only the loaded page. Breakdown and trend charts show an
empty group or period as zero; they do not leave it out. A grouped chart has at
most 366 groups. Select a chart segment, bucket or matrix cell to open the record
type's first list narrowed to that group.

## Filters

A **filter clause** keeps the records where one stored field compares to a
value. The operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull` and
`isNotNull`. The value is a fixed value, today, now or empty. All clauses on a
node must match. There is no OR and no grouping of clauses.

One read carries at most **eight** filters in total. Filters that Nendo adds
itself count towards the eight:

| Context | What Nendo adds | Clauses you can write |
| --- | --- | --- |
| List, board, gallery, matrix | nothing | 8 |
| Tile on a list, board or gallery | the screen's clauses | 8 minus the screen's |
| Tile on one board column | the board's clauses and 1 for the column | 7 minus the board's |
| Related list | 1 for the reference | 7 |
| Calendar or timeline | 2 for the date bounds | 6 |
| Trend chart or activity grid | 2 for the date bounds | 6, less its context's clauses |
| Ranked list | 1 to skip records with no number | 7 |
| Tile on a record page or the front page | nothing | 8 |

A definition over the budget is refused with a message that names each clause and
where it came from. Nendo never drops a clause to make a screen fit.

## How screens get made

There is no visual screen editor. Screens are built as proposals:

1. An agent with the **Shape app** access level reads the file and the screen
   vocabulary, then builds a change set of node operations: add a node, set a
   property, move a node, remove a node. See [Agents](/nendo/docs/agents).
2. Nendo validates the change set on a private copy of the file. A valid change
   set becomes a proposal under **Pending changes**.
3. You open **Review changes**. The review lists each change in plain words, for
   example *Order by Amount, largest first*, and draws a preview of the screens
   over a sample of records from the copy. It describes the front page and
   progress rings instead of drawing them, because their numbers are live reads
   of the whole record type.
4. **Accept changes** applies the same operations to your file. **Reject** leaves
   the file unchanged.

Studio's **Surfaces** area lists the compiled screens of each record type, with
their kind and what they are bound to. When the definition does not compile, it
shows each error with a hint. The one screen edit Studio makes itself is renaming
a board, which also goes through a proposal and a review.

A file records the lowest Nendo version that can draw its screens. An older
Nendo refuses the file instead of drawing part of it.
