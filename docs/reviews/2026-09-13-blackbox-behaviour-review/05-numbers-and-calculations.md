# Measured: exact numerics and calculation results

All values below are `numericLexeme` / `calculations[]` fields read back from
`nendo://application/entity/lot/records`, not what I sent.

## Integers past the double barrier

| record | sent | numericLexeme read back | note |
|---|---|---|---|
| lotSL0001 | 9007199254740993 | `9007199254740993` | 2^53+1. A JSON double would give ...992. |
| lotSL0002 | 9223372036854775807 | `9223372036854775807` | int64 max, exact. |

## Decimals where trailing zeros carry meaning

Sent and read back identically, every time: `3.2000`, `1000.00`, `88.50`, `2.500`,
`12.750`, `8.0000`, `7.0000`, `3.5000`, `55.00`, `0.3125`, `0.0000`, `2.00`.
Scale is preserved, not normalised away.

## Division, which is the interesting case

`fn.seedsPerGram(x) = RoundEven(1000 / x, 4)`, then
`estimatedSeeds = RoundAway(grams * seedsPerGram, 0)` — a calculation reading another.

| lot | gramsPerThousand | seedsPerGram | grams | estimatedSeeds | check |
|---|---|---|---|---|---|
| SL-0001 | 3.2000 | 312.5 | 1000.00 | 312500 | exact |
| SL-0002 | 2.500 | 400 | 12.750 | 5100 | exact |
| SL-0003 | 0.3125 | 3200 | 8.0000 | 25600 | exact |
| SL-0004 | 7.0000 | 142.8571 | 3.5000 | 500 | 1000/7 is non-terminating; RoundEven to 4dp gives 142.8571, and RoundAway(499.99985, 0) = 500 |

SL-0004 is the one that matters: the host did not silently carry a binary-float
142.85714285714286 into the second calculation. It rounded at the declared point and the
dependent calculation consumed the rounded value.

## Aggregates

| variety | lots | lotCount (Count) | quarantinedLots (FilteredCount) | cleanLots (total - flagged) |
|---|---|---|---|---|
| Brandywine | SL-0001, SL-0003 | 2 | 0 | 2 |
| Scarlet Runner | SL-0002 (quarantined) | 1 | 1 | 0 |
| Table Queen | SL-0004, SL-0005 | 2 | 0 | 2 |
| Red Orach | none | 0 | 0 | 0 |

Red Orach confirms the published empty-collection rule on real data: "An empty
collection counts zero. Zero is an answer, not a missing one." It reads 0, not null.

## Divide by zero, over the wire

lotSL0005 has `lotGramsPerThousand = 0.0000`. The record was accepted — a calculation
that cannot produce a value does not block the write, which is right: the stored data is
valid, the derived value is not computable.

    {"calculationId":"lot.seedsPerGram","fieldId":"seedsPerGram","state":"error",
     "value":null,"errorCode":"calculation-divide-by-zero",
     "errorMessage":"This calculation divides by zero.","numericLexeme":null}

    {"calculationId":"lot.estimatedSeeds","fieldId":"estimatedSeeds","state":"error",
     "value":null,"errorCode":"calculation-dependency-failed",
     "errorMessage":"This depends on lot.seedsPerGram, which could not be calculated.",
     "numericLexeme":null}

Three things done well here. `state` is a first-class field, so a reader never has to
infer failure from a null. The dependent calculation names its upstream cause rather
than repeating "divide by zero", so a reader knows which definition to go fix. And the
other three calculations on the same record still produced values — one broken
calculation does not poison its siblings.

## A trap in the same payload

`values` carries the lossy form and `numericLexemes` the lossless one, side by side:

    "values":{"lotSeedCount":9223372036854775807, "lotGramsPerThousand":0.0000, ...}
    "numericLexemes":{"lotSeedCount":"9223372036854775807", ...}

`values` is the obvious-looking field and the one a client reaches for first. Any client
that runs this through a standard JSON parser with double-backed numbers silently gets
9223372036854775808 and loses the trailing zeros, with nothing to indicate it happened.
The server instructions do say to use numericLexemes; the payload itself gives equal
visual weight to the field that will quietly corrupt your data.
