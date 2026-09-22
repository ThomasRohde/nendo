# Measured: the UI-layer refusals (Phase 5)

All returned `state: invalid` with full diagnostics, and the draft stayed open — the
documented recovery loop. Every one names the offending node, most name the property
path, and every hint carries a remedy. Contrast the behaviour-body path in evidence/07.

## Sort / filter / group / total by a calculated field — all NUI214

| tried | node | propertyPath | message |
|---|---|---|---|
| recordList orderByFieldId = seedsPerGram | negOrderList | orderByFieldId | "Field 'seedsPerGram' is calculated, so this host cannot sort by it." |
| filterClause fieldId = needsRetest | negFilterClause | fieldId | "Field 'needsRetest' is calculated, so this host cannot filter on it." |
| boardSurface groupByFieldId = needsRetest | negBoard | groupByFieldId | "Field 'needsRetest' is calculated, so this host cannot group by it." |
| summaryTile sum fieldId = seedsPerGram | negTotalTile | fieldId | "Field 'seedsPerGram' is calculated, so this host cannot total it." |

Shared hint: "Name a stored field. A calculated field can be bound for display on the
same surface, but nothing writes to one and no bounded query reads one."

Two things worth noting. The message inflects the verb to the operation (sort / filter
on / group by / total), so it reads as written for that spot rather than a generic
"cannot use". And the three-surface draft returned all three diagnostics in one
validate — it does not stop at the first error.

## A form of only calculated fields — NUI215

    {"code":"NUI215","severity":"error","propertyPath":null,
     "message":"The form shows only calculated fields, so there is nothing to fill in.",
     "hint":"Bind at least one stored field. A calculated field can be shown beside it,
             but nobody types into one."}

Distinct code from the list cases, and correctly a whole-node problem: propertyPath is
null because no single property is at fault. The remedy is actionable.

## Bearing on finding 04

Both refusals state, unprompted, that "A calculated field can be bound for display on
the same surface." So binding a derived field to a surface is a supported, intended
thing — which means the seven "Bind to unknown field" lines in the accepted proposal
(evidence/04) are a diff-rendering defect, not a description of a real problem. The same
"unknown field" phrasing reappears here in this diff for every derived binding, on a
draft that was correctly ruled invalid for a different reason.
