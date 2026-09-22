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

The owner accepted this amendment on 2026-09-22, having been told in the same sitting
what it gives up. It changes decision driver 5 and the *Authority* and *Semantic
contract* sections below, and nothing else in this decision.

**What is wrong.** Building a new application through MCP costs a person three
interruptions the work does not need. Every proposal waits for a click. Automatic
actions need a second, separate approval at the device. And seeding the result means
fifty records per call, one record type at a time, after the schema proposal has been
accepted — so a five-table demonstration is twenty round trips with a human in the
middle of them. None of those interruptions is protecting anything while the person is
sitting there asking the agent to build the file in the first place. The interruption
has a purpose when an agent proposes a change to a file somebody already depends on; it
has none when the file is three minutes old and the agent is making it to order.

**Options considered.**

- *A. A fifth access level — selected.* A level above Shape app at which the MCP surface
  gains one tool, `nendo.change_set.accept`, and at which the host grants this device's
  automatic-action consent on the agent's behalf for exactly the behaviour the open file
  holds. Off by default, never persisted, never reached without the person choosing it
  for this file session, and confirmed before it takes effect.
- *B. A per-proposal pre-authorisation — rejected.* "Accept whatever this change set
  becomes", given before validation. It reads safer and is not: the person authorises a
  change set they have not seen the preview of, which is the same trust with a worse
  description of itself, and it leaves no single place to say what the session may do.
- *C. Keep acceptance human and fix only the data half — rejected.* Bulk import alone
  removes the twenty round trips and leaves the two interruptions that bracket them.
  Worth doing, and done, but it does not answer the ask.
- *D. Auto-accept without touching behaviour consent — rejected by the owner.* An agent
  that can author an automatic action and accept it, but cannot make the file run it,
  stops one call later with `NENDO_BEHAVIOUR_NOT_APPROVED`. Unattended that stops for a
  click is not unattended.

**Decision.** Visible modes become Off, Inspect, Edit data, Shape app and
**Unattended**. Where this decision said "MCP has no promotion tool; final acceptance is
a visible host-owned user action", it now says: MCP has no promotion tool below
Unattended, and at Unattended one tool, `nendo.change_set.accept`, promotes a proposal
the same session validated. It takes the reviewed operation digest and goes through the
same `PromoteProposalAsync` the person's own Accept button calls, so every staleness,
digest and replay check stands. Validation still happens on a physical clone, promotion
still replays validated operations against the active file, and the proposal is still
visible in Pending changes and in `nendo://application/proposals` between validating and
accepting. What changes is who presses the button.

At Unattended, and at no lower level, the host also grants its automatic-action consent
for the behaviour the open file currently holds — the identical grant a person's
approval writes, scoped to the same behaviour digest, revocable from the same place. The
Engine is unchanged: it still asks `INendoBehaviourAuthority` and still refuses when the
answer is no. The adapter never reaches grant storage and never learns where a grant
lives; it holds one host-supplied delegate, which the host supplies only at this level.

**What this gives up, stated plainly.** At Unattended an agent can write an automatic
action, accept it, and cause it to run, with nobody having read it. That is a real loss
and it is the point of the level. It is bounded by three things and no more: the level
is off by default and resets to off whenever the file session ends, so it cannot be
inherited by the next file or the next launch; it is confirmed before it takes effect;
and every acceptance is an ordinary History revision, so what was done is readable
afterwards even though it was not read beforehand. The posture below Unattended is
unchanged. This is the wrong level to leave on, and the product says so where it is
chosen.

## Context

The product needs an external agent to inspect and shape a local Nendo
application without SQL, source code or filesystem authority. MCP is a suitable
adapter, but it is not the authority, identity or revision model.

Nendo is a single-user, local, Windows product, and what it exists to explore is
malleable software: how far an agent can take a file through a typed interface.
Every step between "a file is open" and "the agent is talking to it" is paid on
every iteration of that exploration. Two things were measured to dominate that
cost. A per-run credential and port invalidated any saved client configuration on
every host start. A server pinned to the newest MCP revision refused the
`initialize` handshake, and Codex CLI — whose client speaks only that handshake —
could not connect at all, while Claude Code could. The owner has chosen
iteration speed over an account boundary on one machine; the decision states
what that buys and what it gives up.

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

