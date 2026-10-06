---
title: Agents
description: Connect Claude Code or Codex to an open Nendo file, choose what it may do, and review what it proposes.
group: Use
order: 40
---

An agent is an AI coding assistant that runs on your computer, such as Claude Code or Codex. Nendo lets an agent read your open file, change its records, and propose changes to its record types, fields, screens, calculations and automatic actions. You choose how much it may do, and you accept its proposals in Nendo.

The agent works through the Model Context Protocol (MCP). It gets typed resources to read and typed tools to call. It never gets SQL, a file path, file-system access, a process, network access or a generic "run this" call. It learns the name of the open file, never its location. This keeps every change inside the same checked operations that the Nendo window uses, so every change is validated, recorded in History and, where possible, reversible. For the terms used here, see [Concepts](/nendo/docs/concepts).

## Connect an agent

1. Open a `.nendo` file in Nendo and leave Nendo running.
2. Select **Agent** in the sidebar, then select an access level. Start with **Inspect**.
3. Register the address with your client once:

```text
claude mcp add --transport http nendo http://127.0.0.1:41763/mcp
codex mcp add nendo --url http://127.0.0.1:41763/mcp
```

The address is the whole configuration. Nendo listens on the loopback address `127.0.0.1` only while a file is open and access is not Off. **Agent → Connection** shows the live address and has a copy button for each client. Claude Code and Codex are the tested clients. Other MCP clients that support Streamable HTTP may work, but they are not tested.

Each file keeps a port of its own on your computer. The first file you switch access on for keeps `41763`, and each further file keeps the next free one, whatever order you open them in later. So you can work with several files at once: register each one once, from its own **Agent → Connection**. The copy buttons name the server after the file, `nendo` for `Nendo.nendo` and `nendo-bcm` for `BCM.nendo`, so the second registration does not replace the first. To give a file a different port, change **Port for this file** there. A port that another file keeps is refused, and the message names that file.

If a file's port is taken by another program when access starts, Nendo does not fail. It listens on a temporary port for that session, and **Agent → Connection** shows a warning and the address to use. Turn **Fixed port** off to use a new port each time.

A script or tool that needs to find a file's address without being told can read `%LOCALAPPDATA%\Nendo\Mcp\active\`. Each running Nendo keeps one small JSON file there for every file it has open, readable only by your Windows account. It holds the `endpoint`, the file's name as `displayName` (never its folder), the file's `applicationId`, the access `mode` and the `processId`. The entry is removed when the file closes. Once connected, `nendo://host/instances` lists the same entries.

There is no credential. While access is on, any program on this computer can connect at the level you chose. On your own computer that is a reasonable trade. On a shared computer it is not. Set access to **Off** when no agent is working.

## Access levels

You set the level on the Agent page. Each level includes everything that the levels before it allow. This computer remembers the level for each file: a file opens at the level you last chose for it. A new file, or a copy of one, opens at Off, and choosing Off forgets it.

| Level | What the agent may do | What it gets |
| --- | --- | --- |
| Off | Nothing. Nendo does not listen, and every lease ends. | No connection. |
| Inspect | Read the whole file: structure, records, screens, history, health and waiting proposals. | The 24 resources. The tool list is empty. |
| Edit data | Create, change, delete, import, move and undo records, and run a screen's command. Writes go straight into the file and appear in History. | Adds 17 tools: `nendo.lease.*` (4), `nendo.data.*` (12) and `nendo.health.verify_integrity`. |
| Shape app | Propose changes to record types, fields, screens, calculations and automatic actions. Proposals wait for you. | Adds 7 tools: `nendo.change_set.begin`, `add_operations`, `amend`, `validate`, `revalidate`, `preview` and `reject`. |
| Unattended | Accept its own proposals, and let the automatic actions they install run. | Adds 1 tool: `nendo.change_set.accept`. |

At every level below Unattended, `nendo.change_set.accept` does not exist. A client that calls it by name gets an unknown-tool error. At those levels, only you accept a proposal.

## The lease

Only one agent writes at a time. To write, an agent calls `nendo.lease.acquire`. It receives two values:

- a **lease ID**, which is the edit authority;
- an **application handle**, a private value that identifies this open file for this agent.

Every write and every change-set call takes both. The agent must keep the handle private. If a second agent tries to acquire the lease, it gets `NENDO_LEASE_HELD`.

The grant also carries a **receipt context**, an unprivileged value the agent saves before it writes, so it can read the outcome of a write whose answer was lost. An agent that sends an `idempotencyKey` with `nendo.lease.acquire` can repeat the call after a lost answer and receive the same grant instead of being refused against itself. One that released its lease, or lost it, takes it again under its earlier handle with `resumeApplicationHandle`: the proposals it validated, its pseudonym and its receipts are its own once more.

