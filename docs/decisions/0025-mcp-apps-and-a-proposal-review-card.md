# ADR-0025: MCP Apps, and a read-only proposal review card as the first candidate

- **Status:** Deferred
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The MCP Apps extension as published (`io.modelcontextprotocol/ui`, read
  2026-10-04), the client matrix on that date (Claude Desktop and web, VS Code Copilot,
  Cursor, Goose render apps; terminal clients do not), and the owner's stated loop (Claude
  Code and Codex in a terminal, `docs/dogfooding.md`)
- **Depends on:** ADR-0007 proposals, ADR-0009 the agent surface, ADR-0013 where
  file-carried code runs
- **Related design:** [MCP interface contract](../contracts/mcp-interface.md), the 2026-10-04
  MCP review (section 7.3), W-156

## Context

MCP Apps lets a tool declare `_meta.ui.resourceUri`, pointing at a `ui://` HTML resource that
the client host renders in a sandboxed iframe with a postMessage bridge; the app can call the
server's tools. For Nendo, one app is clearly worth having: a read-only proposal review card,
the semantic diff, the shape lines, the package hunks and the behaviour sentence rendered as
Pending changes renders them, next to the chat in which the agent proposed it. A second
candidate is a record page for one record. Both are reads. Neither carries an Accept
button: the ADR-0009 amendment of 2026-09-29 rejected approving from the review under
another name, and acceptance stays in Nendo.

Three things make this a decision rather than a work item:

1. It ships JavaScript to a client host over MCP. ADR-0013's rule is that code a file
   carries runs only as a custom view in the view's own frame. An MCP App is neither in the
   file nor in Nendo's frame; it is a new place code runs, and the review bundle it would
   reuse is host code, not file code.
2. It is a third rendering of the same preview, beside the Workbench's Pending changes and
   the MCP JSON. The gate would have to prove the three agree, and say which is canonical.
3. Its value depends on the person using a client that renders apps. The owner's loop is two
   terminal clients, which do not.

## Decision drivers

1. Acceptance stays in Nendo; no rendering anywhere else may offer it.
2. One canonical preview, proved equal wherever it is drawn.
3. Nothing is built that the owner's own loop cannot exercise.

## Options considered

### A. Build the review card now

A `ui://nendo/proposal-review` resource served by the host, built from the Workbench's review
rendering, declared on `nendo.change_set.validate` and `nendo.change_set.preview`. Benefits:
a person in a rendering client reads the proposal where it was proposed. Costs: a new place
code runs, a third rendering to keep equal, and no client in the owner's loop to see it.

### B. Build it when a rendering client is in the loop

The same card, when the person works in a client that renders apps, with the gate extended
to compare the card's text against Pending changes and the MCP preview for the same
proposal. Benefits: built against a real use and a measurable equality. Costs: nothing
today.

### C. Never

The MCP JSON preview is the only agent-side rendering. Costs: a person in a rendering client
reads a proposal as JSON or walks to Nendo.

## Decision

Deferred, as option B. No MCP App is built, declared or served now. When a client that
renders apps enters the owner's loop, this ADR is revisited with the review card as the first
candidate, under these boundaries, which hold whatever the date:

- The card is read-only. It carries no Accept, no Reject and no write; it may call only
  resource reads and `nendo.change_set.preview`.
- The card's rendering is derived from the same projection Pending changes reads, and the
  gate holds the three renderings equal for the same proposal, on the text a person reads.
- The code it ships is host code, versioned with the host, served only to a client that
  declares the extension; it never enters a `.nendo` file, so ADR-0013's rule on
  file-carried code is untouched. A file-carried app is a separate decision.

Until then, the roadmap lists this under decisions needed, and the review's section 7.3
is the record of why.

## Evidence and validation obligations

- Pending until the revisit. The revisit needs: the client the person uses, the extension's
  state on that date, and a measurement of the three renderings' agreement.

## Consequences

### Positive

- No third rendering to keep equal, and no new place code runs, for a client nobody here
  uses.

### Negative

- A person in a rendering client reads a proposal as JSON until the revisit.

## Rejected alternatives

Option A was rejected because its three costs are paid today and its benefit reaches no
client in the owner's loop. Option C was rejected because the card is a read, the ADR-0009
boundary leaves room for a read, and a rendering client may well arrive.

## Revisit triggers

- The person works in a client that renders MCP Apps.
- The extension's sandbox or bridge changes what an app may call.
