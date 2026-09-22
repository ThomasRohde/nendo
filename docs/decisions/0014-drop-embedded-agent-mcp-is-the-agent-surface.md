# ADR-0014: Drop the embedded agent; MCP is the agent surface

- **Status:** Accepted
- **Date:** 2026-09-10
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** High
- **Evidence:** P3 closure, latest-protocol qualification and the P6 closure, whose gate builds a whole application from an empty file through the local MCP interface alone
- **Depends on:** ADR-0009 local MCP transport authority and change sets
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

The first design backlog reserved ADR number 0014 for "embedded agent UX and the
AG-UI authority boundary". The question was whether Nendo should host a model
client in-process, with its own conversational surface, beside the external agent
path or in place of it.

That question was reserved before the MCP interface existed. The interface now
exists. More than one external agent has used it end to end against installed
builds: authoring, reshaping, editing, releasing and reopening, under the
propose → validate → accept gate. The P6 gate builds the Axiom Register from an
empty file through that interface alone. It reads the accepted vocabulary from
`nendo://application/vocabulary` and not from this repository. Every capability
that the reserved ADR was to unlock is currently reachable.

## Decision drivers

1. Keep a local one-file product free of a model-provider dependency.
2. Do not take custody of model credentials in a document application.
3. Keep one authority path for change, not two.
4. Prefer the client that the user already has to a client bundled into the host.
5. Do not keep a reserved decision that no longer describes a real question.

## Options considered

### Embed an agent in the host

Ship an in-process model client and a conversational surface in the Workbench.
This option gives the broadest in-product affordance. It adds a provider
dependency, credential custody, a network posture and model configuration. It
also adds a second path to mutation, which must meet the same gate as MCP.

### Adopt AG-UI as a second authority boundary

Define a distinct protocol for a hosted agent UI. This option adds a contract to
maintain beside the MCP contract for the same operations.

### Drop it; keep MCP as the agent surface

Keep the external-client model. This option has no provider dependency and no
second authority path. The user must supply an MCP client.

## Decision

**There is no embedded agent.** The local MCP interface is the agent surface. The
reserved 0014 scope is dropped. It is not deferred.

- The host has no in-process model client, no bundled provider credentials and
  no model configuration.
- The Workbench has no conversational surface. The existing Agent screen does
  not change: it shows connection, credential and lease status for an external
  client.
- AG-UI is not adopted. ADR-0009 remains the only agent authority boundary.
- Every agent mutation continues to arrive as a change set through the
  propose → validate → accept gate. The owner accepts it before it touches the
  file.

**Note, 2026-09-22.** Two statements above no longer describe the host. The
Agent screen shows the access level, the connection address, the lease, pending
changes and recent activity. The transport has no credential since the ADR-0009
amendment of 2026-09-13. Record writes at Edit data go through the MCP data
tools on the data lane, without a change set. At the Unattended level (ADR-0009
amendment of 2026-09-22), `nendo.change_set.accept` promotes a proposal that the
same session validated, so the owner does not accept it first.
[ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md) describes the
current access levels.

This decision is about scope. It makes no capability claim about any particular
client. Broad client parity remains outside the MVP promise, as ADR-0009
records.

## Evidence and validation obligations

- No new implementation obligation. This decision removes scope.
- The decision carries one documentary obligation: agent-facing guidance must
  describe an external client as the only agent path, with no forward reference
  to a hosted one.

## Consequences

### Positive

- The host keeps no credentials and needs no network of its own.
- There is one authority path, one gate and one contract to keep correct.
- The product stays a local document application and does not become a model
  client.

### Negative

- A user with no MCP client has no agent at all. The affordance is outside the
  product, and onboarding depends on an external tool.
- Nothing in the product demonstrates the agent story on its own.

## Rejected alternatives

Embedding an agent and adopting AG-UI are both rejected. The external MCP path
already carries the qualified journeys. Each alternative would add a second way
to mutate a file, and that way would then need the same review gate. It would
give no capability that is currently out of reach.

## Revisit triggers

- A required capability that the MCP path structurally cannot serve.
- Evidence that the external-client requirement blocks real use and is not only
  a preference.
- Any decision to ship credentials or a provider dependency for another reason.
  That decision would remove the main cost recorded here.
