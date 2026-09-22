# Defect: a content-invalid draft is frozen, undiagnosable and unrecoverable

## Sequence, verbatim

1. `nendo.change_set.begin` -> `change-set-c722ac89cb30fe5dd80daac2de76573b`, state draft
2. Seven `nendo.change_set.add_operations` calls. All accepted.
   Final echo: `{"mutationCount":14,"operationCount":90,"canonicalOperationCount":194,
   "operationLimit":128,"canonicalOperationLimit":512,"state":"draft"}`
   — every published ceiling respected.
3. `nendo.change_set.validate` (idempotencyKey `seedlib-csA-validate-1`)
   -> `NENDO_INVALID_REQUEST: The request arguments are invalid.`
4. `nendo.change_set.validate` again, fresh key `seedlib-validate-a2` -> identical.
5. `nendo.change_set.preview` -> `NENDO_CHANGE_SET_NOT_VALIDATED`
6. `nendo.change_set.amend` (dropFromMutationOrdinal 4)
   -> `NENDO_CHANGE_SET_FROZEN: The change set is already frozen for validation.`
7. `nendo://application/proposals` -> `[]`
8. `nendo.change_set.validate` a third time -> `NENDO_INVALID_REQUEST` again.

## Why this is a defect and not me holding it wrong

`validate`'s own tool description: "An invalid draft is not consumed: its clone is
discarded, the draft stays open, and the returned diagnostics say what to correct with
nendo.change_set.amend before validating again."
`add_operations`' description: "A failed validate leaves the draft open: correct it with
nendo.change_set.amend rather than starting again."

All three promises fail at once. The draft *was* consumed; it does not stay open; no
diagnostics were returned; and `amend` — the remedy both descriptions name — is the one
call that is refused, because the draft is frozen.

The resulting state is a dead end reachable by no documented exit:

| call | result |
|---|---|
| validate | NENDO_INVALID_REQUEST (no diagnostics) |
| preview  | NENDO_CHANGE_SET_NOT_VALIDATED |
| amend    | NENDO_CHANGE_SET_FROZEN |
| proposals| absent |

Only `reject` works, and 90 operations are lost.

## The refusal itself

`NENDO_INVALID_REQUEST: The request arguments are invalid.` names the wrong layer. The
four arguments I sent are exactly the four the tool's JSON schema declares required, and
the identical call shape validated a two-operation draft successfully thirty seconds
later. So the message points the reader at their arguments when the problem is in the
draft's content. It names no operation, no mutation ordinal, no property, and offers no
remedy.

## Control that proves validate is not itself broken

Same handle, same lease, same call shape, a 2-operation draft
(`change-set-e569c30c99e297b66c9919a892fa0fd8`): validate returned a full proposal with
`diagnostics: []`, a three-line `semanticDiff`, and a `raiseMinimumHostVersion` entry.
So `validate` works; it is the invalid-content path that is broken.

## Smallest reproduction

Not yet isolated to one operation — see evidence/02. The 90-operation draft contained
four payload shapes I had to guess because no resource publishes them:
`visibleWhen` as a bare string, a `fieldBinding` to a derived field, `RelatedAggregate`
+ `Sum` with an invented `aggregateFieldId`, and `Concat` over a nullable argument.
