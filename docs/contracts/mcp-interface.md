# MCP interface contract

This contract lists the sixteen resources and nineteen tools that an external
agent sees, and the authority rules behind them. `Test-Production.ps1` asserts
both surfaces by name.

Two of those tools came with the [ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)
amendment of 2026-09-22. *Data mutation* serves `nendo.data.import_records`.
`nendo.change_set.accept` is served only at **Unattended**, the fifth access
level. At every level below Unattended, the tool is not registered at all. If a
client sends it by name, the SDK refuses it as an unknown tool. The service's own
mode check is the second lock behind that refusal.

ADR-0008 is delivered as bounded behaviour architecture. It does not add MCP
authoring tools. The `behaviour.setDefinition` operation installs a definition
inside a change set that the tools below already carry, so ADR-0008 does not
change the tool list. The [acceptance experiment](../design/adr-0008-evidence.md)
stays outside this interface and is history. The shared catalogue in
`nendo://application/vocabulary` publishes typed definitions, their capabilities
and their costs, and they are reviewed as part of a proposal. MCP never bypasses trigger
expansion. Below Unattended, MCP never grants local approval. At Unattended, the
host records that approval itself, as described at the end of this contract.

All requests enter loopback stateless Streamable HTTP with no credential. Both MCP
eras are served:

- the `initialize` handshake on any version that the SDK supports;
- the 2026-07-28 `server/discover` path with per-request metadata. On this path,
  the SDK handles the MCP-Protocol-Version/Mcp-Method/Mcp-Name headers and complete
  result envelopes.

The discovery document names the discover-path headers and the three
`io.modelcontextprotocol/*` `params._meta` keys. A hand-written client therefore
does not have to learn them from errors. The document also carries `displayName`,
the name of the open file. Before, the advertisement identified the endpoint, the
process and the application, but not the file behind them. With two Nendo windows
open, the only answer to "which file do you want?" was to cross-reference the
process ID in the write-owner sidecar.

`displayName` is a label and not a location: it has no directory and nothing that
an agent could open. Agents never receive a database path
([vision.md](../vision.md)). If a caller supplies one, the host reduces it to its
last segment. File resources and catalogs carry private, zero-TTL cache hints.
Tools are listed in stable name order.

The host serializes every tool result with nulls present. The output schema that
is generated from a return type lists nullable members as required. A payload that
dropped one therefore failed validation in any client that checks the schema the
tool advertises. `nendo.lease.acquire` and `nendo.change_set.validate` both failed
in this way.
[Output schema contract tests](../../tests/Nendo.LocalMcp.Tests/OutputSchemaContractTests.cs)
call every declared tool and check its payload against its own declared schema.

Host/Origin/address/body checks occur before dispatch. Lease acquisition mints an
opaque `applicationHandle` in addition to `leaseId`. Supply both on every owned
operation, including renew/release and proposal preview. Possession of the handle
governs ownership, not claimed client names or HTTP connection identity. Keep the
handle private.

By default, the lease ends on explicit release, user revocation or host stop. An
owner can enable a bounded expiry in Agent → Connection. In either mode, the
closure of an agent alone does not end the lease. If the file is closed, switched,
replaced or recovered, the endpoint and the authority become invalid. A healthy
restart of only the renderer preserves them. Receipt lookup requires no live
handle and cannot restore editing authority. No adapter gets SQL, SQLite handles,
physical mappings or arbitrary host invocation.

