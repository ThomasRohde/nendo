# ADR-0014: Drop the embedded agent; MCP is the agent surface

- **Status:** Accepted
- **Date:** 2026-09-10
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** High
- **Evidence:** `tools/Gate-AgentAuthoring.mjs` builds a whole application from an empty file through the local MCP interface alone
- **Depends on:** ADR-0009 local MCP transport authority and change sets
- **Related design:** [`../architecture.md`](../architecture.md), [ADR-0030](0030-launch-the-persons-own-agent-over-acp.md)

## Context

The question was whether Nendo should host a model client in-process, with its own
conversational surface, beside or instead of external agents. The local MCP interface
already lets an external agent author, reshape, edit and reopen an application under the
propose, validate and accept gate, reading the accepted vocabulary from
`nendo://application/vocabulary`.

## Decision

**There is no embedded agent.** The local MCP interface is the agent surface.

- The host has no in-process model client, no provider credentials and no model
  configuration.
- The Agent page shows the access level, the connection address, the lease, pending changes
  and recent activity. Its one conversational surface is the tab of an agent program the
  person installed and launched from it over ACP
  ([ADR-0030](0030-launch-the-persons-own-agent-over-acp.md)). Nendo is an ACP client of
  that program, not a model client.
- AG-UI is not adopted. [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)
  is the only agent authority boundary and states the access levels: record writes on the
  data lane, definition changes as change sets, and acceptance by the person except at the
  Unattended level.
- Agent-facing guidance describes two paths, an external client that connects and an agent
  program launched from the Agent page. Neither is a model client in the host.

This decision is about scope. It makes no claim about any particular client.

## Consequences

**Positive.** The host keeps no model credentials and needs no network of its own. There is
one authority path, one gate and one contract. Nendo stays a local document application.

**Negative.** A person with no agent program has no agent. Onboarding depends on an
external tool, and nothing in the product shows the agent story on its own.

## Rejected alternatives

- **An agent embedded in the host.** A provider dependency, credential custody, a network
  posture and a second path to mutation that would need the same gate.
- **AG-UI as a second authority boundary.** A second contract for the same operations.

## Revisit triggers

- A required capability the MCP path structurally cannot serve.
- Evidence that the external-agent requirement blocks real use, not only preference.
- A decision to ship credentials or a provider dependency for another reason.
