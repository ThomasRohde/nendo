# ADR-0014: Drop the embedded agent; MCP is the agent surface

- **Status:** Accepted
- **Date:** 2026-09-10
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** High
- **Evidence:** P3 closure, latest-protocol qualification and the P6 closure, whose gate builds a whole application from an empty file through the local MCP interface alone
- **Depends on:** ADR-0009 local MCP transport authority and change sets
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

ADR number 0014 was reserved by the first design backlog for "embedded agent UX
and the AG-UI authority boundary" — whether Nendo should host a model client
in-process, with its own conversational surface, alongside or instead of the
external agent path.

That question was reserved before the MCP interface existed. It now does, and it
has been driven end to end by more than one external agent against installed
builds: authoring, reshaping, editing, releasing and reopening, under the
propose → validate → accept gate. P6's gate builds the Axiom Register from an
empty file through that interface alone, reading the accepted vocabulary from
`nendo://application/vocabulary` rather than from this repository. No capability
the reserved ADR was meant to unlock is currently unreachable.

## Decision drivers

1. Keep a local one-file product free of a model-provider dependency.
2. Avoid taking custody of model credentials in a document application.
3. Keep one authority path for change, not two.
4. Prefer the client the user already has over one bundled into the host.
5. Do not carry a reserved decision that no longer describes a real question.

## Options considered

### Embed an agent in the host

Ship an in-process model client and a conversational surface in the Workbench.
Broadest in-product affordance; adds provider dependency, credential custody,
network posture, model configuration and a second path to mutation that must be
held to the same gate as MCP.

### Adopt AG-UI as a second authority boundary

Define a distinct protocol for a hosted agent UI. Adds a contract to maintain
beside the MCP one for the same operations.

### Drop it; keep MCP as the agent surface

Retain the external-client model. No provider dependency and no second authority
path. The user must bring an MCP client.

## Decision

**There is no embedded agent.** The local MCP interface is the agent surface, and
the reserved 0014 scope is dropped rather than deferred.

- No in-process model client, no bundled provider credentials and no model
  configuration in the host.
- No conversational surface in the Workbench. The existing Agent screen remains
  what it is: connection, credential and lease status for an external client.
- AG-UI is not adopted. ADR-0009 remains the only agent authority boundary.
- Every agent mutation continues to arrive as a change set through the
  propose → validate → accept gate, owner-accepted before it touches the file.

This is a scope decision, not a capability claim about any particular client.
Broad client parity remains outside the MVP promise, as ADR-0009 records.

## Evidence and validation obligations

- No new implementation obligation. This decision removes scope.
- The obligation it does carry is documentary: agent-facing guidance must
  describe an external client as the only agent path, with no forward reference
  to a hosted one.

## Consequences

### Positive

- The host keeps no credentials and needs no network of its own.
- One authority path, one gate, one contract to hold correct.
- The product stays a local document application rather than a model client.

### Negative

- A user with no MCP client has no agent at all; the affordance lives outside the
  product and onboarding depends on an external tool.
- Nothing in the product demonstrates the agent story on its own.

## Rejected alternatives

Embedding an agent and adopting AG-UI are both rejected because the external MCP
path already carries the qualified journeys, and each alternative would add a
second way to mutate a file that must then be held to the same review gate for
no capability that is currently out of reach.

## Revisit triggers

- A required capability that the MCP path structurally cannot serve.
- Evidence that the external-client requirement is what blocks real use, rather
  than a preference.
- Any decision to ship credentials or a provider dependency for another reason,
  which would remove the main cost recorded here.