| Resource | Current adapter and shared application service | Projection / outstanding cost |
| --- | --- | --- |
| `nendo://application/describe` | `GetDescriptionAsync` → the projections below | What the file is for, then the manifest, authoring limits, every record type with its fields, every compiled screen, health, `extensions` (every custom-view package the file carries, with its files but not their bytes), and `reads`: every resource URI this host serves, generated from the declared resources. It answers the reconnaissance phase without 1 + N round trips. `resources/list` returns only the parameterless resources, so the read path for records was reachable only through `resources/templates/list`. A review concluded from the seven listed entries that the data API was write-only, and it opened the SQLite file directly to check its own writes. |
| `nendo://application/examples` | `NendoAuthoringExamples.Description` | Seventeen complete contract version 3 change sets that can be sent without change: `create-entity-with-required-fields`, `configure-a-reference`, `a-breakdown-and-a-ring`, `a-trend-and-an-activity-grid`, `a-matrix-and-a-ranking`, `a-board-with-a-lane-per-project`, `build-a-detail-surface`, `define-a-command`, `two-commands-and-a-filtered-list`, `several-views-tabs-and-a-calendar`, `a-timeline-of-spans`, `a-gallery-and-a-rating`, `a-front-page-for-the-file`, `say-what-the-file-is-for`, `calculate-and-act-automatically`, `pin-an-offline-custom-graph`, `put-a-custom-view-in-the-file`. Each example carries the authoring rule that it conveys. Static for a host build. [The example tests](../../tests/Nendo.LocalMcp.Tests/AuthoringExampleTests.cs) replay every example through the real authoring boundary, so an example that stops validating fails the build. |
| `nendo://application/manifest` | `NendoResourceProjection.GetManifestAsync` → `GetDefinitionSnapshotAsync` | What the file is for, plus identity and revision counters, without record/history reads. |
| `nendo://application/vocabulary` | `NendoSemanticVocabulary.Description` + `NendoAuthoringOperations.All` | Every contract version 3 node kind with its permitted properties, required properties, permitted children and root ceiling: `maxRootsPerEntity`, or `maxRootsPerFile` for a root that belongs to the file and not to a record type. The closed filter operators, value kinds, ordering directions and aggregates. The `and` combinator that joins sibling `filterClause` children, and the note that version 3 has no OR and no grouping. The closed `choiceTones` that a choice option may carry. The `charts` rule with its closed groupings and its ceiling on groups. The `overview` rule with the one front page that a file may own and the ceiling on a recent list. The authoring limits. `operations`: every canonical operation with the payload fields that it requires and accepts. It is generated from the tables that the compiler and the authoring boundary validate against. `NendoAgentAuthoringService` builds its accepted field sets from the published table, so a documented field is an accepted field. Static for a host build: it describes the host, not the open file. |
| `nendo://application/entities` | `GetEntitiesAsync` → `GetDefinitionSnapshotAsync` | Stable entity IDs and display labels; no record projection. |
| `nendo://host/instances` | `NendoDiscoveryStore.ReadLiveEntries` | Every Nendo that runs on this device and the file that each one has open. `isThisOne` marks the host that answers the read. This is the only resource here that is not about the open file. The host has written this directory since discovery existed, but nothing read it. An agent therefore could not tell a person which file it was about to write to, and a second Nendo was unreachable in practice (F-064). An entry is admitted on the same terms that the stale sweep uses to keep one, so a dead host is never offered as a place to work. Each entry carries the name of the file and never a path. The resource does not make another endpoint reachable. A client reaches the address that it was registered with and cannot redirect itself. Switching therefore stays the action of the person, and the resource states this in its own `note`. |
| `nendo://application/entity/{entityId}/schema` | `GetSchemaAsync` → `GetDefinitionSnapshotAsync` | Semantic fields, storage kinds, required/presentation/options, and a rating field's `scale` with its `min` and `max`. |
| `nendo://application/entity/{entityId}/records{?cursor,limit}` | `GetRecordsAsync` → `QueryRecordsAsync` | Storage keyset page in stable record-ID order; revision-bound continuation. |
| `nendo://application/surfaces` | `GetSurfacesAsync` → `CompileSemanticDefinitionAsync` | Cached verified definition, with no records. Surface roots appear under `applications[].surfaces` as an ordered node tree with `nodeId`, `kind`, `properties`, `children` and, on a command root, the `commandId` that `nendo.data.execute_command` takes. The removed contract version 1 and 2 `form`/`list`/`board`/`command` slots are gone from this resource as of 2026-09-12. The front page of the file, if it has one, is under `overview` and not among the record types. `state` is `valid`, `invalid` or `noCustomSurfaces`. A stored `surfaceId` is intentionally absent, because it is not part of the compiled plan. The definition digest is taken over the plan. |
| `nendo://application/history{?cursor,limit}` | `GetHistoryAsync` → `QueryHistoryAsync` | Bounded revision summaries in ascending sequence order. `operationCount` and `operationsUri` replace the unbounded nested `operations` array. |
| `nendo://application/revision/{revisionId}/operations{?cursor,limit}` | `GetRevisionOperationsAsync` → `QueryRevisionOperationsAsync` | Bounded sanitized operation descriptors in ordinal order. No canonical payload, raw inverse or physical mapping escapes. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | `GetCsvExportAsync` → `ExportCsvPageAsync` → `QueryRecordsAsync` | One page of the record type as faithful Nendo CSV. This is the profile that the person's own Export writes, so the output can go directly back to `nendo.data.import_records`. The header row carries display names and appears on the first page only, so the pages concatenate into one document. `fieldIds` gives the stable ID behind each column, and an import maps by that ID. The same 1–100 limit and the same revision-bound cursor apply as on every other page here. It is a resource and not a tool, because reading is a resource in this product and because Inspect keeps an empty tool list. |
| `nendo://application/proposals` | `NendoAgentProposalStore.Snapshot` | Every validated proposal that waits for a person, with its title, captured revision, state, operation count, diagnostic count and the most severe reversibility class that it carries. This is the recovery path after a reconnect or a lost response. Before, a pending proposal was invisible, and each proposal captured a revision that the acceptance of any other proposal invalidates. |
| `nendo://application/health` | `GetHealthAsync` → `GetDefinitionSnapshotAsync` | Lightweight status with the time of the last integrity check and the change sequence. A status read does not run integrity again. `changesSinceIntegrityCheck` and `integrityStale` state how far the file has moved since that result was measured. An `ok` taken thirty-two changes ago therefore cannot be read as `ok` now. `nendo.health.verify_integrity` requests a measurement. |
| `nendo://application/extensions` | `GetExtensionsAsync` → `GetDefinitionSnapshotAsync` | Every custom-view package that the file carries: its ID, title, version, entry point, description and total size, and each file's path, media type, SHA-256 and size. No content. A package in the file is stored and reviewed, and nothing runs it yet ([custom-view contract](custom-views.md#packages-in-the-file)). |
| `nendo://application/extension/{packageId}/file{?path,offset,length}` | `GetExtensionFileAsync` → `ReadExtensionFileAsync` | One package file, a page of bytes at a time. `path` is percent-encoded, so `tiles/world.bin` is sent as `tiles%2Fworld.bin`. `offset` and `length` are byte positions. `length` is at most 131,072, and by default the page runs to the end of the file up to that. A text file's page arrives as `text`. Any other page arrives as `base64`, and so does a text page that would split a UTF-8 sequence. `sha256` and `byteLength` describe the whole file, and `nextOffset` is null on the last page. |

