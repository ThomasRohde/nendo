# ADR-0009: Expose bounded local MCP over host application services

- **Status:** Accepted
- **Date:** 2026-09-13
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `McpSecurityTests`, `McpPathPerimeterTests`, `LatestProtocolTests`, `DiscoveryLifecycleTests`, `UnattendedAcceptanceTests`, `ToolOnlyClientTests` (LocalMcp), `DesktopAgentPortStoreTests`, `DesktopAgentModeMemoryTests` (Desktop) and the opt-in installed Claude Code and Codex lanes

## Context

An external agent must be able to inspect and shape a local Nendo application
without SQL, source code or filesystem authority. MCP is the adapter, not the
authority, identity or revision model. Nendo is a single-user, local Windows product
for exploring how far an agent can take a file through a typed interface, so every
setup step between "a file is open" and "the agent is talking to it" is paid on each
iteration. The owner chose iteration speed over an account boundary on one machine;
this decision states what that gives and gives up.

## Decision

Nendo exposes an optional, client-neutral MCP adapter over the typed host
application services, at a static loopback address, with no credential. The
[MCP interface contract](../contracts/mcp-interface.md) holds the detailed surface.

### Transport and perimeter

- Stateless Streamable HTTP through the official .NET MCP SDK, bound only to IPv4
  loopback. The web host reads no ambient configuration, so no endpoint from an
  environment variable or a local `appsettings.json` is bound beside it.
- The server pins no protocol version: it answers an `initialize` handshake on any
  version the SDK supports, and the 2026-07-28 `server/discover` path with
  per-request metadata works alongside it. Neither has a session header.
- There is no credential. The perimeter is the loopback remote address, exact Host
  and Origin matching against the bound port, bounded body size and JSON depth, and
  closed admission after any lifecycle boundary. It runs for every request whatever
  its path, since routing matches `/mcp` without regard to case. Host and Origin
  matching keeps browser-origin requests and DNS rebinding out.
- Registering a client is one line: `claude mcp add --transport http nendo
  http://127.0.0.1:41763/mcp`, `codex mcp add nendo --url http://127.0.0.1:41763/mcp`.

### Ports and discovery

- Each file keeps a port on this device, in `agents\ports.json` under its application
  ID and instance ID. The first time a file turns access on with Fixed port on, it
  keeps the device's port (41763 unless the person chose another) if no file keeps
  it, otherwise the next port no file keeps, and asks for that port from then on. A
  port another file keeps is refused, naming that file. A port another program holds
  falls back to an ephemeral port, which is reported and never fatal. The person can
  choose this file's port, or always-ephemeral, in Agent → Connect. An older list
  keyed by application alone is taken over once by the instance it belonged to.
- The file never carries a port; a Fork, a Duplicate and a new file each keep their
  own. The copy buttons register the file under a name made from it (`nendo` for
  Nendo.nendo, `nendo-bcm` for BCM.nendo).
- The host writes one discovery entry per open file under
  `%LOCALAPPDATA%\Nendo\Mcp\active`, under a user-scoped DACL: endpoint, run ID,
  process ID, access mode, application and instance IDs and display name, never a
  path. It serves the fallback-port case and tells two windows apart.

### Security posture

- The boundary is this computer at the access level the owner chose. While a file is
  open with access on, any process on the machine can connect, under any account.
  The owner's controls are the access level (**Off** by default), revoking the edit
  lease, and the approval dialog.
- This is the posture for a single-user machine. It is not an anti-malware boundary
  and is the wrong choice for a shared computer.
- The process outlives its window
  ([ADR-0002](0002-containing-desktop-architecture-and-process-model.md)), so a
  window that looks closed can still serve MCP; the tray shows the live mode and
  turns it off.

### Access levels

- The levels are Off, Inspect, Edit data, Shape app and Unattended. The host shows
  the active level and the modifying owner. The level is captured when the listener
  starts and fixed for its lifetime; a change restarts the listener.
- The level is remembered per file on this device, in `agents\access.json` under the
  application ID and instance ID. A writable open of that instance turns it on again;
  choosing Off forgets it. A Duplicate or Fork (a new instance), a read-only or
  recovery open, a restore and a replacement begin at Off. A copy made outside Nendo
  keeps the instance ID and opens at the remembered level, as a moved file does. The
  file never stores the level.
- A shape change needs the person's acceptance below Unattended. At Edit data, data
  writes do not.
- **Unattended** adds one tool, `nendo.change_set.accept`, which promotes a proposal
  this session validated, pinned to its reviewed digest (the caller does not supply
  it), through the same `PromoteProposalAsync` as the person's Accept. Validation on a
  clone, replay promotion and the proposal's visibility in Pending changes and
  `nendo://application/proposals` are unchanged
  ([ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md)).
- At Unattended, and only there, the host also grants this device's
  automatic-action consent for the behaviour the open file holds: the same grant a
  person's approval writes, with the same behaviour-digest scope, revoked in the same
  place. The Engine still asks `INendoBehaviourAuthority`; the adapter holds one
  host-supplied delegate and never reaches grant storage.
- Unattended is off by default, confirmed by the person before it takes effect, and
  every acceptance is an ordinary History revision. The product says, where the level
  is chosen, that it is the wrong level to leave on.

### Proposals and consent

