# Scalar fidelity contract

This contract states how exact values survive storage, the Workbench bridge and
the MCP wire.

It is an implementation contract within the scalar and closed-storage boundaries
of ADR-0003. It does not add a provider, a script capability or a user JSON type.

ADR-0008 is delivered, and these fidelity requirements extend to its
calculations:

- checked Int64 and .NET decimal;
- decimal-domain division before any conversion;
- invariant DateOnly;
- value, null and error kept distinct as results.

The [design notes](../design/adr-0008-semantics.md) behind these requirements
are history. [calculations-and-actions.md](calculations-and-actions.md) is the
contract. Scalar storage and transport are as specified below. A formula is not
a scalar: no formula DTO crosses this boundary.

- Text preserves Unicode, whitespace, embedded newlines and the distinction
  between null and empty text. The form offers an explicit Not set control for
  optional text. Untouched fields are not rewritten.
- Integer is signed 64-bit. Decimal is the .NET decimal domain (96-bit unsigned
  coefficient, sign, scale 0–28). Numeric values must never pass through a
  JavaScript number in the edit path or the transport path of the Workbench.
- A presentation never narrows the domain of a stored scalar. A `rating` Integer
  carries a `min` and a `max`. These bound how the value is drawn. They do not
  bound what may be written. A value outside the scale is stored, read back
  exactly, and reported as a data warning. It is not refused or clamped, because
  a scale may be declared over values that already exist.
- Workbench bridge revision 6 represents numbers inside `JsonElement` scalar
  payloads as `{ "$nendoNumber": "<JSON numeric lexeme>" }`. This is a transport
  envelope. It is decoded before the typed application service sees the
  value. It does not persist as a user object. Metadata counts and record
  versions keep their existing typed integer representation. Revisions 2–5 keep
  their legacy output. Revision 5 keeps generation-bound requests and durable
  outcomes.
- MCP keeps the existing scalar `values` projection and adds `numericLexemes`.
  This is a field-ID map of exact numeric strings. Clients with binary-only
  numeric parsers use that map. They send `{ "$nendoNumber": "..." }` for
  numeric values in create/edit payloads or authoring payloads. The local
  adapter decodes the closed envelope before canonical validation. Arrays and
  arbitrary objects remain invalid scalar values. Malformed envelopes, overflow
  and rounding are rejected. Existing exact JSON-number clients remain
  compatible. SDK protocol tests cover the additive projection and exact
  create/edit. Installed-client qualification remains separate.
- Decimal writes use a textual `nendo.decimal:` prefix inside the existing
  ordinary relational NUMERIC column. The nonnumeric prefix prevents SQLite
  affinity from rounding decimal coefficients to binary floating point. Only the
  storage adapter encodes and decodes the prefix. Direct recovery inspection can
  read the coefficient after the documented prefix. SQL numeric casts are not an
  exact query interface. Typed decimal sorting must compare decimal values.
- Authoring a decimal field or writing a decimal field raises the minimum host
  of the file to 1.3.0. This happens in the same transaction as the canonical
  operation. This requirement also applies to proposal replay
  and compensation. Old hosts must refuse writable open. An ordinary open does
  no rewrite or migration. Legacy NUMERIC values remain readable as the actual
  stored values. If an old file already lost precision, the host does not guess
  or reconstruct the value from history.
- Boolean is true, false, or null when optional. Date is a valid `yyyy-MM-dd`.
  Datetime requires an ISO timestamp with explicit UTC or offset, seconds and
  up to seven fractional digits. UUID requires the hyphenated D form. Reference
  integrity and stable choices come from the [relationships
  contract](relationships.md). They do not come from string inspection.

Required evidence:

- min/max Int64 and decimal coefficients;
- scale 28;
- fractional values beyond binary precision;
- null/empty;
- Unicode/newlines;
- no-op saves and unrelated saves;
- invalid values that roll back atomically;
- exact reopen and compensation;
- legacy numeric read without modification;
- old-host compatibility refusal.

The implementation exists. `ScalarFidelityTests`, `ScalarProtocolTests`,
`WorkbenchScalarJsonTests` and `BehaviourScalarTests` test it. This file does not
map each item above to a test case, so it does not claim that every item has a
test.