All four page resources (records, export, history and revision operations) keep
the MCP 1–100 limit. `limit` is a whole number in
that range. Any other value is `NENDO_INVALID_LIMIT`: letters, a fraction, a value
larger than an integer holds, an empty value, `0` or `101`. The template variable
arrives as text, and Nendo classifies it. Before, the SDK's binder refused a
non-integer first, and the client saw a bare internal error with no code.

If a data or definition change occurs between pages, the read returns
`NENDO_STALE_CURSOR`. Restart the query. Foreign, tampered, reopened-file or
earlier agent-access cursors fail. Follow the declared URI template parameter
order (`cursor,limit`). See the [read and authority contract](reads-and-authority.md).

The package-file read pages by bytes, not by records, and it has no cursor.
`offset` and `length` must be whole numbers, and anything else is
`NENDO_INVALID_LIMIT`. A missing `path`, a path the package does not hold, a
`length` outside 1–131,072 and an `offset` past the end of the file are each
`NENDO_INVALID_REQUEST`, and the message names the rule. Each page describes the
file as it stands when that page is read. Compare `sha256` on every page: a file
that changed between two pages shows a different hash.

The resources are served at every level from Inspect upward, and Inspect lists no
tools. The lease, data and health tools are registered from Edit data upward. The
change-set tools other than `nendo.change_set.accept` are registered from Shape app
upward.