By default the lease has no expiry. It ends when the agent releases it, when you select **Revoke edit access**, when you set access to Off, or when you close or switch the file. Closing the agent does not release it. If you want leases to lapse, turn on **Lease expiry** under **Agent → Connection** and set a time from 15 to 86,400 seconds. The agent must then call `nendo.lease.renew` within that time.

`nendo.lease.status` needs no lease. It tells an agent who holds the lease, which is useful after a reconnect or a lost response.

The grant and the status both name the open file, and so do the first sentence of the instructions and the server's title, which a client shows as *Nendo · BCM* for `BCM.nendo`. An agent registered with two files can tell which one it is about to change.

## Reading the file

Reads are MCP resources. They need no lease. Start with `nendo://application/describe`: one read returns what the file is for, its authoring limits, every record type with its fields and record count, every compiled screen, health, and the address of every other read. `describe?include=manifest,entities` returns the record types without the screens, and `nendo://application/entity/{entityId}` is the small first read for one type: its schema, record count and screens together.

| Resource | What it returns |
| --- | --- |
| `nendo://application/describe{?include}` | The whole application in one read, or the facets named. |
| `nendo://application/entity/{entityId}` | One record type as a bundle: schema, record count and its screens. |
| `nendo://application/entity/{entityId}/schema` | One record type's fields, including calculated fields, which are unique or numbered by Nendo, and the links it allows. |
| `nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter,fields}` | A page of records with exact numbers, or one record by ID, or the records a filter leaves, sorted; `fields` keeps only the named fields. |
| `nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}` | An exact count, sum, min or max over the records a filter leaves: whole, per choice, as a grid of two choices, or per day, week, month, quarter or year. Nothing is paged. |
| `nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}` | A record type kept as a tree, depth-first, each record with its parent, depth and number of children. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | A page of records as Nendo CSV, ready to import again. |
| `nendo://application/surfaces` | Every compiled screen as a node tree, with the command IDs a screen's buttons run, and where each node is kept: its surface, its parent and its position among its siblings. |
| `nendo://application/vocabulary` | Everything this Nendo build accepts from an author: node kinds, operators, operations and their payloads, the behaviour catalogue, the authoring rules and the limits. |
| `nendo://application/examples` | Complete change sets that validate as they stand. |
| `nendo://application/proposals` | Proposals that wait for you, each with the change set it came from and the agent that made it. |
| `nendo://application/proposal/{proposalId}` | One proposal in full: its diff, diagnostics and what the file would hold. Its state is live: stale once the file moved under it, active once accepted. |
| `nendo://application/history{?cursor,limit,newestFirst}` | Revision summaries, oldest first, or newest first with `newestFirst=true`. |
| `skill://nendo-authoring/SKILL.md` | The authoring skill, for a client that speaks the Skills extension, with the vocabulary, the examples and the view API as its files. |
| `nendo://host/instances` | Every running Nendo on this computer and the name of the file each has open. |

The remaining six are the manifest, the list of record types, the operations of one revision, health, the custom-view packages the file carries with their files, and the custom-view API.

A filter is a JSON array of clauses, each a field, an operator and a value, joined by *and*: the operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `isNotNull`, `contains` and, for a tree, `descendantOf`. The same filter serves the records read and the aggregate, so an agent finds one record by its code, or counts the open items per status, in one read rather than by paging a type.

Records, export, history and revision operations are paged. `limit` is a whole number from 1 to 100. If the file changes between pages, the next page fails with `NENDO_STALE_CURSOR`. Start again from the first page.

## Writing data

At Edit data and above, the agent changes records with these tools:

| Tool | What it does |
| --- | --- |
| `nendo.data.create_record` | Creates one record. |
| `nendo.data.create_records` | Creates 1 to 50 records of one type as one revision, all or nothing. |
| `nendo.data.import_records` | Imports up to 500 rows from CSV text or JSON, committed 50 to a revision. If a later batch is refused, `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, the first uncommitted row and the committed revisions. Retry the identical call and key to replay earlier batches without duplicates. Invalid CSV mappings or a mixed CSV/JSON payload are refused before writing. A column that Nendo numbers, such as a Reference, may be left out: every row receives the next code. |
| `nendo.data.set_field` | Sets one field on one record. |
| `nendo.data.update_record` | Sets up to 64 fields of one record as one revision, the way a form saves. |
| `nendo.data.apply_writes` | Creates, updates and deletes up to 200 records across record types as one revision, all or nothing. A write may point at a record an earlier write in the same batch created. |
| `nendo.data.undo_revision` | Undoes one record revision the agent's own session committed, as the compensation History makes: a new linked revision, nothing rewound. Undoing the compensation is redo. |
| `nendo.data.move_record` | Moves a record in a record type that is kept as a tree: under another parent, to the top level, or before a sibling. When the siblings leave no room, the few around the new place are renumbered, and the answer names every record written. |
| `nendo.data.set_kept_in_new_files` | Says whether a new file of the application keeps one record, leaves it out, or follows its record type. |
| `nendo.data.delete_record` | Deletes one record. Refused while other records refer to it. |
| `nendo.data.execute_command` | Runs a command that a screen defines. |
| `nendo.data.get_receipt` | Reads the outcome of an earlier write, an import batch by batch, or an acceptance by its proposal. |

A reference field can be given as a **reference** rather than a record ID: the target named by its record ID, or by the value of one of its unique fields, such as a code. Nendo looks the record up and writes its ID and current version, so an agent that knows a task belongs to project `P1` writes that, and never pages the projects to find the ID.

Each record has a **version** that goes up by one with each change. A change or delete names the version the agent expects. If the record moved since the agent read it, the write fails with `NENDO_RECORD_VERSION_CONFLICT`. The agent reads the record again and retries. Every write answers with the version it left, and a command advances the record one version per step.

Each write carries an **idempotency key** that the agent chooses. A retry with the same key and the same request returns the original result and writes nothing twice, even when a record the write referred to has changed in between. The same key with a different request fails with `NENDO_IDEMPOTENCY_CONFLICT`.

A write returns the new record version and `alsoChanged`: the other records that an automatic action changed in the same revision. If a response is lost, the agent calls `nendo.data.get_receipt` with the `receiptContext` from its lease grant and the original key. A missing receipt means the outcome is unknown. It is not permission to try again with a new key.

A calculated field cannot be written. The refusal, `NENDO_FIELD_CALCULATED`, names the calculation and the stored fields it reads. See [Calculations and actions](/nendo/docs/calculations-and-actions).

## Changing the application

At Shape app and above, the agent changes the application through a **change set**: a draft of typed operations that does not touch your file.

1. `nendo.change_set.begin` opens a draft with a title. You see this title later.
2. `nendo.change_set.add_operations` appends up to 16 operations per call. A payload that Nendo cannot use is refused at once, with the operation and the key named.
3. `nendo.change_set.validate` replays the draft on a private copy of the file. If it is valid, it becomes a **proposal**. If it is not, the draft stays open with diagnostics: every independent mistake at once, up to five, each naming the operation it is about. A mistake that only follows from another, such as a field added to a record type that was refused, is not reported twice.
4. `nendo.change_set.amend` replaces the tail of a draft after a failed validate, so the agent does not rebuild it.
5. `nendo.change_set.preview` reads a proposal's summary and diff. `nendo.change_set.reject` discards a draft or proposal.
6. `nendo.change_set.revalidate` validates a proposal's operations again at the file's current revision, as a new proposal under the same change set, after you accepted something else and the file moved under it. Nothing is merged; the operations are simply tried again.

A change set holds at most 128 submitted operations in 32 mutations, and at most 512 after node properties expand. One session can have 8 open drafts and 16 proposals waiting.

A proposal appears on the Agent page under **Pending changes**, with its title, the number of changes and how reversible they are. **Review changes** shows **What changes**, a line per change, and **What this builds**: record types, fields, screens and records as the file would be. **Accept changes** applies it. **Reject** leaves the file as it was. When you accept one proposal, other waiting proposals become stale, because they were made against the earlier file. An agent reads the same proposal at `nendo://application/proposal/{proposalId}`, with no lease, and sees it turn stale or active; an accept answers with the revisions it committed, and `nendo.data.get_receipt` reads them again by the proposal's ID after a lost answer.

When accepting a proposal involves the file's automatic actions, both the queue and the review say so before you accept. A proposal that sets off actions this computer has not approved asks you to approve them on the Agent page first, and **Accept changes** stays unavailable until you do. A proposal that changes the actions says that editing pauses after you accept, until you approve them again. A proposal that both changes the actions and sets them off cannot be accepted as it stands, and the review asks for the actions first and the records after. An agent reads the same facts in the proposal's `behaviour`.

A change set may contain 35 operation types, and nothing else:

- `schema.*` (16): create, rename and retire record types and fields; make a field required; show a text field as one line, long text or Markdown; make a field unique, so no two records can share a value, and have Nendo number it (W-001, W-002…) when a record is created without one; configure a reference; name and colour a choice; keep a record type a tree, and stop keeping it one; say which links a record type allows, from a table of allowed combinations, so Nendo refuses any other link whoever writes it; say whether a new file of the application keeps a record type's records.
- `behaviour.setDefinition` and `behaviour.removeDefinition`: calculations, reusable functions, automatic actions and triggers.
- `application.*` (3): say what the file is for; give the file its own icon colour and letter, the badge that tells it apart from other open files; name what a new file of it is called.
- `ui.*` (4): add, set a property on, move and remove a screen node.
- `data.*` (6): create, change and delete records, mark one for a new file, fill a value on a retired field, and convert an old text reference, carried in the same proposal.
- `extension.*` (4): put a custom view's code into the file as a package and its files, and take them out again. See [Custom views](/nendo/docs/custom-views).

