# MCP interface contract

The fourteen resources and nineteen tools an external agent sees, and the
authority rules behind them. Both surfaces are asserted by name in
`Test-Production.ps1`.

Two of those tools arrived with the [ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)
amendment of 2026-09-22. `nendo.data.import_records` is served from *Data mutation*;
`nendo.change_set.accept` is served only at **Unattended**, the fifth access level, and
at every level below it is not registered at all — a client that sends it by name is
refused by the SDK as an unknown tool, and the service's own mode check is the second
lock behind that.

ADR-0008 is delivered as bounded behaviour architecture, not as new MCP authoring
tools: a definition is installed by the `behaviour.setDefinition` operation inside
a change set the tools below already carry, so the tool list is unchanged by it.
The [acceptance experiment](../design/adr-0008-evidence.md) stays outside this
interface and is history. Typed definitions, their capabilities and their costs are
published through the shared catalogue in `nendo://application/vocabulary` and
reviewed as part of a proposal; MCP never grants local approval and never bypasses
trigger expansion.

All requests enter loopback stateless Streamable HTTP with no credential. Both
MCP eras are served: the `initialize` handshake on any version the SDK supports,
and the 2026-07-28 `server/discover` path with per-request metadata, where the
SDK handles MCP-Protocol-Version/Mcp-Method/Mcp-Name headers and complete result
envelopes. The discovery document names the discover-path headers and the three
`io.modelcontextprotocol/*` `params._meta` keys so a hand-written client does not
learn them by iterating on errors. It also carries `displayName`, the
open file's name: the advertisement previously identified the endpoint, the
process and the application but not which file was behind them, so with two Nendo
windows open "which file do you want?" could only be answered by cross-referencing
the write-owner sidecar's process ID. It is a label and not a location — no
directory, and nothing an agent could open. Agents never receive a database path
([vision.md](../vision.md)), and a caller that hands in one has it reduced to its
last segment. File resources and catalogs carry
private, zero-TTL cache hints; tools are listed in stable name order.

Every tool result is serialized with nulls present. The output schema generated
from a return type lists nullable members as required, so a payload that dropped
one failed validation in any client that checks the schema the tool advertises —
`nendo.lease.acquire` and `nendo.change_set.validate` both did.
[Output schema contract tests](../../tests/Nendo.LocalMcp.Tests/OutputSchemaContractTests.cs)
call every declared tool and check its payload against its own declared schema.

Host/Origin/address/body checks precede dispatch. Lease acquisition mints an
opaque `applicationHandle` as well as `leaseId`; supply both on every owned
operation, including renew/release and proposal preview. Handle possession
governs ownership, not claimed client names or HTTP connection identity. Keep the
handle private. By default the lease ends on
explicit release, user revocation or host stop. An owner can enable a bounded
expiry in Agent → Connection; closing an agent alone does not end either mode.
Closing, switching, replacing or recovering the file invalidates the endpoint
and authority; healthy renderer-only restart preserves them. Receipt lookup
requires no live handle and cannot restore editing authority. No adapter gets
SQL, SQLite handles, physical mappings or arbitrary host invocation.