| Tool | Authority / current implementation | Shared semantic boundary |
| --- | --- | --- |
| `nendo.lease.acquire` | `NendoAgentAuthority.AcquireAsync` | One handle-bound modifying lease. Returns applicationHandle, leaseId and an unprivileged receipt locator before writes. No file mutation. |
| `nendo.lease.renew` | `NendoAgentAuthority.RenewAsync` | Same live handle. Extends an enabled TTL, or confirms ownership when expiry is off. No file mutation. |
| `nendo.lease.release` | `NendoAgentAuthority.ReleaseAsync` | Serialized lease release. No file mutation. |
| `nendo.lease.status` | Current endpoint, no lease needed | `GetStatusAsync`. Reports whether a lease is held, the client display name and pseudonym of the holder, and, if a handle is supplied, whether the lease is yours. This is the recovery path when an acquire response is lost: the grant exists, and no other call can report it. |
| `nendo.data.create_record` | Data mode or higher, live lease; `NendoDataMutationService` | `CreateRecordAsync` → `data.createRecord`, bounded values and server-scoped idempotency. Returns the record ID and its new version, and `alsoChanged`: each other record that an automatic action changed while this write committed, with its new version. `alsoChanged` is empty when no action ran, and when the target reference of every step was empty. An idempotent replay names the same records with `recordVersion` null, because the file may have moved since. The receipt that `nendo.data.get_receipt` reads back does the same. A value map that names a calculated field is `NENDO_FIELD_CALCULATED`, and the refusal names the calculation. |
| `nendo.data.create_records` | Same | `CreateRecordsAsync` → one mutation of 1–50 `data.createRecord` operations: one revision, one idempotency key, all or nothing. `recordVersion` is the version that every created record holds. If an automatic action wrote back to only some of the records, `recordVersion` is null, because no single number is true of the batch. `alsoChanged` names each moved record with its own version. |
| `nendo.data.import_records` | Same | `ImportAsync` → `NendoImportService` → `CreateRecordsAsync`. Takes CSV text or typed JSON; a mixed payload is refused before writing. The native importer's routine decodes CSV, and the same canonical `data.createRecord` operations commit it, fifty to a revision. Unknown, duplicate or out-of-range CSV mappings are typed validation refusals. At most 500 rows per call; the 256 KiB body is the limit met first. `maximumRowsPerCall` echoes the limit on success. Each batch derives its idempotency key from the caller's key; a CSV record ID derives from that key and its row position. If a later batch is refused, `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, first uncommitted data row, committed revision IDs and cause. Retry the identical call and key to replay the earlier batches without duplicates. No response implies the whole call was atomic. |
| `nendo.data.set_field` | Same | `SetFieldAsync` → `data.setField`, expected touched-record version. `alsoChanged` as above. `recordVersion` is the version that the record holds after the revision. If an action wrote back to the same record in that revision, the version is past expected + 1, and `alsoChanged` also names that record. A text or choice value is the JSON string itself. A choice is refused with the declared options and an echo of the value that arrived. A calculated field (`derivedFields` in the schema read) is refused as `NENDO_FIELD_CALCULATED`, which names the calculation. It is not refused as a field that does not exist. |
| `nendo.data.delete_record` | Same | `DeleteRecordAsync` → `data.deleteRecord`, expected touched-record version. Incoming references block deletion, and the refusal names the referring records. Exact retries return the committed outcome. `alsoChanged` as above. |
| `nendo.data.execute_command` | Same | `ExecuteCommandAsync` resolves the stored command, then typed `data.setField`. MCP does not implement domain commands. Returns the resulting `recordVersion`. A command advances the record by one version per `commandStep`, and the steps are in the stored definition. The caller therefore cannot derive the version, and without this value the next optimistic write had nothing to pin to. Null on an idempotent replay, where the version of the original write may have moved since. |
| `nendo.data.get_receipt` | Current endpoint, no modifying lease needed | `GetMutationReceiptAsync`. The saved locator binds the original app/instance/run/scope. A committed receipt carries `generatedChanges`: the records that the write's automatic actions changed, rebuilt from the revision's attributed operations, with `recordVersion` null. A lost response is therefore recovered without a re-read of every record. A missing receipt remains unresolved, and no write authority is granted. |
| `nendo.health.verify_integrity` | Current endpoint, no lease needed | `VerifyIntegrityAsync`. Scans the file and returns the health measured now. The scan also reads every stored custom-view package content and compares it with its SHA-256. An unchanged file is not rescanned: `rescanned` is false, and the recorded result already describes the file. A call after every batch therefore costs nothing. A failed scan puts the host into recovery. That is the protection of the file, not a failure of this call. |
| `nendo.change_set.begin` | Shape app + live lease; `NendoAgentAuthoringService` | Captures typed authority in a bounded transient draft. No active mutation. |
| `nendo.change_set.add_operations` | Same owning handle/draft | Closed canonical DTOs: ≤16 operations per add and ≤128 submitted per change set, expanding to ≤512 canonical. One operation's payload is at most 32 KiB, and an `extension.putFile` payload at most 96 KiB. A larger package file is sent in parts: `putFile` operations with `append: true` continue the file that an earlier `putFile` of the same package and path began in this change set. The host joins the parts in order at validation. A part with nothing to continue is refused when it is sent. The host supplies IDs, and every response echoes every limit. `ui.addNode` accepts an inline `properties` map. At the boundary, the map expands to one `ui.setProperty` per property, so a node and its configuration cost one operation instead of one plus one per property. If `expectedDefinitionRevision` is omitted, the host resolves it from the position of the operation in the change set, so the caller does not model the host's counter. A supplied value is honoured exactly. No active mutation. |
| `nendo.change_set.amend` | Same owning handle/draft, not frozen | Drops every mutation from an ordinal onwards and appends replacements under the same per-call bounds. A correction of one bad operation costs one call, and the change set does not need to be rebuilt. A change set that validated is no longer a draft. Amend, `add_operations` and a fresh `validate` on it are `NENDO_CHANGE_SET_FROZEN`. The refusal names the proposal that the change set became and both remedies: reject the proposal and begin a new change set, or ask the person to accept it. An ID that this session never had is `NENDO_CHANGE_SET_NOT_FOUND: The change set does not exist.` No active mutation. |
| `nendo.change_set.validate` | Same | `PrepareProposalAsync(NendoCanonicalProposalRequest)` → canonical compilation → physical clone validation. Schema-only proposals are valid for Studio. Custom trees that are present must compile fully. A failed validation discards its private clone and leaves the draft open and amendable. Validation is therefore a repeatable dry run and does not end the change set. |
| `nendo.change_set.preview` | Same owning session | Reads the retained typed preview through `NendoAgentProposalStore.GetOwned`. No active mutation and no new acceptance authority. |
| `nendo.change_set.reject` | Same owning session | Removes the owned draft/preview and calls generic `RejectProposalAsync` for its derivative workspace. |
| `nendo.change_set.accept` | **Unattended only**, same owning session | `NendoAgentProposalStore.PromoteAsync`, the method that the person's own Accept button calls, with the proposal's reviewed operation digest. The digest is never omitted. `applied` false is an ordinary answer. `state` says whether the file moved (`stale`), the reviewed plan no longer matches (`failed`) or the proposal still waits (`previewable`). The proposal stays where it is. `behaviourApproved` says whether this acceptance also recorded the device's consent for automatic actions that it installed. A change set that is still a draft is `NENDO_CHANGE_SET_NOT_VALIDATED`. |

`nendo.change_set.begin` reports how many other change sets are already open
against this file, with an advisory that names the captured revision. Every open
proposal captured a revision, and the acceptance of any one of them invalidates the
rest. Before, this appeared only at the approval dialog, after the review.

Later operations in a change set may edit records that earlier operations in that
change set created. Those records have no active-file version to include in the
staleness capture of the proposal. Ordered replay on the proposal clone checks
their expected versions, and promotion checks them again.

Inline node properties fix the throughput problem. The screens of a complete
application needed 84 nodes and roughly 234 operations. That does not fit in one
change set, so the build was split into three proposals, with a human approval
between each. The same screens now need 84 submitted operations. The expansion
has its own separate bound, so the canonical ceiling stays stated and not
implicit.

The preview of a validated proposal is scoped to the validated clone, which is the
whole file as it would stand. `scope` states this. Entities, field counts and
record counts all come from that one set. Before, they came from two sets:
entities from the compiled screens, and records from the file. A schema-only change
set had an entirely empty preview while its diff described all 36 of its
operations. A populated preview counted fields over three record types and records
over four.

The preview also carries `minimumHostVersionBefore` and
`minimumHostVersionAfter`. A raise appears in `semanticDiff` as its own
`raiseMinimumHostVersion` entry, classified irreversible. The preview carries
`purposeBefore` and `purposeAfter` in the same way, as their own pair. A reviewer
does not have to find them among the entities or the surfaces. The purpose of a
file belongs to the file and has no record type and no node. A summary built from a
walk of those would therefore review a change to the purpose as a change to
nothing.

The preview also carries `packageChanges`: each custom-view package file that the
proposal adds, replaces or removes, compared between the active file and the
validated clone. Each entry states the media types and sizes before and after. A
text file of at most 1 MiB also carries its changed lines, with three lines of
context, in `hunks`. The review shows at most 400 changed lines per file and 2,000
per proposal, and `truncated` says where it stopped early. The person sees the same
list in the **Code** section of the review
([custom-view contract](custom-views.md#review)).

Each surface in the preview carries an optional `shape`: the size that a reviewer
cannot infer from a kind and a title. A matrix states its rows, its columns and its
cell count. A board states how many columns it would have. A board grouped by a
reference states that its columns are records of the target type, *one column per
Client record, 12 of them*. It also states when there are none yet, so that the
board would draw nothing. It says "per {name} record" whatever the person named the
type, singular or plural. `shape` is null for every kind whose size is not a
closed question, because a guessed size is worse in a review than no size.

The acceptance of proposals can move the minimum host version of a file: 1.0.0 to
1.5.0 to 1.11.0 across three proposals in the review. This is a durable
compatibility change, and the person who approved it was not shown it.

A data write can be refused because the record type, field or command that it
names is not in the file. The refusal then names the outstanding proposal that
creates it, with the title of that proposal and the required action.
`NENDO_ENTITY_NOT_FOUND` on its own reads as a bad identifier and invites the
wrong repair. Immediately after a validate, the likely cause is that nobody has
accepted the proposal yet.

Every node in the input schema of every tool declares what it accepts. A
`JsonElement` parameter exported as a schema node with a description and no
validation keyword. The MCP Inspector flags such a node as a portability warning,
because some clients refuse it. Five nodes were unconstrained: the operation
payload on `add_operations` and `amend`, the value map on `create_record` and on
each `create_records` entry, and the value on `set_field`.

Those arguments are now `NendoObjectInput` and `NendoScalarInput`. Each still
binds any JSON. Nendo therefore refuses a wrong shape with a sentence that names
the operation or the rule, and the binder does not refuse it with no sentence. Each
argument advertises its shape through the SDK's schema transform hook: `object`
for the maps, and a scalar, `null` or the `$nendoNumber` envelope for a field
value. `InputSchemaContractTests` walks every advertised node and sends the wrong
shapes.

## What a refusal says

A tool error is `CODE: message`. The code is stable, and the message is the
remedy, under one rule: **an engine message passes through when its template carries only
stable IDs, definition display names, declared choice IDs and integers — never a
path and never a stored value.** Every `NendoValidationException` meets that rule
and passes through whole. A precondition passes through when its code is on the
audited list in `NendoToolErrors`: `definition-version-conflict`,
`required-field-needs-migration`, `required-backfill-needed`, `record-referenced`,
`entity-referenced`, `behaviour-not-approved`, `choice-retired`, `reference-unbound`,
`target-version-required`, `target-not-found`, `target-version-conflict`,
`record-version-conflict`, `record-not-found`, `field-not-found`, `field-calculated`
and `aggregate-not-representable`. `aggregate-not-exact` echoes a stored float, and it stays
withheld. A calculation failure passes through as `NENDO_CALCULATION_*`.

An outside review measured the cost of the alternative. One uninformative
`NENDO_INVALID_REQUEST: The request arguments are invalid.` stood for four
unrelated causes:

- an operation type that this host does not implement;
- a data write with a missing required field;
- a choice value that arrived with its quote characters inside it;
- a behaviour body without the key that a sum needs.

The reviewer filed the choice path as broken and abandoned the sum. In every case,
the engine wrote the message that names the cause, and the boundary discarded it.

What each now says:

- An unknown operation type is `NENDO_UNKNOWN_OPERATION`. The refusal names the
  type and the number of operations that the vocabulary lists. It answers the
  question "is there an escape hatch": there is not, and the refusal is the same
  for `sql.execute` as for a typo.
- A payload that the host cannot bind is refused **where it is sent**, at
  `add_operations` or `amend`, as `NENDO_INVALID_REQUEST`. The refusal names the
  mutation ordinal (the one that `amend` takes), the operation index, the
  operation and its ID. It then gives the engine's own sentence: which binding,
  which key, what the key is for, or which key this contract does not define.
  Every operation is built into its typed form at that moment. Nothing enters the
  draft, so a wrong guess costs one call. If a validate ends without a verdict
  (authority moved, or a call was cancelled), the draft reopens and does not stay
  frozen.
- A value refused on a data write names the field, the declared choices and the
  value that arrived (`received "\"Bean\""`), so a double-encoded string is
  visible as one.
- A delete blocked by references names up to five referring records.
- A write that names a calculated field is `NENDO_FIELD_CALCULATED`. The refusal
  names the field, the record type and the calculation, and it points to the
  stored fields that the formula reads. Before, it was `NENDO_FIELD_NOT_FOUND`,
  because the write path looked only at stored columns, while the schema read
  listed the field under `derivedFields`.
- A change set that validated is `NENDO_CHANGE_SET_FROZEN` to `add_operations`,
  `amend` and a fresh `validate`. The refusal names the proposal that the change
  set became and both remedies. Before, it was `NENDO_CHANGE_SET_NOT_FOUND` with
  the sentence withheld, which read as a typo in an ID that the agent had just
  used. `NENDO_CHANGE_SET_NOT_FOUND` now says whether the ID does not exist or
  belongs to another agent session.
- A page limit that is not a whole number from 1 to 100 is `NENDO_INVALID_LIMIT`
  on the resource read, with JSON-RPC `-32602`. Before, it was `-32603` with no
  code, because the SDK's binder refused it before Nendo could.
- `NENDO_UNATTENDED_REQUIRED` is the service's answer to an accept below that
  level. A client normally meets the SDK's unknown-tool refusal first, because the
  tool is not registered at those levels. This code exists as the second lock, for
  a build that registered the tool one level too low.
  Its message is *Unattended access is required.*
- `NENDO_CHANGE_SET_NOT_VALIDATED` is an accept for a change set that is still a
  draft. Its message passes through and tells the agent to validate first.
- `NENDO_INTERNAL_ERROR` names the exception type and nothing else.

The closed authoring union is declared once, in `NendoAuthoringOperations`, and
that table serves two purposes. It is published at
`nendo://application/vocabulary`, and `NendoAgentAuthoringService` builds its
enforcement from it. Before, the payload specification was prose inside the
`add_operations` tool description. That prose grew so long that a real client's
tool listing truncated it mid-token. The union permits twenty-four of the Engine's
twenty-six canonical operations. `data.restoreDeletedRecord` and
`identity.transition` are native-only: lifecycle identity operations remain host
services and are not MCP authoring primitives.

