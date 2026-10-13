# Gantt

A custom view that draws one record type on a time line: a bar from a start date to an end
date, and a diamond for a record with only a start. Rows are in start order, the axis
carries month ticks (at most twelve), or week or day ticks for a span inside a month or two,
and stays at the top while the rows scroll under it. Labels are set as text, so a label that
looks like markup stays text, and a row's name for a screen reader is its label, its group
line and its span. Selecting a record, with the pointer or Enter, asks Nendo to open it. The
rows are one tab stop: Up and Down, Home and End move between them, with a focus ring in the
theme's colour, and a re-read keeps the keyboard and the stop on the row they were on. That
is the view kit (`kit/nendo-view-kit.js`, copied from `tools/view-kit`), which the Gantt is
the first package to carry (W-064). In a Windows contrast theme the bars and milestones are
drawn in the system's text colour and the selected record in its highlight colour, with a bar
down the selected row's start edge, so the focus ring still shows on that row and the two do
not read as one.

On a record page it draws that page's one record as a chart of one: no title or
instructions, the label above its bar, and the span in days. That record is the page's
own, so selecting it opens nothing.

## In Nendo's toolbar

On a Nendo that offers it, the chart's title gives way to Nendo's breadcrumb, and on a
screen Nendo's toolbar carries a Find box (Ctrl F, and in Ctrl K under the view's title).
Rows whose label or group does not hold the text step back; Enter opens the first row that
does. A right-click on a row opens Nendo's menu, with Open record. On a screen the summary
line is Nendo's row's text and the hint is behind About, shown over the chart until Escape,
so the chart starts at the top of the frame; a problem reading the file stays in the frame,
whole. A chart of one on a record page declares nothing and keeps its summary. On an older
Nendo the chart is as it always was.

## What it reads

Everything arrives through `window.nendo`, which `<script src="/_nendo/api.js">` installs:

- `nendo.view.loadRecords()`: the view's records, or on a record page that page's one
  record;
- `nendo.schema.describe()`: the names and types of the fields the view binds. The
  **first date field is the start** and the **second date field is the end**. A record
  without a start is counted in the summary and not drawn, and an end before the start is
  treated as no end. The first bound field that is neither a date nor a date and time is
  shown under each label, as its group or owner; a reference is shown by the name it points
  at. A view that binds no date field says so rather than drawing an empty chart, and a view
  that binds date-and-time fields instead is told, by their names, that the chart draws date
  fields. Each record's label is the
  definition's label field;
- `nendo.ui.theme` and the `theme` event. `api.js` sets the Workbench's colour tokens on
  the page as `--nendo-*` and `gantt.css` draws with them; the values after each token are
  used only when the page runs without them;
- the `changes` event, and the `context` event when the view's definition changes: the
  chart reads again a quarter of a second later, and keeps the selected record selected
  while it is still on the time line;
- `nendo.ui.openRecord(entityId, recordId)`: opening the selected record;
- where the host offers them, `nendo.ui.setToolbar`, `nendo.ui.showMenu` and the `command`
  event, for the Find box and the row menu above.

It writes nothing. A read that Nendo refuses is shown in the summary line, and a record
type with no records says so.

## Putting it into a file

In Studio → Screens → Custom views, choose **Import** and pick this folder's
`nendo-package.json`. The package arrives as a proposal to review, and once it is accepted
the file carries the code. An agent does the same over MCP with `extension.setPackage` and
one `extension.putFile` for each file.

Show it with an `extensionRecordsSurface`, or an `extensionRecordPanel` on a record page,
whose `packageId` is `org.nendo.gantt` and whose `fieldBinding` children name a start date
and an end date. See [authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-Gantt.ps1` serves this folder on one origin and a fixture broker on
another, and runs the real `api.js` between them in Playwright (msedge). It measures that
equal starts share a left edge, that a twenty-day span is drawn about four times a five-day
one, that a later start sits further right, milestones, the undated count, start order, an
owner reference shown by its name, markup-shaped labels, exactly one `ui.openRecord` per
selection from the pointer and the keyboard, a re-read only after a `changes` event that
keeps the selection, one read for a burst of changes, a re-read under new fields after a
`context` event, the no-date empty state, the record page reading only its own record
through `records.get` and opening nothing when it is selected, the record page's compact
380×360 layout, a dark `theme` event and a canvas token changing the measured colour, a
refused read shown as text, the no-records state and a 512×384 window. It also measures the
marks against the track in forced colours, the row's accessible name with its owner, the
keyboard and the one tab stop kept across a re-read, a date-and-time binding named in the
empty state and never shown under a label, two or more ticks on a one-week chart, and the
axis still inside the chart after scrolling sixty rows. Then it measures
the chart again on a broker that offers Nendo's toolbar: no title of its own, the Find box
it declares, which the broker reads by the Workbench's own rules, the rows Find dims, Enter
opening the first match once, Open from the row menu, and nothing declared on a record page.
It runs inside `Test-Production.ps1`.