| Resource | Current adapter and shared application service | Projection / outstanding cost |
| --- | --- | --- |
| `nendo://application/describe` | `GetDescriptionAsync` → the projections below | What the file is for, then the manifest, authoring limits, every record type with its fields, every compiled screen, health, and `reads` — every resource URI this host serves, generated from the declared resources. Answers the reconnaissance phase without 1 + N round trips. `resources/list` returns only the parameterless resources, so the read path for records was reachable only through `resources/templates/list`; a review concluded from the seven listed entries that the data API was write-only, and opened the SQLite file directly to check its own writes. |
| `nendo://application/examples` | `NendoAuthoringExamples.Description` | Eleven complete contract version 3 change sets that can be sent as they stand — `create-entity-with-required-fields`, `configure-a-reference`, `a-breakdown-and-a-ring`, `build-a-detail-surface`, `define-a-command`, `two-commands-and-a-filtered-list`, `several-views-tabs-and-a-calendar`, `a-timeline-of-spans`, `a-gallery-and-a-rating`, `a-front-page-for-the-file`, `calculate-and-act-automatically` — each carrying the authoring rule it conveys. Static for a host build. Every example is replayed through the real authoring boundary by [the example tests](../../tests/Nendo.LocalMcp.Tests/AuthoringExampleTests.cs), so one that stops validating fails the build. |
| `nendo://application/manifest` | `NendoResourceProjection.GetManifestAsync` → `GetDefinitionSnapshotAsync` | What the file is for, plus identity and revision counters, without record/history reads. |
| `nendo://application/vocabulary` | `NendoSemanticVocabulary.Description` + `NendoAuthoringOperations.All` | Every contract version 3 node kind with its permitted properties, required properties, permitted children and its root ceiling — `maxRootsPerEntity`, or `maxRootsPerFile` for a root that belongs to the file rather than to a record type; the closed filter operators, value kinds, ordering directions and aggregates; the `and` combinator that joins sibling `filterClause` children, and the note that version 3 has no OR and no grouping; the closed `choiceTones` a choice option may carry; the `charts` rule with its closed groupings and its ceiling on groups; the `overview` rule with the one front page a file may own and the ceiling on a recent list; the authoring limits; and `operations` — every canonical operation with the payload fields it requires and accepts. Generated from the tables the compiler and the authoring boundary validate against: `NendoAgentAuthoringService` builds its accepted field sets from the published table, so a documented field is an accepted field. Static for a host build; it describes the host, not the open file. |
| `nendo://application/entities` | `GetEntitiesAsync` → `GetDefinitionSnapshotAsync` | Stable entity IDs and display labels; no record projection. |
| `nendo://host/instances` | `NendoDiscoveryStore.ReadLiveEntries` | Every Nendo running on this device and which file each has open, with `isThisOne` marking the host answering the read. The only resource here that is not about the open file. The host has written this directory since discovery existed and nothing read it, so an agent could not tell a person which file it was about to write to, and a second Nendo was unreachable in practice (F-064). An entry is admitted on exactly the terms the stale sweep uses to keep one, so a dead host is never offered as a place to work. Each entry carries the file's name and never a path. It does not make another endpoint reachable: a client reaches the address it was registered with and cannot redirect itself, so switching stays the person's action and the resource says so in its own `note`. |
| `nendo://application/entity/{entityId}/schema` | `GetSchemaAsync` → `GetDefinitionSnapshotAsync` | Semantic fields, storage kinds, required/presentation/options, and a rating field's `scale` with its `min` and `max`. |
| `nendo://application/entity/{entityId}/records{?cursor,limit}` | `GetRecordsAsync` → `QueryRecordsAsync` | Storage keyset page in stable record-ID order; revision-bound continuation. |
| `nendo://application/surfaces` | `GetSurfacesAsync` → `CompileSemanticDefinitionAsync` | Cached verified definition, with no records. Surface roots appear under `applications[].surfaces` as an ordered node tree with `nodeId`, `kind`, `properties`, `children` and, on a command root, the `commandId` that `nendo.data.execute_command` takes. The removed contract version 1 and 2 `form`/`list`/`board`/`command` slots are gone from this resource as of 2026-09-12. `state` is `valid`, `invalid` or `noCustomSurfaces`. A stored `surfaceId` is deliberately absent: it is not part of the compiled plan, and the plan is what the definition digest is taken over. |
| `nendo://application/history{?cursor,limit}` | `GetHistoryAsync` → `QueryHistoryAsync` | Bounded revision summaries in ascending sequence order; `operationCount` and `operationsUri` replace the unbounded nested `operations` array. |
| `nendo://application/revision/{revisionId}/operations{?cursor,limit}` | `GetRevisionOperationsAsync` → `QueryRevisionOperationsAsync` | Bounded sanitized operation descriptors in ordinal order. No canonical payload, raw inverse or physical mapping escapes. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | `GetCsvExportAsync` → `ExportCsvPageAsync` → `QueryRecordsAsync` | One page of the record type as faithful Nendo CSV, the profile the person's own Export writes, so what comes out can be handed straight back to `nendo.data.import_records`. The header row carries display names and is on the first page only, so pages concatenate into one document; `fieldIds` gives the stable ID behind each column, which is what an import maps by. Same 1–100 limit and same revision-bound cursor as every other page here. A resource rather than a tool because reading is a resource in this product, and because Inspect keeps an empty tool list. |
| `nendo://application/proposals` | `NendoAgentProposalStore.Snapshot` | Every validated proposal waiting for a person, with its title, captured revision, state, operation count, diagnostic count and the most severe reversibility class it carries. The recovery path after a reconnect or a lost response: a pending proposal was otherwise invisible, and each one captured a revision that accepting any other invalidates. |
| `nendo://application/health` | `GetHealthAsync` → `GetDefinitionSnapshotAsync` | Lightweight status with the last integrity-check time and change sequence; reading status does not re-run integrity. `changesSinceIntegrityCheck` and `integrityStale` state how far the file has moved since that result was measured, so `ok` taken thirty-two changes ago cannot be read as `ok` now. `nendo.health.verify_integrity` requests a measurement. |

