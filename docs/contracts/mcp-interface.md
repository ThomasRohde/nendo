# MCP interface contract

This contract lists the twenty-eight resources and twenty-eight tools that an external
agent sees, and the authority rules behind them. `Test-Production.ps1` asserts
both surfaces by name, and this sentence is held to the same count by
`Test-Repository.ps1`.

## Access levels

| Level | What is served |
| --- | --- |
| Inspect | Every resource, and the two read tools `nendo.read.resource` and `nendo.read.list`. |
| Edit data | Adds the lease, data and health tools, `nendo.data.import_records` included. |
| Shape app | Adds the change-set tools other than `nendo.change_set.accept`. |
| Unattended | Adds `nendo.change_set.accept`. |

A tool is not registered below its level. A client that calls one by name gets a `-32602`
protocol error carrying the level's code (`NENDO_SHAPE_APP_REQUIRED`,
`NENDO_UNATTENDED_REQUIRED`, …), naming both levels and the person's remedy. The service
keeps its own mode check as a second lock. A name no level serves is `-32602`
`NENDO_TOOL_UNAVAILABLE`.

No adapter gets SQL, SQLite handles, physical mappings, a database path or arbitrary host
invocation ([vision.md](../vision.md)).

## Transport

All requests enter loopback stateless Streamable HTTP with no credential. Both MCP eras
are served:

- the `initialize` handshake on any version the SDK supports;
- the 2026-07-28 `server/discover` path with per-request metadata, where the SDK handles
  the MCP-Protocol-Version/Mcp-Method/Mcp-Name headers and complete result envelopes.

The discovery document names the discover-path headers and the three
`io.modelcontextprotocol/*` `params._meta` keys, and carries `displayName`, the name of the
open file. `displayName` is a label, not a location: if a caller supplies a path, the host
reduces it to its last segment.

### Subscriptions

The 2026-07-28 path serves `subscriptions/listen`. A client that opens it with
`resourceSubscriptions` is acknowledged for the URIs this host pushes, and every other URI
is acknowledged out:

- `nendo://application/manifest` and `nendo://application/proposals`: `resources/updated`
  on every commit the Engine makes (a commit may stale every proposal), and for the
  proposals when one joins the queue or leaves it by promotion or rejection;
- `nendo://application/health`: when the file closes, after which the stream ends;
- `nendo://application/entity/{entityId}/records` with the ID filled in (the template itself
  is acknowledged out): on every commit that changes a record of that type, through any
  writer and an automatic action included, or that changes the definition. Its `_meta`
  carries `io.github.thomasrohde.nendo/changes`: `changeSequence`, the `revisionIds`
  committed, `entityId`, the changed `recordIds` (at most 100, with `truncated` past that)
  and `definitionChanged`. A subscription for a record type the file does not hold yet is
  acknowledged, and is told when the definition creates it.

The acknowledgement and every notification carry the listen request's id under
`_meta/io.modelcontextprotocol/subscriptionId`, as the id itself (a number stays a number).
`toolsListChanged` and `resourcesListChanged` are granted when asked, because
`server/discover` advertises both; none is sent, because a change of access level restarts
the listener and the stream ending is that signal.

A stream holds one of the sixteen request-gate places for its life. It is exempt from the
request timeout once its body has been read and the body's own method is
`subscriptions/listen`. At most four are open at once; the fifth is `NENDO_BUSY` naming the
cap. Each stream holds at most 1,024 unsent changes
(`NendoChangeFeed.MaximumQueuedChanges`). Past that it takes one last entry, sends
`resources/updated` for every URI it honoured without `_meta` changes, and ends; the client
reads each again and subscribes again.

The handshake-era `resources/subscribe` is not served: a stateless handshake client holds no
stream to notify. Such a client polls or moves to the 2026-07-28 path.

### Skills

The host serves the Skills extension (`io.modelcontextprotocol/skills`, SEP-2640), declared
on `server/discover` and `initialize`.

- The host skill is `skill://nendo-authoring/SKILL.md` (frontmatter name `nendo-authoring`),
  generated from the vocabulary's tables: which read answers which question, the lease and
  receipt, change sets, every operation's payload keys, bounds, examples and refusals. Its supporting files
  `skill://nendo-authoring/references/vocabulary.json`, `examples.json` and `view-api.json`
  are the same bytes as the three build-static reads. Its entry and reads carry `cacheScope`
  `public` and a one-hour TTL.
