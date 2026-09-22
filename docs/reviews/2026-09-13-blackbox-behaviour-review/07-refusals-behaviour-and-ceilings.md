# Measured: behaviour-body and ceiling refusals (Phases 5, 4)

All in one draft (change-set-3e65...), each reached by amend, all recoverable — the
draft never froze on any of these. This is the important contrast with evidence/02:
a *well-formed formula that is semantically wrong* is diagnosed cleanly; only a
*malformed binding payload structure* triggers the freeze.

## A formula calling an unlisted function

| expression | code | message |
|---|---|---|
| `DaysBetween(harvested, Now())` | NPROP002 | "'Now' is not a function this formula may call." |
| `HttpGet('https://example.com/price')` | NPROP002 | "'HttpGet' is not a function this formula may call." |

The clock and the network are refused by the same mechanism as any other unlisted name:
the closed function set. The message names the offending function. The catalogue note on
the wire ("There is no clock, no file, no network ... the function set above is closed")
is enforced, not merely asserted.

Weakness: `semanticId` and `propertyPath` are both null, and the hint is generic —
"Correct the named operation and validate the change set again." The message names the
function but the diagnostic does not say which definitionId it lives in. With one
definition per draft that is fine; in a multi-definition change set the reader would
have to grep their own payload for the function name. Compare the NUI codes, which carry
the node's semanticId.

## A formula over a published ceiling

201-term expression `1+1+...+1`:

    {"code":"NPROP002","message":"This formula has more than the 128 parts a formula may contain."}

Names the number (128 = the `astNodes`/`syntaxItems` limit in the vocabulary),
recoverable.

## The per-call operation ceiling

17 operations in one amend call (limit `operationsPerCall` = 16):

    NENDO_CHANGE_SET_LIMIT: One call carries 1-16 operations in total; this one carries 17.

Enforced at call time, names the limit and the actual count. This is the model for what
a limit refusal should read like — and note it is a *different, informative* error code,
not the anonymous NENDO_INVALID_REQUEST that the malformed-binding path returns.

## Removing a definition something still reads

`behaviour.removeDefinition fn.seedsPerGram` while `lot.seedsPerGram` still calls it:

    {"code":"NPROP010",
     "message":"'fn.seedsPerGram' is still used by lot.seedsPerGram. Change or remove
                those first, in this same review."}

Names the definition being removed, names the dependent that blocks it, and states the
remedy including where it must happen ("in this same review" = the same change set). The
best-formed of all the refusals for pointing at the exact obstacle.

## Summary of refusal quality

| what was refused | code | named the problem | named the thing | remedy | recoverable |
|---|---|---|---|---|---|
| sort by calc field | NUI214 | yes | field + path | yes | yes |
| filter by calc field | NUI214 | yes | field + path | yes | yes |
| group by calc field | NUI214 | yes | field + path | yes | yes |
| total calc field | NUI214 | yes | field + path | yes | yes |
| form of only calc fields | NUI215 | yes | node | yes | yes |
| visibleWhen wrong name | NUI330 | yes | node + path | yes | yes |
| unlisted / clock / net function | NPROP002 | yes | function name only | generic | yes |
| formula over 128 parts | NPROP002 | yes | the number | generic | yes |
| remove referenced definition | NPROP010 | yes | both ends | yes | yes |
| >16 ops per call | NENDO_CHANGE_SET_LIMIT | yes | limit + count | implicit | n/a |
| sql.execute operation | NENDO_INVALID_REQUEST | NO | no | no | (rejected) |
| host.runCommand operation | NENDO_INVALID_REQUEST | NO | no | no | (rejected) |
| malformed Sum binding | NENDO_INVALID_REQUEST | NO | no | no | NO (freezes) |
