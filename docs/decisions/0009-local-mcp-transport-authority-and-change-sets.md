# ADR-0009: Expose bounded local MCP over host application services

- **Status:** Accepted
- **Date:** 2026-09-13
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [perimeter tests](../../tests/Nendo.LocalMcp.Tests/McpSecurityTests.cs),
  [protocol tests](../../tests/Nendo.LocalMcp.Tests/LatestProtocolTests.cs),
  [discovery lifecycle tests](../../tests/Nendo.LocalMcp.Tests/DiscoveryLifecycleTests.cs),
  the opt-in installed-client lanes for
  [Claude Code](../../tests/Nendo.LocalMcp.Tests/InstalledClaudeCodeNegotiationTests.cs) and
  [Codex](../../tests/Nendo.LocalMcp.Tests/InstalledCodexNegotiationTests.cs), and the
  [blackbox reviews](../reviews/README.md)
- **Depends on:** ADR-0005 host application services, ADR-0006 revision/idempotency
  model and ADR-0007 proposal lifecycle
- **Related design:** [`../architecture.md`](../architecture.md)

### Accepted amendment — 2026-09-22 (a fifth access level that accepts its own work)

The owner accepted this amendment on 2026-09-22. In the same sitting, the owner
was told what it gives up. It changes decision driver 5 and the *Authority* and
*Semantic contract* sections below. It changes nothing else in this decision.

**What is wrong.** When a person builds a new application through MCP, the work
interrupts the person three times without need:

- every proposal waits for a click;
- automatic actions need a second, separate approval at the device;
- seeding the result takes fifty records per call, one record type at a time,
  after the person accepts the schema proposal.

So a five-table demonstration takes twenty round trips with a human in the
middle of them. None of those interruptions protects anything while the person
sits there and asks the agent to build the file. The interruption has a purpose
when an agent proposes a change to a file that somebody already depends on. It
has no purpose when the file is three minutes old and the agent makes it to
order.

**Options considered.**

- *A. A fifth access level — selected.* This is a level above Shape app. At this
  level the MCP surface gains one tool, `nendo.change_set.accept`. At this level
  the host also grants this device's automatic-action consent on the agent's
  behalf, for exactly the behaviour that the open file holds. The level is off by
  default and never persisted. Nothing reaches it unless the person chooses it
  for this file session, and the person confirms it before it takes effect.
- *B. A per-proposal pre-authorisation — rejected.* The person gives "Accept
  whatever this change set becomes" before validation. It looks safer, but it is
  not. The person authorises a change set without seeing its preview. That is the
  same trust with a worse description. It also gives no single place to state
  what the session may do.
- *C. Keep acceptance human and fix only the data half — rejected.* Bulk import
  alone removes the twenty round trips. It leaves the two interruptions before
  and after them. Bulk import is useful and is done, but it does not answer the
  request.
- *D. Auto-accept without touching behaviour consent — rejected by the owner.* An
  agent that can author and accept an automatic action, but cannot make the file
  run it, stops one call later with `NENDO_BEHAVIOUR_NOT_APPROVED`. An Unattended
  level that stops for a click is not unattended.

**Decision.** Visible modes become Off, Inspect, Edit data, Shape app and
**Unattended**. This decision said "MCP has no promotion tool; final acceptance is
a visible host-owned user action". It now says: MCP has no promotion tool below
Unattended. At Unattended, one tool, `nendo.change_set.accept`, promotes a
proposal that the same session validated. The tool pins the proposal's reviewed
operation digest; the caller does not supply it. It goes through the same `PromoteProposalAsync` that the person's own
Accept button calls, so every staleness, digest and replay check stays. Validation
still happens on a physical clone. Promotion still replays validated operations
against the active file. The proposal is still visible in Pending changes and in
`nendo://application/proposals` between validation and acceptance. The only
change is who presses the button.

At Unattended, and at no lower level, the host also grants its automatic-action
consent for the behaviour that the open file currently holds. This is the same
grant that a person's approval writes. It has the same behaviour-digest scope,
and a person revokes it from the same place. The Engine does not change: it still
asks `INendoBehaviourAuthority` and still refuses when the answer is no. The
adapter never reaches grant storage and never learns where a grant is stored. It
holds one host-supplied delegate, and the host supplies it only at this level.

**What this gives up.** At Unattended, an agent can write an automatic action,
accept it, and cause it to run before anybody reads it. That is a real loss, and
it is the purpose of the level. Three things bound it, and nothing else does:

- the level is off by default and resets to off whenever the file session ends,
  so the next file or the next launch cannot inherit it;
- the person confirms the level before it takes effect;
- every acceptance is an ordinary History revision, so a person can read
  afterwards what was done, although nobody read it before.

The posture below Unattended does not change. This is the wrong level to leave
on, and the product states this where the person chooses it.

## Context

The product needs an external agent to inspect and shape a local Nendo
application without SQL, source code or filesystem authority. MCP is a suitable
adapter, but it is not the authority, identity or revision model.

Nendo is a single-user, local, Windows product. It exists to explore malleable
software: how far an agent can take a file through a typed interface. Every step
between "a file is open" and "the agent is talking to it" has a cost on every
iteration of that exploration. Measurement showed that two things dominated that
cost:

- a per-run credential and port invalidated every saved client configuration at
  each host start;
- a server pinned to the newest MCP revision refused the `initialize` handshake.
  Codex CLI speaks only that handshake, so it could not connect at all. Claude
  Code could connect.

The owner chose iteration speed over an account boundary on one machine. This
decision states what that choice gives and what it gives up.

## Decision drivers

1. One client-neutral semantic contract over the same application services as UI.
2. No caller-selected authority, storage access or generic invocation.
3. Explicit visible user modes and revocable modifying ownership.
4. Bounded requests, errors, retries and abandoned sessions.
5. Clone-backed application authoring, with final acceptance host-owned below the
   Unattended level and agent-owned at it (2026-09-22 amendment).
6. Local/offline operation after an agent disconnects.
7. Registering a client is one static line, valid across restarts, for every
   current MCP client.

## Options considered

### Loopback MCP adapter with a static address

Run an official-SDK server that the desktop host owns on a fixed loopback port.
The server exposes bounded semantic resources and tools, and uses no credential.

### Loopback MCP adapter behind a bearer credential

This is the same adapter, with a per-device bearer published in a discovery file.
Nendo used it from 2026-09-02 to 2026-09-13. The bearer separated the owner's
account from other accounts on the same machine, and did nothing else. Host/Origin
matching already stopped browser-origin attacks, and same-user processes could
read the credential. It cost every client a file read and every registration a
pasted secret.

### Client-specific integrations

Separate Codex, Claude or vendor adapters. They duplicate semantics and let
client behaviour leak into the product authority model.

### Embedded conversational runtime

An agent framework inside Nendo. It adds model credentials, orchestration and a
second product surface.

### Raw SQL or filesystem tools

Generic local capabilities. They bypass validation, history, proposal and
recovery boundaries.

## Decision

Nendo exposes an optional client-neutral MCP adapter over typed host application
services, at a static loopback address, with no credential.

### Transport and perimeter

- Stateless Streamable HTTP through the official .NET MCP SDK, bound only to
  IPv4 loopback. The default port is 41763. If the host cannot bind a port, it
  falls back to an ephemeral port and reports it; this is never fatal. The owner
  can choose a different fixed port or always-ephemeral in Agent → Connection.
- **Both MCP eras are served.** The server pins no protocol version. It answers
  an `initialize` handshake on any version that the SDK supports. The 2026-07-28
  `server/discover` path with per-request metadata works alongside it. Neither
  mode has a session header.
- **There is no credential.** The perimeter is the loopback remote address, exact
  Host and Origin matching against the bound port, bounded body size and JSON
  depth, and closed admission after any lifecycle boundary. The address is the
  whole client configuration: `claude mcp add --transport http nendo
  http://127.0.0.1:41763/mcp`, `codex mcp add nendo --url http://127.0.0.1:41763/mcp`.
- The host writes one discovery entry per open file under
  `%LOCALAPPDATA%\Nendo\Mcp\active`, under a user-scoped DACL. The entry holds the
  endpoint, run ID, process ID, access mode, application and instance IDs, and
  the file's display name. It never
  holds a path. It exists for the fallback-port case and to tell two windows
  apart. A client on the standard port never reads it.

### Security posture

- The boundary is this computer, at the owner's chosen access level. While a
  file is open with access on, any process on the machine can connect, under any
  account. The owner's controls are the access level (**Off** by default),
  revocation of the edit lease, and the approval dialog. A shape change to the
  application still requires the person's acceptance. At *Edit data*, data writes
  do not require it. At *Unattended*, shape changes and automatic-action consent
  do not require it either. For this reason the person chooses that level per
  file session and Nendo never remembers it.
- Host and Origin matching keeps browser-origin requests and DNS rebinding out.
  That defence never depended on a credential.
- This is the posture for a single-user machine. It is not an anti-malware
  boundary, and it is the wrong choice for a shared computer. The revisit
  triggers name what would change it.

### Authority

- Visible modes are Off, Inspect, Edit data, Shape app and Unattended. The host
  shows the active mode and the modifying owner. The host captures the mode when
  the listener starts, and the mode is immutable for the listener's lifetime. A
  change of mode restarts the listener. The mode is never persisted: every file
  session begins at Off.
- `nendo.lease.acquire` mints a random 256-bit `applicationHandle` and a distinct
  lease ID. Every owned data, proposal, renew and release operation supplies
  both. The handle is a capability: whoever holds it can use it across
  independent HTTP requests and clients. Do not log handles or raw request
  bodies. UI and receipts expose only pseudonyms.
- At most one modifying lease exists per open file. By default it does not
  expire. It ends only on explicit release, owner revocation or host stop. The
  owner can enable a bounded expiry. `NendoLeaseGrant.ExpiresAt` is nullable with
  an `EndsOn` discriminator. When expiry is off, `lease.renew` succeeds as a
  confirmation. There is no transport-close event: a client that closes does not
  release editing. With no expiry, a crashed agent holds edit access until the
  owner revokes it, and Agent → Connection states this.