- A file may carry its own skill: a package of kind `skill`
  ([ADR-0024](../decisions/0024-a-file-carries-its-own-agent-skill.md),
  [custom-view contract](custom-views.md#skill-packages)). It is listed after the host's at
  `skill://{packageId}/{name}/SKILL.md`, `name` being the package ID's last segment, its
  manifest the stored SHA-256 and size of every file, `SKILL.md` first. Its files are the
  template `skill://{packageId}/{+path}` (`nendo.application.skill.file`): text as text,
  anything else as a blob. The template also answers the host skill's own URIs. A package
  that is not a skill, or a path it does not hold, is refused.

`skills/list` returns the host's entry first with its complete manifest, each file's
`sha256:` digest and byte size computed from the bytes `resources/read` serves. Because the
list follows the open file, `skills/list`, a file skill's `skills/get` and its reads are
`private` with TTL 0. `skills/get` for a URI it does not serve is `-32602`
`NENDO_SKILL_NOT_FOUND` naming the ones it does; a `uri` that is not text is `-32602`
`NENDO_INVALID_REQUEST`. `directoryRead` is not declared. Nothing in the host vouches for
what a file's skill says: loading it is the client's act, and the person's protection is
the review before acceptance.

### Tasks

The Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) is not served:
`server/discover` does not offer it, and every tool answers within its request whatever
the client declares, so no `CreateTaskResult` is ever due. Waiting for the person to accept
is `subscriptions/listen` on `nendo://application/proposals`.

### Perimeter and request bounds

- Host, Origin, address and body checks run before dispatch on every request. Routing
  matches `/mcp` without regard to case. `NENDO_INVALID_HOST` names
  `http://127.0.0.1:{port}/mcp` and says `localhost` is refused by design;
  `NENDO_INVALID_ORIGIN` names the one origin accepted.
- A body is at most 256 KiB (`limits.requestBodyBytes`). A larger one whose JSON-RPC `id`
  appears in its first 16 MiB is answered under that id (a `tools/call` as a refused tool
  result, anything else as `-32600`) with `NENDO_REQUEST_TOO_LARGE`. That scan holds a
  request-gate place and runs under the request timeout.
- In a record write, one value holds at most `limits.recordValueBytes` and one write's values
  together `limits.recordValuesBytes`, both 256 KiB of UTF-8 as stored. Over them is
  `NENDO_VALUE_TOO_LARGE` or `NENDO_VALUES_TOO_LARGE`, naming the field, the cap and the size.
- A body nests at most 32 levels; deeper is `NENDO_INVALID_JSON` naming the depth and cap,
  which otherwise names the line and byte where the body stopped being JSON.
  `ThePublishedExamplesLeaveRoomUnderTheDepthCap` keeps eight levels of headroom.
- At most 16 requests are in progress (`limits.requestsInFlight`), counted from before the
  body is read. The next waits up to `limits.requestQueueSeconds` (30), with at most 64
  waiting; past that it is `429` `NENDO_BUSY` with `Retry-After`.
- A request, its body included, may take five minutes
  (`NendoLocalMcpHostOptions.RequestTimeout`); past that it is cancelled and answered `503`
  `NENDO_REQUEST_TIMEOUT`, which says a write may still have committed and that
  `nendo.data.get_receipt` says whether.
- `NENDO_HOST_CLOSED` says why an endpoint closes and where the current one is shown, on
  every path: a tool call that waited for the lease, every resource read, list and skills
  call, and a call stopped in a host filter.
- Exact-retry results are kept per lease for the newest 256 calls of each kind (begin,
  validate, revalidate, reject, accept); the replays of add and amend live with their draft.
  An older retry is a new call.

## Surface text

The server instructions, and every tool, parameter and resource description, are at most
2,000 characters. Claude Code shows each only up to 2,048 characters and drops the rest
silently, so the host holds the bound itself.

The instructions (`NendoServerInstructions.For`) name the file, then, inside the first 150
characters (where some clients cut a server's text), name the read tools for a client that
cannot read resources. They go on to what the file holds, which reads to start with, waiting
proposals, the skills to read before writing, the lease and handle, `receiptContext`, ID
scope, what does not exist (no SQL, file, process or network access, no generic invocation)
and who accepts a proposal at the current level. They do not point at the vocabulary,
examples or view API; tool and resource descriptions and the host skill do.
`SurfaceTextBoundTests` reads every variant back through both handshakes and every
description through the lists.

The file is named where a client looks before its first call. `serverInfo.title` is
`Nendo · <file>` (`Nendo · BCM` for `BCM.nendo`). The instructions open with
`This is the Nendo file BCM.nendo.` (`This is a Nendo file.` when no name is known). The
lease grant and `nendo.lease.status` carry `fileName`. The title and the instructions cut a
name past 60 characters. `FileNamedSurfaceTests` holds all four.

Every tool, resource and template carries a `title`; `serverInfo` carries `title`,
`description` and `websiteUrl`. No response names the web server behind it. Tools are
listed in stable name order. `destructiveHint` is true exactly on the thirteen tools that
overwrite or remove what is stored: `set_field`, `move_record`, `execute_command`,
`update_record`, `apply_writes`, `undo_revision`, `set_kept_in_new_files`, `put_media`,
`delete_record`, `amend`, `revalidate`, `reject` and `accept`. `nendo.lease.acquire` states
the lease's lifetime in its description. Every property of every output schema carries a
description: the adapter's result records through `[Description]`, and the Engine's records
that reach the wire through `NendoWireDescriptions`. `SurfaceMetadataTests` holds these.

No tool or parameter description repeats a bound the vocabulary publishes;
`add_operations`, `create_records`, `import_records`, `update_record` and `apply_writes`
point at `limits` by name. `NoToolDescriptionRepeatsABoundTheVocabularyPublishes` fails on
the number or its word in any description.

### Schemas and serialization

- Every tool result is serialized with nulls present, because the generated output schema
  lists nullable members as required (`NendoMcpJson.ToolOptions`). `OutputSchemaContractTests`
  calls every tool and checks its payload against its declared schema.
- Every input-schema node declares what it accepts. Free-form arguments are
  `NendoObjectInput` (advertised as `object`) and `NendoScalarInput` (a string, number,
  boolean, `null` or `$nendoNumber` branch); both bind any JSON, so Nendo refuses a wrong
  shape with its own sentence (`InputSchemaContractTests`).
- Every advertised node names one type: a nullable member becomes one `anyOf` branch per
  type. `EveryAdvertisedSchemaPassesTheInspectorLint` runs the MCP Inspector's
  `boolean-schema`, `type-union`, `untyped-schema` and `remote-ref` rules over every schema.
- Every advertised arguments object and closed record declares `additionalProperties: false`.
- Every tool that returns `structuredContent` carries the same JSON as its text.
- Results and resources use relaxed JSON escaping: Basic Multilingual Plane text past ASCII,
  and `&`, `<`, `>`, `'` and `+`, arrive as themselves; control characters, characters
  outside the BMP and U+2028/U+2029 are escaped. The output is JSON-RPC text, never HTML.

## Leases

`nendo.lease.acquire` mints an opaque `applicationHandle` beside `leaseId`. Supply both on
every owned operation, renew, release and proposal preview included. Possession of the
handle governs ownership, not client names or HTTP connection identity. Keep the handle
private.

- `idempotencyKey`: an exact retry returns the grant already made, which recovers a lost
  acquire response. It answers only the client that acquired (by client name), only until an
  owned call first uses the lease, and for at most five minutes. Another client sending the
  same key gets `NENDO_LEASE_HELD`. The key should be a fresh random value; its length is not
  enforced.
- `resumeApplicationHandle`: a handle this host run minted earlier grants a new lease under
  that handle, so its validated proposals, pseudonym and receipt scope are its own again (a
  write's origin is part of what an exact replay must match). A handle this run never minted
  is `NENDO_HANDLE_UNKNOWN`; the holder of a live lease asking by its own handle gets that
  lease back. Drafts end with the lease; validated proposals carry over.
- `NENDO_LEASE_HELD` points at `nendo.lease.status`, the exact retry under the same
  `idempotencyKey`, and the person's revoke.

By default the lease ends on explicit release, the person's revocation or host stop; the
person can enable a bounded expiry in Agent → Connect (that window merges only the controls
it changed into the saved device settings, under the cross-process lock). Closing an agent
never ends the lease. Closing, switching, replacing or recovering the file invalidates the
endpoint and the authority; a renderer-only restart preserves them. Receipt lookup needs no
live handle and cannot restore editing authority.

## Resources

File resources carry private, zero-TTL cache hints. `vocabulary`, `examples`, `icons` and
`view-api` describe the host build, not the open file, and carry a one-hour `ttlMs`.

| Resource | Service | What it returns |
| --- | --- | --- |
| `nendo://application/describe{?include}` | `GetDescriptionAsync` | What the file is for, the manifest, authoring limits, every record type with its fields, every compiled screen, health, `extensions` (packages with their files, not their bytes, and their settings), `newFile`, and `reads`: every URI this host serves, generated from the declared resources. `include` takes a comma-separated subset of `manifest`, `limits`, `entities`, `surfaces`, `health`, `reads`, `extensions`, `newFile`; a facet left out is null or empty, `included` says what came, and an unknown facet is refused naming the eight. Every facet describes one moment: one definition snapshot, with counts, compiled screens and the new-file preview checked against its change sequence. A commit in between restarts the read; after three attempts it is `NENDO_READ_INTERRUPTED`. |
| `nendo://application/examples` | `NendoAuthoringExamples.Description` | Twenty-two complete contract version 3 change sets that can be sent unchanged: `create-entity-with-required-fields`, `configure-a-reference`, `a-breakdown-and-a-ring`, `a-trend-and-an-activity-grid`, `a-matrix-and-a-ranking`, `a-board-with-a-lane-per-project`, `build-a-detail-surface`, `define-a-command`, `two-commands-and-a-filtered-list`, `several-views-tabs-and-a-calendar`, `a-timeline-of-spans`, `a-gallery-and-a-rating`, `a-front-page-for-the-file`, `say-what-the-file-is-for`, `replace-a-screen-in-its-place`, `calculate-and-act-automatically`, `show-a-custom-graph`, `put-a-custom-view-in-the-file`, `ask-the-agent-from-a-view`, `give-an-app-settings`, `choose-icons`, `teach-an-agent-this-file`. Each carries the rule it conveys; each screen has a `surfaceId` of its own, its root's `nodeId`. `AuthoringExampleTests` replays every example through the real authoring boundary. |
| `nendo://application/manifest` | `NendoResourceProjection.GetManifestAsync` | What the file is for, identity and revision counters. `look`: the tone and letter of the file's icon badge, with `toneChosen` and `letterChosen` saying which the file chose (`application.setLook`), and `icon`, the `media:` address of the file's own picture drawn instead of the badge (`application.setIcon`), or null. The picture is embedded first with `nendo.data.put_media` naming no field; it must be a square PNG, 16 to 1,024 pixels, at most 1 MiB (`icon-invalid`). |
| `nendo://application/vocabulary{?include}` | `NendoSemanticVocabulary.Description` + `NendoAuthoringOperations.All` | Every contract version 3 node kind with its properties, children and root ceiling (`maxRootsPerEntity`, or `maxRootsPerFile`); the closed filter operators, value kinds, directions and aggregates; the `and` combinator (no OR, no grouping); `choiceTones`; the `charts` and `overview` rules; `icons`, which names the icons read and how many icons it lists; the limits; `operations` with each one's payload fields; and `authoringRules`. `include` takes a comma-separated subset of top-level sections (`included` says what came; an unknown name is refused listing them). Generated from the tables the compiler and authoring boundary validate against, so a documented field is an accepted field. |
| `nendo://application/entities` | `GetEntitiesAsync` | Stable entity IDs and display labels. |
| `nendo://host/instances` | `NendoDiscoveryStore.ReadLiveEntries` | Every Nendo running on this device and the name of the file each has open, never a path; `isThisOne` marks the host answering. An entry is live only while the process under its ID started at its `processStartedAt` (an entry without it, while that process started before the entry was written; a process this user may not inspect keeps its entry). The sweep also removes a temporary entry file older than a minute. A client cannot redirect itself to another endpoint; switching is the person's action, as the resource's `note` says. |
| `nendo://application/entity/{entityId}` | `GetEntityBundleAsync` | One record type: its schema with `recordCount`, its compiled surfaces and the diagnostics that name it, as one moment by the same check as `describe`. With `manifest`, the small first read for a session that works on one type. |
| `nendo://application/entity/{entityId}/schema` | `GetSchemaAsync` | Fields, storage kinds, required/presentation/options, `unique`, `sequence` (`prefix`, `width`, or null), a rating's `scale` (`min`, `max`), `hierarchy` (`parentFieldId`, `orderFieldId`) or null, `linkRule` or null, `icon`: the icon the record type chose from Nendo's set, or null for the one guessed from its name (`describe` carries it on each record type too). Calculated fields under `derivedFields`, each with `readsFieldIds`, `readsCalculationIds` and `readsEntityIds`, which `schema.setRetired` refuses to retire as `retired-binding` while the calculation stays. |
| `nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}` | `GetTreeAsync` → `TreeRecordsAsync` | A declared hierarchy depth-first ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)): the records under `root`, or from the top, down to `depth` levels (1–32, default 1), each with `parentRecordId`, `depth` and `childCount`. Each page resumes after the last record of the one before, so any size is read. |
| `nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter,fields}` | `GetRecordsAsync` → `QueryRecordsAsync` | A keyset page in record-ID order, or by `sort`/`desc`; `recordId` reads one record. `filter` is a percent-encoded JSON array of `{fieldId, op, value}` joined by AND; `op` is a vocabulary `filterOperators` entry (`lte`/`gte` map to `le`/`ge`), `contains` or `descendantOf`. Refused by name: an unknown operator or field, a clause key other than `fieldId`, `op`, `value`, and an empty `recordId=`, `filter=` or `sort=`. At most eight filters; a calculated field is filtered or sorted only while at most `limits.calculatedQueryRecords` (10,000) records could match. `fields` takes up to 64 comma-separated field IDs (at most 4,096 characters): each record then carries only those `values`, `referenceLabels`, `calculations` and `numericLexemes`, always with `entityId`, `recordId`, `recordVersion`, and its own `keptInNewFiles` mark. The projection is applied in the adapter and never changes matching, order or the cursor. |
| `nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}` | `GetAggregateAsync` → the Engine's count and aggregate reads | One exact `count`, `sum`, `min` or `max` over the records a `filter` leaves, as invariant lexemes: whole, by one closed field (`groupBy`), as a grid (`rowBy`, `columnBy`) or per civil-date bucket (`dateFieldId`, `bucket`, `range`). `shape` says which sections are filled; an empty set is null, never zero; `unrecognised` counts stored values outside the configured groups. `avg` is refused for the vocabulary's reason; `aggregate-not-exact` stays withheld. The grouped and aggregated fields must be stored: a calculated one is `NENDO_FIELD_CALCULATED` ([ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md) keeps calculated grouping refused); a filter may name a calculated field. `bucket` or `range` without `dateFieldId` is refused. |
| `nendo://application/search{?q,entity,field,cursor,limit}` | `SearchAsync` → `SearchRecordsAsync` | Records found by any word in their text, best match first, from the file's full-text index ([ADR-0028](../decisions/0028-full-text-search-in-the-file.md)). `q` is required: every word must match in some searched field; double quotes make a phrase; `-word` excludes; the last word also matches as a prefix unless it is a single letter. `entity` and `field` narrow by comma-separated IDs. `limit` 1–100, default 20. Each item is `{entityId, recordId, version, label, score, fields}`, a field `{fieldId, snippet, ranges}`. Without an index it is `NENDO_SEARCH_INDEX_MISSING`; `application.buildSearchIndex` in a change set builds one. |
| `nendo://application/surfaces` | `GetSurfacesAsync` → `CompileSemanticDefinitionAsync` | The verified definition, no records. Surface roots under `applications[].surfaces` as a node tree with `nodeId`, `kind`, `properties`, `children`, and on a command root the `commandId` that `execute_command` takes. The file's front page is under `overview`. `state` is `valid`, `invalid` or `noCustomSurfaces`. Every node carries `surfaceId`, `parentNodeId` and `position`, read from the stored definition, which `ui.moveNode` needs. |
| `nendo://application/history{?cursor,limit,newestFirst}` | `GetHistoryAsync` → `QueryHistoryAsync` | Revision summaries with `operationCount` and `operationsUri`, ascending; `newestFirst=true` reads newest first. Any other value than `true`, `false` or empty is `NENDO_INVALID_REQUEST`. The direction is part of the cursor's scope, so a cursor from one direction is `NENDO_INVALID_CURSOR` in the other. |
| `nendo://application/revision/{revisionId}/operations{?cursor,limit}` | `GetRevisionOperationsAsync` | Sanitized operation descriptors in ordinal order; no canonical payload, raw inverse or physical mapping. An operation an automatic action made carries `attribution`: `triggerId`, `triggerName`, `actionId`, `actionName`, `stepId`, `eventKind` (`created`, `updated`, `deleted`), `eventEntityId`, `eventRecordId` ([calculations-and-actions.md](calculations-and-actions.md#identity-retries-and-history)). Names are current, null once the definition has left the file. The author's own operations carry `attribution: null`. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | `GetCsvExportAsync` → `ExportCsvPageAsync` | One page of the record type as faithful Nendo CSV, the profile the person's Export writes ([csv.md](csv.md)). The header row of display names is on the first page only: the first page, or the pages joined in order, import with `csvProfile` `nendo` as they are; a later page alone needs the first page's header line. `fieldIds` gives the stable ID behind each column. |
| `nendo://application/proposal/{proposalId}` | `NendoAgentProposalStore.TryGet`, else `GetProposalAsync` | One proposal in full: semantic diff, diagnostics, package changes, behaviour and the after-acceptance summary. No lease is needed. `changeSetId` and `owner` say whose it is, null for one another client prepared. An accepted proposal reads `active`: with its title and diff while this host run holds them (the last 64 accepted), otherwise from the Engine's receipt alone, where the title says so and the diff is empty. |
| `nendo://application/proposals` | `NendoAgentProposalStore.Snapshot` | Every validated proposal waiting for a person: title, `changeSetId`, `owner` pseudonym, captured revision, state, operation and diagnostic counts, the most severe reversibility class, and `behaviour`. A `previewable` proposal whose captured definition revision is no longer the file's reads `stale`. The recovery path after a reconnect or a lost response. |
| `nendo://application/health` | `GetHealthAsync` | Status with the time of the last integrity check and the change sequence; a read does not run integrity. `changesSinceIntegrityCheck` and `integrityStale` say how far the file has moved since. `nendo.health.verify_integrity` requests a measurement. |
| `nendo://application/extensions` | `GetExtensionsAsync` | Every custom-view package: ID, title, version, entry point, description, total size, and each file's path, media type, SHA-256 and size; `settings`, the settings it declares, and `sharedSettings`, the values the file keeps for them by setting ID ([package settings](#vocabulary-areas)). No content ([custom-view contract](custom-views.md#packages-in-the-file)). |
| `nendo://application/extension-events{?packageId}` | `ViewEvents.Read` | What the file's custom views did in this Nendo ([ADR-0032](../decisions/0032-a-views-runtime-events-reach-its-agent.md)): each package's last 50 events, oldest first, each `loaded`, `stopped`, `error` (an uncaught error's sentence) or `refused` (with `method` and `code`), and how many were `dropped`. Memory only, gone when the file closes. |
| `nendo://application/media/{sha256}{?content}` | `GetMediaAsync` | One embedded picture ([ADR-0031](../decisions/0031-media-in-user-data.md)): `{address, mediaType, byteLength, name, width, height}`. With `content=true`, the picture as a blob when at most 4 MiB; a larger one is refused, naming its description's address. A linked picture is not read here. |
| `nendo://application/extension/{packageId}/file{?path,offset,length}` | `GetExtensionFileAsync` | One package file, a page of bytes at a time; see [Paging](#paging). A text page arrives as `text`; any other page, or a text page that would split a UTF-8 sequence, as `base64`. `sha256` and `byteLength` describe the whole file; `nextOffset` is null on the last page. |
| `nendo://application/icons` | `NendoIconSet.Icons` | Nendo's icon set ([ADR-0038](../decisions/0038-settings-in-one-place.md#icons-for-record-types-and-screens)): `{source, count, icons}`, each icon `{name, group, words}`, `words` being the search words a person types to find it. `schema.setEntityIcon` and a screen's or view's `icon` property take a `name` from it. The Engine carries `src/Nendo.Engine/icon-set.json`, the list the Workbench draws, as an embedded resource. |
| `nendo://application/view-api` | `NendoViewApi.Json` | `window.nendo` as a custom view's code calls it ([custom-view contract](custom-views.md#the-view-api-as-a-read)): every broker method, the helpers, shapes, events, filter words, write values, toolbar kinds, icons, keys, theme tokens, limits, refusals, a starter view and folder development. Read only while writing a view's code; the pointers to it carry none of it, and the instructions do not name it (`ViewApiResourceTests`). |

The three skill resources (`nendo.host.skill`, `nendo.host.skill.file`,
`nendo.application.skill.file`) are described under [Skills](#skills).

### Paging

The records, tree, search, export, history and revision-operations pages take `limit` 1–100.
Any other value (letters, a fraction, an overflow, empty, `0`, `101`) is `-32602`
`NENDO_INVALID_LIMIT`; Nendo classifies the text itself.

The records, tree, search, history and revision-operations pages carry `changeSequence`,
taken from the Engine's own page result. A records page and an aggregate with equal
sequences saw the same revision. Separate reads are not one transaction.

A data or definition change between pages is `NENDO_STALE_CURSOR`: restart the query.
Foreign, tampered, reopened-file or earlier agent-access cursors fail. The query is a set:
`cursor` and `limit` in either order, and an empty `cursor=` is the first page. An
undeclared or repeated parameter is `NENDO_INVALID_REQUEST` naming the parameters the
template takes. See the [read and authority contract](reads-and-authority.md).

The package-file read pages by bytes and has no cursor. `offset` and `length` must be whole
numbers (else `NENDO_INVALID_LIMIT`). A missing `path` (percent-encoded, so
`tiles%2Fworld.bin`), a path the package does not hold, a `length` outside 1–131,072 and an
`offset` past the end are `NENDO_INVALID_REQUEST` naming the rule. `length` defaults to the
rest of the file up to the cap. Each page describes the file as it stands when read; compare
`sha256` across pages.

## Tools

The two read tools add no read of their own; they serve a client that calls tools and
cannot read resources.

| Tool | Authority / implementation | Behaviour |
| --- | --- | --- |
| `nendo.read.resource` | `NendoReadTools.ResourceAsync`, Inspect, no lease | Takes `uri`, any `nendo://` or `skill://` address the resources serve, query in any order; matches an exact URI first, then the first matching template, and answers with that resource's text byte for byte (a binary skill file as an embedded resource). No output schema and no `structuredContent`, since a client may read the structure in place of the text. A resource's refusal is a refused tool result with the same code, sentence and `_meta` refusal. `readOnlyHint` true. |
| `nendo.read.list` | `NendoReadTools.ListAsync`, Inspect, no lease | Every resource address with its purpose (`NendoMcpReadIndex`, templates included), and every skill by its `SKILL.md`: the host's, then each the file carries, marked `fromFile`. `readOnlyHint` true. |
| `nendo.lease.acquire` | `NendoAgentAuthority.AcquireAsync` | One handle-bound modifying lease. Returns `applicationHandle`, `leaseId`, an unprivileged receipt locator (`receiptContext`) and the file's name. Takes `idempotencyKey` and `resumeApplicationHandle` ([Leases](#leases)). The grant (and `renew`'s) carries `limits` (`recordWritesPerCall`, `recordsPerCreateBatch`, `fieldsPerRecordUpdate`, `recordWritesLabelCharacters`, the value and body bytes, `requestsInFlight`, `requestQueueSeconds`, `maximumPageLimit`; the vocabulary has the rest) and `reads`, the first reads by address. |
| `nendo.lease.renew` | `NendoAgentAuthority.RenewAsync` | Same live handle. Extends an enabled TTL, or confirms ownership when expiry is off. |
| `nendo.lease.release` | `NendoAgentAuthority.ReleaseAsync` | Serialized lease release. |
| `nendo.lease.status` | `GetStatusAsync`, no lease | Whether a lease is held, the holder's client name and pseudonym, the file's name, and with a handle, whether the lease is yours. |
| `nendo.data.create_record` | Edit data + live lease; `NendoDataMutationService.CreateRecordAsync` → `data.createRecord` | Bounded values, server-scoped idempotency. Returns the record ID, its version and `alsoChanged`: each other record an automatic action changed in the same commit, with its new version; empty when no action ran or every step's target reference was empty. A replay names the same records with `recordVersion` null. A value map naming a calculated field is `NENDO_FIELD_CALCULATED`. |
| `nendo.data.create_records` | Same; `CreateRecordsAsync` | One mutation of 1–50 `data.createRecord` operations: one revision, one key, all or nothing. `recordVersion` is the version every created record holds, or null when an action wrote back to only some. `alsoChanged` names each moved record with its version. References: see below. |
| `nendo.data.import_records` | Same; `ImportAsync` → `NendoImportService` | CSV text or typed JSON (a mixed payload is refused before writing); see [Import](#import). |
| `nendo.data.set_field` | Same; `SetFieldAsync` → `data.setField` | Expected touched-record version. `recordVersion` is the record's version after the revision; if an action wrote back to the same record, it is past expected + 1 and `alsoChanged` names it too. A text or choice value is the JSON string itself; a choice is refused with the declared options and an echo of the value. A calculated field is `NENDO_FIELD_CALCULATED`, naming the calculation. |
| `nendo.data.update_record` | Same; `SetFieldsAsync` | One mutation of 1–64 `data.setField` operations in stable field order, the path a Workbench form save takes. One revision, one key; one version per field; `recordVersion` is where the record stands. `alsoChanged` and the calculated-field refusal as on `set_field`. |
| `nendo.data.delete_record` | Same; `DeleteRecordAsync` → `data.deleteRecord` | Expected touched-record version. Incoming references block deletion, naming up to five referring records. Exact retries return the committed outcome. |
| `nendo.data.apply_writes` | Same; `ApplyRecordWritesAsync` | Up to `recordWritesPerCall` creates, updates and deletes across record types in one mutation, the Engine batch a view's `records.batch` commits through `data.writeRecords`. All or nothing; one write per record; a write may point at a record an earlier write created or updated, as a plain value or under `references`, and the host supplies the target's version. `records` names every record with its version now, null after a delete and on a replay. `label` is what History calls the revision. A create or update may carry `keptInNewFiles`; a delete that carries it is refused. A reference whose target the batch does not touch and whose version the write does not carry is `NENDO_TARGET_VERSION_REQUIRED` naming `writes[i]`, the field, the target and both remedies (`expectedTargetVersions` by field ID, or `references`). A view-API write key (`op`, `version`, `targetVersions`) is refused naming the key meant. |
| `nendo.data.set_kept_in_new_files` | Same; `SetRecordsKeptInNewFilesAsync` | One `data.setKeptInNewFiles` per record ([ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md)): `kept` true, false or null to follow the type. One record by `entityId` and `recordId`, or up to `recordWritesPerCall` of any types under `records`, as one revision; both forms or neither is refused. Changes no value or version and runs no action: `recordVersion` is null and `recordIds` names the records. `describe` gives each type's `keptInNewFiles`, the manifest's `newFileLabel`, and `newFile` (per type how many records a new file keeps and leaves out, and each kept record pointing at a left-out one). Making a new file is the person's, from the File menu. |
| `nendo.data.put_media` | Same; `PutMediaAsync` → `media.put` | Embeds a picture, and sets the named media field with `data.setField` in the same revision ([ADR-0031](../decisions/0031-media-in-user-data.md)). Bytes arrive as base64 in chunks under one `idempotencyKey`, each at its `offset` and within `requestBodyBytes`; the host stages them in memory by handle and key and refuses a gap. The call with `final: true` (the default) commits and answers `{committed, bytes, address, write}`. A repeated chunk with the same bytes changes nothing; a repeated final call answers the original commit; a picture never committed leaves nothing. The type is read from the bytes (`media-type-mismatch`); `media-too-large` past the item bound. No tool reads a local file or a web address: an agent links one by setting the field to its address with `set_field`. |
| `nendo.data.undo_revision` | Same; `UndoRecordWritesAsync`, origin the lease's pseudonym | One compensation revision linked to the revision it reverses, the undo History and a view make. A revision another origin committed is `NENDO_REVISION_NOT_YOURS` (the usual answer for a definition revision). Already undone, a definition revision of this origin, an irreversible operation, a keep mark changed since, or more than 12,800 operations is `NENDO_COMPENSATION_NOT_SUPPORTED` with the Engine's sentence. A restore whose record is no longer deleted is `NENDO_DELETION_STATE_CONFLICT`; a backfill's undo on a field reactivated since is answered as a plain edit. An undo can be undone (redo); History names the chain Undo, Redo, Undo. It is not refused as `NENDO_BEHAVIOUR_NOT_APPROVED`, since an undo runs no action. `records` names every record with its new version. |
| `nendo.data.move_record` | Same; `MoveRecordAsync` | Typed `data.setField` operations in one revision: the parent, the order, and, only when no gap is left at the insertion point, the smallest run of siblings around it renumbered to fit between its ordered neighbours (a sibling without an order joins the run) ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)). Needs a declared hierarchy; `parentRecordId` null moves to the top level; `beforeRecordId` needs an order field. `recordIds` names every record written; `recordVersion` is stated when the moved record was the only one. A move under its own descendants is `NENDO_HIERARCHY_CYCLE`, naming the loop. |
| `nendo.data.execute_command` | Same; `ExecuteCommandAsync` | Resolves the stored command, then typed `data.setField`. MCP implements no domain commands. Returns `recordVersion`: a command advances the record one version per `commandStep`, so the caller cannot derive it. Null on a replay. |
| `nendo.data.get_receipt` | Current endpoint, no lease | `GetMutationReceiptAsync`. The saved locator binds the original app, instance, run and scope. A committed receipt carries `origin` and `generatedChanges`, the records the write's actions changed, with `recordVersion` null. For an import, the same key answers every batch it committed under `revisions`, the last as `receipt`. `proposalId` in place of the key answers for an accepted proposal with the revisions its acceptance committed. A missing receipt stays unresolved and grants nothing ([operation outcomes](operation-outcomes.md#mcp-clients)). |
| `nendo.health.verify_integrity` | Current endpoint, no lease | `VerifyIntegrityAsync`. Takes an optional `applicationHandle` and ignores it. Scans the file, every stored package content against its SHA-256 included, and returns the health measured now. An unchanged file is not rescanned (`rescanned` false). A failed scan puts the host into recovery: the protection of the file, not a failure of this call. |
| `nendo.change_set.begin` | Shape app + live lease; `NendoAgentAuthoringService` | A bounded transient draft at the current definition revision. Returns the `changeSetId` the other change-set tools take, and how many other change sets are open against the file with an advisory naming the captured revision. At most `draftsPerSession` open drafts; one more is `NENDO_DRAFT_LIMIT`, naming every open draft by `changeSetId` and title and the way out (validate one, reject one, or release the lease). |
| `nendo.change_set.add_operations` | Same owning handle and draft | Closed canonical operations: at most 16 per call and 128 submitted per change set, expanding to at most 512 canonical. One payload is at most 32 KiB; a `data.*` payload at most `limits.requestBodyBytes`; an `extension.putFile` payload at most 96 KiB. See [Authoring](#authoring). |
| `nendo.change_set.amend` | Same, not frozen | Drops every mutation from an ordinal onwards and appends replacements under the same bounds, so one bad operation costs one call. |
| `nendo.change_set.validate` | Same | `PrepareProposalAsync` → canonical compilation → validation on a physical clone. See [Validation](#validation). |
| `nendo.change_set.revalidate` | Same owning session | Rejects the owned proposal and validates its kept operations again as a new draft at the current definition revision, through the same clone validation. The new proposal keeps the `changeSetId`; a draft that no longer validates stays open to amend. The operations are kept behind every validated proposal until it is accepted or rejected, by the agent or the person, and survive a lease release. It captures the new revision before rejecting, so a cancelled revalidate leaves a draft to validate again. Not a rebase: promotion replays the newly validated digest. |
| `nendo.change_set.preview` | Same owning session | The retained typed preview (`NendoAgentAuthoringService.PreviewAsync`, with `OwnedProposal` resolving queued proposals through `NendoAgentProposalStore.TryGetOwned`); the lease proves ownership. The lease-free read is `nendo://application/proposal/{proposalId}`. An accepted proposal reads `active`; a rejected one is `NENDO_CHANGE_SET_NOT_FOUND` naming the proposal and the rejection; one this host run no longer remembers says it settled and to read the file before sending it again. |
| `nendo.change_set.reject` | Same owning session | Removes the owned draft or preview and calls `RejectProposalAsync` for its workspace. See [Rejection cancellation](#rejection-cancellation). |
| `nendo.change_set.accept` | **Unattended only**, same owning session | `NendoAgentProposalStore.PromoteAsync`, the method the person's Accept calls, with the proposal's reviewed digest, never omitted. `applied` false is an ordinary answer; `state` says whether the file moved (`stale`), the plan no longer matches (`failed`) or the proposal still waits (`previewable`), and the proposal stays. `behaviourApproved` says whether the acceptance also recorded consent for actions it installed. `revisions` lists every History revision it committed. A draft is `NENDO_CHANGE_SET_NOT_VALIDATED`. See [Unattended acceptance](#unattended-acceptance). |

Every data write result (`create_record`, `create_records`, `set_field`, `update_record`,
`delete_record`, `execute_command`, `move_record`, `apply_writes`, `undo_revision`) carries
`blockedConditions`: each automatic action the write did not run because its trigger's
condition could not be worked out, with the trigger ID and name, the record that raised it
and the calculation code and sentence. The write committed without that action. The list is
not stored, so a replay and a receipt carry it empty.

Mutation versions are scoped by the pair of record type and record ID: a generated write to
the same ID in another type cannot change the caller's returned version, and an automatic
deletion leaves no version. Commands resolve their owning type in the application service.

### References

`create_record`, `create_records`, `update_record`, `apply_writes` and JSON import take
`references`: each target named by record ID or by a unique field's value, and the host
writes the ID and current version. CSV import's `matchFieldId` follows the same rule; one
mapper serves a create, a batch and a JSON import.

- A whole-number match field is compared by value, so the text `"42"` finds 42.
- A text code is compared without regard to case, as its unique index and CSV import compare
  it. Where that matches several records, the one in exactly the code's case is taken; none
  in that case is refused as ambiguous.
- A record of a `create_records` batch or a JSON import may name an earlier record of the
  same call, created in the same revision at version 1 (or, in a later import batch, read
  from the file).
- An exact retry of a write that names `references` carries the target versions its
  committed revision recorded, read back by the key's receipt, so it replays even when the
  target was edited in between. A different payload under a used key is
  `NENDO_IDEMPOTENCY_CONFLICT`.

The Engine's reference refusals name the field and the record it points at, for example
"Project points at p1 in Projects, which changed after it was selected. Select it again
before saving." The refusal's `RecordId` is the target.

### Import

`nendo.data.import_records` decodes CSV with the native importer's routine and commits the
same canonical `data.createRecord` operations, `limits.import.rowsPerBatch` to a revision, at
most `limits.import.rowsPerCall` rows per call; the 256 KiB body is usually met first.
`maximumRowsPerCall` echoes the limit on success.

- Every row is decoded and checked before anything is written. Each decoded CSV row keeps the
  value bounds every other write keeps, naming its row.
- Unknown, duplicate or out-of-range CSV mappings are validation refusals, as is a required
  field left unmapped, except one with a sequence
  ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)): its column may be left out or
  its cells empty, under either profile and either `emptyIsNull`, and the host assigns the
  next code; a code the row carries is kept.
- A record type or field the file does not hold is `NENDO_ENTITY_NOT_FOUND` or
  `NENDO_FIELD_NOT_FOUND` (naming a pending proposal that creates it); a retired one
  `NENDO_ENTITY_RETIRED` or `NENDO_FIELD_RETIRED`; a column mapped to a calculated field
  `NENDO_FIELD_CALCULATED` naming the column. A record ID twice in a JSON payload is refused
  before any write, naming both positions.
- Each batch's key derives from the caller's (the key, `#` and the ordinal, or
  `import.sha256.` and the key's SHA-256 past 200 characters); a CSV record ID derives from
  that key and its row position. The key is trimmed, as every write's is.
- Each batch after the first is resolved again just before it commits, so rows pointing at a
  record an earlier batch or its actions moved still commit. Batches the key already
  committed carry the target versions their revision recorded, for CSV and JSON alike, so an
  exact retry replays; uncommitted rows resolve against the current file.
- If a later batch is refused, cancelled or fails in storage, `NENDO_IMPORT_PARTIAL` names
  the committed and remaining counts, the first uncommitted data row, the committed revision
  IDs and the cause. Retry the identical call and key to replay the earlier batches without
  duplicates. An import is never atomic across batches.
- The result carries `isIdempotentReplay` (every batch replayed, nothing written now) and
  `replayedRevisions`.
- Each batch carries the session's pseudonym as its origin. A retry resubmits a committed
  batch under the origin its receipt records, so an exact retry from a new lease replays.
- JSON import preserves each record's explicit `keptInNewFiles` true/false/null mark across
  batch boundaries and exact retries; changing that mark under a used key is an idempotency
  conflict.

## Authoring

The closed authoring union is declared once, in `NendoAuthoringOperations`: it is published
at `nendo://application/vocabulary` and `NendoAgentAuthoringService` builds its enforcement
from it. It permits forty of the Engine's forty-five canonical operations. The other five:
`data.restoreDeletedRecord` and `identity.transition` are native lifecycle operations;
`schema.removeChoice` is made only by compensation; `extension.setState` is written only by
a custom view through `nendo.state` ([custom-view contract](custom-views.md#state)); and
`media.put` is written by `nendo.data.put_media`. There is no escape hatch: an unknown type,
`sql.execute` included, is `NENDO_UNKNOWN_OPERATION`.

`behaviour.setDefinition` installs a calculation, function, action or trigger inside an
ordinary change set ([ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md)), so
behaviour adds no tool. MCP never bypasses trigger expansion.

### Adding operations

- The host supplies IDs, and every response echoes every limit.
- `ui.addNode` accepts an inline `properties` map, which expands at the boundary to one
  `ui.setProperty` per property, so a node and its configuration count as one submitted
  operation. The canonical expansion has its own bound.
- An omitted `expectedDefinitionRevision` is resolved from the operation's position in the
  change set; a supplied value is honoured exactly.
- A payload missing a key the vocabulary lists as required is refused naming it.
- A payload key that belongs to another operation (`unique` on `schema.addField`) is refused
  naming that operation.
- A `ui.moveNode` without `parentNodeId` keeps the node's current parent, filled in from the
  file and earlier operations; an explicit null makes it a root.
- `beforeNodeId`, `afterNodeId` or (beside an anchor) `position` sent as null is a key not
  sent. A `ui.addNode` that names none of them goes after its siblings, at one past the last
  sibling's position or 0. Unlike an anchor, this placement does not make a draft stale.
- `keptInNewFiles` on `data.createRecord` is refused naming `data.setKeptInNewFiles`.
- A payload the host cannot bind is refused where it is sent, as `NENDO_INVALID_REQUEST`
  naming the mutation ordinal (the one `amend` takes), the operation index, type and ID, and
  the engine's sentence. Every operation is built into its typed form then; nothing enters
  the draft.
- A package file larger than one payload is sent in parts: `extension.putFile` with
  `append: true` continues the file an earlier `putFile` of the same package and path began
  in this change set, joined in order at validation. A part with nothing to continue is
  refused when sent.
- Later operations may edit records earlier operations created. Ordered replay on the clone
  checks their expected versions, and promotion checks them again.

A change set that validated is frozen: `add_operations`, `amend` and a fresh `validate` are
`NENDO_CHANGE_SET_FROZEN`, naming the proposal it became and both remedies (reject it and
begin again, or ask the person to accept it). An ID this session never had is
`NENDO_CHANGE_SET_NOT_FOUND: The change set does not exist.`; the code also says when the
ID belongs to another session.

### Validation

- Schema-only proposals are valid for Studio; custom trees that are present must compile.
- A failed validation discards its private clone and leaves the draft open and amendable, so
  validation is a repeatable dry run. Required cleanup finishes before the invalid verdict is
  replayable, even if the caller cancels. A validate that ends without a verdict (authority
  moved, or a call was cancelled) reopens the draft.
- A refused change set reports up to five independent refusals together, each naming its
  `operationId`. An operation that depends on a refused one is left out, and a version
  conflict caused by leaving one out is never reported. Each further refusal costs one more
  clone. Each refusal's `hint` names the mutation it sits in as sent, the ordinal `amend`
  takes.
- A draft the definition moved under since it began is validated at the current revision,
  with warning `NCS001` naming both revisions, unless one of its operations pins
  `expectedDefinitionRevision` or holds a placement the host resolved when it arrived (an
  anchor's position and parent, the siblings it moved, the parent a `ui.moveNode` kept);
  either is `NENDO_CHANGE_SET_STALE`, naming the mutation and the remedy (amend from it or
  begin again).
- A change set past the content bound, or a package file past 4 MiB once joined, is refused
  as `NENDO_INVALID_REQUEST` before the clone. A package precondition met on the clone (an
  `extension-*` code) is diagnostic `NPROP010` with the Engine's sentence. A chunked file
  whose first part carried `sha256` or `byteLength` of that part validates: beside `text` or
  `base64` those keys check only that operation's bytes.
- The result carries `changeSetId` and `owner`. An invalid result's `proposalId` names the
  discarded clone. Every proposal the host returns (`validate`, `preview`, `revalidate`,
  `proposals`, `proposal/{proposalId}`) carries `isValid`: true for `previewable` and
  `active`, false otherwise; warnings alone never make it false.
- At most `proposalsPerSession` validated proposals per session, each a clone of the file;
  one more is `NENDO_PROPOSAL_LIMIT` and clones nothing. A validate's replay lasts only while
  the draft holds what it validated: `add_operations` and `amend` forget it.

### The preview

The preview of a validated proposal is scoped to the validated clone, the whole file as it
would stand; `scope` says so, and entities, field counts and record counts come from that
one set. It carries:

- `minimumHostVersionBefore` and `minimumHostVersionAfter`; a raise is its own
  `raiseMinimumHostVersion` entry in `semanticDiff`, classified irreversible.
- `purposeBefore` and `purposeAfter`, since the purpose belongs to no record type or node.
- `packageChanges`: each package file added, replaced or removed, with media types and sizes
  before and after; a text file of at most 1 MiB also carries its changed lines with three
  lines of context in `hunks`, at most 400 changed lines per file and 2,000 per proposal,
  `truncated` saying where it stopped. The person sees the same list under **Code**
  ([custom-view contract](custom-views.md#review)).
- `behaviour`, null when the proposal asks nothing new. Otherwise `createsRecords`,
  `updatesRecords` and `deletesRecords` say what the actions can do once accepted;
  `generatedEffectCount` counts the writes they made on the clone, which acceptance replays
  (above zero, acceptance is refused until consent is held on this device);
  `changesWhatIsApproved` says consent given today does not cover the behaviour after
  acceptance, so editing pauses until it is given again. Both at once cannot be accepted,
  by a person or at Unattended: propose the actions first and the records after
  ([ADR-0009](../decisions/0009-local-mcp-transport-authority-and-change-sets.md)).
- An optional `shape` per surface: a matrix's rows, columns and cell count; a board's
  column count, or for a reference board *one column per Client record, 12 of them* (or none
  yet). Lanes are counted by the renderer's rule (`filterClause` `ne` removes a value, `eq`
  keeps only it). `boards.maximumReferenceColumns` is checked against every target record
  before any filter; a filter over a target held only in part states no count. `shape` is
  null where size is not a closed question.
- The summary's `surfaces` also list the file's custom views (`extensionView`), with
  `entityId` null as the front page has.

A data write refused because the record type, field or command it names is not in the file
names the outstanding proposal that creates it, with its title and the required action:
below Unattended, the person's acceptance; at Unattended, `nendo.change_set.accept` for a
proposal this session validated.

### Vocabulary areas

**Custom views.** `extension.setPackage`, `extension.putFile`, `extension.removeFile` and
`extension.removePackage` write a view's code through ordinary proposals; the person reviews
it as code. Accepted code runs in the Workbench when a view naming its package is shown, and
reaches the file only through `window.nendo`
([custom-view contract](custom-views.md#packages-in-the-file)). `extension.setPackage` with
`kind` `skill` writes the file's own agent skill instead, which never runs
([skill packages](custom-views.md#skill-packages); example `teach-an-agent-this-file`). A view
package's `settings` and `package.setSetting` are under **Package settings** below; one
`extension.setPackage` payload may carry as much as one `extension.putFile` part. No
tool or resource reaches this device's custom-view switches. `limits.extensions`:

- `fileBytes`: 4 MiB for one file;
- `packageFiles` and `packageBytes`: 512 files and 16 MiB for one package;
- `packages` and `totalBytes`: 64 packages and 64 MiB for one `.nendo` file;
- `contentBytesPerChangeSet`: 4 MiB of new content for one change set;
- `pathCharacters` and `packageIdCharacters`: 240 and 80;
- `putFilePayloadBytes`: 96 KiB for one `putFile` payload.

**Hierarchies.** `schema.declareHierarchy` and `schema.removeHierarchy`;
`limits.hierarchy` has `maximumDepth` 32, `maximumAggregatedDescendants` 10,000 (the most
descendants a subtree aggregate folds) and `orderGap` 1,024.

**Unique and generated fields.** `schema.setFieldUnique` and `schema.setFieldSequence`
([ADR-0020](../decisions/0020-unique-and-generated-fields.md)). A duplicate unique value is
`NENDO_VALUE_NOT_UNIQUE`, naming the record that holds it, never the value. A create may
leave a numbered field out; the result's `assigned` lists each record, field and code the
host wrote.

**Presentation.** `schema.setFieldPresentation` moves a Text field between `singleLine`,
`longText` and `markdown`. No value changes; its undo restores the previous presentation (or
none); a unique field stays `singleLine`. It states host 1.44.0.

**Icons.** `schema.setEntityIcon` `{entityId, icon}` gives a record type an icon from Nendo's set,
or with `icon` null the icon guessed from its name again
([ADR-0038](../decisions/0038-settings-in-one-place.md#icons-for-record-types-and-screens)). A
name `nendo://application/icons` does not list is refused as invalid, a retired record type as
`entity-retired`. Its undo restores the icon it replaced, or none. The icon is stored in
`__nendo_entity_icon`, on the `-entityicon-` rung above the file's own icon; the first one
states host 1.56.0, and clearing on a file that never chose one changes neither its layout nor
its host. A screen's root or a custom view takes an icon as its `icon` property with
`ui.setProperty`, which refuses a name outside the set when it is written (a definition
already holding one compiles with the warning `NUI461`; see
[semantic surfaces](semantic-surfaces.md#icons)), which states the same host.

**Package settings.** A view package declares its settings in `extension.setPackage`'s
`settings`, the same list its `nendo-package.json` carries
([custom-view contract](custom-views.md#settings-a-package-declares)). The operation states the
whole list: leaving it out declares none, and a shared value that no longer fits is dropped. A
bad declaration is refused as invalid, naming the setting. `package.setSetting`
`{packageId, settingId, value}` keeps a value in the file for everyone who opens it, or with
`value` null clears it so the default is used; `expectedDefinitionRevision` is filled in like any
definition operation's. It is refused as `extension-package-not-found`,
`package-setting-not-found`, `package-setting-personal` (a setting whose layers are `personal`)
or `package-setting-invalid` (a value that does not fit, with the reason). Its undo restores the
value it replaced, or none. The first declared settings state host 1.57.0, on the `-setting-`
rung above `-entityicon-`. The extensions read and `describe` show each package's `settings`
(normalised: a choice with its `options`, a text setting with its `maxLength`, null for a field
the type does not take) and `sharedSettings`, only values that fit. A setting's personal value
is kept on each computer and is never read or written here.

**Reference labels.** `schema.setReferenceLabel` `{entityId, fieldId, labelFieldId}` shows a
bound reference's records by another active Text field of its target. No value changes; its
undo restores the previous label. An unchanged label is `reference-label-unchanged`, an
unbound reference `reference-unbound`, and retiring the label field `reference-label-in-use`.
It states host 1.51.0.

**Choices.** `schema.addChoice` `{entityId, fieldId, choiceId, displayName, tone?}` appends an
option to an active single-choice field. `choiceId` is new to the field (retired options
included), at most 120 characters; `displayName` is 1–200 characters, unique within the field
case-insensitively (`label-conflict`); at most 32 options. Its undo removes the option (and
option metadata the field lacked before), refused while a record, or a deleted record kept
for its undo, holds it. It states host 1.7.0, or 1.19.0 with a tone, as
`schema.setChoiceMetadata` (rename, colour, retire) does.

**Link rules.** `schema.declareLinkRule` and `schema.removeLinkRule`
([ADR-0026](../decisions/0026-allowed-links.md),
[allowed links](relationships.md#allowed-links)). The schema read carries `linkRule` with its
ten IDs. A mutation leaving a link no table record allows is `NENDO_LINK_NOT_ALLOWED`, naming
the link and, for a reference kind, the three kind records. Declaring a rule over such links
fails validation with `links-not-allowed`, naming the first 20. It states host 1.45.0.

**Behaviour.** `behaviour.setDefinition` and `behaviour.removeDefinition`. The vocabulary
carries the behaviour catalogue (functions with argument and result types, operators, scalar
domain, binding kinds, aggregate rules, ceilings). `behaviour.bindings` lists every binding
shape with its keys, from the table the codec refuses against, a `RelatedAggregate` once per
aggregate; `propertyNotes` says what `visibleWhen` and `fieldId` take.

## Approval and acceptance

Installing an automatic action needs no consent; the **write that would run one** does, and
`NENDO_BEHAVIOUR_NOT_APPROVED` is raised at that write. Below Unattended no tool, resource
or payload field reaches that approval or proposal acceptance; the production gate asserts
that the MCP surface cannot name the grant store or the approval service. The person's
Workbench review calls `PromoteProposalAsync` with the reviewed digest; the write gate
verifies it and replays the validated operations.

### Unattended acceptance

At Unattended, `nendo.change_set.accept` calls that same promotion with that same digest:
same clone, staleness capture and History revision. The host records the device's consent,
through a delegate that takes no arguments:

- after an acceptance that installs actions;
- once before a single retry of a write refused for lack of it;
- once before a single further promotion of a proposal the Engine answered `previewable`
  because it replays actions the device has not approved, so "propose the actions first and
  the records after" is accepted in one call, and `behaviourApproved` says so.

This is the grant a person's approval writes, scoped to the same behaviour digest and
withdrawn in the same place. Below Unattended the delegate is null.

The accept result is cached for its exact retry before the grant runs, and the grant runs to
its end whether or not the caller waits. Only a committed outcome is cached: `stale`,
`failed` or `previewable` is tried again under the same key. A grant that fails after the
commit is reported on the applied result: `applied` true, `behaviourApproved` false, and a
`message` with the failure reference and the remedy.

### Package uploader

The repository's package uploader (`tools/Nendo-McpClient.mjs`) packs at most sixteen
operations per `add_operations` call, counting all mutations together. `--accept` treats only
`NENDO_UNATTENDED_REQUIRED` as a successful handoff for a person to accept. Other refusals and
transport failures exit unsuccessfully and name the proposal; after a lost response, inspect
Pending changes and History before acting again. The acceptance key dies with the uploader's
lease, so a rerun cannot replay it, and a transport failure does not establish that
acceptance did not commit.

## What a refusal says

A tool error is `CODE: message`. The code is stable, and the message is the remedy, under one
rule: **an engine message passes through when its template carries only stable IDs,
definition display names, declared choice IDs and integers — never a path and never a stored
value.** Every `NendoValidationException` meets that rule and passes through whole. A
precondition passes through, on the tool path and the resource path, when its code is on the
audited list in `NendoToolErrors` (`DiagnosablePreconditions`):

- general: `definition-version-conflict`, `required-field-needs-migration`,
  `required-backfill-needed`, `record-referenced`, `entity-referenced`,
  `behaviour-not-approved`, `choice-retired`, `reference-label-in-use`,
  `reference-label-unchanged`, `ui-property-absent`, `reference-unbound`,
  `target-version-required`, `target-not-found`, `target-version-conflict`,
  `record-version-conflict`, `record-not-found`, `field-not-found`, `field-calculated`,
  `aggregate-not-representable`;
- hierarchies ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)): `hierarchy-cycle`,
  `hierarchy-cycle-present`, `hierarchy-too-deep`, `hierarchy-parent-invalid`,
  `hierarchy-parent-required`, `hierarchy-order-invalid`, `hierarchy-already-declared`,
  `hierarchy-not-declared`, `hierarchy-field-in-use`, `hierarchy-order-not-declared`,
  `hierarchy-sibling-not-found`, `move-unchanged`;
- uniqueness ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)):
  `value-not-unique`, `field-values-not-unique`, `field-unique-invalid`,
  `field-unique-unchanged`, `field-sequence-invalid`, `field-sequence-unchanged`,
  `field-sequence-in-use`;
- link rules ([ADR-0026](../decisions/0026-allowed-links.md)): `link-not-allowed`,
  `links-not-allowed`, `link-rule-invalid`, `link-rule-already-declared`,
  `link-rule-not-declared`, `link-rule-field-in-use`;
- undo: `revision-not-found`, `not-an-undo`, `revision-not-yours`,
  `deletion-state-conflict`, `field-not-retired`;
- saving and size: `file-busy`, `value-too-large`, `values-too-large`;
- package settings ([ADR-0038](../decisions/0038-settings-in-one-place.md#apps-declare-their-settings)):
  `package-setting-not-found`, `package-setting-personal`, `package-setting-invalid`, naming the
  package and setting by ID and the declared options or range beside the value the caller sent;
- behaviour: `field-requirement-in-use`, `action-target-mismatch`;
- data writes and reads: `record-id-reserved`, `record-exists-or-invalid`,
  `kept-in-new-files-unchanged`, `new-file-reference-left-out`, `entity-not-found`,
  `entity-exists`, `entity-retired`, `field-retired`, `retired-binding`,
  `record-version-exhausted`, `command-unavailable`, `move-receipt-unavailable`,
  `ui-node-not-found`, `write-ceiling-bytes`, `write-ceiling-rows`, `write-ceiling-schema`
  (which say nothing changed and the file still opens), `file-changed-before-open`, the four
  `reference-conversion-*` codes, `calculated-query-too-wide`, `search-too-long`,
  `search-too-many-terms`, `search-index-missing`, `stale-cursor`, `invalid-limit`,
  `data-unavailable`, `history-unavailable`, `reopen-to-verify`, `read-only`,
  `proposal-not-found`, `receipt-file-mismatch`;
- constant sentences: `read-only-file-changed` (a read-only session's file moved on),
  `replacement-target-read-only` (a file marked read-only is not replaced),
  `replacement-target-in-use` (another reader held the file; nothing changed);
- pictures ([ADR-0031](../decisions/0031-media-in-user-data.md)), none echoing the address or
  the bytes: `media-address-invalid`, `media-missing`, `media-type-mismatch`,
  `media-too-large`, `media-budget-exceeded`, `field-not-media`, and `icon-invalid` (a
  picture that cannot be the file's icon, by its type, size or bytes);
- calculated totals: `calculated-total-incomplete` (a total of a calculated number met a
  record whose calculation could not be worked out; it names the field and the reason) and
  `aggregate-too-many-groups` (a breakdown by a reference past its bound).

Their messages name records by stable ID, record types and fields by ID or display name, a
loop as the chain of IDs it would close, and a ceiling by its number; the person reads the
same sentence in Nendo. `aggregate-not-exact` echoes a stored value and stays withheld, listed
with that reason in `WithheldPreconditions`. Any other precondition reads "The semantic
precondition was not met." `McpDataParityTests.EveryDataPathRefusalIsAuditedAndTheWriteRefusalsReachTheAgentWhole`
fails on a code thrown on a data path that is on neither list. A calculation failure passes
through as `NENDO_CALCULATION_*`.

What the boundary itself says:

- A call that does not fit its tool is refused before the SDK binds it, beginning
  `NENDO_INVALID_REQUEST: {tool} was not called.` and naming each problem: an argument left
  out (`It requires idempotencyKey.`); a key the tool does not take, with the ones it does;
  an undeclared key inside a record, mutation, operation or column mapping
  (`records[0] does not take 'expectedTargetVersionz'; a record takes recordId and values,
  and optionally expectedTargetVersions.`); a value of the wrong kind
  (`expectedRecordVersion must be a whole number; it was a string.`). The contract is read
  from the tool methods by reflection with the binder's serializer options, and
  `ToolRefusalTests` holds it equal to each advertised schema. A whole number sent as a
  string still binds.
- A level refusal is `-32602` with the level's code, e.g. `NENDO_SHAPE_APP_REQUIRED:
  nendo.change_set.begin is served from Shape app, and this file session is at Edit data.
  Ask the person to raise agent access to Shape app on the Agent page in Nendo.`
  `NENDO_UNATTENDED_REQUIRED` reads *Unattended access is required. Ask the person to raise
  agent access to Unattended on the Agent page in Nendo.*
- Every refusal a tool translates also travels in the result's `_meta` under
  `io.github.thomasrohde.nendo/refusal`: `{code, message, pendingProposalId?}`, the same code
  and sentence as the text, and the proposal a pending-cause advisory named. A refusal the
  boundary makes before a tool runs, and every `-32602` protocol error, keep their text. A
  calculation limit adds `limit`: `{allowance, functionCalls, functionCallLimit,
  relatedRecords, relatedRecordLimit, automaticChanges, automaticChangeLimit, workUnits,
  workUnitLimit, path}`, outermost first. `StructuredRefusalTests` holds the object equal to
  the text.
- A refused data value names the field, the declared choices and the value that arrived
  (`received "\"Bean\""`), so a double-encoded string is visible.
- `NENDO_CHANGE_SET_NOT_VALIDATED` is an accept for a draft and tells the agent to validate.
- `NENDO_COMPENSATION_NOT_SUPPORTED` carries the Engine's sentence, naming revision and
  record IDs and operation types, never a stored value.
- `NENDO_INTERNAL_ERROR` names the exception type and a failure reference, nothing else. The
  host hands the failure to the device under that reference, with the request's name, the
  exception types and the frames, never an exception message, argument, handle, lease or
  path (`NendoAgentFailures`; the Desktop keeps it beside the view-failure record, under the
  same switch, per [ADR-0002](../decisions/0002-containing-desktop-architecture-and-process-model.md)).
  The SDK's and web server's warnings and errors reach the same record by event and exception
  type, never by formatted message, and only while the host serves.
- Every tool call is one entry in the Agent page's activity: the tool reports through a slot
  the host's filter holds for the call, and the filter writes the entry once, with the
  revision or proposal it touched.

### Rejection cancellation

The change set remains owned and visible in the host's pending queue until the
Engine completes rejection. Cancellation while waiting for the Engine gate
preserves the preview and permits the same request/key to finish rejection on
retry; it cannot orphan a still-previewable clone.

## Tests

`tests/Nendo.LocalMcp.Tests/` holds the protocol, authoring, data, read-path, schema,
listen, skill and example suites. `EvidenceLaneTests` adds a two-client race, a protocol
matrix over every SDK version, and a soak lane behind `NENDO_RUN_SOAK=1`
(`Test-Production.ps1 -Soak`); `InspectorLaneTests` runs behind `NENDO_RUN_INSPECTOR=1`
(`-Inspector`), and the installed Claude Code and Codex lanes behind their own variables. An
opt-in lane that did not run reports Inconclusive. `tools/Review-NeutralityRuntime.mjs` is
the native neutrality probe.
