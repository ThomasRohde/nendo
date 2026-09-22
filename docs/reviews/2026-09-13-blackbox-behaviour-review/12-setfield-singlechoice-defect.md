# Defect: data.set_field cannot set a singleChoice field

## The three write paths disagree about the same field

For a singleChoice field, the option label is a valid value on every write path EXCEPT
set_field:

| path | field | value sent | result |
|---|---|---|---|
| create_record / create_records | varietyAlert, varietySpecies, lotStatus | "Clear","Tomato","Stored",... | accepted, reads back as the label |
| execute_command commandStep literal | lotStatus | "Withdrawn" | accepted (lotSL0004 read back "Withdrawn") |
| set_field | varietySpecies | "Bean" (a listed option) | NENDO_INVALID_REQUEST |
| set_field | varietyAlert | "Check stock" (a listed option) | NENDO_INVALID_REQUEST |

## Controls that localize it precisely

Same record (varBrandywine), same tool (set_field), same session, after consent so the
file is unlocked:

- set_field varietyDaysToMaturity = 90  (Integer)     -> SUCCESS, v1 -> v2
- set_field varietySpecies = "Bean"     (singleChoice) -> NENDO_INVALID_REQUEST
- set_field varietyAlert = "Check stock"(singleChoice) -> NENDO_INVALID_REQUEST

So it is not the record, not the lease, not the lock (checkout create succeeded in the
same window), not the version (integer write at the same version succeeded). The single
differentiator is that the field is singleChoice.

The schema shows these fields as `"options":["Clear","Check stock"]`, `"choices":[]` —
the options are the values, and create/command accept them. No alternative
representation (a choiceId, an object form) is published anywhere on the wire, and
`choices` is empty, so there is nothing else to send. The error is the anonymous
NENDO_INVALID_REQUEST, naming neither the field nor the reason.

## Why it matters

Changing a status/choice field on an existing record is one of the most common edits in
any database app ("mark this lot Withdrawn", "set this variety's alert"). Over MCP,
set_field is the only general per-field write. This defect means an agent cannot make
that edit at all unless a recordCommand happens to exist for that exact transition. It
is a large hole directly under the most ordinary operation.

## Reproduction

On any singleChoice field of any record: `set_field entity/record/choiceField = "<a
listed option>"` at the correct version, file unlocked. Returns NENDO_INVALID_REQUEST.
The identical call on a non-choice field of the same record at the same version succeeds.
