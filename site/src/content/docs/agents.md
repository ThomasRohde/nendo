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

The address is the whole configuration. Nendo listens on the loopback address `127.0.0.1`, port `41763`, only while a file is open and access is not Off. **Agent → Connection** shows the live address and has a copy button for each client. Claude Code and Codex are the tested clients. Other MCP clients that support Streamable HTTP may work, but they are not tested.

If port 41763 is taken when access starts, Nendo does not fail. It listens on a temporary port for that session, and **Agent → Connection** shows a warning and the address to use. You can change the port, or turn **Fixed port** off to use a new port each time.

There is no credential. While access is on, any program on this computer can connect at the level you chose. On your own computer that is a reasonable trade. On a shared computer it is not. Set access to **Off** when no agent is working.

## Access levels

You set the level on the Agent page. Each level includes everything that the levels before it allow. The level is never remembered: every file opens at Off.

| Level | What the agent may do | What it gets |
| --- | --- | --- |
| Off | Nothing. Nendo does not listen, and every lease ends. | No connection. |
| Inspect | Read the whole file: structure, records, screens, history, health and waiting proposals. | The 14 resources. The tool list is empty. |
| Edit data | Create, change, delete and import records, and run a screen's command. Writes go straight into the file and appear in History. | Adds 12 tools: `nendo.lease.*` (4), `nendo.data.*` (7) and `nendo.health.verify_integrity`. |
| Shape app | Propose changes to record types, fields, screens, calculations and automatic actions. Proposals wait for you. | Adds 6 tools: `nendo.change_set.begin`, `add_operations`, `amend`, `validate`, `preview` and `reject`. |
| Unattended | Accept its own proposals, and let the automatic actions they install run. | Adds 1 tool: `nendo.change_set.accept`. |

At every level below Unattended, `nendo.change_set.accept` does not exist. A client that calls it by name gets an unknown-tool error. At those levels, only you accept a proposal.

## The lease

Only one agent writes at a time. To write, an agent calls `nendo.lease.acquire`. It receives two values:

- a **lease ID**, which is the edit authority;
- an **application handle**, a private value that identifies this open file for this agent.

Every write and every change-set call takes both. The agent must keep the handle private. If a second agent tries to acquire the lease, it gets `NENDO_LEASE_HELD`.

By default the lease has no expiry. It ends when the agent releases it, when you select **Revoke edit access**, when you set access to Off, or when you close or switch the file. Closing the agent does not release it. If you want leases to lapse, turn on **Lease expiry** under **Agent → Connection** and set a time from 15 to 86,400 seconds. The agent must then call `nendo.lease.renew` within that time.

`nendo.lease.status` needs no lease. It tells an agent who holds the lease, which is useful after a reconnect or a lost response.

## Reading the file

Reads are MCP resources. They need no lease. Start with `nendo://application/describe`: one read returns what the file is for, its authoring limits, every record type with its fields, every compiled screen, health, and the address of every other read.

| Resource | What it returns |
| --- | --- |
| `nendo://application/describe` | The whole application in one read. |
| `nendo://application/entity/{entityId}/schema` | One record type's fields, including calculated fields. |
| `nendo://application/entity/{entityId}/records{?cursor,limit}` | A page of records, with exact numbers. |
| `nendo://application/entity/{entityId}/export{?cursor,limit}` | A page of records as Nendo CSV, ready to import again. |
| `nendo://application/surfaces` | Every compiled screen as a node tree. |
| `nendo://application/vocabulary` | Everything this Nendo build accepts from an author: node kinds, operators, operations and their payloads, the behaviour catalogue and the limits. |
| `nendo://application/examples` | Complete change sets that validate as they stand. |
| `nendo://application/proposals` | Proposals that wait for you. |
| `nendo://application/history{?cursor,limit}` | Revision summaries. |
| `nendo://host/instances` | Every running Nendo on this computer and the name of the file each has open. |

The remaining four are the manifest, the list of record types, the operations of one revision, and health.

Records, export, history and revision operations are paged. `limit` is a whole number from 1 to 100. If the file changes between pages, the next page fails with `NENDO_STALE_CURSOR`. Start again from the first page.

## Writing data

At Edit data and above, the agent changes records with these tools:

| Tool | What it does |
| --- | --- |
| `nendo.data.create_record` | Creates one record. |
| `nendo.data.create_records` | Creates 1 to 50 records of one type as one revision, all or nothing. |
| `nendo.data.import_records` | Imports up to 500 rows from CSV text or JSON, committed 50 to a revision. If a later batch is refused, `NENDO_IMPORT_PARTIAL` names the committed and remaining counts, the first uncommitted row and the committed revisions. Retry the identical call and key to replay earlier batches without duplicates. Invalid CSV mappings or a mixed CSV/JSON payload are refused before writing. |
| `nendo.data.set_field` | Sets one field on one record. |
| `nendo.data.delete_record` | Deletes one record. Refused while other records refer to it. |
| `nendo.data.execute_command` | Runs a command that a screen defines. |
| `nendo.data.get_receipt` | Reads the outcome of an earlier write. |

