# MCP layer review

Reviewed 2026-10-04 against `src/Nendo.LocalMcp` (47 files, 9,776 lines), the
[MCP interface contract](docs/contracts/mcp-interface.md), ADR-0009 and ADR-0014,
the test project, the in-house clients under `tools/`, the planner mod, and the
MCP specification as published at modelcontextprotocol.io on the review date
(protocol revision `2026-07-28`, extensions framework per SEP-2133). Nothing in
`src/` was changed. The code was read; the claims below name a file and line
where one was checked.

The short version: the adapter's authority model, perimeter and refusal text are
better than almost any MCP server in the wild, and the last three months of
findings show the layer being shaped by what it *says*. What now holds it back is
what it *does not offer*: the Engine already has filtered reads, by-ID reads,
counts, aggregates, multi-field writes, cross-type batches, compensation and
proposal receipts, and none of them reach the wire. Four real defects sit in the
accept and validate paths. Two MCP extensions fit this product unusually well,
Tasks and Skills over MCP, and one, MCP Apps, deserves an ADR before anyone
builds it.

Contents:

1. [What is already exceptional and must not be lost](#1-what-is-already-exceptional)
2. [Defects found](#2-defects-found)
3. [Engine capabilities the surface withholds](#3-engine-capabilities-the-surface-withholds)
4. [Write-path ergonomics](#4-write-path-ergonomics)
5. [Text, discoverability and the deferred-tool client](#5-text-discoverability-and-the-deferred-tool-client)
6. [Protocol posture against 2026-07-28](#6-protocol-posture-against-2026-07-28)
7. [MCP extensions, one by one](#7-mcp-extensions-one-by-one)
8. [Evidence gaps](#8-evidence-gaps)
9. [Maintainability](#9-maintainability)
10. [A prioritised plan](#10-a-prioritised-plan)
11. [Things not to change](#11-things-not-to-change)

## Progress (2026-10-04 onwards)

Work items W-139 to W-159 in the planner carry this review. This section is the
running record; each line names the item, its state and the commit that closed it.
The planner's source links still say `MCP-REVIEW.md`, the name this file had at the
repository root while the work ran; the anchors are unchanged.

| Item | Scope | State |
| --- | --- | --- |
| W-140 | 2.1 accept caches before granting; proposal receipt on retry | Done, 633adf0 (F-252, C-442) |
| W-141 | 2.2 consent on accept at Unattended | Done, 633adf0 (F-253, C-443) |
| W-142 | 2.3 add_operations clears validate replays | Done, 633adf0 (F-254, C-444) |
| W-143 | 2.4 lease acquire idempotency key and resume handle; proposal summary | Done, e858633 (F-255, C-445); the handle is kept, not retired |
| W-144 | 2.5 small-defect sweep | Done, 8cff008 (F-256, C-446); the clone leak is not a defect |
| W-145 | records read: recordId, sort, desc, filter | Done, 55e7754 (C-447) |
| W-146 | aggregate resource and recordCount | Done, 55e7754 (C-448) |
| W-147 | update_record and apply_writes | Done, 2571bed (C-449); references map on every record input |
| W-148 | proposal detail, live state, receipts, revisions on accept | Done, fd18856 (C-450); receipts under W-144 |
| W-149 | structured refusal _meta; clients stop scraping | Done, f2584b2 (C-451); bounds published, not repeated |
| W-150 | User-Agent fallback, entity bundle, describe facets | Done, 53cb7a0 (C-452) |
| W-151 | subscriptions/listen | Done, d146786 (C-453); the planner mod cannot hold a stream, so it still polls |
| W-152 | Tasks extension | Done, fff18c7 (C-454); no acceptance-wait task, the proposal list and listen carry that |
| W-153 | undo_revision ADR amendment, then build | Done, 366f6bd and 03eb81d (C-455); ADR-0006 and ADR-0009 amended first |
| W-154 | host-level skill over MCP | Done, a6dd934 (C-456); the Inspector's skill verification not run here |
| W-155 | file-carried skill ADR | Done, 86be579 (C-457); ADR-0024 accepted, build is W-160 at Later |
| W-156 | MCP Apps ADR | Done, 86be579 (C-458); ADR-0025 deferred, no build item |
| W-157 | revalidate ADR paragraph, then build | Done, 56855a4 (C-459); ADR-0007 amended first |
| W-158 | evidence lanes | Done, 3f72be0 (C-460); the Inspector lane is unmeasured on this machine |
| W-159 | maintainability sweep | Done, 99882e2 (C-461, accepted exception: the planner mod keeps its own fetch) |
| W-139 | bundle: fold this file into docs when the parts close | Done 2026-10-04: this file moved from the repository root to `docs/reviews/` with this table |

## 1. What is already exceptional

These are the properties a rewrite would have to preserve. They are listed so
that the suggestions below are read as additions, not as a verdict on the base.

- **One typed boundary, no escape hatch.** `NendoAuthoringOperations.All` is both
  the published vocabulary and the enforced allowlist
  (`src/Nendo.LocalMcp/NendoAuthoringOperations.cs:21`), so a documented payload
  field is an accepted one and `sql.execute` is refused exactly like a typo. The
  production gate asserts by name that the adapter cannot reach behaviour
  approval, the custom-view switches or the notification area
  (`tools/Test-Production.ps1:155-176`).
- **Refusals carry the remedy.** `NendoToolBoundary.Validate` reads the argument
  contract off the tool methods by reflection and names the missing key, the
  unknown nested key and the wrong kind before the SDK binder can swallow it
  (`NendoToolBoundary.cs:62-83`). A tool one level up is a `-32602` naming both
  levels and the person's action. A pending proposal is named when a write fails
  on an ID it would create (`NendoAgentProposals.cs:300`).
- **The lease is a capability, the handle a secret, receipts are unprivileged.**
  Lost responses have a documented recovery path (`get_receipt`, `lease.status`),
  and replays are bounded per lease (F-182).
- **Every bound is published.** Change-set ceilings, package bytes, hierarchy
  depth, page limits: all in the vocabulary, all echoed in responses.
- **The text is measured.** Every instruction and description is held under
  2,000 characters by a test that was seen to fail at 2,752
  (`docs/contracts/mcp-interface.md:7-22`). Output schemas describe every
  property; input schemas are closed and lint-clean against the Inspector's four
  rules.
- **Both protocol eras, no credential, one line to register.** The 2026-07-28
  stateless path is served alongside `initialize`; `tools/list` is deterministic;
  cache hints are on every list and read; the build-static resources carry a
  one-hour TTL (`NendoLocalMcpHost.cs:262-320`).
- **The person is visible to the agent and the agent to the person.** `describe`
  carries every read path including templated ones; `nendo://host/instances`
  says which file this is; the Agent page gets one activity entry per call and a
  live "busy" signal (`NendoAgentWorkSignal`).

Nothing below asks to relax any of this.

## 2. Defects found

Ranked by consequence. Each one was checked in the source.

### 2.1 Accept commits, then can report `CHANGE_SET_NOT_FOUND`

`AcceptAsync` promotes first and grants automatic-action consent second
(`NendoAgentAuthoringService.cs:474-485`). Promotion removes the proposal from
the store (`NendoAgentProposals.cs:340-343`). If `unattended.GrantAsync` throws
or the request is cancelled between the two, nothing is cached in
`_acceptReplays`, so the exact retry the instructions tell the agent to make
reaches `proposals.GetOwned` and is refused as a change set this session does
not own. The change is in the file; the agent is told it never existed.

Fix: cache the accept result before the grant, or run the grant under
`CancellationToken.None` and report `behaviourApproved=false` with a message on
failure. `GetProposalReceiptAsync` exists on the application service for exactly
this case and is not called anywhere in the adapter.

### 2.2 At Unattended, accept cannot grant the consent it needs

The Engine answers a promotion refused for `behaviour-not-approved` with
`Applied=false, State=Previewable` rather than throwing
(`src/Nendo.Engine/NendoWriteCoordinator.Promotion.cs:230-238`). `AcceptAsync`
grants consent only `if (outcome.Applied)` (line 481). So a proposal whose
acceptance replays an action the device has not yet approved comes back
`applied=false, previewable` on every attempt, while a direct data write at the
same level succeeds, because `WithConsentAsync` grants and retries on that very
code (`NendoDataMutationService.cs:281-293`). ADR-0009's 2026-09-29 table says
"propose the actions first and the records after"; this is the row where the
agent did that and is still stopped.

Fix: treat `Previewable` with the not-approved message the way the data lane
treats the precondition: grant once, promote once more, then report. The test
in `UnattendedAcceptanceTests` that pairs each grant with its refusal one level
down is the right place for the falsification.

### 2.3 A validate retry can replay a verdict the draft no longer deserves

`AmendAsync` clears `_validateReplays` for the change set (lines 229-234).
`AddOperationsAsync` does not (lines 140-162). The validate digest is only
`{changeSetId}` (line 261). Sequence: validate (invalid), `add_operations`,
validate again under the same idempotency key. The agent gets the old invalid
preview without the new operations ever being compiled. Fix: clear the validate
replays on add as on amend, or fold the draft's operation digest into the
validate digest so the retry is an idempotency conflict rather than a stale
replay.

### 2.4 Proposal ownership dies with the handle, and the recovery text says otherwise

Ownership of a draft or proposal is keyed on the `sessionId`, which is the
application handle minted fresh on every `lease.acquire`
(`NendoLeaseTools.cs:24`, `NendoAgentProposals.cs:255-263`). After a release, a
revocation or a lapsed TTL, the same agent reacquires, gets a new handle, and can
no longer preview, reject or accept what it validated a minute earlier. The
roadmap records this as a limitation; the adapter's own text contradicts it:
`PendingCause` says "If this session validated it, nendo.change_set.accept
applies it" (`NendoAgentProposals.cs:322`), and `NendoAgentProposalSummary`
carries no `changeSetId`, so the agent cannot even name the thing it wants back.

Two related dead ends:

- `NENDO_LEASE_HELD` tells the agent to pass its `applicationHandle` to
  `lease.status` "as it is after a lost acquire response"
  (`NendoToolErrors.cs:130-133`). The handle was in the lost response. The agent
  never had it. With expiry off, only the person can unblock this.
- `DiscardAllDraftsAsync` clears three of the four replay caches and misses
  `_acceptReplays` (lines 563-565 against 535-538).

Fix, in order of ambition:

1. `lease.acquire` takes an optional `idempotencyKey`; an exact retry returns the
   same grant. This closes the lost-response case with no new concept.
2. `lease.acquire` takes an optional `resumeApplicationHandle`. Possession of the
   old handle is proof of prior ownership, so drafts, proposals, replays and the
   receipt scope carry over to the new lease. The old handle is retired.
3. Put `changeSetId`, the owning pseudonym and `ownedByYou` (given a handle) on
   the proposal summary, and let `reject` work on any proposal from the same
   pseudonym after a handle changes.

### 2.5 Smaller defects

- **Clone leak on a cancelled validate.** `proposalId` is minted before
  `PrepareProposalAsync`, but `draft.Preview` is set only after it returns
  (lines 286-299). Cancellation after the Engine created the clone leaves the
  `finally` (320-333) with nothing to reject. A best-effort
  `RejectProposalAsync(proposalId)` on that path closes it.
- **Validated proposals are unbounded per session.** Drafts are capped at 8
  (line 67); each validate moves one into the store, which has no cap, and every
  entry is a physical clone of the file.
- **`nendo://application/proposals` reports state as of validate time.**
  `Snapshot()` projects the stored preview; only `PromoteAsync` rewrites an
  entry. A proposal that went stale when another was accepted still says
  `previewable`. `ListProposalsAsync` on the application service is live and is
  never called.
- **`CloseFileSessionAsync` stops at the first failed reject** (`try/finally`,
  no catch, `NendoAgentProposals.cs:379-389`), leaving later clones in place.
- **Import partial failure is under-reported.** The `NENDO_IMPORT_PARTIAL`
  arm catches `NendoException` only (`NendoImportService.cs:276`). A cancellation
  or an IO failure after batch three escapes without the committed count and
  revision IDs the tool description promises.
- **`get_receipt` cannot read an import batch or an acceptance.** It resolves
  only the `mcp.data.{run}.{owner}` scope (`NendoReceiptContext.cs:412`); import
  batches commit under `agent.import` (`NendoImportService.cs:309`). The
  description says "a prior data-operation receipt" without the exception.
- **Three authoring refusals withhold safe messages.** `CHANGE_SET_STALE`,
  `AUTHORITY_CHANGED` and the authoring `IDEMPOTENCY_CONFLICT` are not in
  `DiagnosableAuthoringCodes` (`NendoToolErrors.cs:113-117`); their messages are
  constants written in the adapter.
- **Accept caches `applied=false`** (line 496), so a same-key retry after the
  cause was fixed returns the stale false. Cache only committed outcomes, or make
  the retry an idempotency conflict with a message that says to use a new key.
- **Contract count drift.** The contract opens with "twenty tools"
  (`docs/contracts/mcp-interface.md:3`); the gate pins twenty-one
  (`tools/Test-Production.ps1:253-274`). `set_kept_in_new_files` arrived without
  the sentence moving.
- **Stale comment in the uploader.** `tools/Put-NendoPackage.mjs` says a fixed
  port "publishes no discovery entry"; it does, and the planner mod depends on it.

## 3. Engine capabilities the surface withholds

This is the largest single gap, and it is cheap to close because every item
below is an existing public method on `NendoApplicationService` behind the same
storage boundary the adapter already uses. Nothing here needs an ADR: ADR-0009
asks that adapters expose typed host services, and these are typed host
services.

| Engine method | What the agent does today instead | Proposed surface |
| --- | --- | --- |
| `QueryRecordsAsync` with `RecordId`, `SortFieldId`, `Descending`, `Filters` (`src/Nendo.Engine/ReadQueries.cs:17-30`: eq, ne, lt, le, gt, ge, contains, isNull, isNotNull, descendantOf) | Pages the whole type 100 at a time to find one record or one value; the planner guide's "read without paying twice" section exists because of this | Extend the records template: `records{?cursor,limit,recordId,sort,desc,filter}` with `filter` as a bounded JSON array of `{fieldId, op, value}` percent-encoded, or as repeated `f=` parameters. Validate against the vocabulary's closed operator list, which already exists for screens. |
| `CountRecordsAsync`, `AggregateRecordsAsync`, `GroupAggregateRecordsAsync`, `BucketAggregateRecordsAsync`, `CellAggregateRecordsAsync` (`NendoApplicationService.cs:110-133`) | Pages everything and counts client-side; no record count exists anywhere on the surface, not even in `describe` | `nendo://application/entity/{entityId}/aggregate{?count,sum,avg,min,max,groupBy,bucket,filter}` returning exact invariant strings, with the same `aggregate-not-exact` withholding rule as today. Put `recordCount` per type into `describe`. |
| `SetFieldsAsync` (`NendoApplicationService.cs:386`, up to 64 fields, one revision) | N `set_field` calls with N hand-carried versions | `nendo.data.update_record(entityId, recordId, expectedRecordVersion, values, expectedTargetVersions)` at Edit data. |
| `ApplyRecordWritesAsync` (`NendoApplicationService.Batch.cs:74`, create/update/delete across types, atomic, 200) | `create_records` for one type, then set_field per reference back-link | `nendo.data.apply_writes(writes[])` at Edit data: the batch form Workbench forms already use. |
| `CompensateRevisionAsync`, `UndoRecordWritesAsync` | Nothing. An agent that made a wrong write at Edit data has no way back except N inverse writes | `nendo.data.undo_revision(revisionId, idempotencyKey)` at Edit data, refused for any revision whose reversibility class is not reversible, and refused for a revision the session did not author unless the person has accepted undo of others' work. Record this in ADR-0006/0009 as an amendment because it is a new authority, even though it is the same compensation History offers. |
| `GetProposalReceiptAsync`, `ListProposalsAsync`, store `Get(proposalId)` | `proposals` snapshot with no diff, no diagnostics, no live state | `nendo://application/proposal/{proposalId}` with the full preview (semantic diff, package hunks, behaviour, shape, diagnostics) for any proposal, since the person can already see all of it in Pending changes. Live state from `ListProposalsAsync`. `get_receipt` extended to proposal acceptances. |
| `ReadExtensionStateAsync` | Nothing | `nendo://application/extension/{packageId}/state`, read-only, for an agent debugging a view. |
| Activity log (`NendoActivityLog.Snapshot`, host-only) | Nothing: an agent cannot see what another client did | `nendo://application/activity{?cursor,limit}` with the same pseudonymised entries the Agent page shows. This is the "who else is here" answer the reviews keep asking for. |

Two further reads that cost nothing to add:

- `nendo://application/entity/{entityId}` as one bundle: schema plus
  `recordCount` plus the surfaces that belong to the type. `describe` is 69 KB
  on the planner; most sessions need one type.
- `describe{?include}` with facets (`manifest,entities,surfaces,health,reads,
  extensions,newFile`) so a client can take the 9 KB it needs.

## 4. Write-path ergonomics

- **Stale cursors on the agent's own writes.** Every write bumps the change
  sequence and every cursor is bound to it, so the common loop "read a page,
  fix a record, read the next page" restarts from page one each time. With
  `recordId` and `filter` reads this stops mattering for lookups, but the page
  cursor could carry the revision it was cut at and be accepted while only
  *later* record IDs changed, since the keyset order is stable record ID. Record
  the decision either way; today the contract just says restart.
- **A stale proposal means a full rebuild.** After `applied=false, stale` the
  agent rejects, begins, re-sends every operation and validates again. The draft's
  mutations are dropped at validate (line 312). Keep them, and offer
  `nendo.change_set.revalidate(changeSetId)`: it re-captures the current
  definition revision and re-runs the same operations through the same clone
  validation. This is still replay of validated operations, not a clone swap,
  so ADR-0007 holds. The roadmap's "rebase needs an ADR" is about *merging*
  concurrent proposals; re-running one against a moved base is not that.
- **The accept result lacks the History revisions.** `outcome.Result.Revisions`
  is available and only `DefinitionRevision` is reported (line 494). The next
  thing an agent does after accepting is read History to confirm; give it the
  IDs.
- **JSON import and `create_records` need a read per reference target.** CSV
  import resolves `matchFieldId` codes and target versions itself; JSON requires
  `expectedTargetVersions` per reference. Let JSON records carry
  `references: {fieldId: {recordId}}` or `{matchFieldId, value}` and resolve as
  CSV does. One rule for both formats.
- **Preview is annotated `ReadOnly` but needs the lease.** Either serve it
  without a lease (it reads a stored preview the person can already see) or
  change the annotation. The former is better now that
  `nendo://application/proposal/{id}` is proposed.
- **Amend says "a draft that has not been accepted".** It refuses anything
  validated. Say "that has not been validated".
- **Hard-coded numbers in descriptions.** `add_operations` says "eight …
  sixteen", `import_records` says "fifty" and "500". The Engine's own comment
  says limits are not to be repeated (`SemanticVocabulary.cs:972-975`). Point at
  the vocabulary and the echoed result, as the other descriptions do.
- **Structured error codes.** Every in-house client regex-scrapes `NENDO_*`
  from result text (`tools/Nendo-McpClient.mjs`, `Gate-AgentAuthoring.mjs`'s
  `explainingTool`). Tool results may carry `_meta`. Add, beside the text,
  `_meta["<your-prefix>/refusal"] = {code, message, remedy, level?, proposalId?}`
  under a reverse-DNS prefix from a domain you control, as the `_meta` rules
  require. Protocol errors keep their `-32602`. The text stays for the model;
  the object is for clients.

## 5. Text, discoverability and the deferred-tool client

Observed in the session that wrote this review: Claude Code now loads MCP tools
lazily. The `nendo` server's twenty-one tools appeared only as names in a
deferred list; their descriptions are fetched on demand through a tool search,
while the **server instructions were in context from the start**. Two
consequences:

1. The instructions are the one text an agent is guaranteed to read. They are
   already written to fit the 2,048 cut and already name the first read, the
   lease, the receipt and the level. That is the right content. Keep them
   first-sentence-dense; the tool descriptions can be longer than they are now
   in a client that loads them one at a time, but the bound test should stay.
2. Tool and resource **names** are now a search surface. `nendo.data.*`,
   `nendo.change_set.*`, `nendo.lease.*` and `nendo.health.*` search well. A
   future `update_record`, `apply_writes`, `undo_revision` and `revalidate`
   should follow the same verb-noun pattern.

Other text items:

- The instructions say "Read nendo://application/describe first" without saying
  it is 69 KB on a mature file. Add "or `manifest` and one `entity/{id}` for one
  type" once that bundle exists.
- `nendo.lease.status` is the right tool after a reconnect and says so; nothing
  tells a *fresh* session that `nendo://application/proposals` may already hold
  its predecessor's work. One sentence in the instructions.
- The handshake-era client shows as "Local agent" in activity because the
  stateless host sees `clientInfo` only in `initialize`. Fall back to the HTTP
  `User-Agent` header, sanitised through `NendoTransportIdentity.Sanitize`, so
  Codex gets a name. Cheap, and it removes a roadmap limitation.

## 6. Protocol posture against 2026-07-28

Checked against the published changelog. The adapter is in good standing:
stateless, both eras, `server/discover` served by the SDK, deterministic tool
order, `ttlMs` and `cacheScope` on every list and read, `-32602` for an unknown
tool, no use of the deprecated Roots, Sampling or Logging features, no reliance
on SSE resumability. Three things the revision added are not used and would pay
for themselves.

### 6.1 `subscriptions/listen`

The revision replaced `resources/subscribe` with one long-lived POST whose
response stream carries opted-in notifications. The .NET SDK 2.2.0 exposes
`McpServerHandlers.SubscriptionsListenHandler` and its documentation says it is
"especially useful for stateless Streamable HTTP, where unsolicited notifications
are dropped but the listen request's response stream can still carry" them.

Nendo has three facts worth pushing instead of being polled:

- `nendo://application/proposals` changed: the person accepted or rejected.
  Today an agent at Shape app validates and then has no signal at all; the
  planner mod polls `lease.status` and a records page every 60 seconds.
- `nendo://application/manifest` changed: a revision committed, by anyone. This
  is the "live updates are not assumed" friction in dogfooding.
- `nendo://application/health` changed: recovery entered, access lowered, the
  host closing. Today an agent learns this from the next refusal.

The Engine already raises a commit event for the Workbench. Wire that to
`resources/updated` on the listen stream for those three URIs, plus
`toolsListChanged` when the level changes. Keep the stream under the same
request gate and timeout; a listen request should hold one of the sixteen
places and be the first thing shed under `NENDO_BUSY`.

### 6.2 Multi Round-Trip Requests

Stateless mode disables server-initiated elicitation; MRTR is the replacement
and the SDK implements it (`InputRequiredResult`, `MrtrContext`). Two uses fit
and one does not:

- Fits: `nendo.lease.acquire` when another client holds the lease. Return
  `input_required` with a form elicitation "Wait, or ask the person to revoke?"
  only if the client declares elicitation. The retry carries the answer. This
  is a convenience, not an authority change.
- Fits: `nendo://host/instances` when the agent reads it and more than one
  Nendo is open: elicit "which file did you mean?" and answer with the right
  address in text. The agent still cannot redirect itself, which is the point.
- Does **not** fit: acceptance. An elicitation "accept this proposal?" rendered
  by the client is a new consent surface that ADR-0009's 2026-09-29 amendment
  rejected under another name ("approve from the review"). Acceptance stays in
  Nendo.

### 6.3 Structured content and `_meta`

Already discussed under refusals. The one addition: every successful write
result could carry `_meta["io.modelcontextprotocol/serverInfo"]` as the spec
asks of 2026-07-28 servers; the SDK does this on the discover path. Check it on
tool results.

## 7. MCP extensions, one by one

Extensions are identified by reverse-DNS, negotiated through the `extensions`
map on both capability sets, always opt-in, and must degrade to core behaviour.
Four official ones exist today.

### 7.1 Tasks (`io.modelcontextprotocol/tasks`) — adopt

The redesigned extension (SEP-2663) is polling-based: a tool may answer
`resultType: "task"` with a durable `taskId`, the client calls `tasks/get`, and
the task can sit in `input_required` for human-in-the-loop steps. The .NET SDK
ships it as `ModelContextProtocol.Extensions.Tasks` 2.2.0, matching the pinned
core version.

Nendo has exactly the operations the extension was written for:

| Operation | Why it is a task |
| --- | --- |
| `change_set.validate` | A physical clone of a 5 MB file plus compilation; five minutes is the current ceiling and a cancelled validate can leak the clone (2.5). |
| `data.import_records` | Up to ten batch revisions with automatic actions; partial failure is already reported batch by batch, which is what task status messages are for. |
| `health.verify_integrity` | A full scan that also hashes every package file. |
| **Waiting for acceptance** | This is the real prize. At every level below Unattended the agent validates and then has no way to wait for the person except asking them in chat. A `validate` that returns a task whose status stays `working` with the message "waiting for the person to accept in Nendo" and resolves to `completed` with the promotion outcome when they do, or `cancelled` when they reject, turns the propose → validate → accept gate into one awaitable call. Acceptance still happens in Nendo. Nothing about authority moves. |

Design notes:

- Return a task only when the client declared the extension; otherwise behave
  as today. The SDK enforces this.
- Task state is host memory keyed by the task ID; it dies with the listener,
  which is what `NENDO_HOST_CLOSED` already means. Say so in `ttlMs`.
- A task must not extend a lease. The agent can release the lease while it
  waits for acceptance, which is the etiquette dogfooding already asks for.
- `tasks/cancel` on a validate rejects the clone; on an acceptance wait it
  rejects the proposal, which is `change_set.reject` by another route and should
  be recorded as such in activity.
- Client support is the open question: the published matrix does not list
  Tasks per client yet. Adopt it anyway; the fallback is the current behaviour
  and the implementation is one package and four handlers.

### 7.2 Skills over MCP (`io.modelcontextprotocol/skills`) — adopt in two steps

SEP-2640 is Final. A server declares `resources` plus the extension, implements
`skills/list` and `skills/get`, and serves `SKILL.md` plus supporting files as
ordinary resources with SHA-256 manifests. Clients today: ChatGPT and Inspector
partially, `mcpc` fully; Claude Code is not yet on the matrix. The .NET SDK has
no skills types in 2.2.0, so the two methods are hand-registered through
`McpServerOptions.RequestHandlers`, which is the same mechanism the host already
uses for its filters.

Why this fits Nendo better than most servers:

- The guidance an agent needs is long and the instructions are capped at 2,000
  characters. The vocabulary (operations, rules, limits), the seventeen examples
  and the view API are already resources; a `SKILL.md` that says *when* to read
  each, with them as supporting files, is the missing index. It replaces the
  prose in `docs/dogfooding.md` that every session re-reads, and it is served by
  the host that knows which build it describes.
- Step one, no ADR: one host-level skill, `skill://nendo-authoring/SKILL.md`,
  generated from the same tables as the vocabulary, build-static, one-hour TTL.
  Supporting files are the existing resources under their `skill://` URIs. Cost:
  two handlers, one generator, one test that the manifest digests match the
  bytes served.
- Step two, needs an ADR: **a file carries its own skill.** ADR-0013 already
  lets a `.nendo` file carry a custom-view package reviewed as code before
  acceptance. A package kind `skill` (a `SKILL.md` and references, no
  executable content) would let the planner file teach an agent its `pl.cmd.*`
  workflow, its Reference codes and its lane rules, and let a CRM file say how
  it wants a lead qualified. The agent discovers it through `skills/list` from
  the file it is connected to. This is the malleable-software axiom pointed at
  the agent itself. Content is untrusted by the extension's own rules (hosts
  must verify digests and require approval), and it enters the file only
  through a proposal the person accepts. The ADR question is whether
  instructions aimed at an agent are "definition" the way screens are, and
  whether Studio shows them.

### 7.3 MCP Apps (`io.modelcontextprotocol/ui`) — later, with an ADR

A tool declares `_meta.ui.resourceUri` pointing at a `ui://` HTML resource that
the host renders in a sandboxed iframe with a postMessage bridge; the app can
call tools. Supported by Claude Desktop and web, VS Code Copilot, Cursor, Goose
and others; not by a terminal client.

The one app that is clearly worth building is a **read-only proposal review
card**: the semantic diff, the shape lines, the package hunks and the behaviour
sentence, rendered the way Pending changes renders them, next to the chat where
the agent proposed it. A second candidate is a record page for one record. Both
are reads. Neither should carry an Accept button, for the reason in 6.2.

Why it waits for an ADR rather than a work item:

- It ships JavaScript to a client host over MCP. ADR-0013's rule is that code a
  file carries runs only as a custom view in the view's own frame. An MCP App is
  neither in the file nor in Nendo's frame. It is a new place code runs, and the
  review bundle it would reuse is host code, not file code.
- It adds a third rendering of the same preview (Workbench, MCP JSON, app). The
  ADR should say which is canonical and how the gate proves the three agree.
- The payoff depends on the person using a client that renders apps. The owner's
  stated loop is Claude Code and Codex in a terminal.

Keep it on the roadmap under "needs decision/ADR" with the proposal review card
as the first candidate.

### 7.4 Auth extensions — not applicable

OAuth client credentials and enterprise-managed authorization exist for remote
servers with an authorization server. ADR-0009 removed the credential on
purpose and names the peer-process user check as the route back if an account
boundary is ever wanted. Neither extension is that route. Do not adopt.

### 7.5 A vendor extension of your own — not yet

Nendo could declare its own `extensions` entry advertising, say, the access
level and the lease state so a client can show them before the first call. The
same facts are one `lease.status` call away and `server/discover` already carries
the level in the instructions. Hold this until a client would do something with
it.

## 8. Evidence gaps

The test project is broad on what the adapter says and thin on what two clients
do to it at once.

- **No two-client race.** Lease refusal and receipt mismatch are covered; two
  agents writing the same file through alternating leases, each holding
  cursors and proposals, are not. One lane: client A validates, client B
  accepts at Unattended, client A's cursor and proposal go stale, A recovers
  through the documented path. This is the lane that would have caught 2.4.
- **No soak.** Nothing runs a lease for an hour with renewals, or validates
  eight drafts and begins eight more (2.5, unbounded store).
- **Protocol matrix.** `initialize` is tested at 2025-06-18 only;
  `server/discover` at 2026-07-28 only. One parametrised test over every
  version the SDK lists in `supportedVersions`.
- **Installed-client lanes pass when skipped.** Both `return` when the opt-in
  variable is unset and report success. Mark them `Inconclusive` so a gate run
  that never exercised them says so.
- **No Inspector lane in the gate.** The blackbox prompt asks reviewers to run
  `npx @modelcontextprotocol/inspector --cli … tools/list`; the gate ports four
  of its rules. If the Inspector is on the machine, run it in
  `Test-Production.ps1` behind a switch, the way the installed-client lanes are
  switched.
- **Falsification evidence for the four defects above** belongs in Findings
  with the failing text quoted, per the "when something is reported broken"
  loop in `AGENTS.md`.

## 9. Maintainability

Found by reading; none of these changes behaviour.

- `NendoAgentAuthoringService.cs` holds four replay caches with four
  copy-pasted "remove where SessionId ==" loops (531-546); the `CHANGE_SET_FROZEN`
  refusal twice (131-136, 193-198); `ResolveRevision` re-implementing the
  `Object()`/`Without()` helpers (809-831 vs 788-807); `CanonicalCount`
  re-deriving `Expand`. A `RemoveWhere` on `NendoReplayCache` and one frozen
  refusal helper remove most of it.
- `State` is typed three ways across results: an enum on the preview, a string
  on accept, the literal `"draft"` on begin and add. One enum serialised
  camelCase by the options the host already uses.
- `NendoRecordInput` is mapped to `NendoCreateRecordEntry` in both
  `NendoDataMutationService` (65-74) and `NendoImportService` (213-227), with
  different ID validation and a null-versus-empty difference for target
  versions. One mapper.
- The 200-character idempotency-key bound is restated in five files. One
  constant in `NendoAuthoringLimits`, published in the vocabulary like the rest.
- `ExecuteAsync` exists three times (`NendoDataTools`, `NendoAuthoringTools`,
  `NendoUnattendedTools`). One generic wrapper that takes the activity kind.
- `RevokeSessionAsync` on `NendoAgentAuthority` has no production caller.
- The parameter called `sessionId` throughout the adapter is the application
  handle. Rename it; 2.4 was hard to see because of it.
- `NendoMcpDescription` has two `<summary>` blocks, the first stale
  (`NendoMcpContracts.cs:263-278`).
- Every in-house client re-implements discovery scanning, liveness, identity
  check, cursor paging, chunking and lease acquire/release.
  `tools/Nendo-McpClient.mjs` should own all six, and the planner mod should
  import it rather than carry a copy with `id: 1` and no liveness check
  (F-212 applies to it today).

## 10. A prioritised plan

Each line is sized for one work item. Standing is noted where an ADR is needed.

**Now: defects (no ADR).**

1. 2.1 accept-then-grant ordering, with `GetProposalReceiptAsync` as the
   recovery read. Falsify by throwing from the consent delegate.
2. 2.2 consent on accept at Unattended. Falsify with the existing paired test.
3. 2.3 validate replay after add. Falsify with the three-call sequence.
4. 2.4 acquire idempotency key, then resume handle; `changeSetId` and
   `ownedByYou` on the proposal summary; fix `LEASE_HELD` text; clear
   `_acceptReplays` on discard.
5. The rest of 2.5 as one sweep, with the contract count and the uploader
   comment.

**Next: the Engine's reads and writes (no ADR).**

6. Records: `recordId`, `sort`, `desc`, `filter` on the records template.
7. Aggregates resource and `recordCount` in `describe`.
8. `nendo.data.update_record` and `nendo.data.apply_writes`.
9. `nendo://application/proposal/{proposalId}`, live state, `get_receipt` for
   imports and acceptances, revisions on the accept result.
10. Structured refusal `_meta`, and the in-house client stops scraping.
11. `User-Agent` fallback name; `entity/{id}` bundle; `describe{?include}`.

**Next: protocol (no ADR, SDK supports both).**

12. `subscriptions/listen` for proposals, manifest, health and tool-list
    changes; the planner mod and `/next` switch from polling to listening.
13. Tasks extension for validate, import, verify and the acceptance wait.

**Later: decisions.**

14. ADR-0006/0009 amendment for `nendo.data.undo_revision` at Edit data.
15. Host-level Skills over MCP (no ADR), then an ADR for file-carried skills.
16. ADR for MCP Apps with the proposal review card as the candidate.
17. `change_set.revalidate` after a stale acceptance; confirm it stays within
    ADR-0007 as written here, or amend.

**Alongside: evidence.**

18. Two-client race lane, soak lane, protocol-version matrix, `Inconclusive`
    on skipped installed lanes, optional Inspector lane.

## 11. Things not to change

- The closed vocabulary, the proposal gate below Unattended, and acceptance in
  Nendo. Every extension above was chosen because it leaves these alone.
- No credential, loopback only, exact Host and Origin. The auth extensions do
  not replace the peer-process check and should not be read as a reason to add
  one.
- Reads as resources, writes as tools, Inspect with an empty tool list. The
  aggregate and proposal reads above are resources for this reason.
- The 2,000-character bound on every description, measured by a test.
- `destructiveHint` true on everything that overwrites. `update_record`,
  `apply_writes` and `undo_revision` are destructive.
