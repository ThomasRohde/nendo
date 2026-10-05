# MCP interface contract

This contract lists the twenty-four resources and twenty-five tools that an external
agent sees, and the authority rules behind them. `Test-Production.ps1` asserts
both surfaces by name, and this sentence is held to the same count by
`Test-Repository.ps1`.

The server instructions, and every tool, parameter and resource description, are
held to 2,000 characters. Claude Code shows each of them only up to 2,048
characters and drops the rest with nothing on the wire to say so, so the host
cannot see the cut and holds the bound itself. On 2026-09-27 the instructions were
2,755 characters and lost the sentence that says no SQL, file, process or network
access exists; `add_operations` (2,179) lost its amend remedy and `import_records`
(2,056) its retry sentence. The instructions now say what the file is, the first
read, how to take the lease and keep the handle private, to save `receiptContext`,
what does not exist, the smaller first read for one record type, that a
predecessor's proposals may be waiting, and who accepts a proposal at the current
level, in under 2,000 characters across their variants (W-150 took them to the bound). The paragraph for someone writing a
2026-07-28 client by hand left them: `server/discover` and this contract carry it.
The rules that were the second half of the `add_operations` description are the
vocabulary's `authoringRules`, which the description names.
`SurfaceTextBoundTests` reads every variant back through both handshakes and every
description through the lists; with the old text restored it failed at 2,752,
2,179 and 2,056 characters.

Two of those tools came with the [ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)
amendment of 2026-09-22. *Edit data* serves `nendo.data.import_records`.
`nendo.change_set.accept` is served only at **Unattended**, the fifth access
level. At every level below Unattended, the tool is not registered at all. If a
client sends it by name, the boundary refuses it as `NENDO_UNATTENDED_REQUIRED`, a
`-32602` protocol error that names the level. The service's own mode check is the
second lock behind that refusal.

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

Since 2026-10-04 (W-151) the 2026-07-28 path also serves `subscriptions/listen`. A
client that opens it with `resourceSubscriptions` is acknowledged for the three URIs
this host pushes, `nendo://application/manifest`, `nendo://application/proposals` and
`nendo://application/health`, and every other URI is acknowledged out. The stream then
carries `resources/updated` for the manifest and the proposals on every commit the
Engine makes (a commit may stale every proposal), for the proposals when one joins the
queue or leaves it by promotion or rejection, and for health when the file closes, after
which the stream ends; each notification carries the listen request's id under
`_meta/io.modelcontextprotocol/subscriptionId`. `toolsListChanged` is not honoured: a
change of access level restarts the listener, and the stream ending is that signal. A
stream holds one of the sixteen request-gate places for its life and is exempt from the
request timeout; at most four are open at once, and the fifth is `NENDO_BUSY` naming the
cap. Before, an agent at Shape app validated and had no signal when the person accepted,
and the planner mod polled every sixty seconds. The planner mod still polls: the hook
API's HTTP fetch returns a whole response and cannot hold a stream, which is recorded on
the planner item. [The listen tests](../../tests/Nendo.LocalMcp.Tests/SubscriptionsListenTests.cs)
read the stream as the wire carries it; the SDK's client has no listen helper in 2.2.0.