Each record has a **version** that goes up by one with each change. A change or delete names the version the agent expects. If the record moved since the agent read it, the write fails with `NENDO_RECORD_VERSION_CONFLICT`. The agent reads the record again and retries.

Each write carries an **idempotency key** that the agent chooses. A retry with the same key and the same request returns the original result and writes nothing twice. The same key with a different request fails with `NENDO_IDEMPOTENCY_CONFLICT`.

A write returns the new record version and `alsoChanged`: the other records that an automatic action changed in the same revision. If a response is lost, the agent calls `nendo.data.get_receipt` with the `receiptContext` from its lease grant and the original key. A missing receipt means the outcome is unknown. It is not permission to try again with a new key.

A calculated field cannot be written. The refusal, `NENDO_FIELD_CALCULATED`, names the calculation and the stored fields it reads. See [Calculations and actions](/nendo/docs/calculations-and-actions).

## Changing the application

At Shape app and above, the agent changes the application through a **change set**: a draft of typed operations that does not touch your file.

1. `nendo.change_set.begin` opens a draft with a title. You see this title later.
2. `nendo.change_set.add_operations` appends up to 16 operations per call. A payload that Nendo cannot use is refused at once, with the operation and the key named.
3. `nendo.change_set.validate` replays the draft on a private copy of the file. If it is valid, it becomes a **proposal**. If it is not, the draft stays open with diagnostics.
4. `nendo.change_set.amend` replaces the tail of a draft after a failed validate, so the agent does not rebuild it.
5. `nendo.change_set.preview` reads a proposal's summary and diff. `nendo.change_set.reject` discards a draft or proposal.

A change set holds at most 128 submitted operations in 32 mutations, and at most 512 after node properties expand. One session can have 8 open drafts.

A proposal appears on the Agent page under **Pending changes**, with its title, the number of changes and how reversible they are. **Review changes** shows **What changes**, a line per change, and **What this builds**: record types, fields, screens and records as the file would be. **Accept changes** applies it. **Reject** leaves the file as it was. When you accept one proposal, other waiting proposals become stale, because they were made against the earlier file.

A change set may contain 20 operation types, and nothing else:

- `schema.*` (8): create, rename and retire record types and fields; make a field required; configure a reference; name and colour a choice.
- `behaviour.setDefinition` and `behaviour.removeDefinition`: calculations, reusable functions, automatic actions and triggers.
- `application.setPurpose`: say what the file is for.
- `ui.*` (4): add, set a property on, move and remove a screen node.
- `data.*` (5): create, change and delete records, fill a value on a retired field, and convert an old text reference, carried in the same proposal.

Restoring a deleted record and changing a file's identity are not available to an agent. `nendo://application/vocabulary` lists every operation with the fields it takes. `nendo://application/examples` holds 16 complete change sets, from a record type with required fields to a calculation with an automatic action. Each one is tested against the real authoring path. For what a screen can contain, see [Screens](/nendo/docs/screens).

## Unattended

Unattended removes your review. The agent accepts its own proposals, and Nendo records this computer's approval for the automatic actions they install, so those actions run. Nobody reads a change before the file takes it.

When you select Unattended, Nendo asks you to confirm. The level is never remembered. It ends when you lower the level or close the file. Every change still appears in History, and you can withdraw the approval of automatic actions under Health.

Use it while an agent builds a new file from nothing, where there is nothing yet to protect. Do not leave it on.

## While an agent works

- The status bar shows a pill, for example *Claude Code is working*, on every screen. Its tooltip names the current activity and tells you to use **Revoke edit access** to stop it.
- If your own action waits behind an agent write, the busy bar says that the agent is writing to this file.
- The Agent page shows the **Most recent agent**, the **Editing owner**, **Pending changes** and **Recent activity**: reads, writes with their revision, proposal steps and access changes. A client that connects with the standard handshake appears as *Local agent*.

## How a refusal reads

A refused call returns `CODE: message`. The code is stable. The message names what was refused and what to do. It never contains a file path or a stored value. Examples:

```text
NENDO_SHAPE_APP_REQUIRED: Shape app access is required.
NENDO_LEASE_HELD: Another local agent currently has edit access.
NENDO_UNKNOWN_OPERATION: Operation type 'sql.execute' is not one this host implements; nendo://application/vocabulary lists the 20 it accepts under operations.
```

The last one is the same for SQL as for a typing error. There is no other way in.

## Good first prompts

- At Inspect: "Read nendo://application/describe and tell me what this file holds."
- At Inspect: "List the record types, their fields and how many records each has."
- At Edit data: "Add three sample records to Tasks, then read them back."
- At Shape app: "Propose a board of Tasks grouped by status. Keep the existing records, and wait for me to review."
- At Shape app: "Propose a calculated field on Projects that counts its open tasks."

When the agent is done, ask it to release the lease, and set access back to Off.
