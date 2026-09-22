# Scalar fidelity contract

How exact values survive storage, the Workbench bridge and the MCP wire.

Implementation contract within ADR-0003's scalar and closed-storage boundaries.
This does not add a provider, script capability or user JSON type.

ADR-0008 is delivered, and these fidelity requirements extend to its
calculations: checked Int64 and .NET decimal, decimal-domain division before any
conversion, invariant DateOnly, and value, null and error kept distinct as
results. The [design notes](../design/adr-0008-semantics.md) behind that are
history and [calculations-and-actions.md](calculations-and-actions.md) is the
contract. Scalar storage and transport are as specified below, and a formula is
not a scalar: no formula DTO crosses this boundary.

- Text preserves Unicode, whitespace, embedded newlines and the distinction
  between null and empty text. The form offers an explicit Not set control for
  optional text; untouched fields are not rewritten.
- Integer is signed 64-bit. Decimal is the .NET decimal domain (96-bit unsigned
  coefficient, sign, scale 0–28). Numeric values must never pass through a
  JavaScript number in the Workbench's edit or transport path.
- A presentation never narrows a stored scalar's domain. A `rating` Integer carries a
  `min` and `max` that bound how it is drawn, not what may be written: a value outside
  the scale is stored, read back exactly, and reported as a data warning rather than
  refused or clamped, because a scale may be declared over values that already exist.
- Workbench bridge revision 6 represents numbers inside `JsonElement` scalar
  payloads as `{ "$nendoNumber": "<JSON numeric lexeme>" }`. This is a transport
  envelope, decoded before the typed application service sees the value. It
  does not persist as a user object. Metadata counts and record versions retain
  their existing typed integer representation. Revisions 2–5 keep their legacy
  output; revision 5 retains generation-bound requests and durable outcomes.
- MCP keeps the existing scalar `values` projection and adds `numericLexemes`,
  a field-ID map of exact numeric strings. Clients with binary-only numeric
  parsers use that map and send `{ "$nendoNumber": "..." }` for numeric values
  in create/edit or authoring payloads. The local adapter decodes the closed
  envelope before canonical validation. Arrays and arbitrary objects remain
  invalid scalar values; malformed envelopes, overflow and rounding are rejected.
  Existing exact JSON-number clients remain compatible. SDK protocol tests cover
  the additive projection and exact create/edit; installed-client qualification
  remains separate.
- Decimal writes use a textual `nendo.decimal:` prefix inside the existing
  ordinary relational NUMERIC column. The nonnumeric prefix prevents SQLite
  affinity from rounding decimal coefficients to binary floating point. The
  storage adapter alone encodes/decodes it. Direct recovery inspection can read
  the coefficient after the documented prefix; SQL numeric casts are not an
  exact query interface. Typed decimal sorting must compare decimal values.
- Authoring a decimal field or writing a decimal field raises the file's
  minimum host to 1.3.0 in the same transaction as its canonical operation.
  This requirement also applies to proposal replay and compensation. Old hosts
  must refuse writable open. An ordinary open performs no rewrite or migration.
  Legacy NUMERIC values remain readable as the actual stored values; precision
  already lost in an old file is not guessed or reconstructed from history.
- Boolean is true, false or null when optional. Date is a valid `yyyy-MM-dd`.
  Datetime requires an ISO timestamp with explicit UTC or offset, seconds and
  up to seven fractional digits. UUID requires the hyphenated D form. Reference
  integrity and stable choices come from the [relationships
  contract](relationships.md), not from string inspection.

Required evidence: min/max Int64 and decimal coefficients, scale 28, fractional
values beyond binary precision, null/empty, Unicode/newlines, no-op and unrelated
saves, invalid values rolling back atomically, exact reopen and compensation,
legacy numeric read without modification, and old-host compatibility refusal.
This file specifies implementation obligations; it does not claim they passed.