All three page resources retain the MCP 1–100 limit. `limit` is a whole number in
that range; anything else — letters, a fraction, a value past what an integer
holds, an empty value, `0`, `101` — is `NENDO_INVALID_LIMIT`. The template
variable arrives as text and is classified by Nendo, because the SDK's binder
used to refuse a non-integer first and the client saw a bare internal error with
no code. Any intervening data or
definition change returns `NENDO_STALE_CURSOR`; restart the query. Foreign,
tampered, reopened-file or earlier agent-access cursors fail. Follow the declared
URI template parameter order (`cursor,limit`). See the [read and authority contract](reads-and-authority.md).

| Tool | Authority / current implementation | Shared semantic boundary |
| --- | --- | --- |
| `nendo.lease.acquire` | `NendoAgentAuthority.AcquireAsync` | One handle-bound modifying lease; returns applicationHandle, leaseId and an unprivileged receipt locator before writes. No file mutation. |
| `nendo.lease.renew` | `NendoAgentAuthority.RenewAsync` | Same live handle; extends an enabled TTL or confirms ownership when expiry is off. No file mutation. |
| `nendo.lease.release` | `NendoAgentAuthority.ReleaseAsync` | Serialized lease release; no file mutation. |
| `nendo.lease.status` | Current endpoint, no lease needed | `GetStatusAsync`; reports whether a lease is held, by which client display name and pseudonym, and — with a supplied handle — whether it is yours. The recovery path when an acquire response is lost: the grant is real, and nothing else could say so. |
| `nendo.data.create_record` | Data mode or higher, live lease; `NendoDataMutationService` | `CreateRecordAsync` → `data.createRecord`, bounded values and server-scoped idempotency. Returns the record ID and its new version, and `alsoChanged`: each other record an automatic action changed while this committed, with its new version. Empty when no action ran, and when every step's target reference was empty. An idempotent replay names the same records with `recordVersion` null — the file may have moved since — as does the receipt read back through `nendo.data.get_receipt`. A value map naming a calculated field is `NENDO_FIELD_CALCULATED`, naming the calculation. |
| `nendo.data.create_records` | Same | `CreateRecordsAsync` → one mutation of 1–50 `data.createRecord` operations: one revision, one idempotency key, all or nothing. `recordVersion` is the version every created record holds; when an automatic action wrote back to only some of them it is null, since no single number is true of the batch, and `alsoChanged` names each moved record with its own version. |
| `nendo.data.import_records` | Same | `ImportAsync` → `NendoImportService` → `CreateRecordsAsync`. CSV text or typed JSON, decoded through the routine the native importer uses and committed through the same canonical `data.createRecord` operations, fifty to a revision. At most 500 rows a call — the 256 KiB body is the limit met first — and `maximumRowsPerCall` echoes it. Each batch's idempotency key is derived from the caller's, and a CSV row's record ID from that key and the row's position, so an exact retry asks for the same records rather than a second copy. A refused batch stops the run: `committed` says how many landed and the response never implies the call was atomic. |
| `nendo.data.set_field` | Same | `SetFieldAsync` → `data.setField`, expected touched-record version. `alsoChanged` as above. `recordVersion` is the version the record holds after the revision, so an action that wrote back to the same record in it leaves it past expected + 1, and `alsoChanged` names that record too. A text or choice value is the JSON string itself; a choice is refused naming the declared options and echoing what arrived. A calculated field — `derivedFields` in the schema read — is refused as `NENDO_FIELD_CALCULATED` naming the calculation, not as a field that does not exist. |
| `nendo.data.delete_record` | Same | `DeleteRecordAsync` → `data.deleteRecord`, expected touched-record version. Incoming references block deletion, and the refusal names the referring records; exact retries return the committed outcome. `alsoChanged` as above. |
| `nendo.data.execute_command` | Same | `ExecuteCommandAsync` resolves the stored command, then typed `data.setField`; MCP does not implement domain commands. Returns the resulting `recordVersion`: a command advances the record by one version per `commandStep`, and the steps live in the stored definition, so the caller cannot derive it and the next optimistic write had nothing to pin to. Null on an idempotent replay, where the original write's version may since have moved. |
| `nendo.data.get_receipt` | Current endpoint, no modifying lease needed | `GetMutationReceiptAsync`; saved locator binds original app/instance/run/scope. A committed receipt carries `generatedChanges` — the records the write's automatic actions changed, rebuilt from the revision's attributed operations, with `recordVersion` null — so a lost response is recovered without re-reading every record. A missing receipt remains unresolved; no write authority is granted. |
| `nendo.health.verify_integrity` | Current endpoint, no lease needed | `VerifyIntegrityAsync`; scans the file and returns health measured now. An unchanged file is not rescanned — `rescanned` is false and the recorded result already describes it — so calling it after every batch costs nothing. A failed scan puts the host into recovery, which is the file being protected, not this call failing. |
| `nendo.change_set.begin` | Shape app + live lease; `NendoAgentAuthoringService` | Captures typed authority in a bounded transient draft; no active mutation. |
| `nendo.change_set.add_operations` | Same owning handle/draft | Closed canonical DTOs, ≤16 operations/add and ≤128 submitted per change set, expanding to ≤512 canonical; IDs supplied by host, and every limit echoed in every response. `ui.addNode` accepts an inline `properties` map that expands to one `ui.setProperty` per property at the boundary, so a node and its configuration cost one operation rather than one plus one per property. An omitted `expectedDefinitionRevision` is resolved from the operation's position in the change set, so the caller does not model the host's counter; a supplied value is honoured exactly. No active mutation. |
| `nendo.change_set.amend` | Same owning handle/draft, not frozen | Drops every mutation from an ordinal onwards and appends replacements under the same per-call bounds. Correcting one bad operation costs one call rather than a rebuilt change set. A change set that validated is no longer a draft: amend, `add_operations` and a fresh `validate` are `NENDO_CHANGE_SET_FROZEN`, naming the proposal it became and the remedy — reject it, or ask the person to accept it — and an ID this session never had is `NENDO_CHANGE_SET_NOT_FOUND: The change set does not exist.` No active mutation. |
| `nendo.change_set.validate` | Same | `PrepareProposalAsync(NendoCanonicalProposalRequest)` → canonical compilation → physical clone validation. Schema-only proposals are valid for Studio; present custom trees must compile fully. A failed validation discards its private clone and leaves the draft open and amendable, so it is a repeatable dry run rather than the end of the change set. |
| `nendo.change_set.preview` | Same owning session | Reads the retained typed preview via `NendoAgentProposalStore.GetOwned`; no active mutation or new acceptance authority. |
| `nendo.change_set.reject` | Same owning session | Removes the owned draft/preview and calls generic `RejectProposalAsync` for its derivative workspace. |
| `nendo.change_set.accept` | **Unattended only**, same owning session | `NendoAgentProposalStore.PromoteAsync` — the method the person's own Accept button calls — with the proposal's reviewed operation digest, never omitted. `applied` false is an ordinary answer: `state` says whether the file moved (`stale`), the reviewed plan no longer matches (`failed`) or it is still waiting (`previewable`), and the proposal stays where it is. `behaviourApproved` says whether this acceptance also recorded the device's consent for automatic actions it installed. A change set still in draft is `NENDO_CHANGE_SET_NOT_VALIDATED`. |

