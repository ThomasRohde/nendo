# Defect: the Sum rollup shape cannot be learned from the wire, and each guess destroys a draft

## What the wire publishes about it

`nendo://application/vocabulary`, behaviour.bindings:

    {"kind":"RelatedAggregate",
     "requiredFields":["entityId","relatedEntityId","relatedReferenceFieldId","aggregate"],
     "summary":"A bounded aggregate over the records pointing back at this one."}

and behaviour.aggregates lists `Count`, `FilteredCount`, `Sum`, with Sum's result type
given as "integer or decimal, matching the field" — "the field" is never named.

`requiredFields` is demonstrably incomplete: the server's own `calculate-and-act-
automatically` example sends `predicateFieldId` on a FilteredCount binding, and that key
appears in no resource. So the published required-field list does not describe the
accepted payload, and there is no published way to discover the rest.

## The three attempts

Identical skeleton each time: two record types, a configured reference, one
RelatedAggregate calculation. Only the Sum binding's field key changed.

| # | change set | Sum binding named its field as | validate result |
|---|---|---|---|
| 1 | change-set-dfb9f8bcc240e70438663bde27357d39 | `aggregateFieldId: "probeSeeds"` | NENDO_INVALID_REQUEST, draft frozen |
| 2 | change-set-0475326b43db78d3dbd2549227929bb7 | *omitted entirely* | NENDO_INVALID_REQUEST, draft frozen |
| 3 | change-set-5ada646b7c0ec5e7f398959c1d4dbee3 | `fieldId: "qSeeds"` | NENDO_INVALID_REQUEST, draft frozen |

## The control that rules out my setup

Attempt 3 carried a `Count` rollup in the same mutation, shaped exactly like the one in
the server's published example (`project.taskCount`), over the same reference. If the
skeleton were wrong, Count would fail too. Count is used unchanged in the application I
went on to build and validates green. The defect is specific to `Sum`.

## Why this costs more than a wrong guess should

Every wrong shape triggers the freeze in evidence/01: no diagnostics, draft frozen,
`amend` refused, whole change set lost. So the only way to discover the shape is trial
and error, and each trial costs one of the eight `draftsPerSession`. I stopped after
three because I could not afford a fourth and still build the application.

Remaining names I did not get to try: `sumFieldId`, `valueFieldId`, `targetFieldId`,
`relatedFieldId`, `aggregateField`.

## Consequence for the review

I dropped the Sum rollup from the application. `variety.totalSeeds` — the most natural
calculation in the whole domain, "how many seeds of this variety does the library hold"
— does not exist, because I could not find out how to write it without reading the
source. All four *binding kinds* are still covered; one *aggregate* is not.

## Reproduction

Send the mutation below against an empty file, after creating `pLot`/`pVariety` and
configuring the reference:

    {"operationType":"behaviour.setDefinition","payload":{
      "definitionId":"pVariety.totalSeeds","definitionKind":"Calculation",
      "body":{"entityId":"pVariety","fieldId":"totalSeeds","displayName":"Seeds held",
        "resultType":"Integer","resultNullable":false,"expression":"seeds",
        "bindings":[{"bindingId":"seeds","kind":"RelatedAggregate","aggregate":"Sum",
          "entityId":"pVariety","relatedEntityId":"pLot",
          "relatedReferenceFieldId":"pLotVariety",
          "resultType":"Integer","nullable":false}],
        "callAliases":[]}}}

Then `nendo.change_set.validate`.
