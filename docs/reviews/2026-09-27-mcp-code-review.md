# MCP code review — 27 September 2026

A code review of `src/Nendo.LocalMcp` (36 files), its test project, the
[MCP interface contract](../contracts/mcp-interface.md) and
[ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md),
read against the 2026-07-28 specification, the C# SDK 2.2.0 and the MCP
Inspector's schema lint, and probed on the wire against the installed host
(`nendo-local` 0.16.0 at `http://127.0.0.1:41763/mcp`, the Nendo Development
planner open at Unattended). The two earlier MCP reviews
([12 September](2026-09-12-local-mcp-review.md),
[14 September](2026-09-14-installed-host-mcp-review.md)) were read first so that
nothing already closed is reopened. Claude Code did this review.

One class of finding was fixed in the same sitting (W-087). The rest is
registered in the planner as five Now work items, W-082 to W-086, each with its
findings and an acceptance check. The findings below are the record; the planner
carries the next action.

## What was measured

| Measurement | Result |
| --- | --- |
| Compiler warnings, `Nendo.LocalMcp` and its tests | 0 (`TreatWarningsAsErrors` is on for the tree) |
| Analyzer warnings at `AnalysisLevel=latest-all`, project only | Noise for an application (2,662 CA2007 across the build); the items worth reading are named in W-086 |
| MCP Inspector lint, 20 tools, input and output schemas | 77 `type-union` warnings before; 0 after W-087. No `boolean-schema`, `untyped-schema` or `remote-ref` finding either way |
| Claude Code's cut on server instructions and tool descriptions | 2,048 characters, measured from where the client's display stops: instructions 2,755 characters, `nendo.change_set.add_operations` 2,179, `nendo.data.import_records` 2,056 |
| `server/discover` | 200, `supportedVersions` `["2026-07-28"]`, `resultType` `complete`, `_meta` carries `serverInfo`, `ttlMs` 0 and `cacheScope` `private` on every list and read |
| GET, DELETE, OPTIONS on `/mcp` | 405 with `Allow: POST` |
| `Mcp-Name` not matching the body | 400, JSON-RPC `-32020` HeaderMismatch |
| `Host: localhost:41763` | 400 `NENDO_INVALID_HOST` |
| 17-deep body, 300 KiB body, non-JSON body | 400 `NENDO_INVALID_JSON`, 413 naming 262,144 bytes, 400 `NENDO_INVALID_JSON` |
| Deepest request the published examples need | 14 levels (payload depth 7 inside `params/arguments/mutations[]/operations[]/payload`) against a cap of 16 |
| Unknown tool | `isError` result `NENDO_TOOL_UNAVAILABLE`, not a `-32602` protocol error |
| Missing required argument (`idempotencyKey` off `nendo.data.set_field`) | `An error occurred invoking 'nendo.data.set_field'.` and nothing else |
| Unknown nested key (`records[].expectedTargetVersionz`) | Bound silently; the call proceeded to `NENDO_ENTITY_NOT_FOUND` |
| Empty cursor; `limit` before `cursor` | `NENDO_INVALID_CURSOR`; `Unknown resource URI` |
| Titles on tools and resources; descriptions on output properties | 0 of 20; 0 of 17; 0 in total |

The probe scripts and their outputs are task-owned scratch under
`artifacts/mcp-review/` and are not a record; the numbers above are.

## Fixed in this change — W-087

The owner's Inspector screenshot showed `nendo.change_set.accept` with two
*Schema portability* warnings. Every nullable member of every tool was the same
case: the exporter writes `"type": ["integer", "null"]`, and the Inspector's
`type-union` rule warns that a client mapping tool schemas onto a single-type
dialect drops the constraint or refuses the tool.

`NendoJsonInputs.OneTypePerNode` now splits every type array into one `anyOf`
branch per type, through the same schema-transform hook that already advertised
the two argument shapes; the keywords that belong to a type move into its branch,
and the description and default stay on the node. The field-value shape on
`nendo.data.set_field` was rewritten with single-type branches.

The guard, `InputSchemaContractTests.EveryAdvertisedSchemaPassesTheInspectorLint`,
ports the Inspector's four rules and runs them over every input and output schema
of all twenty tools, then checks that the null branches survived. With the split
withheld it failed:

```text
Assert.IsEmpty failed. Expected collection of size 0. Actual: 76. 'collection' expression: 'findings'. The Inspector would report:
nendo.change_set.accept:outputSchema/properties/message: type-union (warning): type is the array ["string","null"].
nendo.change_set.accept:outputSchema/properties/definitionRevision: type-union (warning): type is the array ["integer","null"].
nendo.change_set.begin:outputSchema/properties/advisory: type-union (warning): type is the array ["string","null"].
```

Seventy-six rather than seventy-seven, because the field-value shape is a separate
rewrite. `OutputSchemaContractTests` now follows each payload into the matching
branch, so a nullable object such as a receipt is still checked for its required
members. The contract and the blackbox prompt (Phase 1 now lints the tool list the
way the reference tool does) were updated in the same change.

