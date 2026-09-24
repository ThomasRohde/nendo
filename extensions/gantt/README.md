# Gantt

A custom view that draws one record type on a time line: a bar from a start date to an end
date, and a diamond for a record with only a start. It is the first **record-set** package,
for an `extensionRecordsSurface` view (ADR-0013, 2026-09-24): it receives records with typed
columns, not a graph, and it needs no links. From 0.2.0 it also sits on a record page as an
`extensionRecordPanel`, where Nendo sends that page's one record and it draws a chart of one.

It is a separately versioned, unsigned package with no dependencies, downloads or write
operations, implementing protocol 2. It reads only the bounded projection Nendo approves.
Selecting a record is a suggestion; opening and editing it stay with the host.

## What it reads

The view names its columns as disclosed fields. The **first date field is the start** and
the **second date field is the end**; a record without a start is counted in the summary
and not drawn, and an end before the start is treated as no end. The first disclosed field
that is not a date is shown under each record's label, as its group or owner. A view that
discloses no date field says so rather than drawing an empty chart.

Rows are in start order. The axis carries month ticks, at most twelve. Labels are set as
text, so a label that looks like markup stays text.

## Building and pinning

```powershell
pwsh ./tools/Build-NendoGanttPackage.ps1
```

The output is `artifacts/extensions/org.nendo.gantt-0.2.0.nendoview`, and the command prints
the SHA-256 a file pins. Pin it with an `extensionRecordsSurface`, or an
`extensionRecordPanel` on a record page, whose `fieldBinding` children name a start date and
an end date; see
[authoring a custom view](../../docs/custom-view-authoring.md).

## What measures it

`pwsh ./tools/Review-Gantt.ps1` runs the pinned Playwright CLI against a task-owned local
server. It measures that equal starts share a left edge, that a twenty-day span is drawn
about four times a five-day one, that a later start sits further right, milestones, the
undated count, start order, the selection message's exact keys from the pointer and the
keyboard, markup-shaped labels, generation replacement, the no-date empty state, refusal of
a protocol-1 message, both themes and a 512x384 window. It runs inside `Test-Production.ps1`.
With every bar drawn at one width it fails with `A twenty-day span is not drawn about four
times a five-day one`.