Run an official-SDK server owned by the desktop host on a fixed loopback port,
exposing bounded semantic resources and tools, with no credential.

### Loopback MCP adapter behind a bearer credential

The same adapter, with a per-device bearer published in a discovery file. Used
from 2026-09-02 to 2026-09-13. The bearer distinguished the owner's account from
other accounts on the same machine and nothing else — browser-origin attacks
were already stopped by Host/Origin matching, and same-user processes could read
the credential. It cost every client a file read and every registration a
pasted secret.

### Client-specific integrations

Separate Codex, Claude or vendor adapters. Duplicates semantics and lets client
behaviour leak into the product authority model.

### Embedded conversational runtime

An agent framework inside Nendo. Adds model credentials, orchestration and a
second product surface.

### Raw SQL or filesystem tools

Generic local capabilities. Bypasses validation, history, proposal and recovery
boundaries.

## Decision

Nendo exposes an optional client-neutral MCP adapter over typed host application
services, at a static loopback address, with no credential.

### Transport and perimeter

- Stateless Streamable HTTP through the official .NET MCP SDK, bound only to
  IPv4 loopback. The default port is 41763; a port that cannot be bound falls
  back to an ephemeral one and is reported, never fatal. The owner can choose a
  different fixed port or always-ephemeral in Agent → Connection.
- **Both MCP eras are served.** The server pins no protocol version: an
  `initialize` handshake on any version the SDK supports is answered, and the
  2026-07-28 `server/discover` path with per-request metadata works alongside it.
  There is no session header in either mode.
- **There is no credential.** The perimeter is the loopback remote address, exact
  Host and Origin matching against the bound port, bounded body size and JSON
  depth, and closed admission after any lifecycle boundary. The address is the
  whole client configuration: `claude mcp add --transport http nendo
  http://127.0.0.1:41763/mcp`, `codex mcp add nendo --url http://127.0.0.1:41763/mcp`.
- One discovery entry per open file is written under
  `%LOCALAPPDATA%\Nendo\Mcp\active` with the endpoint, run ID, process ID, access
  mode and the file's display name — never a path — under a user-scoped DACL. It
  exists for the fallback-port case and to tell two windows apart; a client on
  the standard port never reads it.

### Security posture

- The boundary is this computer, at the owner's chosen access level. While a
  file is open with access on, any process on the machine — under any account —
  can connect. The owner's controls are the access level (**Off** by default),
  revocation of the edit lease, and the approval dialog: shaping the application
  still requires the person's acceptance. Data writes at *Edit data* do not, and
  neither shape changes nor automatic-action consent do at *Unattended*, which is
  why that level is chosen per file session and never remembered.
- Host and Origin matching keeps browser-origin requests and DNS rebinding out.
  That defence never depended on a credential.
- This is the posture for a single-user machine. It is not an anti-malware
  boundary, and it is the wrong choice for a shared computer; the revisit
  triggers name what would change it.

### Authority

- Visible modes are Off, Inspect, Edit data, Shape app and Unattended. The host
  shows the active mode and the modifying owner. The mode is captured when the
  listener starts and is immutable for its lifetime; changing it restarts the
  listener. It is never persisted: every file session begins at Off.
- `nendo.lease.acquire` mints a random 256-bit `applicationHandle` and a distinct
  lease ID. Every owned data, proposal, renew and release operation supplies
  both. The handle is a capability: possession permits use across independent
  HTTP requests and clients. Do not log handles or raw request bodies; UI and
  receipts expose only pseudonyms.
- At most one modifying lease exists per open file. By default it does not
  expire and ends only on explicit release, owner revocation or host stop; the
  owner can enable a bounded expiry. `NendoLeaseGrant.ExpiresAt` is nullable with
  an `EndsOn` discriminator, and `lease.renew` succeeds as a confirmation when
  expiry is off. There is no transport-close event: closing a client does not
  release editing. With no expiry, a crashed agent holds edit access until
  revoked, and Agent → Connection says so.
- The `hostRunId` is per run and the cursor key is per run: replacement, file
  switch or close, and recovery invalidate old authority. Renderer-only restart
  preserves healthy authority. Receipt lookup is read-only and cannot recreate a
  handle or lease.
