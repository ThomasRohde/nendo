# Outside app-builder review of the MCP contract

Received 2026-10-05 as `MCP-FEEDBACK.md` at the repository root, from a team that built a
GitHub Copilot CLI extension (`debate-nendo`) against Nendo 0.17.0 through the local MCP
endpoint alone, without this repository. Each claim was checked against the code the same
day and answered as planner bundle W-164. The review follows unchanged below this status.

## Status of each point

| # | Point | Answer |
| --- | --- | --- |
| 1 | No change notifications for MCP clients | Partly present when they tested: W-151 (`subscriptions/listen` for manifest, proposals, health) shipped the day after 0.17.0 was cut. **W-171** adds `nendo://application/entity/{entityId}/records` to listen, naming the changed records in `_meta`. Handshake-era `resources/subscribe` is not served: the transport is stateless. |
| 2 | Value size limit unpublished; refusal unnamed; 1 MB body is a transport error | **W-165**: `limits.recordValueBytes` (32 KiB), `recordValuesBytes` (64 KiB) and `requestBodyBytes` (256 KiB) published; sizes counted as stored, not as escaped (a tool's arguments reach the adapter with `ø` as `\u00f8`, six bytes, which is why their 16,381 × `ø` was refused); `NENDO_VALUE_TOO_LARGE` / `NENDO_VALUES_TOO_LARGE` name field, cap and size; an oversized body is answered under its JSON-RPC id as a refused tool result. |
| 3 | Every write keeps a History revision, drafts included | Declined. ADR-0021 lets only the person fold history; a transient write would let an agent decide what History keeps. Write one revision per finished turn, not per streamed chunk. |
| 4 | Native screens cannot be filtered at run time | **W-172**, ADR-0004 amendment of 2026-10-05: **Filter** on a list, board or matrix picks one value of one choice or reference field, transient and never written. |
| 5 | Long text cannot be shown as Markdown | **W-173**: presentation `markdown` on Text fields, host 1.44.0. |
| 6 | Node positions are write-only | **W-168**: `surfaces` gives every node `surfaceId`, `parentNodeId` and `position`; `ui.addNode` and `ui.moveNode` take `beforeNodeId` / `afterNodeId`. |
| 7a | `op` vs `operator`, `lte` vs `le` | Deliberate and documented (`SemanticVocabulary.cs`): the durable contract keeps `lte`/`gte`, the query spells `le`/`ge`, and the MCP read takes `op`. Not changed. |
| 7b | `validate` has no `isValid` | **W-167**: `isValid` on validate, revalidate, preview and the proposals read. |
| 7c | `references` cannot name a target created earlier in the batch | **W-166**: resolved by record ID or unique value among the batch's earlier writes. |
| 8 | One exclusive lease per file, data writes included | Declined. ADR-0009 allows one lease per file; the handle is a capability several clients may share, which is the sanctioned way for a background writer and an author to coexist. |
| 9 | No way to find a running file's endpoint | Already present: `%LOCALAPPDATA%\Nendo\Mcp\active\` holds one entry per open file, and each file keeps its own port. **W-169** names it in the agents guide, and the skill and the instances read point there (the protocol carries no path). |
| 10a | `NUI452` before the package exists | Already worked in one change set; **W-170** adds the test and says so in the examples and docs. |
| 10b–d | 64 toolbar options, 360 px panels, `loadRecords` extra filters | Not filed. |

## The review as received

This feedback comes from building `debate-nendo`, a GitHub Copilot CLI
extension (`.github/extensions/debate-nendo/`). The extension mirrors live
model debates into a Nendo file and takes requests back from buttons in that
file. Everything went through Nendo's local MCP endpoint: Nendo 0.17.0,
contract version 3, the Unattended access level and one file
(`Debate.nendo`). The work was:

- building the app over change sets (record types, screens, record commands
  and a custom-view package), and later upgrading it;
- a background writer that sends batched, versioned `nendo.data.apply_writes`
  calls while a debate runs, every few seconds;
- a poller that claims and answers the requests that record commands file;
- a custom view (`extensionRecordPanel`, `extensionView` and
  `extensionRecordsSurface`).

Each point below is something we observed or had to work around. Where we did
not verify something, we say so.

### What worked well

- **The contract describes itself.** We wrote the app without outside
  documentation. We read `nendo://application/vocabulary`, `describe`,
  `examples`, `view-api` and the authoring skill. The vocabulary's kinds,
  required properties, permitted children and limits were accurate.
- **Validate before accept.** `change_set.validate` followed by `reject` gave us
  a safe dry run (`apply.mjs --validate-only`) against the real file. We used it
  before every change to the definition.
- **Refusals carry stable codes.** Each refusal has a `NENDO_` code in `_meta`.
  A client can branch on the code, not on the prose. Idempotency keys and
  receipts (`data.get_receipt`) made it possible to retry after a lost
  response without writing twice.
- **Optimistic concurrency.** `expectedRecordVersion` on every write handled
  two cases. Two CLI sessions racing to claim the same button request could
  not both win. A person editing a record while the extension wrote to it got
  a clean `NENDO_RECORD_VERSION_CONFLICT`.
- **The view sandbox and its API.** We could follow these rules without effort:
  no network, no storage, theme tokens, `changes` events, toolbar controls,
  `ui.setHeight` and `ui.openRecord`. The rules are strict and still practical.
  `nendo.has(...)` makes it easy to degrade gracefully.
- **History labels.** `apply_writes` labels made every revision traceable to a
  debate and a turn.

### Problems and suggestions

Ordered roughly by how much they cost us.

#### 1. MCP clients cannot learn about changes without polling

A view gets `changes` events. An MCP client gets nothing, as far as we could
find in `resources/list` and the tool list. Our buttons (`recordCommand` with
`commandStep`s) set request fields, so the extension has to poll every 2 s for
pending requests and back off while Nendo is closed. That means latency, wasted
calls and a lot of code for something the host already knows.

**Suggestions:**
- support `resources/subscribe` on entity records, or on a filtered records
  URI;
- or add a record-command step kind that notifies connected MCP clients, a
  kind of "outbox" event they can wait on.

#### 2. The size limit on record values is not in `limits`, and its refusal does not state it

A write is refused when its `values` object is larger than about 32 KiB of
UTF-8 JSON. The refusal is `NENDO_INVALID_REQUEST`: "Record values must be a
bounded JSON object."

- `describe.limits` lists `valuesPerRecord: 128` and `fieldsPerRecordUpdate`,
  but no byte budget.
- We found the threshold by bisection. 32,763 ASCII characters in one field
  were accepted. Two such fields, or 16,381 × `ø`, were refused.
- A 1 MB body gave a transport-level RPC error, not a refusal.

**Suggestions:**
- publish the budget in `limits`, for example `recordValuesBytes`, and say
  whether it is per write or per record;
- name the budget and the actual size in the refusal, with a dedicated code
  such as `NENDO_VALUES_TOO_LARGE`;
- refuse oversized bodies with the same structured refusal.

Long model answers are common in this kind of app. We now shorten them on the
client side, and the full text lives outside Nendo.

#### 3. Every write adds a History revision, even for transient data

We stream the answer a model is writing into a `long` field every 3 s, so
users can watch it. Each `apply_writes` call becomes a History revision that
keeps the full text, so one debate turn leaves many near-identical revisions.
That costs storage. It also hurts privacy: model answers can quote
confidential context, and History keeps every draft.

**Suggestions:**
- add a way to mark a field, or a write, as transient: it is not kept in
  History, or it is collapsed into the next non-transient revision;
- or add a "replace the previous revision with the same label" option;
- or add a History retention setting per record type.

#### 4. Native screens cannot be filtered at runtime

`filterClause`s are fixed in the definition. Users asked to filter **Issues by
status** by debate (a reference field). We could only do it by replacing the
native board with an `extensionRecordsSurface` that reimplements the board,
which also loses native drag and drop.

**Suggestions:**
- add a runtime quick filter on board, list and matrix surfaces for choice and
  reference fields;
- or add a definition-level "filter control" child that lets the person pick
  the value of one clause.

#### 5. Long text cannot be shown as Markdown

AI-generated text (and many notes fields) is Markdown, but `longText` shows it
raw. We wrote a custom view, plus a parser, only to show headings, lists, tables
and code nicely on a record page.

**Suggestion:** add a `markdown` presentation for text fields: a safe subset,
rendered as text nodes, with links inert or opened through the host.

#### 6. Node positions are write-only

`ui.addNode` and `ui.moveNode` take a zero-based `position`, but neither
`nendo://application/surfaces` nor `describe` returns positions. Root order is
also not visible. When we replaced a root screen in an existing file, we had
to guess its index from the original change sets. We guessed wrong, and the
new screen landed one slot late, after the matrix. It took a second change set
(`ui.moveNode`) to fix it.

**Suggestions:**
- return `position` (and the parent) for every node in `surfaces`;
- accept relative anchors such as `beforeNodeId` / `afterNodeId`;
- or add a `ui.replaceNode` that keeps the old node's place.

#### 7. Small inconsistencies between the MCP API and the view API

- **Filter key and operators.** The MCP records filter is
  `{fieldId, op, value}`. The view API's query filter is
  `{fieldId, operator, value}`. The vocabulary's `filterClause` uses `lte` /
  `gte`, while query operators are `le` / `ge`. We had to keep three spellings
  in our heads; one shape everywhere would help.
- **Validate result shape.** `change_set.validate` reports `state` (for
  example `previewable`) and `diagnostics`, but no `isValid`. The `surfaces`
  resource does report `isValid` / `state`. A boolean in both, or one
  documented rule ("valid when no diagnostic has severity error"), would make
  clients less fragile.
- **References to records in the same batch.**
  - A reference to a record created earlier in the same `apply_writes` batch
    works as a plain value.
  - The same target named under `references` fails with
    `NENDO_TARGET_NOT_FOUND`.
  - For targets outside the batch, it is the other way round: `references`
    works, and a plain value needs the target's version.

  The client has to track which targets were written earlier in each batch. It
  would be simpler if `references` also resolved targets created earlier in the
  same batch.

#### 8. One edit lease per file, for data writes too

`nendo.lease.acquire` gives one owner per file. Our background writer holds the
lease while a debate runs. Any other agent, including our own `apply.mjs`
script for app changes, then has to wait or take over. Record writes already
carry `expectedRecordVersion`, which gives safe concurrency at the record
level. We release the lease after a minute idle and save its handle to resume
after a reload; that is a lot of machinery for a background mirror.

**Suggestions:**
- add a shared lease mode for the data lane (record writes only, protected by
  versions), separate from the exclusive definition lane;
- or allow short-lived, per-call leases for `apply_writes`.

#### 9. Finding the endpoint

The MCP address has to be copied from Nendo into `.mcp.json`. To find which
running Nendo has a given file open, a client must already know one endpoint
so it can read `nendo://host/instances`. We query every loopback server in the
MCP configuration.

**Suggestion:** publish running instances in a well-known per-user location,
for example a small JSON file under `%LOCALAPPDATA%\Nendo\instances\`, holding
the endpoint and the open file name. Tools could then find a file's endpoint
without configuration. Alternatively, give each file a stable port.

#### 10. Smaller points

- **`NUI452` warning before the package exists.** An `extensionRecordPanel`
  that names a package not yet installed gives a warning until the package
  arrives in a later change set. It would help if the package could come in
  the same change set, or if validation took a pending package in the session
  into account.
- **Toolbar `select` takes at most 64 options.** A filter over many records
  (runs, in our case) needs a searchable picker or a larger limit. We show the
  newest 63 runs.
- **Record page panels start 360 px tall.** A `fit to content` option would
  save every view from measuring itself and calling `ui.setHeight` again after
  each render.
- **`extensionRecordsSurface` context.** It would help to have the surface's
  own filter clauses resolved for `records.query` (as `view.loadRecords()`
  does), so a custom board can add one clause without restating the others.
  We did not verify whether `loadRecords` accepts extra filters.

### Summary of requests

| # | Request | Effect for clients like ours |
| --- | --- | --- |
| 1 | Change notifications for MCP clients | No polling for button requests |
| 2 | Published byte budget and a specific refusal for record values | No bisection; predictable limits |
| 3 | Transient fields or writes kept out of History | Live streaming without History bloat or retained drafts |
| 4 | Runtime filters on native boards and lists | No custom view only to filter |
| 5 | A `markdown` presentation for text | Formatted AI output without a custom view |
| 6 | Readable node positions, or relative anchors | Safe upgrades of existing apps |
| 7 | One filter shape, a validate boolean, uniform reference resolution | Less client-side special-casing |
| 8 | A shared lease mode for record writes | Background writers and app authors can coexist |
| 9 | Discovery of running instances | Zero-configuration connection |

Thank you for Nendo. A self-describing local MCP contract made it possible to
build and change a complete app from an extension, and the strictness of the
contract caught real mistakes before they reached the file.