`nendo.change_set.begin` reports how many other change sets are already open
against this file, with an advisory naming the captured revision. Every open
proposal captured a revision and accepting any one of them invalidates the rest;
that used to surface only at the approval dialog, after the review.

Records created earlier in a change set may be edited by later operations in
that change set. They have no active-file version to include in proposal
staleness capture; their expected versions are checked by ordered replay on the
proposal clone and again during promotion.

Inline node properties are the throughput fix. A complete application's screens
ran to 84 nodes and roughly 234 operations, which does not fit one change set, so
the build split into three proposals with a human approval between each. The same
screens are 84 submitted operations now, and the expansion is bounded separately
so the canonical ceiling stays honest rather than implicit.

A validated proposal's preview is scoped to the validated clone — the whole file
as it would stand — and says so in `scope`. Entities, field counts and record
counts are all taken from that one set. They previously came from two: entities
from the compiled screens, records from the file. A schema-only change set
previewed as entirely empty while its diff described all 36 of its operations,
and a populated preview counted fields over three record types and records over
four. The preview also carries `minimumHostVersionBefore` and
`minimumHostVersionAfter`, and a raise appears in `semanticDiff` as its own
`raiseMinimumHostVersion` entry, classified irreversible. It carries
`purposeBefore` and `purposeAfter` the same way, as its own pair rather than
something to be found among the entities or the surfaces: what a file is for
belongs to the file and has neither a record type nor a node, so a summary built
by walking those would review a change to it as changing nothing. Each surface in
the preview carries an optional `shape`: the size a reviewer cannot infer from a
kind and a title. A matrix states its rows, its columns and its cell count; a board
states how many columns it would have, and a board grouped by a reference states
that its columns are records of the target type, *one column per Client record, 12
of them* — including that there are none yet, so it would draw nothing. It says
"per {name} record" whatever the person named the type, singular or plural.
`shape` is null for every kind whose size is
not a closed question, because a guessed size is worse in a review than none.
Accepting proposals can
move a file's minimum host version — 1.0.0 to 1.5.0 to 1.11.0 across three of
them in the review — which is a durable compatibility change, and the person
approving it was not shown it.

