# ADR-0032: A custom view's runtime events reach the agent that wrote it

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `ViewEventsTests`, `ViewEventsResourceTests`, the Desktop report tests and `extension-broker.test.mjs`
- **Depends on:** ADR-0009, ADR-0013
- **Contract:** [custom views](../contracts/custom-views.md), [MCP interface](../contracts/mcp-interface.md)

## Context

An agent that writes a custom view over MCP cannot see it run. The package resource is
definition data; a refused bridge call is answered to the frame alone; an uncaught error reaches
the frame's console only; and the Desktop logs nothing for views. A preview of the source proves
the source, not the embedded host.

## Decision

The Workbench's broker reports what it saw, the open file keeps a small ring in memory, and an
agent reads it at `nendo://application/extension-events`.

- **Events:** `loaded` (the frame connected), `stopped` (it stopped answering), `error` (an error
  the view's code threw and did not catch: its sentence only, at most 500 characters, never the
  stack) and `refused` (a call the broker or host refused, with its method and code, toolbar
  declarations included).
- **Reporting:** the broker sends them through `extension.events.report`, at most ten a second
  from one view. A view's own actor may not call it: what is kept is what the broker saw, not what
  a view says.
- **Keeping:** the ring belongs to one open file's write coordinator, so every service over that
  file shares it and no other file reads it. It keeps each package's last 50 events, for at most
  32 packages, the package heard from longest ago going first, and counts those let go. Memory
  only: gone when the file closes. Nothing is written to the file or the device.
- **Three kinds of evidence, each named as such:** a proposal's validation is the definition;
  `tools/view-kit/preview.mjs`, which serves a package folder against the real `api.js`, is the
  source and says so first; this read is the embedded host. A view shown nowhere has no events.

## Consequences

- An agent reads why its view failed in Nendo, by code, without a browser of its own, and nothing
  new is stored.
- Events are lost when the file closes or Nendo restarts, and only the last 50 per package are kept.
- An error's sentence may name a value the view was showing; it reaches only an agent that can read
  the file anyway.

## Rejected alternatives

- **A log file on the device:** device-wide and outlives the file.
- **The browser's console and network log over CDP:** the whole profile, every frame and origin.
- **A view reporting its own events:** a view could write what the broker never saw.

## Revisit triggers

- An agent needs a view's events from before the file was last opened.
- A view's events need to reach a person rather than an agent.