Restoring a deleted record and changing a file's identity are not available to an agent. `nendo://application/vocabulary` lists every operation with the fields it takes. `nendo://application/examples` holds 17 complete change sets, from a record type with required fields to a calculation with an automatic action and a custom view whose code the file carries. Each one is tested against the real authoring path. `nendo://application/view-api` is for an agent writing a custom view's code, and only then: every call the view's page can make, with a whole view to start from. For what a screen can contain, see [Screens](/nendo/docs/screens).

## Unattended

Unattended removes your review. The agent accepts its own proposals, and Nendo records this computer's approval for the automatic actions they install, so those actions run. Nobody reads a change before the file takes it.

When you select Unattended, Nendo asks you to confirm. The level is never remembered. It ends when you lower the level or close the file. Every change still appears in History, and you can withdraw the approval of automatic actions under Health.

Use it while an agent builds a new file from nothing, where there is nothing yet to protect. Do not leave it on.

## For clients that speak more of the protocol

Everything above works with the standard MCP handshake. A client on the 2026-07-28 protocol revision can use more, and loses nothing if it does not.

- **Listening.** `subscriptions/listen` on `nendo://application/entity/{entityId}/records`, with a record type's ID filled in, tells the client when a commit changes a record of that type and names the records that changed, so a script waiting on a button's request does not have to poll. `subscriptions/listen` on `nendo://application/proposals`, `manifest` and `health` tells the client when you accept or reject a proposal, when anything commits, and when the file closes. A client that cannot hold a stream polls instead.
- **Tasks.** A client that declares the Tasks extension runs the three long calls as tasks it polls: `nendo.change_set.validate`, `nendo.data.import_records` and `nendo.health.verify_integrity`. Every other call, every write included, is answered at once whatever the client declares. A task never extends a lease.
- **Skills.** A client that declares the Skills extension lists the skill `nendo-authoring`: which read answers which question, the lease, the change-set loop, every operation and the refusals, with the vocabulary, the examples and the view API as its files, each with a digest the client can check. It says what this page says, from the Nendo build that serves it.
- **The file's own skill.** A file can also carry instructions for whoever works on it: how its records are meant to be used, which commands to run and when. They are a skill package, written like a custom view's code with `extension.setPackage` and kind `skill`, and you read every line before you accept it. Once accepted, the client lists it after `nendo-authoring`, named after the last part of the package ID. Nothing in Nendo runs it; a client offers it to its model, and asks you first if it is built to. Studio shows it among the file's packages as an agent skill.

Every refusal also travels as a structured object beside its text, under `io.github.thomasrohde.nendo/refusal` in the result's `_meta`, with the code, the sentence and, where a waiting proposal explains the refusal, that proposal's ID. A client reads the code there rather than from the text.

## While an agent works

- The status bar shows a pill, for example *Claude Code is working*, on every screen. Its tooltip names the current activity and tells you to use **Revoke edit access** to stop it.
- If your own action waits behind an agent write, the busy bar says that the agent is writing to this file.
- The Agent page shows the **Most recent agent**, the **Editing owner**, **Pending changes** and **Recent activity**: reads, writes with their revision, proposal steps and access changes. A client that connects with the standard handshake appears as *Local agent*.

## How a refusal reads

A refused call returns `CODE: message`. The code is stable. The message names what was refused and what to do. It never contains a file path or a stored value. Examples:

```text
NENDO_SHAPE_APP_REQUIRED: nendo.change_set.begin is served from Shape app, and this file session is at Edit data. Ask the person to raise agent access to Shape app on the Agent page in Nendo.
NENDO_INVALID_REQUEST: nendo.data.create_records was not called. records[0] does not take 'expectedTargetVersionz'; a record takes recordId and values, and optionally expectedTargetVersions.
NENDO_UNKNOWN_OPERATION: Operation type 'sql.execute' is not one this host implements; nendo://application/vocabulary lists the 32 it accepts under operations.
```

The last one is the same for SQL as for a typing error. There is no other way in.

## Good first prompts

- At Inspect: "Read nendo://application/describe and tell me what this file holds."
- At Inspect: "List the record types, their fields and how many records each has."
- At Inspect: "Count the Tasks per status, and show me the one whose code is T-042."
- At Edit data: "Add three sample records to Tasks, then read them back."
- At Edit data: "Import this CSV into Tasks, matching the Project column by project code."
- At Shape app: "Propose a board of Tasks grouped by status. Keep the existing records, and wait for me to review."
- At Shape app: "Propose a calculated field on Projects that counts its open tasks."

When the agent is done, ask it to release the lease, and set access back to Off.
