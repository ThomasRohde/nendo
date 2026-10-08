# Feedback on the Nendo MCP server: using it from a tool-only client

For the Nendo maintainers · 8 October 2026

An agent in GitHub Copilot CLI used the Nendo MCP server to build a note structure in a Garden file: 39 new notes, 23 tags and 74 links, most of them kept in new files. This note reports what worked, what got in the way, and what we recommend. Every finding comes from that session: tool results, tool definitions, the file's own agent skill and the Garden view's code.

## Summary

Writing through Nendo works very well. Batches are atomic, every write is idempotent, versions protect against lost updates, and a malformed call is refused with a message that says exactly what to send.

Reading is the gap. Everything an agent must read before it writes is offered only as `nendo://` resources: IDs, schemas, records and their versions, limits, the change-set vocabulary and History. Copilot CLI's MCP client uses tools only, so the agent could read nothing through Nendo, and the file's own agent skill never reached it. It fell back on opening the SQLite file directly, which is the one thing you would least want an agent to do.

Recommendations, most important first:

1. **Add a read tool.** A read-only tool that takes any `nendo://` address and returns the resource, plus one that lists them. This one change makes every tool-only client a full client, without a second contract to maintain.
2. **Say how to read, early.** Put it in the first sentence of the server's description, and return the limits and key addresses from `nendo.lease.acquire`, the call every agent makes first.
3. **Batch "kept in new files".** Accept `keptInNewFiles` on `nendo.data.apply_writes`, and let `nendo.data.set_kept_in_new_files` take several records in one revision.
4. **Report the concurrency limit as a tool error, or queue.** Today a call beyond the 16 in flight fails with HTTP 429, which the client treats as a transport failure.
5. **Garden: define the Body-row derivation exactly,** or let the view derive rows for notes written over MCP. The skill's description differs from what the view does.

The root cause sits in the client, and it is worth raising with GitHub as well. But some MCP clients use tools only, and a read tool makes Nendo work with all of them today.

## The session

| | |
| --- | --- |
| Client | GitHub Copilot CLI 1.0.80 on Windows, over Streamable HTTP; the model was Claude Opus 5.5 |
| File | `Garden.nendo`: format `nendo.sqlite.application` 1 (minimum host 1.46.0), Garden view `org.nendo.garden` 0.21.0, agent skill `dev.nendo.garden` 1.4.0 |
| Lease | Unattended, ended by an explicit release |
| Writes | 5 `apply_writes` batches holding 137 writes (136 creates, 1 update), then 134 `set_kept_in_new_files` calls |
| Calls | 160 in all: 143 succeeded and 17 failed (5 invalid requests while learning call shapes, 1 missing target version, 11 busy) |
| History | 139 new revisions, 134 of them single-record "kept in new files" marks |
| Result | The integrity check passed, and the end state was verified against the Garden view's own code |

Three things about the client shaped the session:

- **Tools only.** Copilot CLI's MCP documentation speaks only of a server's tools: its configuration allows or blocks tools, and `/mcp show` lists tools. Nothing in the session could list or read resources.
- **Deferred definitions.** At first the agent sees only tool names, and it loads a definition by searching for the tool. Its first calls guessed the shape; your errors corrected it.
- **Truncated description.** The client's tool listing cut the server's description at about 150 characters: "This is the Nendo file Garden.nendo: record types and records, screens (lists, boards, calendars, record pages and commands), calculated fields, reusable fun…".

## What worked well

Please keep these:

- **Errors that teach.** For example: "nendo.data.apply_writes was not called. writes[0] does not take 'op'; a record write takes kind, entityId and recordId, and optionally values, expectedRecordVersion, expectedTargetVersions and references." Five messages like it taught the agent every call shape it got wrong, and "was not called" made it clear a retry was safe.
- **Atomic batches across record types.** One `apply_writes` call wrote 74 links; another updated a note and created 7 notes and 23 tags. A write may reference a record created earlier in the same batch, and the host supplies its version.
- **Idempotency keys on every write,** so the calls that failed as busy could simply be sent again.
- **Versions in every result,** so records created in the session could be referenced without reading them back.
- **Plain tools for health and leases.** `nendo.health.verify_integrity` and `nendo.lease.status` gave clear answers.

## Findings and recommendations

### 1. Reads exist only as resources

**Severity: high.**

The tool descriptions send the agent to resources for nearly everything it must know:

| To | The tools point to |
| --- | --- |
| Find entity and field IDs | `nendo://application/entities`, `.../describe`, `.../entity/{entityId}/schema` |
| Get a record's current version, for an update or after a conflict | `nendo://application/entity/{entityId}/records` ("read the record and carry its current version") |
| Learn the limits: batch sizes, fields per update, label length | `nendo://application/vocabulary` |
| Write a change set | `nendo://application/vocabulary` ("The contract lives in nendo://application/vocabulary, not in this description") and `.../examples` |
| Check that new files can be made | `nendo://application/describe`, under `newFile.conflicts` |
| Confirm a write | "Read the record back at nendo://application/entity/{entityId}/records" |
| Find a revision to undo | `nendo://application/history` |

The file's agent skill adds search, aggregates and lookups by slug, all of them resources too.

From a tool-only client, an agent therefore cannot update a record it did not just create, cannot learn the limits, cannot check for new-file conflicts, and cannot write a change set without guessing its operations. This session got by because nearly everything it wrote was new, so the versions came back from the creates. Its one update, to a note at version 5, and every check of the end state needed the SQLite file. The agent opened it for shared reading while Nendo held it.

That workaround is worth avoiding. It depends on internal physical names such as `note_23106857` and `title_33dd6d86`, it goes around the host and its lease, and it could catch the file mid-write. An agent with shell access may well take that route when the supported one is closed; this one did.

**Recommendations**

- Add a tool such as `nendo.read.resource` that takes a `nendo://` address and returns exactly what the resource returns, and `nendo.read.list` for the addresses and address templates. Like the resources, neither should need a lease.
- Mark both with the MCP annotation `readOnlyHint: true`, so a client can run them without asking each time.
- Optionally, add typed tools for the most frequent reads: records with filter, sort, fields and paging; records by ID with their versions; search; aggregates.
- Keep the resources. Clients that can read them lose nothing.

### 2. The contract is hard to find

**Severity: high.**

- **The description gets cut.** A client that truncates the server's description shows only its opening clause, so the most useful sentence should come first. For example: "If you cannot read MCP resources, read them with nendo.read.resource; start with nendo://application/describe."
- **The limits are out of reach.** `nendo.lease.acquire` returns a lease, a handle and a receipt context. Adding the main limits (`recordWritesPerCall`, `recordsPerCreateBatch`, `fieldsPerRecordUpdate`, `recordWritesLabelCharacters`) and the key addresses would give a tool-only agent the essentials from the call it always makes first.
- **The skill never arrived.** The file's agent skill, `dev.nendo.garden`, holds rules an agent needs: Body versus Manual rows, slugs, the 32 KiB bound on a value, and how to use the lease. It never reached the agent through Nendo; the agent found it in the file's extension tables. Make sure the read tool can return it, and name it in the server's description.

### 3. "Kept in new files" costs a call and a revision per record

**Severity: medium.**

`nendo.data.create_record`, `create_records` and `import_records` take `keptInNewFiles`, but each covers a single record type per call. `nendo.data.apply_writes`, the only batch that spans record types, does not take it. This skeleton mixed notes, tags and links that point at each other, so the agent created it with `apply_writes` and then marked 134 records with 134 calls to `set_kept_in_new_files`. History now holds 134 revisions for one decision, and sending that many calls is what pushed the agent into parallel calls (finding 4).

**Recommendations**

- Accept `keptInNewFiles` on each `apply_writes` write.
- Let `set_kept_in_new_files` take a list of records, as one revision.
- Consider "keep this record and everything it points at". A kept record may point only at kept records, so this would also guarantee there are no `newFile.conflicts`.

### 4. The concurrency limit arrives as HTTP 429

**Severity: medium.**

With 30 calls in flight, 11 failed at the transport level:

```text
HTTP 429 Too Many Requests: {"error":"NENDO_BUSY","message":"16 requests to this file are already in progress, the most this host serves at once. Retry when one of them has answered."}
```

Copilot CLI reported these as "MCP request failed: Transport send error", not as tool results. The message itself is clear, but a client may treat a transport failure as a broken connection.

**Recommendations**

- Hold excess calls briefly in a bounded queue, or answer with a tool error result (`isError`) that carries `NENDO_BUSY` and a retry delay.
- Publish the limit alongside the others.
- Batching (finding 3) removes most of the reasons to call in parallel.

### 5. Writing a Garden note over MCP means re-implementing the view

**Severity: medium. Package: Garden.**

The skill says: "When you write a body over MCP, write its Body rows yourself the same way, or leave them and the next save in the view will make them." Leaving them means the graph and backlinks stay empty until each note is saved in the view, and hub notes are rarely saved. Writing them "the same way" is underspecified:

- **Link context.** The skill and the help call it "the sentence". The view stores the whole source line, trimmed and cut to 200 characters around the link (`parse.mjs`), so a line with two sentences keeps both. An agent that follows the skill writes a different context, and the next save in the view rewrites every such row, one extra update per link.
- **Task key.** The skill calls it "the key of its text". The view uses FNV-1a over the lower-cased, whitespace-collapsed text, as eight hex digits, adding `-2` and `-3` for repeats.

The agent matched the view only by extracting `parse.mjs` and `sync.mjs` from the file and reading them.

**Recommendations**

- Either state the derivation exactly in the skill, naming `parse.mjs` as the reference, or have the view derive the rows for notes whose body changed without them.
- Replace "sentence" with "line" in the skill and the help.

### 6. Smaller points

**Severity: low.**

- **The view and the MCP name the same things differently.** The view's batch writes use `op`, `version` and `targetVersions`, while `apply_writes` uses `kind`, `expectedRecordVersion` and `expectedTargetVersions`. An agent that learns from the view's code, as this one did, gets its first call wrong. Aligning the names, or accepting both, avoids that.
- **The missing-version error doesn't say what to do.** "NENDO_TARGET_VERSION_REQUIRED: Select the target again so its current version can be checked." reads as interface copy. Naming the write, the field and the target, and the two remedies (`expectedTargetVersions` keyed by field ID, or `references` by record ID or unique field), would make it as useful as the other errors.
- **`apply_writes` doesn't say that an update advances the version once per field written.** `update_record` says so. A four-field update took a note from version 5 to 9.
- **Arguments vary between tools.** `verify_integrity` refuses `applicationHandle` ("it takes no arguments"), while `lease.release` requires it as well as `leaseId`. Accepting and ignoring the handle everywhere would save a round trip.
- **Nothing steers agents to `label`.** History is how a person reviews an agent's work, but the skill's write guidance never mentions `label`, the name History gives a revision. This session didn't use it, so its 139 revisions are described only by what they do.

## Appendix: errors observed

| Tool | Result | Cause |
| --- | --- | --- |
| `nendo.data.apply_writes` | `NENDO_INVALID_REQUEST`: writes take `kind`, not `op` | The view's write format was used |
| `nendo.data.apply_writes` | `NENDO_INVALID_REQUEST`: requires `applicationHandle` and `idempotencyKey` | The tool's definition wasn't loaded yet |
| `nendo.data.apply_writes` | `NENDO_TARGET_VERSION_REQUIRED` | Parents created in an earlier batch were referenced without their versions |
| `nendo.data.set_kept_in_new_files` | `NENDO_INVALID_REQUEST`: no `recordIds`, one `recordId` per call | Several records were sent in one call |
| `nendo.data.set_kept_in_new_files` | HTTP 429 `NENDO_BUSY`, 11 times | 30 calls were sent in parallel |
| `nendo.health.verify_integrity` | `NENDO_INVALID_REQUEST`: takes no arguments | `applicationHandle` was sent |
| `nendo.lease.release` | `NENDO_INVALID_REQUEST`: requires `applicationHandle` | Only `leaseId` was sent |

## Fix pass (2026-10-08, Garden 0.21.1)

Every finding is fixed; the optional extras left undone are named at the end. Each fix has a guard
in a lane that already runs: `tests/Nendo.LocalMcp.Tests` (`ToolOnlyClientTests`,
`BatchWriteToolTests`, `HostHardeningTests`, `SurfaceTextBoundTests`, `FileSkillTests`) and
`tools/garden/skill.test.mjs` in `tools/Review-Garden.ps1`. Every guard was falsified: the
defect was put back, the guard failed with the text below, and it passed again once the fix
was restored, byte for byte.

