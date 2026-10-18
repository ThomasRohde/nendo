# ADR-0032: A custom view's runtime events reach the agent that wrote it

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The survey in Context (2026-10-15, W-251, Finding F-308) and the delivery's tests
  below. Accepted on the owner's standing pre-acceptance of ADR changes (2026-09-24).
- **Depends on:** ADR-0009 local MCP, ADR-0013 custom views
- **Related design:** [custom-view contract](../contracts/custom-views.md), [MCP interface](../contracts/mcp-interface.md)

## Context

An agent that writes a custom view over MCP cannot see it run. `nendo://application/extensions`
is the package as definition data; a refused bridge call is answered to the frame alone; an error
the view's code throws reaches the frame's console and nowhere else; and the Desktop logs nothing
for views. Billable's agent built its own browser adapter with 28 light and dark, narrow and wide
cases, which proved its source and not the embedded host, and still could not say why a toolbar
was refused in Nendo.

## Decision drivers

1. The agent that wrote a view learns what the view did when it ran here, with the codes Nendo gave.
2. Nothing from another open file, another package of no interest, or the browser profile is read.
3. Nothing about a view is written to the file or to the device.
4. A report never slows a view or the person, and a flood of them is bounded.

## Options considered

### A. The broker reports what it saw, the open file keeps a small ring, MCP reads it — selected

The Workbench's broker already sees every call, every refusal with its code, the handshake and a
view that stops answering. The view's API script hands it an error the view did not catch. The
broker tells the host, at most ten a second from one view; the host keeps each package's last 50
events in memory, for at most 32 packages, beside the open file's write coordinator; an agent
reads them at `nendo://application/extension-events`. Gone when the file closes.

### B. A log file on the device

Survives a restart, but it is device-wide and outlives the file, which driver 2 and 3 rule out, and
it would need retention rules of its own.

### C. The browser's own console and network log, over CDP

Complete, but it is the browser profile: every frame, every origin, extensions included. It is a
debugging lane, not something an agent with read access to one file should reach.

## Decision

Option A. A view's events are `loaded` (its frame connected), `stopped` (it stopped answering),
`error` (an error its code threw and did not catch, its sentence only, at most 500 characters,
never the stack) and `refused` (a call the broker or the host refused, with its method and code,
toolbar declarations included). The broker reports them through `extension.events.report`, which
a view's own actor may not carry: what is kept is what the broker saw, not what a view says.

The ring belongs to one open file's write coordinator, so every service over that file shares it
and no other file's host can read it. It is memory only. The read says which kind of evidence it
is: neither a definition's validation nor a test of the view's source, but what the embedded host
saw. A view shown nowhere has no events.

The fixture broker the gate lanes use becomes a supported preview: `tools/view-kit/preview.mjs`
serves a package folder against the real `api.js` and says, first, that it is a source test and
not the embedded host, and where the embedded host's events are read. Results from each of the
three kinds of evidence say which they are: a proposal's validation is the definition, the
preview is the source, and this read is the embedded host.

## Evidence and validation obligations

- Engine: a package keeps its last 50 events and counts those let go; text is cut to its bound; the
  package heard from longest ago goes first; two open files never share events (`ViewEventsTests`).
- MCP: an agent reads a view's error and its refused calls with their codes, and nothing of
  another file (`ViewEventsResourceTests`).
- Desktop: `extension.events.report` keeps the event for the open file and refuses an unknown kind;
  a view's actor cannot send it.
- Broker: a connection, an uncaught error, a refused call and a refused toolbar are each reported
  with their code, at most ten a second (`extension-broker.test.mjs`, W-251).

## Consequences

### Positive

- An agent can read why its view failed in Nendo, by code, without a browser of its own.
- Nothing new is stored, so there is nothing to clean up, migrate or consent to.

### Negative

- Events are lost when the file closes or Nendo restarts, and only the last 50 per package are kept.
- An error's sentence may name a value the view was showing. It reaches only an agent that can read
  the file anyway.

## Rejected alternatives

A device log (B) outlives the file and is device-wide. The browser's own diagnostics (C) are the
whole profile's. A view reporting its own events was rejected because a view could then write what
the broker never saw.

## Revisit triggers

- An agent needs a view's events from before the file was last opened.
- A view's events need to reach a person rather than an agent.