A data write refused because the record type, field or command it names is not in
the file names the outstanding proposal that creates it, with its title and the
required action. `NENDO_ENTITY_NOT_FOUND` on its own reads as a bad identifier and
invites the wrong repair; immediately after a validate, the likely cause is that
nobody has accepted the proposal yet.

Every node in every tool's input schema declares what it accepts. A `JsonElement`
parameter exported as a schema carrying a description and no validation keyword,
which the MCP Inspector flags as a portability warning because some clients refuse
such a node; five were unconstrained — the operation payload on `add_operations`
and `amend`, the value map on `create_record` and each `create_records` entry, and
the value on `set_field`. Those arguments are now `NendoObjectInput` and
`NendoScalarInput`: each still binds any JSON, so a wrong shape is refused by Nendo
with a sentence naming the operation or the rule rather than by the binder with
none, and each advertises its shape through the SDK's schema transform hook —
`object` for the maps, and a scalar, `null` or the `$nendoNumber` envelope for a
field value. `InputSchemaContractTests` walks every advertised node and sends the
wrong shapes.

## What a refusal says

A tool error is `CODE: message`. The code is stable and the message is the remedy,
under one rule: **an engine message passes through when its template carries only
stable IDs, definition display names, declared choice IDs and integers — never a
path and never a stored value.** Every `NendoValidationException` meets that rule
and passes through whole. A precondition passes through when its code is on the
audited list in `NendoToolErrors` (`record-referenced`, `behaviour-not-approved`,
`record-version-conflict`, `target-*`, `choice-retired`, `aggregate-not-representable`
and the earlier three); `aggregate-not-exact` echoes a stored float and stays
withheld. A calculation failure passes through as `NENDO_CALCULATION_*`.

