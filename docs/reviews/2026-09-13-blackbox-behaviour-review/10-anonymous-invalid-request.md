# Measured: the anonymous NENDO_INVALID_REQUEST failure class

Four distinct causes, one indistinguishable message. Every one of these returned
exactly `NENDO_INVALID_REQUEST: The request arguments are invalid.` with no diagnostic,
no field name, no operation name:

1. A malformed RelatedAggregate Sum binding (evidence/02). Froze the draft.
2. `sql.execute` as an operationType (evidence/06 summary). Rejected at add_operations.
3. `host.runCommand` as an operationType. Rejected at add_operations.
4. `data.create_record` on lot omitting the required `lotSeedCount`.

## The required-field case, isolated

Refused (missing lotSeedCount, all other required fields present):

    create_record lot {lotCode, lotGramsPerThousand, lotGrams, lotGermination, lotQuarantined}
    -> NENDO_INVALID_REQUEST: The request arguments are invalid.

Positive control, identical but for the one field, succeeded:

    create_record lot {..., lotSeedCount: 820}  -> recordVersion 1, committed as lotSL0006

So the omission of one required field is the entire cause, and the message names neither
the field nor even the category of problem. A person authoring by hand would be told
"the request arguments are invalid" and left to diff their own payload against an
11-field schema.

## The pattern

Nendo has two error qualities that fall along a clean line:

- The **semantic compiler** layer (UI nodes, formula bodies, definition dependencies)
  returns rich diagnostics: a stable code (NUI214, NUI215, NUI330, NPROP002, NPROP010),
  the offending semanticId and propertyPath where applicable, and an actionable hint.
- The **argument / envelope** layer (operation type recognition, payload structure,
  required-field presence on a data write) returns one anonymous NENDO_INVALID_REQUEST
  for every cause, with nothing to localize it.

The line is visible because the same conceptual error lands on different sides of it. A
formula that names a missing function is diagnosed (NPROP002 names the function); a
binding whose structure the deserializer cannot bind is not (anonymous, and it freezes).
A UI node bound to a missing field is diagnosed (NUI330); a data record missing a field
is not. The rich layer is very good. The anonymous layer is where every expensive
surprise in this review lived.