Since 2026-10-05 (W-171) a stream may also name one record type's records,
`nendo://application/entity/{entityId}/records` with the ID filled in; the template
itself is acknowledged out. The stream then carries `resources/updated` for that URI on
every commit that changes a record of that type, through any writer, an automatic
action's writes included, or that changes the definition. Its `_meta` carries
`io.github.thomasrohde.nendo/changes`: `changeSequence`, the `revisionIds` committed,
`entityId`, the changed `recordIds` (at most 100, with `truncated` past that) and
`definitionChanged`. A client waiting on the requests a screen's buttons file reads
those records instead of paging the type every few seconds, which an outside author had
built (MCP-FEEDBACK.md #1). The Engine raises the commit with what it changed
(`NendoApplicationService.CommittedChanges`); a commit that changes no record of the
type and not the definition says nothing about it.

The handshake-era `resources/subscribe` is not served. This host is stateless
Streamable HTTP: a handshake client holds no standing stream for the host to write a
notification to after its request has been answered, so a subscription would be
acknowledged and then never heard from. A client on that path polls, or moves to the
2026-07-28 path.

Since 2026-10-04 (W-154) the host also serves the Skills extension
(`io.modelcontextprotocol/skills`, SEP-2640), declared on `server/discover` and
`initialize`, with one host-level skill: `skill://nendo-authoring/SKILL.md`, whose
frontmatter names it `nendo-authoring` and whose body says which read answers which
question, the lease and the receipt, how a change set becomes a proposal, every
operation with its payload keys, the bounds, the examples and the refusals to expect,
generated from the same tables the vocabulary is. Its supporting files are
`skill://nendo-authoring/references/vocabulary.json`, `examples.json` and
`view-api.json`, the same bytes as the three build-static reads. `skills/list` returns
its entry first with its complete manifest, each file's `sha256:` digest and byte size
computed from the bytes `resources/read` serves; `skills/get` returns it by URI, with
`cacheScope` `public` and the one-hour TTL, and any URI it does not serve is `-32602`
`NENDO_SKILL_NOT_FOUND` naming the ones it does. Every read of the four carries the
one-hour TTL. `directoryRead` is not declared. `HostSkillTests` holds each digest and
size equal to a read of the file, and the frontmatter equal to the entry's.

Since 2026-10-05 (W-160, [ADR-0024](../decisions/0024-a-file-carries-its-own-agent-skill.md))
a file may carry its own skill: a package of kind `skill`, accepted by its person like any
package ([custom-view contract](custom-views.md#skill-packages)). `skills/list` lists each
one after the host's, by package ID, at `skill://{packageId}/SKILL.md`, its frontmatter read
from that file (`name` is the package ID's last segment) and its manifest the stored SHA-256
and size of every file, `SKILL.md` first. Its files are the template
`skill://{packageId}/{+path}` (`nendo.application.skill.file`): text as text and anything else as a
blob, so the digest of what a client receives is the one listed; a package that is not a
skill, or a path it does not hold, is refused. The template also answers the host skill's
own URIs with the same bytes. Because the list follows the open file, `skills/list` is
`private` with TTL 0, and so are a file skill's `skills/get` and reads. A file with no
skill package lists the host's skill alone. Nothing in the host vouches for what a file's
skill says: loading it is the client's act under its own approval, and the person's
protection is the review before acceptance. `FileSkillTests` holds the listing before and
after acceptance, every digest and size against a read, and the refusals.

Since 2026-10-04 (W-152) the host also serves the Tasks extension
(`io.modelcontextprotocol/tasks`, SEP-2663, `ModelContextProtocol.Extensions.Tasks`
2.2.0). A client that declares the extension on its request runs three tools as a task
it polls with `tasks/get` and may stop with `tasks/cancel`: `nendo.change_set.validate`
(a physical clone plus compilation), `nendo.data.import_records` (up to ten batch
revisions) and `nendo.health.verify_integrity` (a full scan); `NendoLocalMcpHost.TaskCapableTools`
names the three. A client that does not declare it is answered as before, and every
other tool is answered at once whatever the client declares: a write is answered, not
polled for. The task's result is the tool's result, refusals included. Task state is
host memory keyed by task ID, with a thirty-minute TTL that says it dies with the
listener. A task never extends a lease. `tasks/cancel` on a validate cancels its clone
by the existing path, so no proposal the agent cannot reach is left behind. What the
review asked for and this does not do: a validate task that stays `working` until the
person accepts. A task's result is its tool's result, and acceptance is not validate's
outcome; the wait is `subscriptions/listen` on `nendo://application/proposals` and then
`nendo://application/proposal/{proposalId}`, which says `active` once accepted. The
[Tasks tests](../../tests/Nendo.LocalMcp.Tests/TasksExtensionTests.cs) hold the three.

The discovery document names the discover-path headers and the three
`io.modelcontextprotocol/*` `params._meta` keys. A hand-written client therefore
does not have to learn them from errors. The document also carries `displayName`,
the name of the open file. Before, the advertisement identified the endpoint, the
process and the application, but not the file behind them. With two Nendo windows
open, the only answer to "which file do you want?" was to cross-reference the
process ID in the write-owner sidecar.

A client shows none of that before its first call, so the file is named where it
does look (W-089). `serverInfo.title` is `Nendo · <file>` (`Nendo · BCM` for
`BCM.nendo`), so two registered files read as two servers in a client's list. The
instructions open with `This is the Nendo file BCM.nendo:`. The lease grant and
`nendo.lease.status` carry `fileName`. The title and the instructions cut a name
past 60 characters, so a 255-character file name cannot push the instructions past
their bound; `FileNamedSurfaceTests` holds all four, and with the name withheld it
failed on `Expected "Nendo · fixture"`, reading `Nendo`.

`displayName` is a label and not a location: it has no directory and nothing that
an agent could open. Agents never receive a database path
([vision.md](../vision.md)). If a caller supplies one, the host reduces it to its
last segment. File resources and catalogs carry private, zero-TTL cache hints.
`nendo://application/vocabulary`, `nendo://application/examples` and
`nendo://application/view-api` describe the host build rather than the open file,
and carry a one-hour `ttlMs`. Tools are
listed in stable name order.

Every tool, resource and template carries a `title`, and `serverInfo` carries
`title` (Nendo and the file), `description` and `websiteUrl`. No response names the web server
behind it. `destructiveHint` is true exactly where a tool overwrites or removes what
is stored: `set_field`, `move_record`, `execute_command`, `delete_record`, `amend`,
`reject` and `accept`. On 2026-09-27 the first three said false, which the
specification reserves for additive updates. `nendo.lease.acquire` states the
lease's lifetime in its own description. Every property of every output schema
carries a description: the adapter's own result records through `[Description]`
beside each member, and the Engine's records that reach the wire (the receipt,
generated changes, assigned values, diagnostics, semantic diff entries and package
changes) through `NendoWireDescriptions`, which the schema transform applies. Before,
the twenty output schemas described no property at all, so what a null
`recordVersion` meant lived in comments no client reads. `SurfaceMetadataTests`
holds each of these, and each was seen to fail with its defect put back.

The host serializes every tool result with nulls present. The output schema that
is generated from a return type lists nullable members as required. A payload that
dropped one therefore failed validation in any client that checks the schema the
tool advertises. `nendo.lease.acquire` and `nendo.change_set.validate` both failed
in this way.
[Output schema contract tests](../../tests/Nendo.LocalMcp.Tests/OutputSchemaContractTests.cs)
call every declared tool and check its payload against its own declared schema.

Host/Origin/address/body checks occur before dispatch. A body is at most 256 KiB
(`limits.requestBodyBytes`). A larger one whose JSON-RPC `id` the host can read in its first
16 MiB is answered under that id rather than as a bare HTTP 413, which a client reports
as a transport failure (W-165): a `tools/call` as a refused tool result carrying
`NENDO_REQUEST_TOO_LARGE` in text and `_meta`, anything else as a JSON-RPC `-32600` error
with the code. Inside a record write, one value holds at most `limits.recordValueBytes`
(32 KiB) and one write's values together `limits.recordValuesBytes` (64 KiB), counted as
UTF-8 bytes of the value as stored: a string's own text, not its JSON escapes, which the
.NET client SDK writes for every non-ASCII character. Over them is `NENDO_VALUE_TOO_LARGE`
or `NENDO_VALUES_TOO_LARGE`, naming the field, the cap and the size. A body
nests at most 32 levels; a deeper one is `NENDO_INVALID_JSON` naming its depth and
the cap. The cap was 16 until 2026-09-27, two levels over the deepest published
example, and `ThePublishedExamplesLeaveRoomUnderTheDepthCap` now holds eight levels of
headroom. At most 16 requests are in progress at once, counted from before the body
is read, so a request still sending its body holds a place: the next is `429`
`NENDO_BUSY` with `Retry-After`. A request, its body included, may take five minutes
(`NendoLocalMcpHostOptions.RequestTimeout`); past that it is cancelled and answered
`503` `NENDO_REQUEST_TIMEOUT`, which says that a write may still have committed and
that `nendo.data.get_receipt` says whether. Nothing bounded either before. The results
that make an exact retry replay are kept, per lease, for the newest 256 calls of each
kind (begin, add and amend, validate, reject, accept); a retry older than that is a
new call. A session holds at most `draftsPerSession` open drafts and, since 2026-10-04
(W-144), `proposalsPerSession` validated proposals, each a clone of the file; the
seventeenth validate is `NENDO_PROPOSAL_LIMIT` and clones nothing. Both limits are in
the vocabulary. They were kept for the life of the lease, which has no expiry by default.
A validate's replay lasts only while the draft holds what it validated: `add_operations`
and `amend` both forget it, so a validate retried under its old key after either
compiles the draft again (W-142; add used to leave the stale verdict in place).

Lease acquisition mints an
opaque `applicationHandle` in addition to `leaseId`. Supply both on every owned
operation, including renew/release and proposal preview. Possession of the handle
governs ownership, not claimed client names or HTTP connection identity. Keep the
handle private.

Since 2026-10-04 (W-143) `nendo.lease.acquire` takes two optional arguments. An
`idempotencyKey` makes an exact retry return the grant it already made while that
lease is held, which is the recovery for a lost acquire response; before, the retry was
`NENDO_LEASE_HELD` against the agent itself, and the refusal sent it to `lease.status`
with a handle it never received. A `resumeApplicationHandle`, a handle this host run
minted earlier, grants a new lease under that same handle, so the proposals the
session validated, its pseudonym and its receipt scope are its own again. The handle
is kept rather than retired because all three are keyed on it, and because a write's
origin is part of what an exact replay must match. A handle this run never minted is
`NENDO_HANDLE_UNKNOWN`; the holder of a live lease asking by its own handle gets that
lease back. Drafts still end with the lease: only validated proposals carry over.
`nendo://application/proposals` names each proposal's `changeSetId` and `owner`, the
pseudonym the grant reports, so a session can tell its own before it acts. The
adapter's parameter for the handle is now called `applicationHandle` throughout; it was
`sessionId`, which hid that a reconnect minted a new one.

By default, the lease ends on explicit release, user revocation or host stop. An
owner can enable a bounded expiry in Agent → Connection. The
device settings writer merges only the controls changed in that window with the
latest saved settings, under the required cross-process lock. A stale window's
port edit cannot restore an older lease-expiry choice. The
same window retains unsaved field intent through a failed persistence attempt
and an identical retry. In either mode, the
closure of an agent alone does not end the lease. If the file is closed, switched,
replaced or recovered, the endpoint and the authority become invalid. A healthy
restart of only the renderer preserves them. Receipt lookup requires no live
handle and cannot restore editing authority. No adapter gets SQL, SQLite handles,
physical mappings or arbitrary host invocation.

| Resource | Current adapter and shared application service | Projection / outstanding cost |
| --- | --- | --- |
| `nendo://application/describe{?include}` | `GetDescriptionAsync` → the projections below | What the file is for, then the manifest, authoring limits, every record type with its fields, every compiled screen, health, `extensions` (every custom-view package the file carries, with its files but not their bytes), and `reads`: every resource URI this host serves, generated from the declared resources. It answers the reconnaissance phase without 1 + N round trips. `resources/list` returns only the parameterless resources, so the read path for records was reachable only through `resources/templates/list`. A review concluded from the seven listed entries that the data API was write-only, and it opened the SQLite file directly to check its own writes. Since 2026-10-04 (W-150) `include` takes a comma-separated subset of `manifest`, `limits`, `entities`, `surfaces`, `health`, `reads`, `extensions`, `newFile`; a facet left out is null or empty and `included` says what came; an unknown facet is refused naming the eight. |
| `nendo://application/examples` | `NendoAuthoringExamples.Description` | Seventeen complete contract version 3 change sets that can be sent without change: `create-entity-with-required-fields`, `configure-a-reference`, `a-breakdown-and-a-ring`, `a-trend-and-an-activity-grid`, `a-matrix-and-a-ranking`, `a-board-with-a-lane-per-project`, `build-a-detail-surface`, `define-a-command`, `two-commands-and-a-filtered-list`, `several-views-tabs-and-a-calendar`, `a-timeline-of-spans`, `a-gallery-and-a-rating`, `a-front-page-for-the-file`, `say-what-the-file-is-for`, `calculate-and-act-automatically`, `show-a-custom-graph`, `put-a-custom-view-in-the-file`. Each example carries the authoring rule that it conveys. Static for a host build. [The example tests](../../tests/Nendo.LocalMcp.Tests/AuthoringExampleTests.cs) replay every example through the real authoring boundary, so an example that stops validating fails the build. |
| `nendo://application/manifest` | `NendoResourceProjection.GetManifestAsync` → `GetDefinitionSnapshotAsync` | What the file is for, plus identity and revision counters, without record/history reads. `look` is the tone and letter of the badge the file's icons carry, as drawn, with `toneChosen` and `letterChosen` saying which parts the file chose (`application.setLook`) rather than has by default. |
| `nendo://application/vocabulary` | `NendoSemanticVocabulary.Description` + `NendoAuthoringOperations.All` | Every contract version 3 node kind with its permitted properties, required properties, permitted children and root ceiling: `maxRootsPerEntity`, or `maxRootsPerFile` for a root that belongs to the file and not to a record type. The closed filter operators, value kinds, ordering directions and aggregates. The `and` combinator that joins sibling `filterClause` children, and the note that version 3 has no OR and no grouping. The closed `choiceTones` that a choice option may carry. The `charts` rule with its closed groupings and its ceiling on groups. The `overview` rule with the one front page that a file may own and the ceiling on a recent list. The authoring limits. `operations`: every canonical operation with the payload fields that it requires and accepts. `authoringRules`: the rules that are easy to break and expensive to discover — definition identifiers global to the file and record IDs scoped to their type, a required field in the same mutation as its entity, the omitted revision the host fills in, inline node properties and what they cost, one contract version across roots, where a payload is refused, amend after a failed validate, and who accepts — from `NendoAuthoringOperations.Rules`. It is generated from the tables that the compiler and the authoring boundary validate against. `NendoAgentAuthoringService` builds its accepted field sets from the published table, so a documented field is an accepted field. Static for a host build: it describes the host, not the open file. |
| `nendo://application/entities` | `GetEntitiesAsync` → `GetDefinitionSnapshotAsync` | Stable entity IDs and display labels; no record projection. |
| `nendo://host/instances` | `NendoDiscoveryStore.ReadLiveEntries` | Every Nendo that runs on this device and the file that each one has open. `isThisOne` marks the host that answers the read. This is the only resource here that is not about the open file. The host has written this directory since discovery existed, but nothing read it. An agent therefore could not tell a person which file it was about to write to, and a second Nendo was unreachable in practice (F-064). An entry is admitted on the same terms that the stale sweep uses to keep one, so a dead host is never offered as a place to work. Each entry carries the name of the file and never a path. The resource does not make another endpoint reachable. A client reaches the address that it was registered with and cannot redirect itself. Switching therefore stays the action of the person, and the resource states this in its own `note`. |
| `nendo://application/entity/{entityId}` | `GetEntityBundleAsync` → schema, count and surfaces | One record type as a bundle (W-150): its schema with `recordCount`, the compiled surfaces that belong to it and the diagnostics that name it. With `manifest`, the small first read for a session that works on one type; `describe` is 69 KB on the planner and most of it is screens. |
| `nendo://application/entity/{entityId}/schema` | `GetSchemaAsync` → `GetDefinitionSnapshotAsync` | Semantic fields, storage kinds, required/presentation/options, and a rating field's `scale` with its `min` and `max`. |
| `nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}` | `GetTreeAsync` → `TreeRecordsAsync` | A declared hierarchy depth-first (ADR-0019): the records under `root`, or from the top level, down to `depth` levels (1 to 32, default 1), each with `parentRecordId`, `depth` and `childCount`. Refused past 10,000 records as `NENDO_HIERARCHY_TOO_WIDE`; position-cut pages with a revision-bound continuation. |
| `nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter}` | `GetRecordsAsync` → `QueryRecordsAsync` | Storage keyset page in stable record-ID order; revision-bound continuation. Since 2026-10-04 (W-145) the same typed query the screens use: `recordId` reads one record, `sort` and `desc` order the page, and `filter` is a percent-encoded JSON array of `{fieldId, op, value}` joined by AND, `op` one of the vocabulary's `filterOperators` (`lte` and `gte` are mapped to the Engine's `le` and `ge`) plus `contains` and `descendantOf`. An unknown operator is refused naming the ten accepted; an unknown field, naming the record type's fields. The Engine's own bounds apply: at most eight filters, and a calculated field filtered or sorted within `limits.query`. |
| `nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}` | `GetAggregateAsync` → `CountRecordsAsync`, `AggregateRecordsAsync`, `GroupAggregateRecordsAsync`, `CellAggregateRecordsAsync`, `BucketAggregateRecordsAsync` | One exact `count`, `sum`, `min` or `max` over the records a `filter` leaves, as invariant lexemes and without paging (W-146): whole, grouped by one closed field (`groupBy`), as a grid of two (`rowBy`, `columnBy`) or per civil-date bucket (`dateFieldId`, `bucket`, `range`). `shape` says which sections are filled; an empty set is null, never zero; `unrecognised` counts stored values outside the configured groups. `avg` is refused for the vocabulary's reason. `aggregate-not-exact` stays withheld. `describe` and `entity/{entityId}/schema` carry `recordCount` per record type. |
| `nendo://application/surfaces` | `GetSurfacesAsync` → `CompileSemanticDefinitionAsync` | Cached verified definition, with no records. Surface roots appear under `applications[].surfaces` as an ordered node tree with `nodeId`, `kind`, `properties`, `children` and, on a command root, the `commandId` that `nendo.data.execute_command` takes. The removed contract version 1 and 2 `form`/`list`/`board`/`command` slots are gone from this resource as of 2026-09-12. The front page of the file, if it has one, is under `overview` and not among the record types. `state` is `valid`, `invalid` or `noCustomSurfaces`. Every node also carries `surfaceId`, `parentNodeId` and `position` (W-168), read from the stored definition beside the plan: the plan carries none of them, because the definition digest is taken over what a node draws and not where it is kept. An author changing an existing file needs all three for `ui.moveNode`. |
| `nendo://application/history{?cursor,limit}` | `GetHistoryAsync` → `QueryHistoryAsync` | Bounded revision summaries in ascending sequence order. `operationCount` and `operationsUri` replace the unbounded nested `operations` array. |
| `nendo://application/revision/{revisionId}/operations{?cursor,limit}` | `GetRevisionOperationsAsync` → `QueryRevisionOperationsAsync` | Bounded sanitized operation descriptors in ordinal order. No canonical payload, raw inverse or physical mapping escapes. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | `GetCsvExportAsync` → `ExportCsvPageAsync` → `QueryRecordsAsync` | One page of the record type as faithful Nendo CSV. This is the profile that the person's own Export writes, so the output can go directly back to `nendo.data.import_records`. The header row carries display names and appears on the first page only, so the pages concatenate into one document. `fieldIds` gives the stable ID behind each column, and an import maps by that ID. The same 1–100 limit and the same revision-bound cursor apply as on every other page here. It is a resource and not a tool, because reading is a resource in this product and because Inspect keeps an empty tool list. |
| `nendo://application/proposal/{proposalId}` | `NendoAgentProposalStore.TryGet`, else `GetProposalAsync` | One proposal in full (W-148): semantic diff, diagnostics, package changes, behaviour and the after-acceptance summary, for any proposal the Engine holds, since the person already reads all of it under Pending changes. No lease, so a fresh session reads its predecessor's work; `changeSetId` and `owner` say whose it is, null for a proposal another client prepared. `state` is live by the same rule as the list, and an accepted proposal reads `active` (F-261; until 2026-10-04 it was `NENDO_PROPOSAL_NOT_FOUND`): with its title and diff while this host run holds them, which `NendoAgentProposalStore` keeps for the last 64 it accepted, and from the Engine's receipt alone after a restart or for one the person accepted that this adapter never queued, where the title says so and the diff is empty. |
| `nendo://application/proposals` | `NendoAgentProposalStore.Snapshot` | Every validated proposal that waits for a person, with its title, `changeSetId`, `owner` pseudonym, captured revision, state, operation count, diagnostic count and the most severe reversibility class that it carries. A proposal still `previewable` in the store whose captured definition revision is no longer the file's reads `stale` here, which is what its acceptance would say (W-144; the store itself is rewritten only by an attempted promotion). This is the recovery path after a reconnect or a lost response. Before, a pending proposal was invisible, and each proposal captured a revision that the acceptance of any other proposal invalidates. |
| `nendo://application/health` | `GetHealthAsync` → `GetDefinitionSnapshotAsync` | Lightweight status with the time of the last integrity check and the change sequence. A status read does not run integrity again. `changesSinceIntegrityCheck` and `integrityStale` state how far the file has moved since that result was measured. An `ok` taken thirty-two changes ago therefore cannot be read as `ok` now. `nendo.health.verify_integrity` requests a measurement. |
| `nendo://application/extensions` | `GetExtensionsAsync` → `GetDefinitionSnapshotAsync` | Every custom-view package that the file carries: its ID, title, version, entry point, description and total size, and each file's path, media type, SHA-256 and size. No content. A view that names a package runs its code in the Workbench when the view is shown ([custom-view contract](custom-views.md#packages-in-the-file)). |
| `nendo://application/extension/{packageId}/file{?path,offset,length}` | `GetExtensionFileAsync` → `ReadExtensionFileAsync` | One package file, a page of bytes at a time. `path` is percent-encoded, so `tiles/world.bin` is sent as `tiles%2Fworld.bin`. `offset` and `length` are byte positions. `length` is at most 131,072, and by default the page runs to the end of the file up to that. A text file's page arrives as `text`. Any other page arrives as `base64`, and so does a text page that would split a UTF-8 sequence. `sha256` and `byteLength` describe the whole file, and `nextOffset` is null on the last page. |
| `nendo://application/view-api` | `NendoViewApi.Json`, embedded from the Workbench's api build | `window.nendo` as a custom view's code calls it ([custom-view contract](custom-views.md#the-view-api-as-a-read)): every broker method with its call, parameters and answer, the helpers `api.js` adds, the context and record shapes, the events, the filter words, write values, toolbar kinds, icons and keys, theme tokens, limits, refusals, a whole view to start from, and how a person develops a package from a folder. Read only while an agent writes a view's code (W-094). The instructions, the vocabulary's `extension.setPackage`, the custom-view example and describe's `reads` each name it with that condition and carry none of it; `ViewApiResourceTests` fails when one of them does. Static for a host build. |

All four page resources (records, export, history and revision operations) keep
the MCP 1–100 limit. `limit` is a whole number in
that range. Any other value is `NENDO_INVALID_LIMIT`: letters, a fraction, a value
larger than an integer holds, an empty value, `0` or `101`. The template variable
arrives as text, and Nendo classifies it. Before, the SDK's binder refused a
non-integer first, and the client saw a bare internal error with no code.

If a data or definition change occurs between pages, the read returns
`NENDO_STALE_CURSOR`. Restart the query. Foreign, tampered, reopened-file or
earlier agent-access cursors fail. The query is a set: `cursor` and `limit` may
come in either order, and an empty `cursor=` is the first page. Before, the SDK
matched the template's expansion as written, so `?limit=2&cursor=` was an unknown
resource URI and `?cursor=&limit=2` an invalid cursor. A query parameter that the
template does not declare, or one given twice, is `NENDO_INVALID_REQUEST` naming the
parameters it does take. See the [read and authority contract](reads-and-authority.md).

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
| `nendo.lease.acquire` | `NendoAgentAuthority.AcquireAsync` | One handle-bound modifying lease. Returns applicationHandle, leaseId, an unprivileged receipt locator and the open file's name before writes. Optional `idempotencyKey` (an exact retry returns the same grant) and `resumeApplicationHandle` (a new lease under an earlier handle of this run). No file mutation. |
| `nendo.lease.renew` | `NendoAgentAuthority.RenewAsync` | Same live handle. Extends an enabled TTL, or confirms ownership when expiry is off. No file mutation. |
| `nendo.lease.release` | `NendoAgentAuthority.ReleaseAsync` | Serialized lease release. No file mutation. |
| `nendo.lease.status` | Current endpoint, no lease needed | `GetStatusAsync`. Reports whether a lease is held, the client display name and pseudonym of the holder, the open file's name, and, if a handle is supplied, whether the lease is yours. This is the recovery path when an acquire response is lost: the grant exists, and no other call can report it. |
| `nendo.data.create_record` | Data mode or higher, live lease; `NendoDataMutationService` | `CreateRecordAsync` → `data.createRecord`, bounded values and server-scoped idempotency. Returns the record ID and its new version, and `alsoChanged`: each other record that an automatic action changed while this write committed, with its new version. `alsoChanged` is empty when no action ran, and when the target reference of every step was empty. An idempotent replay names the same records with `recordVersion` null, because the file may have moved since. The receipt that `nendo.data.get_receipt` reads back does the same. A value map that names a calculated field is `NENDO_FIELD_CALCULATED`, and the refusal names the calculation. |
| `nendo.data.create_records` | Same | `CreateRecordsAsync` → one mutation of 1–50 `data.createRecord` operations: one revision, one idempotency key, all or nothing. Since 2026-10-04 (W-147) a record may carry `references`, each target named by record ID or by a unique field's value, and the host writes the ID and current version: the rule CSV import's `matchFieldId` follows, now one rule for both formats and for `create_record`, `update_record` and `apply_writes`. One mapper turns a record input into an Engine entry for a create, a batch and a JSON import. A reference is resolved to its target's current version before the Engine sees the write, and the Engine replays a key only for the payload it committed, so since 2026-10-04 (F-258) an exact retry of a write that names `references` carries the target versions its committed revision recorded, read back by the key's receipt, for `create_record`, `create_records`, `update_record` and `apply_writes` alike: a retry after a lost response replays even when the target was edited in between, and a different payload under the used key is still `NENDO_IDEMPOTENCY_CONFLICT`. `recordVersion` is the version that every created record holds. If an automatic action wrote back to only some of the records, `recordVersion` is null, because no single number is true of the batch. `alsoChanged` names each moved record with its own version. |
| `nendo.data.import_records` | Same | `ImportAsync` → `NendoImportService` → `CreateRecordsAsync`. Takes CSV text or typed JSON; a mixed payload is refused before writing. The native importer's routine decodes CSV, and the same canonical `data.createRecord` operations commit it, fifty to a revision. Unknown, duplicate or out-of-range CSV mappings are typed validation refusals, and so is a required field left unmapped, except one with a sequence (ADR-0020): since 2026-10-04 (F-259) a generated code's column may be left out or its cells left empty, under either profile and either `emptyIsNull`, and the host assigns the next code as it does for a create that leaves the field out; a code the row carries is kept. At most `limits.import.rowsPerCall` rows per call; the 256 KiB body is the limit met first. `maximumRowsPerCall` echoes the limit on success. Each batch derives its idempotency key from the caller's key (the key, `#` and the ordinal, or `import.sha256.` and the key's SHA-256 when that would pass 200 characters); a CSV record ID derives from that key and its row position. A retry gives the rows of batches its key already committed the reference target versions their revision recorded, so an exact retry replays after a referenced record is edited; uncommitted rows resolve against the current file. If a later batch is refused, or cancelled, or fails in storage, `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, first uncommitted data row, committed revision IDs and cause (until 2026-10-04 only a Nendo refusal was reported this way; a cancellation or IO failure after a committed batch escaped without the counts). Retry the identical call and key to replay the earlier batches without duplicates. No response implies the whole call was atomic. Each batch revision carries the session's pseudonym as its origin, as every other agent write does (it carried a bare `agent` until 2026-09-27). The origin is part of what a replay must match, so a retry resubmits a batch that already committed under the origin its receipt records, and an exact retry from a new lease still replays. |
| `nendo.data.set_field` | Same | `SetFieldAsync` → `data.setField`, expected touched-record version. `alsoChanged` as above. `recordVersion` is the version that the record holds after the revision. If an action wrote back to the same record in that revision, the version is past expected + 1, and `alsoChanged` also names that record. A text or choice value is the JSON string itself. A choice is refused with the declared options and an echo of the value that arrived. A calculated field (`derivedFields` in the schema read) is refused as `NENDO_FIELD_CALCULATED`, which names the calculation. It is not refused as a field that does not exist. |
| `nendo.data.delete_record` | Same | `DeleteRecordAsync` → `data.deleteRecord`, expected touched-record version. Incoming references block deletion, and the refusal names the referring records. Exact retries return the committed outcome. `alsoChanged` as above. |
| `nendo.data.set_kept_in_new_files` | Same | `SetRecordKeptInNewFilesAsync` → `data.setKeptInNewFiles` (ADR-0022): `kept` true, false or null to follow the record type. Changes no value or version and runs no action, so `recordVersion` is null and `recordIds` names the record. The create tools take `keptInNewFiles` to mark in the same revision. `describe` gives each type's `keptInNewFiles`, the manifest's `newFileLabel`, and `newFile`: per type how many records a new file keeps and leaves out, and each kept record that points at a left-out one. A record read carries `keptInNewFiles` only when the record has its own mark. Making a new file is the person's, from the File menu; no tool does it. |
| `nendo.data.update_record` | Same | `SetFieldsAsync` → one mutation of 1 to 64 `data.setField` operations in stable field order (W-147): the Workbench's form save. One revision, one idempotency key; the record advances one version per field, and `recordVersion` is where it stands. `alsoChanged` and the calculated-field refusal as on `set_field`. |
| `nendo.data.apply_writes` | Same | `ApplyRecordWritesAsync` → one mutation of up to `recordWritesPerCall` creates, updates and deletes across record types (W-147): the batch the Workbench's forms commit. All or nothing; one write per record; a write may point at a record an earlier write created or updated, as a plain value or under `references` by record ID or by a unique field's value (W-166), and the host supplies that target's version. `records` names every record with the version it holds now, null after a delete and on a replay. `label` is what History calls the revision. |
| `nendo.data.undo_revision` | Same | `UndoRecordWritesAsync` with the lease's pseudonym as origin (W-153; ADR-0006 and ADR-0009 amendments of 2026-10-04): one compensation revision, linked to the revision it reverses, the undo History and a view make. A revision another origin committed is `NENDO_REVISION_NOT_YOURS`; a definition revision and an irreversible operation are refused by the Engine as for a view; an undo can itself be undone (redo). `records` names every record with its new version. |
| `nendo.data.move_record` | Same | `MoveRecordAsync` expands into typed `data.setField` operations in one revision: the parent, the order, and only when no gap is left at the insertion point the smallest run of siblings around it that fits between its ordered neighbours renumbered (ADR-0019); a sibling without an order is taken into that run. Until 2026-10-04 the whole level was renumbered whenever a neighbour had no order or no gap, so the planner's first move past an unordered sibling wrote 140 records (F-260). Needs a declared hierarchy; `parentRecordId` null moves to the top level, `beforeRecordId` needs an order field. `recordIds` names every record written; `recordVersion` is stated when the moved record was the only one. The Engine's rule refuses a move under the record's own descendants as `NENDO_HIERARCHY_CYCLE`, naming the loop. |
| `nendo.data.execute_command` | Same | `ExecuteCommandAsync` resolves the stored command, then typed `data.setField`. MCP does not implement domain commands. Returns the resulting `recordVersion`. A command advances the record by one version per `commandStep`, and the steps are in the stored definition. The caller therefore cannot derive the version, and without this value the next optimistic write had nothing to pin to. Null on an idempotent replay, where the version of the original write may have moved since. |
| `nendo.data.get_receipt` | Current endpoint, no modifying lease needed | `GetMutationReceiptAsync`. The saved locator binds the original app/instance/run/scope. A committed receipt carries `origin`, the pseudonym of the session that committed it, and `generatedChanges`: the records that the write's automatic actions changed, rebuilt from the revision's attributed operations, with `recordVersion` null. A lost response is therefore recovered without a re-read of every record. A missing receipt remains unresolved, and no write authority is granted. Since 2026-10-04 (W-144) the same key answers for an import: every batch its key committed, in order, under `revisions`, with the last as `receipt`; and `proposalId` in place of the key answers for an accepted proposal with the revisions its acceptance committed. Before, an import batch committed under the shared `agent.import` scope and an acceptance under its proposal were both unreadable here, though the description promised "a prior data-operation receipt" without the exception. |
| `nendo.health.verify_integrity` | Current endpoint, no lease needed | `VerifyIntegrityAsync`. Scans the file and returns the health measured now. The scan also reads every stored custom-view package content and compares it with its SHA-256. An unchanged file is not rescanned: `rescanned` is false, and the recorded result already describes the file. A call after every batch therefore costs nothing. A failed scan puts the host into recovery. That is the protection of the file, not a failure of this call. |
| `nendo.change_set.begin` | Shape app + live lease; `NendoAgentAuthoringService` | Captures typed authority in a bounded transient draft. No active mutation. |
| `nendo.change_set.add_operations` | Same owning handle/draft | Closed canonical DTOs: ≤16 operations per add and ≤128 submitted per change set, expanding to ≤512 canonical. One operation's payload is at most 32 KiB, and an `extension.putFile` payload at most 96 KiB. A larger package file is sent in parts: `putFile` operations with `append: true` continue the file that an earlier `putFile` of the same package and path began in this change set. The host joins the parts in order at validation. A part with nothing to continue is refused when it is sent. The host supplies IDs, and every response echoes every limit. `ui.addNode` accepts an inline `properties` map. At the boundary, the map expands to one `ui.setProperty` per property, so a node and its configuration cost one operation instead of one plus one per property. If `expectedDefinitionRevision` is omitted, the host resolves it from the position of the operation in the change set, so the caller does not model the host's counter. A supplied value is honoured exactly. No active mutation. |
| `nendo.change_set.amend` | Same owning handle/draft, not frozen | Drops every mutation from an ordinal onwards and appends replacements under the same per-call bounds. A correction of one bad operation costs one call, and the change set does not need to be rebuilt. A change set that validated is no longer a draft. Amend, `add_operations` and a fresh `validate` on it are `NENDO_CHANGE_SET_FROZEN`. The refusal names the proposal that the change set became and both remedies: reject the proposal and begin a new change set, or ask the person to accept it. An ID that this session never had is `NENDO_CHANGE_SET_NOT_FOUND: The change set does not exist.` No active mutation. |
| `nendo.change_set.validate` | Same | `PrepareProposalAsync(NendoCanonicalProposalRequest)` → canonical compilation → physical clone validation. Schema-only proposals are valid for Studio. Custom trees that are present must compile fully. A failed validation discards its private clone and leaves the draft open and amendable. Validation is therefore a repeatable dry run and does not end the change set. A change set that is refused reports each independent refusal together, up to five, each diagnostic naming its `operationId` (W-010). An operation that names something a refused one introduced, or a record it wrote, is left out rather than reported, and a version conflict that leaving an operation out causes is never reported. Each further refusal costs one more clone of the file. The result, like every proposal the host returns (`preview`, `revalidate`, `proposals`, `proposal/{proposalId}`), carries `isValid`: true for `previewable`, and `active` once accepted; false for every other state. Warnings alone never make it false (W-167). |
| `nendo.change_set.revalidate` | Same owning session | Rejects the owned proposal and validates its kept operations again as a new draft captured at the current definition revision, through the same clone validation (W-157; ADR-0007 note of 2026-10-04). The new proposal keeps the `changeSetId`; a draft that no longer validates stays open to amend. The operations are kept behind every validated proposal until it is accepted or rejected, and survive a lease release as the proposal does. Not a rebase: nothing is merged, and promotion replays the newly validated digest as always. |
| `nendo.change_set.preview` | Same owning session | Reads the retained typed preview through `NendoAgentProposalStore.GetOwned`. No active mutation and no new acceptance authority. The lease it takes is proof of ownership, not a write; the lease-free read of the same preview is `nendo://application/proposal/{proposalId}` (W-148). |
| `nendo.change_set.reject` | Same owning session | Removes the owned draft/preview and calls generic `RejectProposalAsync` for its derivative workspace. |
| `nendo.change_set.accept` | **Unattended only**, same owning session | `NendoAgentProposalStore.PromoteAsync`, the method that the person's own Accept button calls, with the proposal's reviewed operation digest. The digest is never omitted. `applied` false is an ordinary answer. `state` says whether the file moved (`stale`), the reviewed plan no longer matches (`failed`) or the proposal still waits (`previewable`). The proposal stays where it is. `behaviourApproved` says whether this acceptance also recorded the device's consent for automatic actions that it installed. `revisions` lists every History revision the acceptance committed (W-148), so confirming it needs no history page. A change set that is still a draft is `NENDO_CHANGE_SET_NOT_VALIDATED`. |

`nendo.change_set.begin` reports how many other change sets are already open
against this file, with an advisory that names the captured revision. Every open
proposal captured a revision, and the acceptance of any one of them invalidates the
rest. Before, this appeared only at the approval dialog, after the review.

Later operations in a change set may edit records that earlier operations in that
change set created. Those records have no active-file version to include in the
staleness capture of the proposal. Ordered replay on the proposal clone checks
their expected versions, and promotion checks them again.

Invalid validation remains a dry run even if its caller cancels while private
preview cleanup waits. Required cleanup finishes before the invalid verdict
becomes replayable, and the draft remains amendable. A preview handed over for
review retains its normal frozen state.

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

The preview also carries `behaviour`: what accepting means for this device's consent
to the file's automatic actions ([ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md),
2026-09-29 amendment). It is null when the proposal asks nothing new. Otherwise
`createsRecords`, `updatesRecords` and `deletesRecords` say what the actions can do
once accepted. `generatedEffectCount` counts the writes they made on the clone, which
acceptance replays; above zero, acceptance is refused until consent for the behaviour
is held on this device. `changesWhatIsApproved` says that consent given today does not
cover the behaviour after acceptance, so editing pauses until it is given again. Both
at once cannot be accepted, by a person or at Unattended, because consent can only be
given to actions the file already holds: propose the actions first and the records
after. Pending changes, and each proposal in `nendo://application/proposals`,
carry the same `behaviour`.

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
creates it, with the title of that proposal and the required action: below
Unattended, the person's acceptance; at Unattended, `nendo.change_set.accept` for a
proposal this session validated. Until 2026-09-27 it said "there is no promotion
tool" at every level, which at Unattended sent an agent to ask for something it
could do itself.
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
for the maps, and one branch each for a string, a number, a boolean, `null` and the
`$nendoNumber` envelope for a field value. `InputSchemaContractTests` walks every
advertised node and sends the wrong shapes.

Every advertised node names one type. The exporter writes a nullable member as
`"type": ["integer", "null"]`, which is valid JSON Schema and which the MCP
Inspector warns on at every such node (its `type-union` rule): a client that maps
tool schemas onto a single-type dialect drops the constraint or refuses the tool.
On 2026-09-27 the twenty tools carried seventy-seven such nodes, every nullable
member in and out. The same transform hook now splits each into one `anyOf`
branch per type, each branch carrying the keywords that belong to that type, with
the description and the default left on the node. The Inspector's four rules
(`boolean-schema`, `type-union`, `untyped-schema`, `remote-ref`) are ported into
`EveryAdvertisedSchemaPassesTheInspectorLint`, which runs them over every input and
output schema and was seen to fail with 76 findings when the split was withheld.

Mutation versions are scoped by the pair of record type and record ID. A generated
write to the same ID in another type cannot change the caller's returned version;
an automatic deletion leaves no version. Commands resolve their owning type in
the typed application service. JSON import preserves each record's explicit
`keptInNewFiles` true/false/null mark, including across batch boundaries and exact
retries; changing that mark under an already-used key is an idempotency conflict.

The repository's package uploader packs at most sixteen operations in each
`add_operations` call, counting all mutations together. `--accept` treats only
`NENDO_UNATTENDED_REQUIRED` as a successful handoff for a person to accept. Other
refusals and transport failures exit unsuccessfully and name the proposal; after
a lost response, inspect Pending changes and History before acting again. The
acceptance key dies with the uploader's lease, so a rerun cannot replay it. A
transport failure does not establish that acceptance did not commit.

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
`record-version-conflict`, `record-not-found`, `field-not-found`, `field-calculated`,
`aggregate-not-representable`, and the hierarchy codes of ADR-0019 (`hierarchy-cycle`,
`hierarchy-cycle-present`, `hierarchy-too-deep`, `hierarchy-too-wide`,
`hierarchy-parent-invalid`, `hierarchy-parent-required`, `hierarchy-order-invalid`,
`hierarchy-already-declared`, `hierarchy-not-declared`, `hierarchy-field-in-use`,
`hierarchy-order-not-declared`, `hierarchy-sibling-not-found` and `move-unchanged`), the
uniqueness codes of ADR-0020 (`value-not-unique`, `field-values-not-unique`,
`field-unique-invalid`, `field-unique-unchanged`, `field-sequence-invalid`,
`field-sequence-unchanged`, `field-sequence-in-use`),
whose messages name records by stable ID and a loop as the chain of IDs it would close. `aggregate-not-exact` echoes a stored float, and it stays
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

- A call that does not fit its tool is refused before the SDK binds it, as a tool
  error that begins `NENDO_INVALID_REQUEST: {tool} was not called.` and then names
  each problem: an argument left out (`It requires idempotencyKey.`); a key the tool
  does not take, with the ones it does; a key inside a record, a mutation, an
  operation or a column mapping that it does not declare (`records[0] does not take
  'expectedTargetVersionz'; a record takes recordId and values, and optionally
  expectedTargetVersions.`); a value of the wrong kind (`expectedRecordVersion must
  be a whole number; it was a string.`). Before 2026-09-27 the binder answered a
  missing argument with `An error occurred invoking` and nothing else, and it bound
  a record with a misspelt key by dropping the key, so the write went ahead without
  it. The contract is read from the tool methods by reflection, through the same
  serializer options the binder uses, and `ToolRefusalTests` holds it equal to the
  schema every tool advertises, key by key. Every advertised arguments object and
  closed record declares `additionalProperties: false`. A whole number sent as a
  string still binds, as it did: a refusal here is never stricter than the call.
- A tool that a higher level serves is a `-32602` protocol error carrying that
  level's code, and the message names both levels and the person's remedy:
  `NENDO_SHAPE_APP_REQUIRED: nendo.change_set.begin is served from Shape app, and
  this file session is at Edit data. Ask the person to raise agent access to Shape
  app on the Agent page in Nendo.` Before, the SDK answered `Unknown tool`, so the
  three level codes could not occur from a real client. A name that no level serves
  is `-32602` `NENDO_TOOL_UNAVAILABLE`, as the specification asks of an unknown tool;
  it was a tool error.
- Since 2026-10-04 (W-149) every refusal a tool translates also travels as an object
  in the result's `_meta`, under `io.github.thomasrohde.nendo/refusal` (a reverse-DNS
  key from the project's own domain, as the `_meta` rules require): `{code, message,
  pendingProposalId?}`, the same code and sentence the text carries, and the proposal
  a pending-cause advisory named. The text stays for the model; the object is for a
  client, and `tools/Nendo-McpClient.mjs` reads it rather than scraping the text. A
  refusal the boundary makes before a tool runs, and every `-32602` protocol error,
  keep their text, which begins with the code and a colon. `StructuredRefusalTests`
  holds the object equal to the text for a precondition, an authority refusal, an
  authoring refusal and a pending-cause advisory.
- No tool or parameter description repeats a bound the vocabulary publishes (W-149):
  `add_operations`, `create_records`, `import_records`, `update_record` and
  `apply_writes` point at `limits` by name, and the vocabulary now publishes
  `recordsPerCreateBatch`, `fieldsPerRecordUpdate`, `idempotencyKeyCharacters`,
  `recordWritesLabelCharacters` and `import.rowsPerCall` and `rowsPerBatch`, which the
  adapter reads rather than restates. `NoToolDescriptionRepeatsABoundTheVocabularyPublishes`
  fails on the number or its word in any tool or parameter description.
- The perimeter's refusals say what to send instead. `NENDO_INVALID_HOST` names
  `http://127.0.0.1:{port}/mcp` and says that `localhost` is refused by design;
  `NENDO_INVALID_ORIGIN` names the one origin accepted; `NENDO_INVALID_JSON` names the
  depth a body reached and the cap, or the line and byte where it stopped being JSON;
  `NENDO_HOST_CLOSED` says why an endpoint closes and where the current one is shown.
  `NENDO_LEASE_HELD` points at `nendo.lease.status`, at the exact retry under the same
  `idempotencyKey` that recovers a lost acquire response, and at the person's revoke.
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
- `NENDO_UNATTENDED_REQUIRED` is what a client meets when it sends
  `nendo.change_set.accept` below that level: the boundary names the level, as
  above. The service keeps its own check as the second lock, for a build that
  registered the tool one level too low. Its message is *Unattended access is
  required. Ask the person to raise agent access to Unattended on the Agent page in
  Nendo.*
- `NENDO_CHANGE_SET_NOT_VALIDATED` is an accept for a change set that is still a
  draft. Its message passes through and tells the agent to validate first.
- `NENDO_INTERNAL_ERROR` names the exception type and a failure reference, and
  nothing else. The host hands the failure to the device that runs it under that
  reference, with the request's name, the exception types and the frames it passed
  through, and without an exception message, an argument, a handle, a lease or a path
  (`NendoAgentFailures`; the Desktop keeps it beside the view-failure record, under the
  same switch, per the [ADR-0002](../decisions/0002-containing-desktop-architecture-and-process-model.md)
  amendment of 2026-09-27). The SDK's and the web server's own warnings and errors
  reach the same record by event and exception type, never by their formatted message,
  and only while the host serves: a start that recovers from a busy port is not a
  failure, though the hosting layer logs each refused bind as an error.
  Before, the host cleared every log provider, and an internal failure left no trace.
- Every tool call is one entry in the activity the Agent page shows: the tool says
  what it did through a slot the host's filter holds for the call, and the filter
  writes the entry once, with the revision or proposal it touched. Before, a
  successful call wrote two entries, so the twenty the page shows held ten calls.

The closed authoring union is declared once, in `NendoAuthoringOperations`, and
that table serves two purposes. It is published at
`nendo://application/vocabulary`, and `NendoAgentAuthoringService` builds its
enforcement from it. Before, the payload specification was prose inside the
`add_operations` tool description. That prose grew so long that a real client's
tool listing truncated it mid-token. The rules that stayed behind went the same
way on 2026-09-27 and are now `authoringRules`. The union permits twenty-eight of the Engine's
thirty canonical operations. `data.restoreDeletedRecord` and
`identity.transition` are native-only: lifecycle identity operations remain host
services and are not MCP authoring primitives.

`extension.setPackage`, `extension.putFile`, `extension.removeFile` and
`extension.removePackage` are among the twenty-eight. An agent therefore writes a
custom view's code into the file through ordinary proposals, and the person reviews
it as code before accepting. Once accepted, the code runs in the Workbench whenever
a view that names its package is shown, and reaches the file only through
`window.nendo` ([custom-view contract](custom-views.md#packages-in-the-file)).
`extension.setPackage` also takes `kind`; with `skill` it writes the file's own agent
skill instead, which never runs ([skill packages](custom-views.md#skill-packages)), and the
example `teach-an-agent-this-file` is one to copy. No tool or resource reaches this device's
custom-view switches. The vocabulary
publishes the package bounds under `limits.extensions`:

- `fileBytes`: 4 MiB for one file;
- `packageFiles` and `packageBytes`: 512 files and 16 MiB for one package;
- `packages` and `totalBytes`: 64 packages and 64 MiB for one `.nendo` file;
- `contentBytesPerChangeSet`: 4 MiB of new content for one change set;
- `pathCharacters` and `packageIdCharacters`: 240 and 80;
- `putFilePayloadBytes`: 96 KiB for one `putFile` payload.

The bounds of a declared hierarchy are under `limits.hierarchy`: `maximumDepth` 32,
`maximumDescendants` 10,000 and `orderGap` 1,024. `schema.declareHierarchy` and
`schema.removeHierarchy` are among the twenty-eight, and a record type's schema read carries
its `hierarchy` (`parentFieldId`, `orderFieldId`), or null.

`schema.setFieldUnique` and `schema.setFieldSequence` are among them too
([ADR-0020](../decisions/0020-unique-and-generated-fields.md)). Each field in a schema read
carries `unique` and `sequence` (`prefix`, `width`, or null), and a write that would duplicate
a unique value is refused as `NENDO_VALUE_NOT_UNIQUE`, naming the record that already holds it
— never the value. A create may leave a numbered field out; the write result's `assigned`
lists each record, field and code the host wrote.

A change set past the content bound, or a file past 4 MiB once its parts are
joined, is refused at validation as `NENDO_INVALID_REQUEST`, and nothing reaches
the clone. A package precondition met on the clone, one of the `extension-*` codes,
arrives as a validation diagnostic, `NPROP010`, with the Engine's sentence.

`behaviour.setDefinition` and `behaviour.removeDefinition` are among the twenty-eight,
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
refused for lack of it, and, since 2026-10-04 (W-141), once before a single further
promotion of a proposal the Engine answered `previewable` because it replays actions
the device has not approved: the ADR-0009 row "propose the actions first and the
records after" is accepted on the first call, and `behaviourApproved` says so. This
is the same grant that a person's approval writes, scoped to the same behaviour
digest and withdrawn in the same place. At every level below, the delegate that does
this is null, and the refusals are exactly as they were.
[The acceptance tests](../../tests/Nendo.LocalMcp.Tests/UnattendedAcceptanceTests.cs)
pair each of these with a refusal at the level below.

The accept result is cached for its exact retry before the grant runs, and the grant
runs to its end whether or not the caller is still waiting (W-140). Only a committed
outcome is cached: an accept answered `stale`, `failed` or `previewable` is tried again
under the same key, so a retry after the cause is gone reports the live answer (W-144). A grant that fails
after the commit is reported on the applied result: `applied` true, `behaviourApproved`
false and a `message` carrying the failure reference and the remedy. Until 2026-10-04 the
call failed as `NENDO_INTERNAL_ERROR` with nothing cached, and the exact retry the
instructions ask for was refused as `NENDO_CHANGE_SET_NOT_FOUND` although the change
was in the file.

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
[listen tests](../../tests/Nendo.LocalMcp.Tests/SubscriptionsListenTests.cs),
[Tasks tests](../../tests/Nendo.LocalMcp.Tests/TasksExtensionTests.cs),
[host skill tests](../../tests/Nendo.LocalMcp.Tests/HostSkillTests.cs),
[evidence lanes](../../tests/Nendo.LocalMcp.Tests/EvidenceLaneTests.cs) (W-158: a two-client race
through alternating leases in the default set; the soak lane behind `NENDO_RUN_SOAK=1`, which
`Test-Production.ps1 -Soak` sets; a protocol matrix over every version the SDK lists, the
handshake ones by `initialize` and the per-request ones by `server/discover`),
[the Inspector lane](../../tests/Nendo.LocalMcp.Tests/InspectorLaneTests.cs) (behind
`NENDO_RUN_INSPECTOR=1`, `Test-Production.ps1 -Inspector`, with the reference Inspector where
`npx` finds it), the installed Claude Code and Codex lanes behind their own variables. Since
2026-10-04 every opt-in lane that did not run reports Inconclusive, so a gate run says which
lanes it did not exercise rather than counting them as passed.
[authoring ergonomics tests](../../tests/Nendo.LocalMcp.Tests/AuthoringErgonomicsTests.cs),
[extension package protocol tests](../../tests/Nendo.LocalMcp.Tests/ExtensionPackageProtocolTests.cs),
and the [native neutrality probe](../../tools/Review-NeutralityRuntime.mjs).

### Rejection cancellation

The change set remains owned and visible in the host's pending queue until the
Engine completes rejection. Cancellation while waiting for the Engine gate
preserves the preview and permits the same request/key to finish rejection on
retry; it cannot orphan a still-previewable clone.
