# ADR-0030: Launch the person's own agent over ACP, in a tab

- **Status:** Accepted
- **Date:** 2026-10-08
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The Agent Client Protocol at protocol version 1; `DesktopLaunchedAgentTests` against a stand-in ACP agent; the Workbench's agent node tests and shell lane
- **Amends:** ADR-0014 (the Workbench gains a conversation tab; the rest stands)
- **Amended by:** ADR-0033 (a custom view may send a message; the agent's settings are on the Agent page)
- **Depends on:** ADR-0002, ADR-0009, ADR-0014
- **Contract:** [launched agents](../contracts/launched-agents.md), [MCP interface](../contracts/mcp-interface.md)

## Context

[ADR-0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md) keeps any model client,
provider dependency and credential out of the host, at the cost that a person with no MCP client
has no agent. The Agent Client Protocol (ACP) lets an application start an agent program it does
not own as a child process, talk JSON-RPC over stdio, and name the MCP servers the session should
use; the program brings its own model, sign-in and billing. Copilot CLI, Gemini CLI, OpenCode,
and Claude Code and Codex through adapters speak it. AG-UI is a different protocol: it connects a
hosted agent backend to a web front end, starts no local program and names no MCP servers.

## Decision

**The Agent page may launch the person's own agent program over ACP, and the conversation opens
in a tab.** The host is an ACP client only: no model client, no provider dependency, no
credential.

**What may be launched.** An installed program that speaks ACP on stdio: the known agents found
on `PATH` (`DesktopAgentCatalog`) and one command line the person enters. The person's command and
the agents they hide are kept on this device, never in the file. The host never downloads,
installs or updates an agent and reads no registry over the network; for a missing or renamed
package it shows the install or update command for the person to run.

**When Launch is offered.** At **Inspect or higher**, with the listener running; at Off,
read-only or in recovery the page says why. One launched agent per file window. The tab shows the
level and links to the Agent page, with no control that changes it. The level is enforced where
it always is, at the MCP boundary: the launched agent is one more MCP client under the same level,
leases and change-set gate. The tab's gating is a convenience, not the protection.

**What the host tells the agent.**

- `initialize` declares no file-system and no terminal capability.
- `session/new` names exactly one MCP server, this file's loopback address as `http`. An agent
  without `mcpCapabilities.http`, or on another protocol version, is refused by name.
- The working directory is a new empty folder under this device's Nendo state, removed when the
  session ends, unless the person chose, for this file on this device, to start the agent in the
  file's repository: the nearest folder above the file that holds `.git`, or the file's own folder
  when none does. The agent then works there as it would from a terminal, with that folder's
  instructions, skills, settings and hooks. Nendo never removes that folder, and the choice is
  kept on the device, never in the file. Empty is the default.
- Sign-in uses only a method the agent offered, with `authenticate`; the agent performs it and no
  secret passes through Nendo.
- An application handle in tool input or output is hidden wherever agent text is shown (ADR-0009
  lets the UI show only pseudonyms).

**The tab.**

- A tab kind of the window, never written to the file. It shows message text, tool calls with
  their kind, status and whether they went through Nendo, the plan, permission requests, the
  agent's notices and context compactions, its name for the conversation, and how full its
  context is and what it has cost, as the agent reports them.
- Agent text is untrusted: text and safe Markdown, no HTML, no script, no automatic navigation.
- A picture the agent or its tools send inline is drawn when its own bytes say PNG, JPEG, GIF or
  WebP, within a bound, from those bytes and nothing else: no SVG, no address it names, no fetch.
  The conversation keeps a bounded number in memory and the oldest go first. What a picture shows
  is the agent's, as its text is; Nendo cannot hide an application handle inside one.
- A permission request shows the agent's own options. The host never answers one itself and never
  picks an *always* option for the person, at any level.
- The agent's ACP session options (model, effort, mode and the rest) are shown on the Agent page
  while it runs, and a value is sent only when the person picks it there or on a view's launch
  card (ADR-0033). The values a person picks are kept per agent on this device, with the options
  the agent last offered, and sent again when that agent next starts, before it is ready: a value
  it no longer offers is not sent, and one it refuses leaves a notice in the conversation. They
  are the agent's settings, not Nendo's access level. The tab and custom views have none.
- **@** points the agent at what the person chooses (record types, fields, views, records found
  through the search index, waiting proposals, other tabs) as bounded nendo:// references the
  agent could already read at its level. Pictures the person pastes, drops or picks go with the
  message as ACP image blocks, bounded, and only to an agent that declared
  `promptCapabilities.image`; Nendo keeps none of them. **/** lists the agent's own slash commands; Nendo never
  runs or checks one.
- A proposal the agent validates is reviewed on the Agent page as any other.
- A custom view may send a message into the conversation, marked with its title
  ([ADR-0033](0033-a-view-messages-the-launched-agent.md)).
- The transcript lives in host memory from launch until the file closes or another agent is
  launched; never in the file or on the device.

**Lifetime.** The program runs in a Job Object that ends it and everything it started when the
conversation ends or the host exits. Ending the agent, closing its tab, closing or replacing the
file, recovery, the level set to Off and a moved listener address all end the session. A level
change between Inspect and Unattended does not; the agent's next MCP call meets it.

**What Nendo cannot confine.** The program is the one the person would run in a terminal, with
its own shell, file and web tools. Nendo grants it nothing more than an empty folder, or the
file's repository when the person chose it, and the file's MCP address at the person's level, and does not sandbox it. The axiom that agents never
receive raw SQL or file-system authority holds for what Nendo grants, not for what the person's
own program can do. The Agent page says so before the first launch.

**Unchanged.** ADR-0009's boundary, levels, leases and change-set gate; ADR-0014's no model
client, credentials or model configuration; AG-UI not adopted; a person may still connect any MCP
client from a terminal.

## Consequences

- A person with an ACP agent installed uses it from inside Nendo, with no terminal or
  registration, and one authority path remains.
- Nendo's button starts a program that can do anything the person's account can.
- ACP and its adapters change; a known command can stop working, and the catalog's renamed
  packages need upkeep by hand.
- A person without an ACP-capable agent still has none.

## Rejected alternatives

- **AG-UI between host and tab:** a second contract for the events ACP already carries.
- **AG-UI to a hosted agent, or an in-process model client:** brings back ADR-0014's provider,
  credential and network costs.
- **Declaring file-system and terminal capabilities:** makes Nendo a file and shell broker, and
  does not stop an agent's own tools.
- **Always the file's own folder:** a file kept in a repository's subfolder misses the
  repository's instructions and skills, which sit at its root.
- **A folder per agent through its own flags (`--add-dir` and the like):** not part of ACP, so one
  command line per agent to keep up.
- **Auto-allowing permissions at Unattended:** Unattended is about the file; a permission request
  is usually about the computer.
- **Keeping the transcript in the file:** it is the person's working notes and carries whatever
  the agent read.
- **Bundling an adapter in the installer:** it would fall behind, carry Node and a vendor's SDK,
  and make one vendor's agent part of Nendo.

## Revisit triggers

- Launched agents do harm through their own tools that a person did not expect from the tab.
- An ACP version changes the session or permission model.
- A wish to keep or resume conversations (`session/load`).
- A need to reach an agent that does not run on this computer.