| Finding | Fix | Failure with the defect put back |
| --- | --- | --- |
| 1 | `nendo.read.resource` takes any `nendo://` or `skill://` address and returns exactly what `resources/read` returns, through the SDK's own resource match; a resource's refusal comes back as a refused tool result. `nendo.read.list` names every address, the templated ones included, and every skill. Both are `readOnlyHint` and served from Inspect, which listed no tools until now (ADR-0009, 2026-10-08 amendment). | No read tools at Inspect: `Method 'tools/call' is not available.` A refusal left as a protocol error: `McpProtocolException: Request failed (remote): NENDO_ENTITY_NOT_FOUND: …` |
| 2 | The instructions name the read tool by character 124, right after the file's name, and say to read a skill the file carries before writing. The lease grant carries `limits` (the batch, field, label, value and body bounds, `requestsInFlight`, `requestQueueSeconds`) and `reads`, the first reads by address. The host skill says how to read without resources. | Sentence after the description: `At ReadOnly the read tool is named by character 311, past the 150 a client shows`. Grant without limits: `The grant carries no limits.` |
| 3 | Each `apply_writes` write takes `keptInNewFiles`, in the batch's revision. `set_kept_in_new_files` takes up to 200 `records` of any types as one revision. History undoes a revision that carries marks as a whole, and refuses when a mark changed since (ADR-0022, 2026-10-08). | Batch ignoring the mark: `Assert.IsTrue failed. … record.RecordId == "p2").KeptInNewFiles`. Undo not offered: `History does not offer to undo a batch that marks its records.` One record of several marked: `CollectionAssert.AreEqual failed. Different number of elements.` |
| 4 | A request past the 16 in flight waits up to 30 seconds for a place, with at most 64 waiting, and only then is `429 NENDO_BUSY`. Both bounds are published in the vocabulary and the grant. | Refused at once again: `Timed out waiting for the request past the bound to wait.` |
| 5 | The Garden skill (1.5.0) states the derivation exactly, names `parse.mjs` and `sync.mjs` as the reference, and carries a worked example whose rows a test derives with the view's own `parse()`. "Sentence" is "line" in the skill, the help, the guide sheet, the definition and the design note. | Context as the sentence: the `links: target and context` diff. Key of the raw text: `+ key: '3a91c999'` / `- key: '434efef9'` |
| 6 | A view-API key is refused naming the key meant. `NENDO_TARGET_VERSION_REQUIRED` names `writes[i]`, the field, the target and both remedies, before the Engine's form wording is reached. `apply_writes` says an update advances one version per field. `verify_integrity` accepts and ignores `applicationHandle`. The host skill, the Garden skill and `apply_writes` all ask for a `label`. | `… does not contain string ''op', the view API's name for kind'`; `NENDO_TARGET_VERSION_REQUIRED: Select the target again so its current version can be checked.' does not contain string 'writes[1] sets project to p1'`; `It does not take 'applicationHandle'; it takes no arguments.` |

Not done, on purpose:

- **Typed read tools** for records, search and aggregates. `nendo.read.resource` reaches all of
  them by address.
- **A busy refusal as a tool result.** A request is counted before its body is read, so it has no
  JSON-RPC id to answer under. The queue makes the refusal rare instead.
- **Accepting the view's key names** in `apply_writes`, **the view deriving rows** for notes
  written over MCP, and **"keep a record and everything it points at"**. The refusal names the
  key, and the skill now states the derivation.

`lease.release` still takes both the handle and the lease ID, because the handle is the
authority.

Checks run:

- `Nendo.LocalMcp.Tests`: 238 passed, 5 skipped (the opt-in installed-client, Inspector and soak
  lanes).
- `Nendo.Engine.Tests`: 1,109 passed, 2 skipped.
- Workbench `help.test.mjs` and `format.test.mjs`: 29 passed.
- `tools/Review-Garden.ps1`: 79 unit tests and the browser lane passed, with no browser
  exceptions.

`workspace/Garden.nendo` carries Garden 0.21.1 and skill 1.5.0 (`Build-Garden.mjs upgrade`,
definition revision 67). `Build-Garden.mjs compare` still reports that a new garden would keep 1
record rather than 33 seeds; the last pass recorded the same thing.

The full gate, `Test-Production.ps1 -SkipRestore`, ran with these results:

- **Passed:** every stage before the Garden lane, including LocalMcp 238, Desktop 390 and Engine
  1,109, the boundary checks, the surface check (`25 resources, 27 closed tools`) and the Help
  inventory.
- **Garden browser lane, failed in the gate:** a motion-timing check on the Graph screen
  (`{"travelled":36,"afterTwoSeconds":3}`), which this pass does not touch. Run alone straight
  after, the lane passed in full.
- **Repository gate, stopped at its interlock:** `workspace/Garden.nendo is open in Nendo`, so
  the binary-asset check and the checks after it did not run.
- **Repository gate, run again once the owner closed Nendo:** it caught the contract's opening
  sentence still counting twenty-five tools. With that fixed it passed in full, including all 70
  tracked binary assets read end to end, `workspace/Garden.nendo` among them, which is then
  committed.

`Test-Site.ps1` passed.

`artifacts/installer/Nendo-Setup.exe` was rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
The payload carries the read tools: both `Nendo.LocalMcp.dll` and the Workbench bundle contain
`nendo.read.resource`.

Not exercised: GitHub Copilot CLI itself, and the installed host until the new installer is
installed.