Consent to automatic actions stays separate and person-owned; a proposal says what
it asks of consent before anyone accepts. Its preview carries `behaviour` (null when
it asks nothing new), computed when read, never stored: what the actions can do,
how many writes they made on the clone, and whether the behaviour after acceptance
differs from what the device can approve now. Pending changes, the review, the MCP
preview and `nendo://application/proposals` show it.

| The proposal | Accept |
| --- | --- |
| sets off actions this device approved | offered; accepting runs them |
| sets off actions not approved here | withheld until they are approved on the Agent page |
| changes the actions, sets nothing off | offered; editing pauses until they are approved |
| changes the actions and sets them off | withheld; propose the actions first, the records after |

At Unattended, `nendo.change_set.accept` grants on the second row and promotes once
more.

### Leases

- `nendo.lease.acquire` mints a random 256-bit `applicationHandle` and a distinct
  lease ID; every owned data, proposal, renew and release call supplies both. The
  handle is a capability usable across requests and clients. Handles and raw request
  bodies are never logged; UI and receipts show only pseudonyms.
- At most one modifying lease exists per open file. By default it does not expire and
  ends only on release, owner revocation or host stop; closing the client does not
  release it. The owner can turn on a bounded expiry (`NendoLeaseGrant.ExpiresAt` is
  nullable, with an `EndsOn` discriminator); with expiry off, `lease.renew` succeeds as
  a confirmation. The Agent page states that a crashed agent holds the lease until
  revoked.
- `hostRunId` and the cursor key are per run. Replacement, file switch or close, and
  recovery invalidate old authority; a renderer-only restart keeps it. Receipt lookup
  is read-only and cannot recreate a handle or lease.
- Client metadata is a display label only. A handshake client shows as "Local agent";
  a 2026-07-28 client carries its name on every request.
- The [ADR-0005](0005-host-application-services-and-write-coordinator.md) coordinator
  linearizes revocation and admitted writes.

### Semantic surface

- Resources and tools expose manifests, schema, records, surfaces, history and health
  through bounded typed projections. Every resource is also reachable through the
  read-only tools `nendo.read.resource` and `nendo.read.list`, served from Inspect, for
  clients that call tools but cannot read resources. Nothing exposes SQL, SQLite types
  or handles, physical identifiers, the database path, or process, network, filesystem
  or generic host invocation.
- Data writes are canonical typed operations with explicit versions and idempotency
  keys. An agent at Edit data may undo a record revision its own pseudonym committed
  with `nendo.data.undo_revision` ([ADR-0006](0006-split-revisions-audit-and-compensation.md)).
- Application authoring uses `begin`, `add_operations`, `amend`, `validate`,
  `preview`, `revalidate` and `reject` change-set steps over ADR-0007 proposals, plus
  `accept` at Unattended.
- Bulk data uses the same record operations: a paged faithful-CSV export resource and
  one import tool at Edit data that decodes CSV or typed JSON and commits it in bounded
  all-or-nothing revisions ([CSV contract](../contracts/csv.md)). Neither carries a
  path. A later-batch refusal reports the batches already committed; an exact retry
  replays them.
- Errors are stable and sanitized: semantic causes without paths, SQL or exception
  internals.
- On the 2026-07-28 path, `subscriptions/listen` pushes three facts: the manifest
  moved, the proposal queue changed, the file is closing. It moves no authority.
- Every tool answers within its request; the Tasks extension is not served. A request
  past the in-flight bound waits for a place, up to `limits.requestQueueSeconds`,
  rather than being refused at once.
- There is no client-specific semantic branch. The opt-in installed-client lanes
  (`NENDO_RUN_INSTALLED_CLAUDE_TEST`, `NENDO_RUN_INSTALLED_CODEX_TEST`) run the real
  binaries with only the URL configured; that is compatibility evidence, not a
  parity promise.

## Consequences

### Positive

- External agents share one semantic authority model with Studio and surfaces.
- Registering a client is one line that never changes; a checkout of this repository
  carries it for Claude Code and Codex.
- Every current MCP client can connect, whichever protocol era it speaks.
- Offline use never depends on an agent.

### Negative

- Other accounts on the same machine can reach an open file at its access level.
- A crashed agent's edit lease persists until revoked.
- No equivalent-behaviour claim across MCP clients.
- At Unattended, a shape change and an automatic action can reach the active file and
  run before anybody reads them. History records what was done, not that it was
  reviewed. A file set to Unattended reopens at Unattended without a fresh
  confirmation.
- At Edit data, an agent can undo its own wrong write in one call.

## Rejected alternatives

- A bearer credential: its only job was keeping other accounts out, which did not
  justify the setup cost on a single-user machine.
- A peer-process user check: would restore the account boundary with no client
  setup. It is the route back if that boundary is wanted; it is not built.
- Pinning the newest protocol only: refused every handshake-era client.
- Per-proposal pre-authorisation instead of Unattended: authorises a change set
  without its preview.
- Approving consent and accepting in one press from the review: new consent authority
  over a behaviour the person has not seen in force.
- Client-specific integrations, an embedded conversational runtime, raw SQL or
  filesystem tools.

## Revisit triggers

- Shared or multi-account machines become product scope: reinstate an account
  boundary, preferably the peer-process user check.
- Remote or multi-user agents become product scope.
- A required client cannot use the client-neutral contract without semantic
  branching.
- An embedded agent experience receives a separately accepted decision.
