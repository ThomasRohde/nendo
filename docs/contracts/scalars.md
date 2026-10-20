# Scalar fidelity contract

How exact values survive storage, the Workbench bridge and the MCP wire, within the
scalar and closed-storage boundaries of ADR-0003. It adds no provider, script
capability or user JSON type.

Calculations ([calculations-and-actions.md](calculations-and-actions.md)) keep the
same fidelity: checked Int64 and .NET decimal, decimal-domain division before any
conversion, invariant DateOnly, and value, null and error kept distinct as results.
A formula is not a scalar: no formula DTO crosses this boundary.

- **Text** preserves Unicode, whitespace, embedded newlines and the distinction
  between null and empty text. The form offers an explicit Not set control for
  optional text. Untouched fields are not rewritten.
- **Integer** is signed 64-bit. **Decimal** is the .NET decimal domain (96-bit
  unsigned coefficient, sign, scale 0–28). Numeric values never pass through a
  JavaScript number in the Workbench's edit or transport path.
- A presentation never narrows the domain of a stored scalar. A `rating` Integer's
  `min` and `max` bound how the value is drawn, not what may be written: a value
  outside the scale is stored, read back exactly, and reported as a data warning,
  never refused or clamped, because a scale may be declared over existing values.
- **The Workbench bridge** represents numbers inside `JsonElement` scalar payloads as
  `{ "$nendoNumber": "<JSON numeric lexeme>" }` (`WorkbenchScalarJsonConverter`), a
  transport envelope decoded before the typed application service sees the value
  and never persisted as a user object. Metadata counts and record versions keep
  their typed integer representation. The host serves bridge protocol 7 only
  (`DesktopShellContract.BridgeProtocolVersion`): a request at any other version is
  refused as `unsupported-protocol` before anything runs.
- **MCP** returns the scalar `values` projection plus `numericLexemes`, a field-ID map
  of exact numeric strings for clients with binary-only numeric parsers. Such clients
  send `{ "$nendoNumber": "..." }` for numeric values in create/edit or authoring
  payloads; the local adapter decodes the closed envelope before canonical
  validation. Plain exact JSON numbers are also accepted. Arrays and arbitrary
  objects are invalid scalar values. Malformed envelopes, overflow and rounding are
  rejected.
- Both adapters compile the same transport decoder from
  `src/Shared/NumericEnvelopeJson.cs`. Desktop retains its outgoing encoding;
  MCP translates malformed envelopes to its validation error. The Engine does
  not reference transport envelopes.
- **Decimal storage** uses a textual `nendo.decimal:` prefix inside the ordinary
  relational NUMERIC column, so SQLite affinity cannot round the coefficient to
  binary floating point. Only the storage adapter encodes and decodes the prefix.
  Direct recovery inspection can read the coefficient after the prefix. SQL numeric
  casts are not an exact query interface; typed decimal sorting compares decimal
  values.
- Authoring or writing a decimal field raises the file's minimum host to 1.3.0 in the
  same transaction as the canonical operation, including proposal replay and
  compensation. An ordinary open does no rewrite or migration. A NUMERIC value
  without the prefix is read as the stored value; the host never reconstructs lost
  precision from history.
- **Boolean** is true, false, or null when optional. **Date** is a valid
  `yyyy-MM-dd`. **Datetime** requires an ISO timestamp with explicit UTC or offset,
  seconds and up to seven fractional digits. **UUID** requires the hyphenated D form,
  in either case; it is stored as written and compared without regard to case, so
  the two cases of one UUID are one value to a filter and a sort. Reference integrity
  and stable choices come from the [relationships contract](relationships.md), not
  from string inspection.

Required evidence: min/max Int64 and decimal coefficients, scale 28, fractional
values beyond binary precision, null/empty, Unicode/newlines, no-op and unrelated
saves, invalid values that roll back atomically, exact reopen and compensation,
unprefixed numeric reads without modification, and old-host refusal.
`ScalarFidelityTests`, `ScalarProtocolTests`, `WorkbenchScalarJsonTests` and
`BehaviourScalarTests` test the implementation; this list is not mapped item by item
to test cases.