An outside review measured the cost of the alternative. One blind
`NENDO_INVALID_REQUEST: The request arguments are invalid.` stood for four unrelated
causes — an operation type this host does not implement, a data write missing a
required field, a choice value that arrived with its quote characters inside it, and
a behaviour body missing the key a sum needs — and the reviewer filed the choice
path as broken and abandoned the sum. The engine had written the naming message in
every case; the boundary threw it away.

What each now says:

- An unknown operation type is `NENDO_UNKNOWN_OPERATION`, naming the type and the
  number of operations the vocabulary lists. It is the answer to "is there an
  escape hatch": there is not, and the refusal is the same for `sql.execute` as for
  a typo.
- A payload the host cannot bind is refused **where it is sent** — `add_operations`
  or `amend` — as `NENDO_INVALID_REQUEST` naming the mutation ordinal (the one
  `amend` takes), the operation index, the operation and its ID, and then the
  engine's own sentence: which binding, which key, what the key is for, or which key
  this contract does not define. Every operation is built into its typed form at that
  moment; nothing enters the draft, so a wrong guess costs one call. A validate that
  ends without a verdict — authority moved, a call cancelled — reopens the draft rather
  than leaving it frozen.
- A value refused on a data write names the field, the declared choices, and what
  arrived (`received "\"Bean\""`), so a double-encoded string is visible as one.
- A delete blocked by references names up to five referring records.
- A write naming a calculated field is `NENDO_FIELD_CALCULATED`, naming the field,
  the record type and the calculation, and pointing at the stored fields its formula
  reads. It used to be `NENDO_FIELD_NOT_FOUND` — the write path looked only at
  stored columns — while the schema read listed the field under `derivedFields`.
- A change set that validated is `NENDO_CHANGE_SET_FROZEN` to `add_operations`,
  `amend` and a fresh `validate`, naming the proposal it became and both remedies.
  It used to be `NENDO_CHANGE_SET_NOT_FOUND` with the sentence withheld, which read
  as a typo in an ID the agent had just used. `NENDO_CHANGE_SET_NOT_FOUND` now says
  whether the ID does not exist or belongs to another agent session.
- A page limit that is not a whole number from 1 to 100 is `NENDO_INVALID_LIMIT`
  on the resource read, with JSON-RPC `-32602`; it used to be `-32603` with no code,
  because the SDK's binder refused it before Nendo could.
- `NENDO_UNATTENDED_REQUIRED` is the service's answer to an accept below that level.
  A client normally meets the SDK's unknown-tool refusal first, because the tool is not
  registered there at all; this code exists as the second lock, for a build that
  registered it a rung too low.
- `NENDO_CHANGE_SET_NOT_VALIDATED` is an accept for a change set that is still a draft.
- `NENDO_INTERNAL_ERROR` names the exception type and nothing else.

The closed authoring union is declared once, in `NendoAuthoringOperations`, and
serves two purposes from that table: it is published at
`nendo://application/vocabulary`, and `NendoAgentAuthoringService` builds its
enforcement from it. The payload specification used to be prose inside the
`add_operations` tool description, which grew long enough to be truncated
mid-token in a real client's tool listing. It permits nineteen of the Engine's
twenty-one canonical operations. `data.restoreDeletedRecord` and
`identity.transition` are native-only: lifecycle identity operations remain host
services, not MCP authoring primitives.