## Findings registered for work

### W-082 — MCP instructions and tool descriptions fit under the 2,048-character cut

- **F-170.** Claude Code shows instructions and descriptions up to 2,048
  characters and drops the rest. The instructions lose the sentences on no SQL,
  file, process or network access, on acceptance being the person's below
  Unattended and on `nendo.change_set.accept` at Unattended;
  `add_operations` loses its amend remedy; `import_records` loses its retry
  sentence. The host cannot see the cut, so the bound has to be held on the
  server and measured by a test.

### W-083 — Every MCP refusal names the argument, the access level or the remedy

- **F-171.** A missing required argument is refused with no sentence and no code:
  the SDK binder fails before Nendo sees the call.
- **F-172.** Unknown nested keys are dropped silently (`System.Text.Json` ignores
  unmapped members), and an unknown top-level key is refused without its name or
  the accepted names. A misspelt `expectedTargetVersions` is the case that
  matters.
- **F-173.** A tool that exists only at a higher access level is refused by the
  SDK as unknown, so the three level codes Help documents cannot occur.
- **F-174.** An unknown tool is an execution error where the specification
  names a `-32602` protocol error.
- **F-175.** `NENDO_INVALID_HOST`, `NENDO_INVALID_JSON` and `NENDO_LEASE_HELD`
  name no remedy.

### W-084 — Titles, output descriptions and honest hints

- **F-176.** No titles on tools or resources, no descriptions on output
  properties, no `title` or `websiteUrl` on `serverInfo`, `Server: Kestrel` on
  every response, no lease lifetime in `acquire`'s description, and nullable
  list parameters advertising nullable items.
- **F-177.** `set_field`, `execute_command` and `move_record` advertise
  `destructiveHint` false while overwriting stored values.
- **F-178.** An empty cursor and the other query-parameter order are refused;
  the static vocabulary and examples resources carry `ttlMs` 0.

### W-085 — One activity entry per call, imports attributed, internal errors traced

- **F-179.** Every successful tool call writes two activity entries, so the
  Agent page's twenty entries hold ten calls.
- **F-180.** Import revisions carry the origin `agent` instead of the session
  pseudonym every other agent write carries.
- **F-181.** `builder.Logging.ClearProviders()` discards every SDK and Kestrel
  log, and `NENDO_INTERNAL_ERROR` names only the exception type: an internal
  failure leaves no trace.

### W-086 — Harden the host

- **F-182.** The 16-level JSON depth cap leaves two levels over the deepest
  published example, and the refusal does not name the cap. The same item
  carries the unbounded replay caches, the unguarded `ProposalAdded` handler,
  the absence of an in-flight bound, and the analyzer items worth keeping.

## What was read and found sound

So the next reviewer does not spend the same hours:

- **Transport and perimeter.** Loopback-only Kestrel, HTTP/1, exact Host and
  Origin matching against the bound port, 256 KiB body and 16-level depth before
  dispatch, closed admission checked again after the body has arrived, a
  per-run cursor key, and a discovery entry under a user DACL that carries no
  path. The 2026-07-28 header rules, `resultType`, `_meta.serverInfo`, cache
  hints and 405 on GET and DELETE all come from the SDK and were seen on the
  wire.
- **Authority.** One gate serializes acquire, renew, release, revoke and every
  admitted write; the lease is bound to handle, lease ID, host run and file
  identity; the gate-free peek exists for the window; the lease-ended handler
  discards drafts under the same lock order everywhere, so revoke cannot
  deadlock against a write.
- **Idempotency.** Exact replays are digest-checked on every authoring step; a
  validate that ends without a verdict reopens the draft; an import derives a
  bounded batch key and stable record IDs from the caller's key and replays
  committed batches with the target versions their own revision recorded.
- **Error translation.** Engine messages pass through only from an audited
  list of codes whose templates carry stable IDs and integers; `aggregate-not-exact`
  stays withheld because it echoes a stored value; a pending proposal is named
  when it explains a refusal.
- **Structured results.** Every tool advertises an output schema, serializes
  nulls so the schema's `required` holds, and the contract test calls every tool
  and checks the payload against the schema it advertises.
- **Unattended.** The one tool that exists only there is registered in its own
  block, consent is a host-supplied delegate with no arguments, and every level
  below refuses exactly as before.

## Not checked

- The Inspector's web client itself was not run against the rebuilt host; the
  ported lint is the measurement. The Phase 1 prompt now asks the next outside
  review to run the real one.
- The `Nendo.Desktop` Agent page was not driven; the double-entry finding is
  read from the code and from the unfiltered `GetActivities(20)` it renders.
- Codex and Claude Code installed-client lanes were not run (opt-in).
- No performance measurement was taken; the 8-concurrent-describe figure from
  14 September stands.