- The `hostRunId` is per run and the cursor key is per run. Replacement, file
  switch or close, and recovery invalidate old authority. A renderer-only restart
  keeps healthy authority. Receipt lookup is read-only and cannot recreate a
  handle or lease.
- Client metadata is a display label only. A handshake client appears as
  "Local agent" in activity, because a stateless host sees its name only in the
  handshake. A 2026-07-28 client carries its name on every request.
- The ADR-0005 coordinator linearizes revocation and admitted writes.

### Semantic contract

- Resources and tools expose semantic manifests, schema, records, surfaces,
  history and health through bounded typed projections. They expose no SQL,
  SQLite type or handle, physical identifier, database path, process, network,
  filesystem or generic host invocation.
- Data writes are canonical typed operations with explicit versions and
  idempotency keys.
- Application authoring uses explicit `begin`, `add_operations`, `amend`,
  `validate`, `preview` and `reject` change-set steps backed by ADR-0007
  proposals. Below Unattended, MCP has no promotion tool, and final acceptance is
  a visible host-owned user action. At Unattended, `accept` promotes a proposal
  that this session validated, with its reviewed digest. It goes through the
  same service that the host's own Accept calls (2026-09-22 amendment).
- Bulk data enters and leaves through the same canonical record operations:
  - a paged faithful-CSV export resource;
  - one import tool at *Edit data* that decodes CSV or typed JSON and commits it
    in bounded all-or-nothing revisions.

  Neither carries a path, and neither is a new persistence or validation route.
  A later-batch refusal reports the batches already committed and their revisions;
  an exact retry replays them. Invalid mappings and mixed-format input are refused
  before writing.
- Stable sanitized errors disclose semantic causes without paths, SQL or
  exception internals.
- Nendo implements no client-specific semantic branch. Opt-in installed-client
  lanes exercise both Claude Code and Codex. That is compatibility evidence. It
  is not a general parity promise.

## Evidence and validation obligations

- The perimeter tests assert that the server refuses non-loopback, mismatched
  Host, mismatched Origin, oversize and over-deep bodies before dispatch. They
  also assert that it refuses a body that arrives after admission closes.
- The protocol tests assert that the server answers the `initialize` handshake
  with the client's own version. They also assert that the 2026-07-28 discover
  path works without a session header.
- The installed-client lanes run the real Claude Code and Codex binaries
  against a live host with only the URL configured. Each client must read
  `nendo://application/manifest`. The lanes are opt-in
  (`NENDO_RUN_INSTALLED_CLAUDE_TEST`, `NENDO_RUN_INSTALLED_CODEX_TEST`) because
  they need the clients installed and signed in.
- The discovery lifecycle tests assert that the entry carries no credential, is
  DACL-protected and is removed on shutdown. They also assert that a closed host
  refuses a request that the perimeter would otherwise admit.

## Consequences

### Positive

- External agents share one semantic authority model with Studio and surfaces.
- Registering a client is one line that never changes. A checkout of this
  repository carries it for both Claude Code and Codex.
- Every current MCP client can connect, whichever protocol era it speaks.
- A failed or disconnected agent cannot be required for offline use.

### Negative

- Other accounts on the same machine can reach an open file at its access level.
- A crashed agent's edit lease persists until revoked.
- No equivalent-behaviour claim across MCP clients.
- At Unattended, a shape change and an automatic action can reach the active file
  before anybody reads either. History records what was done. Nothing records
  that it was reviewed, because nobody reviewed it.

## Rejected alternatives

- **A bearer credential**: see *Options considered*. Its one real job was to keep
  other accounts out. On a single-user machine, that job did not justify the
  setup cost.
- **A peer-process user check**: this check admits only connections from
  processes that the same Windows account owns. It would restore the account
  boundary with no client configuration. It is the route back if that boundary
  is ever wanted. It is not built.
- **Pinning the newest protocol only**: this refused the handshake that every
  handshake-era client sends, and it gave nothing in return.
- Client-specific integrations, an embedded runtime and raw generic tools, for
  the reasons above.

## Revisit triggers

- Shared or multi-account machines become product scope: reinstate an account
  boundary, preferably the peer-process user check.
- Remote or multi-user agents become explicit product scope.
- A required client cannot use the client-neutral contract without semantic
  branching.
- An embedded agent experience receives a separately accepted decision.

## History

- 2026-09-02 — accepted: stateful Streamable HTTP, per-run bearer and endpoint,
  60-second lease TTL, disconnect revocation.
- 2026-09-08 — stateless transport, MCP 2026-07-28 only, server-minted
  application handles; then relaxed single-user defaults: fixed port 41763, a
  device-scoped persisted credential, no lease expiry.
- 2026-09-13 — the credential removed and both protocol eras served. Measurement
  showed that the bearer was the only setup cost and that the protocol pin was
  the reason Codex could not connect.
- 2026-09-22 — amended: a fifth mode, Unattended, at which `nendo.change_set.accept`
  promotes the session's own validated proposal and the host grants the open file's
  automatic-action consent; and bulk data in and out through a CSV export resource
  and one import tool at Edit data.
