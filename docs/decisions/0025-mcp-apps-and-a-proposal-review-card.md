# ADR-0025: MCP Apps, and a read-only proposal review card as the first candidate

- **Status:** Deferred
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The MCP Apps extension (`io.modelcontextprotocol/ui`); the owner's loop runs in terminal clients, which do not render apps
- **Depends on:** ADR-0007, ADR-0009, ADR-0013

Nendo builds, declares and serves no MCP App. A proposal is read as the MCP preview
(`nendo.change_set.preview`) and reviewed and accepted in Nendo's Pending changes
([MCP interface](../contracts/mcp-interface.md)).

If a client that renders MCP Apps enters the owner's loop, this is revisited with a read-only
proposal review card as the first candidate, under these boundaries:

- The card carries no Accept, Reject or write; it may call only resource reads and
  `nendo.change_set.preview`. Acceptance stays in Nendo (ADR-0009).
- It renders from the same projection Pending changes reads, and the gate holds the three
  renderings (Workbench, MCP JSON, card) equal on the text a person reads.
- Its code is host code, versioned with the host and served only to a client that declares the
  extension. It never enters a `.nendo` file; a file-carried app is a separate decision.

Rejected: building it now (a new place code runs and a third rendering to keep equal, for no
client in use). Revisit when the person works in a client that renders MCP Apps, or when the
extension changes what an app may call.