- Client metadata is a display label only. A handshake client appears as
  "Local agent" in activity, because a stateless host sees its name only in the
  handshake; a 2026-07-28 client carries its name on every request.
- Revocation and admitted writes are linearized through the ADR-0005 coordinator.

### Semantic contract

- Resources and tools expose semantic manifests, schema, records, surfaces,
  history and health through bounded typed projections. They expose no SQL,
  SQLite type or handle, physical identifier, database path, process, network,
  filesystem or generic host invocation.
- Data writes are canonical typed operations with explicit versions and
  idempotency keys.
- Application authoring uses explicit `begin`, `add_operations`, `amend`,
  `validate`, `preview` and `reject` change-set steps backed by ADR-0007
  proposals. Below Unattended, MCP has no promotion tool and final acceptance is
  a visible host-owned user action. At Unattended, `accept` promotes a proposal
  this session validated, with its reviewed digest, through the same service the
  host's own Accept calls (2026-09-22 amendment).
- Bulk data arrives and leaves through the same canonical record operations: a
  paged faithful-CSV export resource, and one import tool at *Edit data* that
  decodes CSV or typed JSON and commits it in bounded all-or-nothing revisions.
  Neither carries a path, and neither is a new persistence or validation route.
- Stable sanitized errors disclose semantic causes without paths, SQL or
  exception internals.
- Nendo implements no client-specific semantic branch. Claude Code and Codex
  are both exercised by opt-in installed-client lanes; that is compatibility
  evidence, not a general parity promise.

## Evidence and validation obligations

- The perimeter tests assert non-loopback, mismatched Host, mismatched Origin,
  oversize and over-deep bodies are refused before dispatch, and that a body
  arriving after admission closes is refused.
- The protocol tests assert the `initialize` handshake is answered with the
  client's own version and that the 2026-07-28 discover path works without a
  session header.
- The installed-client lanes run the real Claude Code and Codex binaries
  against a live host with only the URL configured and require each to read
  `nendo://application/manifest`. They are opt-in (`NENDO_RUN_INSTALLED_CLAUDE_TEST`,
  `NENDO_RUN_INSTALLED_CODEX_TEST`) because they need the clients installed and
  signed in.
- The discovery lifecycle tests assert the entry carries no credential, is
  DACL-protected, is removed on shutdown, and that a closed host refuses a
  request the perimeter would otherwise admit.

## Consequences

### Positive

- External agents share one semantic authority model with Studio and surfaces.
- Registering a client is one line that never changes; a checkout of this
  repository carries it for both Claude Code and Codex.
- Every current MCP client can connect, whichever protocol era it speaks.
- A failed or disconnected agent cannot be required for offline use.

### Negative

- Other accounts on the same machine can reach an open file at its access level.
- A crashed agent's edit lease persists until revoked.
- No equivalent-behaviour claim across MCP clients.
- At Unattended, a shape change and an automatic action can reach the active file
  with nobody having read either. History records what was done; nothing records
  that it was reviewed, because it was not.

## Rejected alternatives

- **A bearer credential** — see *Options considered*. Its one real job, keeping
  other accounts out, was judged not worth the setup cost on a single-user
  machine.
- **A peer-process user check** — admitting only connections from processes
  owned by the same Windows account would restore the account boundary with no
  client configuration. It is the route back if that boundary is ever wanted;
  it is not built.
- **Pinning the newest protocol only** — refused the handshake every
  handshake-era client sends. Nothing was gained for it.
- Client-specific integrations, an embedded runtime and raw generic tools, for
  the reasons above.

## Revisit triggers

- Shared or multi-account machines become product scope: reinstate an account
  boundary, by preference the peer-process user check.
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
- 2026-09-13 — the credential removed and both protocol eras served, after the
  bearer was measured to be the only setup cost and the protocol pin the reason
  Codex could not connect.
- 2026-09-22 — amended: a fifth mode, Unattended, at which `nendo.change_set.accept`
  promotes the session's own validated proposal and the host grants the open file's
  automatic-action consent; and bulk data in and out through a CSV export resource
  and one import tool at Edit data.