`behaviour.setDefinition` and `behaviour.removeDefinition` are among the nineteen,
so an agent authors calculations, reusable functions, actions and triggers through
ordinary proposals. The vocabulary's `behaviour.bindings` publishes every binding
shape with the keys it takes — a `RelatedAggregate` once per aggregate, because
`FilteredCount` takes `predicateFieldId` and `Sum` takes `valueFieldId` — from the
same table the codec refuses against, and `propertyNotes` says what `visibleWhen`
and `fieldId` take. What it cannot do is let them run: a file whose actions run
automatically is not editable until the person at this device approves it, and
there is no tool, resource or payload field that reaches that approval. The
production gate asserts the local MCP surface cannot name it. The vocabulary
resource carries the behaviour catalogue those definitions must be written against
— the closed function set with argument and result types, the operators, the scalar
domain, the binding kinds, the aggregate rules and the ceilings — and
`nendo://application/examples` carries a worked change set that authors two
dependent calculated fields, a reusable function, an action and its trigger. Form batching in Workbench
uses `SetFieldsAsync`, expanding to existing field operations; there is no new
MCP form tool. Relationship/delete/rename operations are not implied by a
generic service name.

Below Unattended there is no MCP accept/promote tool, and acceptance is the
person's: native-owned Workbench review calls `PromoteProposalAsync` with the
reviewed digest, the write gate verifies it and replays the validated operations.
At Unattended, `nendo.change_set.accept` calls that same service with that same
digest. Nothing else about promotion changes — not the clone, not the staleness
capture, not the History revision — so the sentence that used to end "there is no
promotion tool" now ends "there is one, at one level, and the person chose it"
(ADR-0009, 2026-09-22 amendment). Both application families and the unfamiliar
two-entity specimen/visit fixture use these same services.

Installing an automatic action needs no consent; the **write that would run one**
does, which is where `NENDO_BEHAVIOUR_NOT_APPROVED` is raised. At Unattended the
host records that consent — the same grant a person's approval writes, scoped to
the same behaviour digest, withdrawn in the same place — after an acceptance that
installs actions, and once before a single retry of a write refused for want of it.
At every level below, the delegate that does this is null and the refusals are
exactly what they were. [The acceptance tests](../../tests/Nendo.LocalMcp.Tests/UnattendedAcceptanceTests.cs)
pair each of these with the level below refusing it.

Evidence: [protocol resource tests](../../tests/Nendo.LocalMcp.Tests/ProtocolResourceTests.cs),
[unattended acceptance tests](../../tests/Nendo.LocalMcp.Tests/UnattendedAcceptanceTests.cs),
[import and export tests](../../tests/Nendo.LocalMcp.Tests/ImportExportProtocolTests.cs),
[authoring tests](../../tests/Nendo.LocalMcp.Tests/AuthoringProtocolTests.cs),
[output schema contract tests](../../tests/Nendo.LocalMcp.Tests/OutputSchemaContractTests.cs),
[contract version 3 surface tests](../../tests/Nendo.LocalMcp.Tests/ComposableSurfaceResourceTests.cs),
[authoring recovery tests](../../tests/Nendo.LocalMcp.Tests/AuthoringRecoveryTests.cs),
[worked example tests](../../tests/Nendo.LocalMcp.Tests/AuthoringExampleTests.cs),
[data outcomes](../../tests/Nendo.LocalMcp.Tests/DataOutcomeProtocolTests.cs),
[read path tests](../../tests/Nendo.LocalMcp.Tests/ReadPathTests.cs),
[authoring ergonomics tests](../../tests/Nendo.LocalMcp.Tests/AuthoringErgonomicsTests.cs),
and the [native neutrality probe](../../tools/Review-NeutralityRuntime.mjs).