`extension.setPackage`, `extension.putFile`, `extension.removeFile` and
`extension.removePackage` are among the twenty-four. An agent therefore writes a
custom view's code into the file through ordinary proposals, and the person reviews
it as code before accepting. Nothing runs a package from the file yet
([custom-view contract](custom-views.md#packages-in-the-file)). The vocabulary
publishes the package bounds under `limits.extensions`:

- `fileBytes`: 4 MiB for one file;
- `packageFiles` and `packageBytes`: 512 files and 16 MiB for one package;
- `packages` and `totalBytes`: 64 packages and 64 MiB for one `.nendo` file;
- `contentBytesPerChangeSet`: 4 MiB of new content for one change set;
- `pathCharacters` and `packageIdCharacters`: 240 and 80;
- `putFilePayloadBytes`: 96 KiB for one `putFile` payload.

A change set past the content bound, or a file past 4 MiB once its parts are
joined, is refused at validation as `NENDO_INVALID_REQUEST`, and nothing reaches
the clone. A package precondition met on the clone, one of the `extension-*` codes,
arrives as a validation diagnostic, `NPROP010`, with the Engine's sentence.

`behaviour.setDefinition` and `behaviour.removeDefinition` are among the twenty-four,
so an agent authors calculations, reusable functions, actions and triggers through
ordinary proposals. The vocabulary's `behaviour.bindings` publishes every binding
shape with the keys that it takes, from the same table that the codec refuses
against. It lists a `RelatedAggregate` once per aggregate, because `FilteredCount`
takes `predicateFieldId` and `Sum` takes `valueFieldId`. `propertyNotes` says what
`visibleWhen` and `fieldId` take.

Below Unattended, the agent cannot make these definitions run. A file whose
actions run automatically is not editable until the person at this device
approves it. No tool, resource or payload field reaches that approval. The
production gate asserts that the local MCP surface cannot name the grant store or
the approval service. At Unattended, the host records the approval through a
delegate that takes no arguments, as described below. The vocabulary resource carries the
behaviour catalogue that those definitions must be written against: the closed
function set with argument and result types, the operators, the scalar domain, the
binding kinds, the aggregate rules and the ceilings. `nendo://application/examples`
carries a worked change set that authors two dependent calculated fields, a
reusable function, an action and its trigger.

Form batching in Workbench uses `SetFieldsAsync`, which expands to existing field
operations. There is no new MCP form tool. A generic service name does not imply
relationship/delete/rename operations.

Below Unattended, there is no MCP accept/promote tool, and acceptance is the
person's. Native-owned Workbench review calls `PromoteProposalAsync` with the
reviewed digest. The write gate verifies the digest and replays the validated
operations. At Unattended, `nendo.change_set.accept` calls that same service with
that same digest. Nothing else about promotion changes: not the clone, not the
staleness capture, not the History revision. The sentence that used to end "there
is no promotion tool" now ends "there is one, at one level, and the person chose
it" (ADR-0009, 2026-09-22 amendment). Both application families and the unfamiliar
two-entity specimen/visit fixture use these same services.

The installation of an automatic action needs no consent. The **write that would
run one** needs consent, and `NENDO_BEHAVIOUR_NOT_APPROVED` is raised at that
write. At Unattended, the host records that consent after an acceptance that
installs actions. It also records it once before a single retry of a write that was
refused for lack of it. This is the same grant that a person's approval writes,
scoped to the same behaviour digest and withdrawn in the same place. At every level
below, the delegate that does this is null, and the refusals are exactly as they
were. [The acceptance tests](../../tests/Nendo.LocalMcp.Tests/UnattendedAcceptanceTests.cs)
pair each of these with a refusal at the level below.

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
[extension package protocol tests](../../tests/Nendo.LocalMcp.Tests/ExtensionPackageProtocolTests.cs),
and the [native neutrality probe](../../tools/Review-NeutralityRuntime.mjs).
